/*
 * app.js — Nifty Option Chain frontend
 *
 * >>> FILL THIS IN once fetch_option_chain.py has run once and you can
 * see the real column names in data/latest.json <<<
 *
 * COLUMNS maps this app's concept of each field to the exact column
 * header pandas.read_html gave that column (same header text as the
 * table on the Moneycontrol page). Open data/latest.json after the
 * first successful run, copy the header strings you see, and paste
 * them in below — nothing else in this file needs to change.
 */
 
const COLUMNS = {
  strike: "Strike  Price",
  callOI: "OI",
  callChgOI: "OI  Change",
  callVol: "Volume",
  callLTP: "LTP",
  putLTP: "LTP.1",
  putVol: "Volume.1",
  putChgOI: "OI  Change.1",
  putOI: "OI.1",
};

const DATA_URL = "data/latest.json";
const HISTORY_INDEX_URL = "data/history/index.json";
const HISTORY_FILE = (date) => `data/history/${date}.jsonl`;

let liveTimer = null;

async function fetchJSON(url) {
  const res = await fetch(`${url}?_=${Date.now()}`); // cache-bust
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isNaN(n) ? null : n;
}

function computeATMIndex(rows) {
  let bestIdx = -1;
  let bestDiff = Infinity;
  rows.forEach((r, i) => {
    const c = num(r[COLUMNS.callLTP]);
    const p = num(r[COLUMNS.putLTP]);
    if (c === null || p === null) return;
    const diff = Math.abs(c - p);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  });
  return bestIdx;
}

function computePCR(rows) {
  let callSum = 0, putSum = 0;
  rows.forEach((r) => {
    callSum += num(r[COLUMNS.callOI]) || 0;
    putSum += num(r[COLUMNS.putOI]) || 0;
  });
  if (!callSum) return null;
  return (putSum / callSum).toFixed(2);
}

function setFreshness(fetchedAtIso) {
  const dot = document.getElementById("pulseDot");
  const label = document.getElementById("updatedValue");
  if (!fetchedAtIso) {
    dot.className = "pulse-dot dead";
    label.textContent = "—";
    return;
  }
  const fetchedAt = new Date(fetchedAtIso);
  const ageMin = (Date.now() - fetchedAt.getTime()) / 60000;
  dot.className = "pulse-dot " + (ageMin < 10 ? "fresh" : ageMin < 45 ? "stale" : "dead");
  label.textContent = fetchedAt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

function renderTable(rows, atmIdx, strikeRange) {
  const tbody = document.getElementById("chainBody");
  tbody.innerHTML = "";

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">No rows in this snapshot.</td></tr>`;
    return;
  }

  let visible = rows;
  if (strikeRange > 0 && atmIdx >= 0) {
    const lo = Math.max(0, atmIdx - strikeRange);
    const hi = Math.min(rows.length, atmIdx + strikeRange + 1);
    visible = rows.slice(lo, hi);
  }

  const maxCallOI = Math.max(...rows.map((r) => num(r[COLUMNS.callOI]) || 0), 1);
  const maxPutOI = Math.max(...rows.map((r) => num(r[COLUMNS.putOI]) || 0), 1);

  visible.forEach((r) => {
    const isAtm = rows.indexOf(r) === atmIdx;
    const callOI = num(r[COLUMNS.callOI]);
    const putOI = num(r[COLUMNS.putOI]);
    const callPct = callOI ? Math.min(100, (callOI / maxCallOI) * 100) : 0;
    const putPct = putOI ? Math.min(100, (putOI / maxPutOI) * 100) : 0;

    const tr = document.createElement("tr");
    if (isAtm) tr.className = "atm-row";
    tr.innerHTML = `
      <td><span class="oi-bar call" style="width:${callPct}%"></span><span class="cell-value">${fmt(callOI)}</span></td>
      <td><span class="cell-value">${fmt(num(r[COLUMNS.callChgOI]))}</span></td>
      <td><span class="cell-value">${fmt(num(r[COLUMNS.callVol]))}</span></td>
      <td><span class="cell-value">${fmt(num(r[COLUMNS.callLTP]))}</span></td>
      <td class="strike-cell">${fmt(num(r[COLUMNS.strike]))}</td>
      <td><span class="cell-value">${fmt(num(r[COLUMNS.putLTP]))}</span></td>
      <td><span class="cell-value">${fmt(num(r[COLUMNS.putVol]))}</span></td>
      <td><span class="cell-value">${fmt(num(r[COLUMNS.putChgOI]))}</span></td>
      <td><span class="oi-bar put" style="width:${putPct}%"></span><span class="cell-value">${fmt(putOI)}</span></td>
    `;
    tbody.appendChild(tr);
  });
}

function fmt(n) {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-IN");
}

function currentStrikeRange() {
  return Number(document.getElementById("strikeRange").value);
}

function renderPayload(payload) {
  const rows = payload.rows || [];
  const atmIdx = computeATMIndex(rows);
  document.getElementById("atmValue").textContent = atmIdx >= 0 ? fmt(num(rows[atmIdx][COLUMNS.strike])) : "—";
  document.getElementById("pcrValue").textContent = computePCR(rows) ?? "—";
  document.getElementById("spotValue").textContent = payload.spot ? fmt(num(payload.spot)) : "≈ ATM";
  setFreshness(payload.fetched_at_ist);
  renderTable(rows, atmIdx, currentStrikeRange());
}

async function loadLive() {
  try {
    const payload = await fetchJSON(DATA_URL);
    renderPayload(payload);
  } catch (e) {
    console.error("Failed to load live data", e);
  }
}

async function populateHistoryDropdown() {
  try {
    const idx = await fetchJSON(HISTORY_INDEX_URL);
    const select = document.getElementById("historyDate");
    (idx.dates || []).slice().reverse().forEach((d) => {
      const opt = document.createElement("option");
      opt.value = d;
      opt.textContent = d;
      select.appendChild(opt);
    });
  } catch (e) {
    // history index may not exist yet on first run — that's fine
  }
}

async function loadHistoryDay(date) {
  const text = await (await fetch(HISTORY_FILE(date))).text();
  const snapshots = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (!snapshots.length) return;
  // Show the most recent snapshot for that day; each line is one fetch.
  renderPayload(snapshots[snapshots.length - 1]);
}

function initControls() {
  document.getElementById("strikeRange").addEventListener("change", loadLive);
  document.getElementById("historyDate").addEventListener("change", (e) => {
    if (liveTimer) clearInterval(liveTimer);
    if (e.target.value === "") {
      loadLive();
      liveTimer = setInterval(loadLive, 60_000);
    } else {
      loadHistoryDay(e.target.value);
    }
  });
}

(async function init() {
  initControls();
  await populateHistoryDropdown();
  await loadLive();
  liveTimer = setInterval(loadLive, 60_000); // frontend polls every minute; actual data cadence is set by the GitHub Action
})();
