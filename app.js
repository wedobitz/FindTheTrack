const CSV_PATH = "data/output.csv";

const searchInput = document.getElementById("searchInput");
const resultsEl = document.getElementById("results");
const resultCountEl = document.getElementById("resultCount");
const chips = document.querySelectorAll(".chip");
const MAX_COVER_REQUESTS = 5;
const RESULTS_PAGE_SIZE = 5;

let tracks = [];
let activeFilter = "all";
let debounceTimer = null;
let visibleResultCount = RESULTS_PAGE_SIZE;
let coverCache = loadCoverCache();
let coverQueue = [];
let activeCoverRequests = 0;
const queuedCoverIds = new Set();
const unavailableCoverIds = new Set();

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
      track["Artista Album"],
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
 * Costruisce i blocchi risultato.
 * Più tracce dello stesso disco diventano una card album espandibile.
 */
function buildResultItems(filteredTracks) {
  const albumGroups = new Map();

  filteredTracks.forEach((track, index) => {
    const key = getAlbumKey(track);

    if (!albumGroups.has(key)) {
      albumGroups.set(key, {
        firstIndex: index,
        tracks: []
      });
    }

    albumGroups.get(key).tracks.push(track);
  });

  const albumItems = [];
  const singleTracks = [];

  albumGroups.forEach(group => {
    if (group.tracks.length > 1) {
      albumItems.push({
        type: "album",
        firstIndex: group.firstIndex,
        tracks: group.tracks
      });
      return;
    }

    singleTracks.push({
      firstIndex: group.firstIndex,
      track: group.tracks[0]
    });
  });

  return albumItems
    .concat(buildSingleResultItems(singleTracks))
    .sort((a, b) => a.firstIndex - b.firstIndex);
}

function getAlbumKey(track) {
  return [
    track["URL Discogs"],
    track["Catalogo"],
    track["Album"],
    track["Artista Album"] || track["Artista"],
    track["Cartella"]
  ].map(normalizeText).join("|");
}

function buildSingleResultItems(singleTracks) {
  const groups = new Map();

  singleTracks.forEach(({ firstIndex, track }) => {
    const key = track._groupKey;

    if (!groups.has(key)) {
      groups.set(key, {
        type: "group",
        firstIndex,
        tracks: []
      });
    }

    groups.get(key).tracks.push(track);
  });

  return Array.from(groups.values());
}

/**
 * Rendering principale.
 */
function renderResults() {
  const query = searchInput.value;
  const filteredTracks = getFilteredTracks(query);
  const resultItems = buildResultItems(filteredTracks);
  const visibleItems = resultItems.slice(0, visibleResultCount);
  const hasMoreResults = resultItems.length > visibleResultCount;

  resultCountEl.textContent = `${filteredTracks.length} risultati`;

  if (!filteredTracks.length) {
    resultsEl.innerHTML = `
      <div class="empty">
        Nessun risultato trovato.
      </div>
    `;
    return;
  }

  resultsEl.innerHTML = resultItems
    .slice(0, visibleResultCount)
    .map(item => {
      if (item.type === "album") {
        return renderAlbumCard(item.tracks);
      }

      if (item.tracks.length === 1) {
        return renderSingleCard(item.tracks[0]);
      }

      return renderGroupCard(item.tracks);
    })
    .join("") + renderLoadMoreButton(hasMoreResults, resultItems.length, visibleItems.length);

  loadVisibleAlbumCovers();
}

function renderLoadMoreButton(hasMoreResults, totalItems, visibleItems) {
  if (!hasMoreResults) {
    return "";
  }

  return `
    <button class="load-more" type="button">
      Altri risultati
      <span>${visibleItems} di ${totalItems}</span>
    </button>
  `;
}

/**
 * Card album espandibile.
 */
function renderAlbumCard(tracks) {
  const first = tracks[0];
  const albumArtist = first["Artista Album"] || first["Artista"];
  const releaseId = getDiscogsReleaseId(first);
  const coverUrl = coverCache[releaseId];

  return `
    <article class="card album-card">
      <div class="album-header ${releaseId ? "" : "no-cover"}">
        <div class="album-main">
          <h2 class="card-title">${escapeHTML(first["Album"] || "Album non indicato")}</h2>
          <div class="card-artist">${escapeHTML(albumArtist)}</div>

          <div class="folder">Scaffale: ${escapeHTML(first["Cartella"])}</div>

          <div class="meta">
            <span>${tracks.length} brani trovati</span>
            ${first["Anno"] ? `<span>${escapeHTML(first["Anno"])}</span>` : ""}
            ${first["Formato"] ? `<span>${escapeHTML(first["Formato"])}</span>` : ""}
            ${first["Genere"] ? `<span>${escapeHTML(first["Genere"])}</span>` : ""}
          </div>
        </div>

        ${releaseId ? `
          <div class="album-cover ${coverUrl ? "loaded" : ""}" data-release-id="${escapeHTML(releaseId)}">
            ${coverUrl ? `<img src="${escapeHTML(coverUrl)}" alt="">` : ""}
          </div>
        ` : ""}
      </div>

      <div class="album-tracks">
        ${tracks.map(track => renderSingleCard(track)).join("")}
      </div>
    </article>
  `;
}

