/*
 * app.js — Nifty Option Chain frontend
 *
 * COLUMNS maps this app's concept of each field to the exact column
 * header pandas.read_html produced (note the double spaces in some
 * headers — copied exactly from data/latest.json).
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
let currentDaySnapshots = []; // loaded when a replay date is picked
let visibleCols = { oi: true, chgoi: true, vol: true, ltp: true };

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

// % change in OI = chg / previousOI * 100, where previousOI = OI - chg
function pctChg(oi, chg) {
  if (oi === null || chg === null) return null;
  const prev = oi - chg;
  if (!prev) return null;
  return (chg / prev) * 100;
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

function fmt(n) {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-IN");
}

// Indian lakh/crore compact format — used for OI and Volume, which run into
// large magnitudes. LTP and percentages stay as plain numbers via fmt()/fmtPct().
function fmtCompact(n) {
  if (n === null || n === undefined) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${sign}${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}${(abs / 1e5).toFixed(2)} L`;
  return fmt(n);
}

function fmtPct(n) {
  if (n === null || n === undefined) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

function currentStrikeRange() {
  return Number(document.getElementById("strikeRange").value);
}

function visibleRows(rows, atmIdx, strikeRange) {
  if (strikeRange > 0 && atmIdx >= 0) {
    const lo = Math.max(0, atmIdx - strikeRange);
    const hi = Math.min(rows.length, atmIdx + strikeRange + 1);
    return rows.slice(lo, hi);
  }
  return rows;
}

function renderTable(rows, atmIdx, strikeRange) {
  const tbody = document.getElementById("chainBody");
  tbody.innerHTML = "";

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">No rows in this snapshot.</td></tr>`;
    return;
  }

  const visible = visibleRows(rows, atmIdx, strikeRange);
  const maxCallOI = Math.max(...rows.map((r) => num(r[COLUMNS.callOI]) || 0), 1);
  const maxPutOI = Math.max(...rows.map((r) => num(r[COLUMNS.putOI]) || 0), 1);

  visible.forEach((r) => {
    const isAtm = rows.indexOf(r) === atmIdx;
    const callOI = num(r[COLUMNS.callOI]);
    const putOI = num(r[COLUMNS.putOI]);
    const callChgPct = pctChg(callOI, num(r[COLUMNS.callChgOI]));
    const putChgPct = pctChg(putOI, num(r[COLUMNS.putChgOI]));
    const callPct = callOI ? Math.min(100, (callOI / maxCallOI) * 100) : 0;
    const putPct = putOI ? Math.min(100, (putOI / maxPutOI) * 100) : 0;

    const tr = document.createElement("tr");
    if (isAtm) tr.className = "atm-row";
    tr.innerHTML = `
      <td class="col-oi"><span class="oi-bar call" style="width:${callPct}%"></span><span class="cell-value">${fmtCompact(callOI)}</span></td>
      <td class="col-chgoi"><span class="cell-value">${fmtPct(callChgPct)}</span></td>
      <td class="col-vol"><span class="cell-value">${fmtCompact(num(r[COLUMNS.callVol]))}</span></td>
      <td class="col-ltp"><span class="cell-value">${fmt(num(r[COLUMNS.callLTP]))}</span></td>
      <td class="strike-cell">${fmt(num(r[COLUMNS.strike]))}</td>
      <td class="col-ltp"><span class="cell-value">${fmt(num(r[COLUMNS.putLTP]))}</span></td>
      <td class="col-vol"><span class="cell-value">${fmtCompact(num(r[COLUMNS.putVol]))}</span></td>
      <td class="col-chgoi"><span class="cell-value">${fmtPct(putChgPct)}</span></td>
      <td class="col-oi"><span class="oi-bar put" style="width:${putPct}%"></span><span class="cell-value">${fmtCompact(putOI)}</span></td>
    `;
    tbody.appendChild(tr);
  });

  applyColumnVisibility();
}

// ---- mirrored bar charts (calls left, puts right, strike centered) ----
function renderMirrorChart(containerId, rows, atmIdx, strikeRange, callKey, putKey, formatter) {
  const container = document.getElementById(containerId);
  const visible = visibleRows(rows, atmIdx, strikeRange);
  if (!visible.length) {
    container.innerHTML = `<div class="empty-state">No data.</div>`;
    return;
  }

  const maxAbs = Math.max(
    ...visible.map((r) => Math.abs(num(r[callKey]) || 0)),
    ...visible.map((r) => Math.abs(num(r[putKey]) || 0)),
    1
  );

  container.innerHTML = visible
    .map((r) => {
      const strike = fmt(num(r[COLUMNS.strike]));
      const callVal = num(r[callKey]) || 0;
      const putVal = num(r[putKey]) || 0;
      const callWidth = Math.min(100, (Math.abs(callVal) / maxAbs) * 100);
      const putWidth = Math.min(100, (Math.abs(putVal) / maxAbs) * 100);
      const callNeg = callVal < 0 ? "negative" : "";
      const putNeg = putVal < 0 ? "negative" : "";
      return `
        <div class="chart-row">
          <div class="chart-side call">
            <span class="chart-value">${formatter(callVal)}</span>
            <div class="chart-bar call ${callNeg}" style="width:${callWidth}%"></div>
          </div>
          <div class="chart-strike">${strike}</div>
          <div class="chart-side put">
            <div class="chart-bar put ${putNeg}" style="width:${putWidth}%"></div>
            <span class="chart-value">${formatter(putVal)}</span>
          </div>
        </div>`;
    })
    .join("");
}

function renderCharts(rows, atmIdx, strikeRange) {
  renderMirrorChart("oiChart", rows, atmIdx, strikeRange, COLUMNS.callOI, COLUMNS.putOI, fmtCompact);
  renderMirrorChart("chgOiChart", rows, atmIdx, strikeRange, COLUMNS.callChgOI, COLUMNS.putChgOI, fmtCompact);
}

// ---- analysis: support/resistance, max pain, fresh OI buildup ----
const NEAR_ATM_WINDOW = 4; // how many strikes out from ATM counts as "near"

function computeSupportResistance(rows, atmIdx) {
  let overallResistance = null, overallSupport = null;
  let maxCallOI = -1, maxPutOI = -1;
  let nearResistance = null, nearSupport = null;
  let nearCallOI = -1, nearPutOI = -1;

  rows.forEach((r, i) => {
    const strike = num(r[COLUMNS.strike]);
    const callOI = num(r[COLUMNS.callOI]) || 0;
    const putOI = num(r[COLUMNS.putOI]) || 0;
    if (strike === null) return;

    if (callOI > maxCallOI) { maxCallOI = callOI; overallResistance = { strike, oi: callOI }; }
    if (putOI > maxPutOI) { maxPutOI = putOI; overallSupport = { strike, oi: putOI }; }

    // near-ATM window: resistance from strikes at/above ATM, support from strikes at/below ATM,
    // both capped to NEAR_ATM_WINDOW steps away so a far-away wall doesn't get called "near"
    if (i >= atmIdx && i <= atmIdx + NEAR_ATM_WINDOW && callOI > nearCallOI) {
      nearCallOI = callOI; nearResistance = { strike, oi: callOI };
    }
    if (i <= atmIdx && i >= atmIdx - NEAR_ATM_WINDOW && putOI > nearPutOI) {
      nearPutOI = putOI; nearSupport = { strike, oi: putOI };
    }
  });

  return { nearResistance, nearSupport, overallResistance, overallSupport };
}

function computeMaxPain(rows) {
  const strikes = rows.map((r) => num(r[COLUMNS.strike])).filter((s) => s !== null);
  let minPain = Infinity, maxPainStrike = null;

  strikes.forEach((K) => {
    let pain = 0;
    rows.forEach((r) => {
      const S = num(r[COLUMNS.strike]);
      if (S === null) return;
      const callOI = num(r[COLUMNS.callOI]) || 0;
      const putOI = num(r[COLUMNS.putOI]) || 0;
      if (K > S) pain += (K - S) * callOI;
      if (S > K) pain += (S - K) * putOI;
    });
    if (pain < minPain) { minPain = pain; maxPainStrike = K; }
  });

  return maxPainStrike;
}

function computeTopBuildup(rows) {
  let topCall = null, topPut = null;
  rows.forEach((r) => {
    const strike = num(r[COLUMNS.strike]);
    if (strike === null) return;
    const callChg = num(r[COLUMNS.callChgOI]) || 0;
    const putChg = num(r[COLUMNS.putChgOI]) || 0;
    if (!topCall || callChg > topCall.chg) topCall = { strike, chg: callChg };
    if (!topPut || putChg > topPut.chg) topPut = { strike, chg: putChg };
  });
  return { topCall, topPut };
}

function statCard(label, value, sub, cls) {
  return `
    <div class="stat-card">
      <span class="stat-label">${label}</span>
      <span class="stat-value ${cls || ""}">${value}</span>
      ${sub ? `<span class="stat-sub">${sub}</span>` : ""}
    </div>`;
}

function renderAnalysis(rows, atmIdx) {
  const container = document.getElementById("analysisPanel");
  if (!rows.length || atmIdx < 0) {
    container.innerHTML = `<div class="empty-state">Not enough data yet.</div>`;
    return;
  }

  const { nearResistance, nearSupport, overallResistance, overallSupport } = computeSupportResistance(rows, atmIdx);
  const maxPain = computeMaxPain(rows);
  const { topCall, topPut } = computeTopBuildup(rows);

  const cards = [
    statCard("Resistance (near ATM)", nearResistance ? fmt(nearResistance.strike) : "—",
      nearResistance ? `Call OI ${fmtCompact(nearResistance.oi)}` : "", "call"),
    statCard("Support (near ATM)", nearSupport ? fmt(nearSupport.strike) : "—",
      nearSupport ? `Put OI ${fmtCompact(nearSupport.oi)}` : "", "put"),
    statCard("Strongest Resistance", overallResistance ? fmt(overallResistance.strike) : "—",
      overallResistance ? `Call OI ${fmtCompact(overallResistance.oi)}` : "", "call"),
    statCard("Strongest Support", overallSupport ? fmt(overallSupport.strike) : "—",
      overallSupport ? `Put OI ${fmtCompact(overallSupport.oi)}` : "", "put"),
    statCard("Max Pain", maxPain !== null ? fmt(maxPain) : "—",
      "Where writers' payout is lowest", "atm"),
    statCard("Fresh Call Writing", topCall ? fmt(topCall.strike) : "—",
      topCall ? `+${fmtCompact(topCall.chg)} OI added` : "", "call"),
    statCard("Fresh Put Writing", topPut ? fmt(topPut.strike) : "—",
      topPut ? `+${fmtCompact(topPut.chg)} OI added` : "", "put"),
  ];

  container.innerHTML = cards.join("");
}


function applyColumnVisibility() {
  const table = document.getElementById("chainTable");
  table.classList.toggle("hide-oi", !visibleCols.oi);
  table.classList.toggle("hide-chgoi", !visibleCols.chgoi);
  table.classList.toggle("hide-vol", !visibleCols.vol);
  table.classList.toggle("hide-ltp", !visibleCols.ltp);

  // keep the CALLS/PUTS group header colspan in sync with visible columns per side
  const visibleCount = ["oi", "chgoi", "vol", "ltp"].filter((k) => visibleCols[k]).length || 1;
  document.querySelectorAll(".calls-group, .puts-group").forEach((th) => {
    th.colSpan = visibleCount;
  });
}

function initColumnToggles() {
  document.querySelectorAll(".col-toggles input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", () => {
      visibleCols[cb.dataset.col] = cb.checked;
      applyColumnVisibility();
    });
  });
}

function renderPayload(payload) {
  const rows = payload.rows || [];
  const atmIdx = computeATMIndex(rows);
  const strikeRange = currentStrikeRange();
  document.getElementById("atmValue").textContent = atmIdx >= 0 ? fmt(num(rows[atmIdx][COLUMNS.strike])) : "—";
  document.getElementById("pcrValue").textContent = computePCR(rows) ?? "—";
  document.getElementById("spotValue").textContent = payload.spot ? fmt(num(payload.spot)) : "≈ ATM";
  setFreshness(payload.fetched_at_ist);
  renderTable(rows, atmIdx, strikeRange);
  renderCharts(rows, atmIdx, strikeRange);
  renderAnalysis(rows, atmIdx);
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
  const timeSelect = document.getElementById("historyTime");
  if (!date) {
    timeSelect.classList.add("hidden");
    timeSelect.innerHTML = "";
    currentDaySnapshots = [];
    return;
  }
  const text = await (await fetch(HISTORY_FILE(date))).text();
  currentDaySnapshots = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

  timeSelect.innerHTML = "";
  currentDaySnapshots.forEach((snap, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    const t = snap.fetched_at_ist ? new Date(snap.fetched_at_ist) : null;
    opt.textContent = t
      ? t.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : `Snapshot ${i + 1}`;
    timeSelect.appendChild(opt);
  });
  timeSelect.classList.remove("hidden");

  if (currentDaySnapshots.length) {
    timeSelect.value = currentDaySnapshots.length - 1; // default to latest snapshot of that day
    renderPayload(currentDaySnapshots[currentDaySnapshots.length - 1]);
  }
}

function initControls() {
  document.getElementById("strikeRange").addEventListener("change", () => {
    if (document.getElementById("historyDate").value === "") {
      loadLive();
    } else {
      const i = Number(document.getElementById("historyTime").value);
      if (currentDaySnapshots[i]) renderPayload(currentDaySnapshots[i]);
    }
  });

  document.getElementById("historyDate").addEventListener("change", async (e) => {
    if (liveTimer) clearInterval(liveTimer);
    if (e.target.value === "") {
      await loadHistoryDay(""); // clears/hides time select
      loadLive();
      liveTimer = setInterval(loadLive, 60_000);
    } else {
      await loadHistoryDay(e.target.value);
    }
  });

  document.getElementById("historyTime").addEventListener("change", (e) => {
    const i = Number(e.target.value);
    if (currentDaySnapshots[i]) renderPayload(currentDaySnapshots[i]);
  });

  initColumnToggles();
}

(async function init() {
  initControls();
  await populateHistoryDropdown();
  await loadLive();
  liveTimer = setInterval(loadLive, 60_000); // frontend polls every minute; actual data cadence is set by the GitHub Action
})();
