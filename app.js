const CSV_PATH = "data/output.csv";

const searchInput = document.getElementById("searchInput");
const resultsEl = document.getElementById("results");
const resultCountEl = document.getElementById("resultCount");
const exploreButton = document.getElementById("exploreButton");
const qualityButton = document.getElementById("qualityButton");
const statsButton = document.getElementById("statsButton");
const chips = document.querySelectorAll(".chip");
const MAX_COVER_REQUESTS = 5;
const RESULTS_PAGE_SIZE = 5;
const SAMPLE_PASSWORD = "tpiacess";

let tracks = [];
let activeFilter = "all";
let debounceTimer = null;
let visibleResultCount = RESULTS_PAGE_SIZE;
let sampleUnlocked = false;
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
      track["Anno"],
      track["Paese"],
      track["Etichetta"],
      track["Formato"],
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

  if (activeFilter === "sample") {
    filtered = filtered.filter(track => {
      return normalizeText(track["Note"]).includes("sample");
    });
  } else if (activeFilter !== "all") {
    filtered = filtered.filter(track => {
      return track._speed === activeFilter;
    });
  }

  if (normalizedQuery === "__missing_duration") {
    filtered = filtered.filter(track => !String(track["Durata"] || "").trim());
  } else if (normalizedQuery === "__missing_year") {
    filtered = filtered.filter(track => !Number(track["Anno"]));
  } else if (normalizedQuery === "__missing_title") {
    filtered = filtered.filter(track => !String(track["Titolo"] || "").trim());
  } else if (normalizedQuery === "__missing_position") {
    filtered = filtered.filter(track => !String(track["Posizione"] || "").trim());
  } else if (normalizedQuery === "__missing_written_by") {
    filtered = filtered.filter(track => !String(track["Written By"] || "").trim());
  } else if (normalizedQuery === "__suspicious_duplicates") {
    const duplicateKeys = getSuspiciousDuplicateKeys();
    filtered = filtered.filter(track => duplicateKeys.has(getSuspiciousDuplicateKey(track)));
  } else if (normalizedQuery) {
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
  if (activeFilter === "quality") {
    renderQualityDashboard();
    return;
  }

  if (activeFilter === "explore") {
    renderExploreDashboard();
    return;
  }

  if (activeFilter === "stats") {
    renderStatsDashboard();
    return;
  }

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

function renderStatsDashboard() {
  const stats = getCollectionStats();

  resultCountEl.textContent = "Statistiche collezione";
  resultsEl.innerHTML = `
    <section class="stats-grid">
      ${renderStatCard("Brani caricati", formatNumber(stats.trackCount))}
      ${renderStatCard("Dischi", formatNumber(stats.recordCount))}
      ${renderStatCard("Scaffali", formatNumber(stats.folderCount))}
      ${renderStatCard("Artista più presente", stats.topArtist.label, `${stats.topArtist.count} brani`)}
      ${renderStatCard("Genere più presente", stats.topGenre.label, `${stats.topGenre.count} brani`)}
      ${renderStatCard("Decade più rappresentata", stats.topDecade.label, `${stats.topDecade.count} brani`)}
      ${renderStatCard("Etichetta più frequente", stats.topLabel.label, `${stats.topLabel.count} brani`)}
    </section>
  `;
}

function renderExploreDashboard() {
  const groups = getExploreGroups();

  resultCountEl.textContent = "Esplora collezione";
  resultsEl.innerHTML = `
    <section class="explore">
      ${groups.map(group => `
        <article class="explore-section">
          <h2>${escapeHTML(group.label)}</h2>
          <div class="explore-chips">
            ${group.items.map(item => `
              <button class="explore-chip" type="button" data-search="${escapeHTML(item.search)}">
                ${escapeHTML(item.label)}
                <span>${item.count}</span>
              </button>
            `).join("")}
          </div>
        </article>
      `).join("")}
    </section>
  `;
}

function renderQualityDashboard() {
  const issues = getDataQualityIssues();

  resultCountEl.textContent = "Qualità dati";
  resultsEl.innerHTML = `
    <section class="quality">
      ${issues.map(issue => `
        <article class="quality-card ${issue.count ? "" : "is-ok"}">
          <div>
            <h2>${escapeHTML(issue.label)}</h2>
            <p>${escapeHTML(issue.description)}</p>
          </div>
          <button class="quality-action" type="button" data-search="${escapeHTML(issue.search)}" ${issue.count ? "" : "disabled"}>
            ${issue.count}
          </button>
        </article>
      `).join("")}
    </section>
  `;
}

function getDataQualityIssues() {
  const duplicateKeys = getSuspiciousDuplicateKeys();

  return [
    {
      label: "Brani senza titolo",
      description: "Righe prive del titolo del brano.",
      search: "__missing_title",
      count: countMissing(track => track["Titolo"])
    },
    {
      label: "Anno = 0",
      description: "Dischi o brani con anno assente o impostato a zero.",
      search: "__missing_year",
      count: countMissing(track => track["Anno"])
    },
    {
      label: "Posizione mancante",
      description: "Tracce senza lato/numero, per esempio A1 o B2.",
      search: "__missing_position",
      count: countMissing(track => track["Posizione"])
    },
    {
      label: "Durata mancante",
      description: "Brani senza durata indicata.",
      search: "__missing_duration",
      count: countMissing(track => track["Durata"])
    },
    {
      label: "Written By mancante",
      description: "Brani senza autori/compositori.",
      search: "__missing_written_by",
      count: countMissing(track => track["Written By"])
    },
    {
      label: "Doppioni sospetti",
      description: "Stesso artista, titolo e album presenti più volte.",
      search: "__suspicious_duplicates",
      count: tracks.filter(track => duplicateKeys.has(getSuspiciousDuplicateKey(track))).length
    }
  ];
}

function getExploreGroups() {
  return [
    {
      label: "Generi più presenti",
      items: getTopExploreItems(track => splitValues(track["Genere"]))
    },
    {
      label: "Stili più presenti",
      items: getTopExploreItems(track => splitValues(track["Stile"]))
    },
    {
      label: "Anni",
      items: getTopExploreItems(track => [track["Anno"]].filter(Boolean))
    },
    {
      label: "Paesi",
      items: getTopExploreItems(track => [track["Paese"]].filter(Boolean))
    },
    {
      label: "Etichette",
      items: getTopExploreItems(track => splitValues(track["Etichetta"]))
    },
    {
      label: "Scaffali",
      items: getTopExploreItems(track => [track["Cartella"]].filter(Boolean))
    },
    {
      label: "Ricerche rapide",
      items: [
        { label: "Brani senza durata", search: "__missing_duration", count: countMissing(track => track["Durata"]) },
        { label: "Dischi senza anno", search: "__missing_year", count: countMissing(track => track["Anno"]) }
      ].filter(item => item.count)
    }
  ].filter(group => group.items.length);
}

function getTopExploreItems(getValues, limit = 12) {
  const counts = new Map();

  tracks.forEach(track => {
    getValues(track).forEach(value => {
      const label = String(value || "").trim();
      if (!label || label === "0") return;

      counts.set(label, (counts.get(label) || 0) + 1);
    });
  });

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([label, count]) => ({
      label,
      search: label,
      count
    }));
}

