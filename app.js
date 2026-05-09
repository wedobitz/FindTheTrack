const CSV_PATH = "data/output.csv";

const searchInput = document.getElementById("searchInput");
const resultsEl = document.getElementById("results");
const resultCountEl = document.getElementById("resultCount");
const chips = document.querySelectorAll(".chip");

let tracks = [];
let activeFilter = "all";
let debounceTimer = null;

/**
 * Normalizza testo:
 * - minuscolo
 * - rimuove accenti
 * - rimuove caratteri inutili
 */
function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parser CSV semplice ma robusto.
 * Gestisce virgole dentro campi racchiusi tra virgolette.
 */
function parseCSV(text) {
  const rows = [];
  let currentRow = [];
  let currentValue = "";
  let insideQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"' && insideQuotes && nextChar === '"') {
      currentValue += '"';
      i++;
    } else if (char === '"') {
      insideQuotes = !insideQuotes;
    } else if (char === "," && !insideQuotes) {
      currentRow.push(currentValue);
      currentValue = "";
    } else if ((char === "\n" || char === "\r") && !insideQuotes) {
      if (currentValue || currentRow.length) {
        currentRow.push(currentValue);
        rows.push(currentRow);
        currentRow = [];
        currentValue = "";
      }

      if (char === "\r" && nextChar === "\n") {
        i++;
      }
    } else {
      currentValue += char;
    }
  }

  if (currentValue || currentRow.length) {
    currentRow.push(currentValue);
    rows.push(currentRow);
  }

  return rows;
}

/**
 * Converte CSV in array di oggetti.
 */
function csvToObjects(csvText) {
  const rows = parseCSV(csvText);

  if (!rows.length) return [];

  const headers = rows[0].map(header => header.replace(/^\uFEFF/, "").trim());

  return rows.slice(1).map(row => {
    const item = {};

    headers.forEach((header, index) => {
      item[header] = row[index] ? row[index].trim() : "";
    });

    return item;
  });
}

/**
 * Prepara i dati per ricerca veloce.
 * Crea search_blob una volta sola.
 */
function prepareTracks(rawTracks) {
  return rawTracks.map(track => {
    const searchableFields = [
      track["Titolo"],
      track["Artista"],
      track["Album"],
      track["Genere"],
      track["Stile"],
      track["Written By"],
      track["Cartella"]
    ];

    return {
      ...track,
      _speed: getRecordSpeed(track),
      _searchBlob: normalizeText(searchableFields.join(" ")),
      _groupKey: `${normalizeText(track["Titolo"])}|${normalizeText(track["Artista"])}`
    };
  });
}

/**
 * Ricava il tab corretto dal formato Discogs.
 * Nel CSV i 33 giri spesso arrivano come "LP", non come testo "33".
 */
function getRecordSpeed(track) {
  const formato = normalizeText(track["Formato"]);

  if (formato.includes("45 rpm") || /\b45\b/.test(formato)) {
    return "45";
  }

  if (formato.includes("33 rpm") || formato.includes("33 1 3") || /\b33\b/.test(formato)) {
    return "33";
  }

  if (formato.includes("78 rpm") || /\b78\b/.test(formato)) {
    return "";
  }

  if (/\blp\b/.test(formato) || formato.includes("album") || formato.includes("12")) {
    return "33";
  }

  if (/\b7\b/.test(formato) || formato.includes("single")) {
    return "45";
  }

  return "";
}

/**
 * Carica CSV locale.
 */
async function loadCSV() {
  try {
    const response = await fetch(CSV_PATH);

    if (!response.ok) {
      throw new Error("CSV non trovato");
    }

    const csvText = await response.text();
    const rawTracks = csvToObjects(csvText);

    tracks = prepareTracks(rawTracks);

    resultCountEl.textContent = `${tracks.length} brani caricati`;
    renderInitialState();

  } catch (error) {
    resultCountEl.textContent = "Errore nel caricamento del CSV";
    resultsEl.innerHTML = `
      <div class="empty">
        Controlla che il file esista in <strong>data/output.csv</strong>
      </div>
    `;
    console.error(error);
  }
}