function getDiscogsReleaseId(track) {
  const match = String(track["URL Discogs"] || "").match(/\/release\/(\d+)/);
  return match ? match[1] : "";
}

function loadCoverCache() {
  try {
    return JSON.parse(localStorage.getItem("albumCoverCache") || "{}");
  } catch {
    return {};
  }
}

function saveCoverCache() {
  try {
    localStorage.setItem("albumCoverCache", JSON.stringify(coverCache));
  } catch {
    // La cache immagini è un bonus: se il browser la blocca, l'app continua a funzionare.
  }
}

function loadVisibleAlbumCovers() {
  document.querySelectorAll(".album-cover[data-release-id]").forEach(cover => {
    const releaseId = cover.dataset.releaseId;

    if (!releaseId || cover.querySelector("img") || unavailableCoverIds.has(releaseId)) {
      return;
    }

    if (coverCache[releaseId]) {
      setAlbumCoverImage(cover, coverCache[releaseId]);
      return;
    }

    queueAlbumCover(releaseId);
  });

  processCoverQueue();
}

function queueAlbumCover(releaseId) {
  if (queuedCoverIds.has(releaseId)) {
    return;
  }

  queuedCoverIds.add(releaseId);
  coverQueue.push(releaseId);
}

function processCoverQueue() {
  while (activeCoverRequests < MAX_COVER_REQUESTS && coverQueue.length) {
    const releaseId = coverQueue.shift();
    activeCoverRequests++;

    fetchDiscogsCover(releaseId)
      .then(url => {
        if (url) {
          coverCache[releaseId] = url;
          saveCoverCache();
          updateAlbumCoverElements(releaseId, url);
          return;
        }

        unavailableCoverIds.add(releaseId);
        updateUnavailableCoverElements(releaseId);
      })
      .catch(() => {
        unavailableCoverIds.add(releaseId);
        updateUnavailableCoverElements(releaseId);
      })
      .finally(() => {
        activeCoverRequests--;
        processCoverQueue();
      });
  }
}

function updateAlbumCoverElements(releaseId, url) {
  document
    .querySelectorAll(`.album-cover[data-release-id="${releaseId}"]`)
    .forEach(cover => setAlbumCoverImage(cover, url));
}

function updateUnavailableCoverElements(releaseId) {
  document
    .querySelectorAll(`.album-cover[data-release-id="${releaseId}"]`)
    .forEach(cover => cover.classList.add("unavailable"));
}

async function fetchDiscogsCover(releaseId) {
  const response = await fetch(`https://api.discogs.com/releases/${releaseId}`);

  if (!response.ok) {
    return "";
  }

  const release = await response.json();
  const primaryImage = release.images?.find(image => image.type === "primary");
  return primaryImage?.uri150 || release.thumb || release.images?.[0]?.uri150 || "";
}

function setAlbumCoverImage(cover, url) {
  cover.classList.add("loaded");
  cover.innerHTML = `<img src="${escapeHTML(url)}" alt="">`;
}

/**
 * Card risultato singolo.
 */
function renderSingleCard(track) {
  return `
    <article class="card">
      <h2 class="card-title">${escapeHTML(track["Titolo"])}</h2>
      <div class="card-artist">${escapeHTML(track["Artista"])}</div>

      <div class="folder">Scaffale: ${escapeHTML(track["Cartella"])}</div>

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
    ["Artista Album", hasDifferentAlbumArtist(track) ? track["Artista Album"] : ""],
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

function hasDifferentAlbumArtist(track) {
  return track["Artista Album"] && normalizeText(track["Artista Album"]) !== normalizeText(track["Artista"]);
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
 * Click delegati sui risultati: restano validi dopo ogni ricerca o cambio tab.
 */
function handleResultsClick(event) {
  const detailSearch = event.target.closest(".detail-search");

  if (detailSearch) {
    event.stopPropagation();

    searchInput.value = detailSearch.dataset.search;
    renderResults();
    searchInput.focus();
    searchInput.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  const albumHeader = event.target.closest(".album-card .album-header");

  if (albumHeader) {
    const card = albumHeader.closest(".album-card");
    card.classList.toggle("open");
    return;
  }

  const groupHeader = event.target.closest(".group-card .group-header");

  if (groupHeader) {
    const card = groupHeader.closest(".group-card");
    card.classList.toggle("open");
    return;
  }

  const loadMoreButton = event.target.closest(".load-more");

  if (loadMoreButton) {
    visibleResultCount += RESULTS_PAGE_SIZE;
    renderResults();
  }
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
    visibleResultCount = RESULTS_PAGE_SIZE;
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
    visibleResultCount = RESULTS_PAGE_SIZE;
    renderResults();
  });
});

searchInput.addEventListener("input", handleSearchInput);
resultsEl.addEventListener("click", handleResultsClick);

loadCSV();
focusSearchInput();

function focusSearchInput() {
  searchInput.focus();
  setTimeout(() => searchInput.focus(), 0);
}