function getCollectionStats() {
  return {
    trackCount: tracks.length,
    recordCount: countUnique(tracks, getAlbumKey),
    folderCount: countUnique(tracks, track => track["Cartella"]),
    topArtist: getMostFrequent(tracks, getStatsArtist),
    topGenre: getMostFrequent(tracks, track => splitFirstValue(track["Genere"])),
    topDecade: getMostFrequent(tracks, getDecade),
    topLabel: getMostFrequent(tracks, track => splitFirstValue(track["Etichetta"]))
  };
}

function renderStatCard(label, value, detail = "") {
  return `
    <article class="stat-card">
      <div class="stat-label">${escapeHTML(label)}</div>
      <div class="stat-value">${escapeHTML(value || "Non indicato")}</div>
      ${detail ? `<div class="stat-detail">${escapeHTML(detail)}</div>` : ""}
    </article>
  `;
}

function countUnique(items, getValue) {
  const values = new Set();

  items.forEach(item => {
    const value = normalizeText(getValue(item));
    if (value) values.add(value);
  });

  return values.size;
}

function getMostFrequent(items, getValue) {
  const counts = new Map();

  items.forEach(item => {
    const value = String(getValue(item) || "").trim();
    if (!value) return;

    counts.set(value, (counts.get(value) || 0) + 1);
  });

  let top = { label: "", count: 0 };

  counts.forEach((count, label) => {
    if (count > top.count) {
      top = { label, count };
    }
  });

  return top;
}