/**
 * Applica ricerca e filtro.
 */
function getFilteredTracks(query) {
  const normalizedQuery = normalizeText(query);

  let filtered = tracks;

  if (activeFilter !== "all") {
    filtered = filtered.filter(track => {
      return track._speed === activeFilter;
    });
  }

  if (normalizedQuery) {
    const terms = normalizedQuery.split(" ");

    filtered = filtered.filter(track => {
      return terms.every(term => track._searchBlob.includes(term));
    });
  }

  return filtered;
}

/**
 * Raggruppa duplicati per Titolo + Artista.
 */
function groupTracks(filteredTracks) {
  const groups = new Map();

  filteredTracks.forEach(track => {
    const key = track._groupKey;

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    groups.get(key).push(track);
  });

  return Array.from(groups.values());
}

/**
 * Rendering principale.
 */
function renderResults() {
  const query = searchInput.value;
  const filteredTracks = getFilteredTracks(query);
  const groupedTracks = groupTracks(filteredTracks);

  resultCountEl.textContent = `${filteredTracks.length} risultati`;

  if (!filteredTracks.length) {
    resultsEl.innerHTML = `
      <div class="empty">
        Nessun risultato trovato.
      </div>
    `;
    return;
  }

  resultsEl.innerHTML = groupedTracks
    .slice(0, 150)
    .map(group => {
      if (group.length === 1) {
        return renderSingleCard(group[0]);
      }

      return renderGroupCard(group);
    })
    .join("");

  attachGroupEvents();

  if (groupedTracks.length > 150) {
    resultsEl.innerHTML += `
      <div class="empty">
        Mostrati i primi 150 risultati. Continua a scrivere per restringere la ricerca.
      </div>
    `;
  }
}

/**
 * Card risultato singolo.
 */
function renderSingleCard(track) {
  return `
    <article class="card">
      <h2 class="card-title">${escapeHTML(track["Titolo"])}</h2>
      <div class="card-artist">${escapeHTML(track["Artista"])}</div>

      <div class="folder">Scaffale / Cartella: ${escapeHTML(track["Cartella"])}</div>

      <div class="meta">
        ${track["Album"] ? `<span>${escapeHTML(track["Album"])}</span>` : ""}
        ${track["Anno"] ? `<span>${escapeHTML(track["Anno"])}</span>` : ""}
        ${track["Formato"] ? `<span>${escapeHTML(track["Formato"])}</span>` : ""}
        ${track["Genere"] ? `<span>${escapeHTML(track["Genere"])}</span>` : ""}
      </div>

      ${renderTrackDetails(track)}
    </article>
  `;
}

/**
 * Card gruppo duplicati.
 */
function renderGroupCard(group) {
  const first = group[0];

  return `
    <article class="card group-card">
      <div class="group-header">
        <h2 class="card-title">${escapeHTML(first["Titolo"])}</h2>
        <div class="card-artist">${escapeHTML(first["Artista"])}</div>
        <div class="duplicate-count">Presente in ${group.length} dischi</div>
      </div>

      <div class="versions">
        ${group.map(track => `
          <div class="version">
            <div class="version-title">
              ${escapeHTML(track["Album"] || "Album non indicato")}
            </div>

            <div class="folder">
              ${escapeHTML(track["Cartella"])}
            </div>

            <div class="meta">
              ${track["Anno"] ? `<span>${escapeHTML(track["Anno"])}</span>` : ""}
              ${track["Formato"] ? `<span>${escapeHTML(track["Formato"])}</span>` : ""}
              ${track["Etichetta"] ? `<span>${escapeHTML(track["Etichetta"])}</span>` : ""}
            </div>

            ${renderTrackDetails(track)}
          </div>
        `).join("")}
      </div>
    </article>
  `;
}