function splitFirstValue(value) {
  return String(value || "").split(",")[0].trim();
}

function splitValues(value) {
  return String(value || "")
    .split(",")
    .map(part => part.trim())
    .filter(Boolean);
}

function countMissing(getValue) {
  return tracks.filter(track => {
    const value = String(getValue(track) || "").trim();
    return !value || value === "0";
  }).length;
}

function getSuspiciousDuplicateKeys() {
  const counts = new Map();

  tracks.forEach(track => {
    const key = getSuspiciousDuplicateKey(track);
    if (!key) return;

    counts.set(key, (counts.get(key) || 0) + 1);
  });

  const duplicateKeys = new Set();

  counts.forEach((count, key) => {
    if (count > 1) {
      duplicateKeys.add(key);
    }
  });

  return duplicateKeys;
}

function getSuspiciousDuplicateKey(track) {
  const title = normalizeText(track["Titolo"]);
  const artist = normalizeText(track["Artista"]);
  const album = normalizeText(track["Album"]);

  if (!title || !artist || !album) {
    return "";
  }

  return `${title}|${artist}|${album}`;
}

function getStatsArtist(track) {
  const artist = String(track["Artista"] || "").trim();

  if (normalizeText(artist) === "various") {
    return "";
  }

  return artist;
}

function getDecade(track) {
  const year = Number(track["Anno"]);

  if (!year) {
    return "";
  }

  return `${Math.floor(year / 10) * 10}s`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("it-IT").format(value);
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
  const qualityAction = event.target.closest(".quality-action");

  if (qualityAction && !qualityAction.disabled) {
    searchInput.value = qualityAction.dataset.search;
    setActiveFilter("all");
    visibleResultCount = RESULTS_PAGE_SIZE;
    renderResults();
    searchInput.focus();
    searchInput.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

  const exploreChip = event.target.closest(".explore-chip");

  if (exploreChip) {
    searchInput.value = exploreChip.dataset.search;
    setActiveFilter("all");
    visibleResultCount = RESULTS_PAGE_SIZE;
    renderResults();
    searchInput.focus();
    searchInput.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }

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
    if (activeFilter === "stats" || activeFilter === "explore" || activeFilter === "quality") {
      setActiveFilter("all");
    }

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
    if (chip.dataset.filter === "sample" && !unlockSampleFilter()) {
      return;
    }

    setActiveFilter(chip.dataset.filter);
    visibleResultCount = RESULTS_PAGE_SIZE;
    renderResults();
  });
});

function setActiveFilter(filter) {
  activeFilter = filter;

  chips.forEach(chip => {
    chip.classList.toggle("active", chip.dataset.filter === filter);
  });

  statsButton.classList.toggle("active", filter === "stats");
  exploreButton.classList.toggle("active", filter === "explore");
  qualityButton.classList.toggle("active", filter === "quality");
}

function unlockSampleFilter() {
  if (sampleUnlocked) {
    return true;
  }

  const password = window.prompt("Password per accedere ai Sample");

  if (password === SAMPLE_PASSWORD) {
    sampleUnlocked = true;
    return true;
  }

  if (password !== null) {
    window.alert("Password non corretta");
  }

  return false;
}

searchInput.addEventListener("input", handleSearchInput);
resultsEl.addEventListener("click", handleResultsClick);
exploreButton.addEventListener("click", () => {
  setActiveFilter("explore");
  visibleResultCount = RESULTS_PAGE_SIZE;
  renderResults();
});
qualityButton.addEventListener("click", () => {
  setActiveFilter("quality");
  visibleResultCount = RESULTS_PAGE_SIZE;
  renderResults();
});
statsButton.addEventListener("click", () => {
  setActiveFilter("stats");
  visibleResultCount = RESULTS_PAGE_SIZE;
  renderResults();
});

loadCSV();
focusSearchInput();

function focusSearchInput() {
  searchInput.focus();
  setTimeout(() => searchInput.focus(), 0);
}