/**
 * Menu espandibile con i campi completi del CSV.
 */
function renderTrackDetails(track) {
  const showTrackCredits = !haveSameCreditNames(track["Written By"], track["Crediti Traccia"]);
  const details = [
    ["Posizione", track["Posizione"]],
    ["Durata", track["Durata"]],
    ["Paese", track["Paese"]],
    ["Etichetta", track["Etichetta"]],
    ["Catalogo", track["Catalogo"]],
    ["Stile", track["Stile"]],
    ["Written By", track["Written By"]],
    ["Crediti Traccia", showTrackCredits ? track["Crediti Traccia"] : ""],
    ["Note", track["Note"]]
  ].filter(([, value]) => value);

  const discogsUrl = track["URL Discogs"];

  if (!details.length && !discogsUrl) {
    return "";
  }

  return `
    <details class="track-details">
      <summary>Dettagli</summary>
      <dl>
        ${details.map(([label, value]) => `
          <div>
            <dt>${escapeHTML(label)}</dt>
            <dd>${renderClickableDetailValue(value)}</dd>
          </div>
        `).join("")}
        ${discogsUrl ? `
          <div>
            <dt>Discogs</dt>
            <dd><a href="${escapeHTML(discogsUrl)}" target="_blank" rel="noopener noreferrer">Apri scheda</a></dd>
          </div>
        ` : ""}
      </dl>
    </details>
  `;
}

/**
 * Nasconde i crediti traccia quando ripetono solo gli stessi nomi di Written By.
 */
function haveSameCreditNames(writtenBy, trackCredits) {
  const writtenNames = extractCreditNames(writtenBy);
  const creditNames = extractCreditNames(trackCredits);

  if (!writtenNames.length || !creditNames.length) {
    return false;
  }

  if (writtenNames.length !== creditNames.length) {
    return false;
  }

  return writtenNames.every((name, index) => name === creditNames[index]);
}

function extractCreditNames(value) {
  return String(value || "")
    .split(" | ")
    .map(part => part.replace(/\s*\[[^\]]*\]\s*$/g, "").trim())
    .filter(Boolean)
    .map(normalizeText)
    .sort();
}

/**
 * Rende cliccabili i valori composti dei dettagli.
 * Esempio: "Adriano Celentano | Luciano Beretta" diventa una serie di ricerche rapide.
 */
function renderClickableDetailValue(value) {
  return String(value || "")
    .split(" | ")
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => `
      <button class="detail-search" type="button" data-search="${escapeHTML(part)}">
        ${escapeHTML(part)}
      </button>
    `)
    .join("");
}

/**
 * Click per aprire/chiudere duplicati.
 */
function attachGroupEvents() {
  document.querySelectorAll(".group-card .group-header").forEach(header => {
    header.addEventListener("click", () => {
      const card = header.closest(".group-card");
      card.classList.toggle("open");
    });
  });

  document.querySelectorAll(".detail-search").forEach(button => {
    button.addEventListener("click", event => {
      event.stopPropagation();

      searchInput.value = button.dataset.search;
      renderResults();
      searchInput.focus();
      searchInput.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
}

/**
 * Evita problemi HTML se nel CSV ci sono simboli speciali.
 */
function escapeHTML(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/**
 * Debounce ricerca.
 */
function handleSearchInput() {
  clearTimeout(debounceTimer);

  debounceTimer = setTimeout(() => {
    renderResults();
  }, 120);
}

/**
 * Stato iniziale.
 */
function renderInitialState() {
  resultsEl.innerHTML = `
    <div class="empty">
      Cerca un brano, un artista o un album.
    </div>
  `;
}

/**
 * Eventi filtri.
 */
chips.forEach(chip => {
  chip.addEventListener("click", () => {
    chips.forEach(c => c.classList.remove("active"));
    chip.classList.add("active");

    activeFilter = chip.dataset.filter;
    renderResults();
  });
});

searchInput.addEventListener("input", handleSearchInput);

loadCSV();
