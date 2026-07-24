/*
 * app.js — Nifty Option Chain frontend
 *
 * COLUMNS maps this app's concept of each field to the exact column
 * header pandas.read_html produced (note the double spaces in some
 * headers — copied exactly from data/latest.json).
 */
const COLUMNS = {
  strike: "Strike",
  callOI: "CE OI",
  callChgOI: "CE Chng OI",
  callVol: "CE Volume",
  callLTP: "CE LTP",
  putLTP: "PE LTP",
  putVol: "PE Volume",
  putChgOI: "PE Chng OI",
  putOI: "PE OI",
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
      const originalIdx = rows.indexOf(r);
      const isAtm = originalIdx === atmIdx;
      const callOtm = originalIdx > atmIdx; // strikes above spot are OTM for calls
      const putOtm = originalIdx < atmIdx;  // strikes below spot are OTM for puts

      const strike = fmt(num(r[COLUMNS.strike]));
      const callVal = num(r[callKey]) || 0;
      const putVal = num(r[putKey]) || 0;
      const callWidth = Math.min(100, (Math.abs(callVal) / maxAbs) * 100);
      const putWidth = Math.min(100, (Math.abs(putVal) / maxAbs) * 100);
      const callNeg = callVal < 0 ? "negative" : "";
      const putNeg = putVal < 0 ? "negative" : "";
      return `
        <div class="chart-row${isAtm ? " atm-row" : ""}">
          <div class="chart-side call${callOtm ? " otm" : ""}">
            <span class="chart-value">${formatter(callVal)}</span>
            <div class="chart-bar call ${callNeg}" style="width:${callWidth}%"></div>
          </div>
          <div class="chart-strike">${strike}</div>
          <div class="chart-side put${putOtm ? " otm" : ""}">
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

// ---- generic trend line chart (used for OI trend, PCR trend, straddle trend) ----
function renderTrendChart(containerId, points, seriesDefs, currentIndex) {
  const container = document.getElementById(containerId);
  if (!points || !points.length) {
    container.innerHTML = `<div class="empty-state">No data yet today.</div>`;
    return;
  }

  const allVals = points.flatMap((p) => seriesDefs.map((d) => p[d.key] ?? 0));
  const minV = Math.min(...allVals, 0);
  const maxV = Math.max(...allVals, 0);
  const pad = (maxV - minV) * 0.1 || 1;
  const yMin = minV - pad, yMax = maxV + pad;

  const W = 720, H = 220, marginL = 46, marginR = 54, marginT = 14, marginB = 24;
  const plotW = W - marginL - marginR, plotH = H - marginT - marginB;
  const xFor = (i) => marginL + (i / Math.max(1, points.length - 1)) * plotW;
  const yFor = (v) => marginT + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  const pathFor = (key) =>
    points.map((p, i) => `${i === 0 ? "M" : "L"} ${xFor(i).toFixed(1)} ${yFor(p[key] ?? 0).toFixed(1)}`).join(" ");

  const idx = currentIndex !== null && currentIndex !== undefined ? currentIndex : points.length - 1;
  const markerX = xFor(idx).toFixed(1);

  const labelIdxs = [0, Math.floor(points.length / 2), points.length - 1];
  const timeLabels = labelIdxs
    .map((i) => {
      const t = points[i].time ? new Date(points[i].time) : null;
      const label = t ? t.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "";
      return `<text x="${xFor(i).toFixed(1)}" y="${H - 6}" font-size="10" fill="var(--muted)" text-anchor="middle">${label}</text>`;
    })
    .join("");

  const yTicks = 4;
  const yLabels = Array.from({ length: yTicks + 1 }, (_, k) => {
    const v = yMin + ((yMax - yMin) / yTicks) * k;
    const fmtFn = seriesDefs[0].fmt || fmt;
    return `<text x="${marginL - 6}" y="${yFor(v).toFixed(1)}" font-size="10" fill="var(--muted)" text-anchor="end" dominant-baseline="middle">${fmtFn(v)}</text>`;
  }).join("");

  const lines = seriesDefs.map((d) => `<path d="${pathFor(d.key)}" class="trend-line ${d.cls}"></path>`).join("");
  const dots = seriesDefs
    .map((d) => {
      const v = points[idx][d.key] ?? 0;
      const y = yFor(v).toFixed(1);
      const fmtFn = d.fmt || fmt;
      return `
        <circle cx="${markerX}" cy="${y}" r="4" class="trend-dot ${d.cls}"></circle>
        <text x="${Number(markerX) + 8}" y="${y}" font-size="11" class="trend-label ${d.cls}" dominant-baseline="middle">${fmtFn(v)}</text>`;
    })
    .join("");

  const legendHtml = `<div class="trend-legend">${seriesDefs
    .map((d) => `<span class="legend-item"><span class="dot ${d.cls}"></span>${d.label}</span>`)
    .join("")}</div>`;

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" class="trend-svg">
      <line x1="${marginL}" y1="${yFor(0).toFixed(1)}" x2="${W - marginR}" y2="${yFor(0).toFixed(1)}" class="trend-zero" />
      <line x1="${markerX}" y1="${marginT}" x2="${markerX}" y2="${H - marginB}" class="trend-marker" />
      ${yLabels}
      ${timeLabels}
      ${lines}
      ${dots}
    </svg>
    ${legendHtml}
  `;
}

function renderOiTrendChart(snapshots, currentIndex) {
  const points = snapshots.map((snap) => {
    const rows = snap.rows || [];
    let callChg = 0, putChg = 0;
    rows.forEach((r) => {
      callChg += num(r[COLUMNS.callChgOI]) || 0;
      putChg += num(r[COLUMNS.putChgOI]) || 0;
    });
    return { time: snap.fetched_at_ist, callChg, putChg, diff: putChg - callChg };
  });
  renderTrendChart("oiTrendChart", points, [
    { key: "putChg", label: "Put OI (Chg Day)", cls: "put", fmt: fmtCompact },
    { key: "callChg", label: "Call OI (Chg Day)", cls: "call", fmt: fmtCompact },
    { key: "diff", label: "PE-CE (Chg Day)", cls: "diff", fmt: fmtCompact },
  ], currentIndex);
}

function renderPcrTrendChart(snapshots, currentIndex) {
  const points = snapshots.map((snap) => ({
    time: snap.fetched_at_ist,
    pcr: Number(computePCR(snap.rows || [])) || 0,
  }));
  renderTrendChart("pcrTrendChart", points, [
    { key: "pcr", label: "PCR", cls: "pcr", fmt: (v) => v.toFixed(2) },
  ], currentIndex);
}

function renderStraddleTrendChart(snapshots, currentIndex) {
  const points = snapshots.map((snap) => {
    const rows = snap.rows || [];
    const atmIdx = computeATMIndex(rows);
    const straddle =
      atmIdx >= 0 ? (num(rows[atmIdx][COLUMNS.callLTP]) || 0) + (num(rows[atmIdx][COLUMNS.putLTP]) || 0) : 0;
    return { time: snap.fetched_at_ist, straddle };
  });
  renderTrendChart("straddleTrendChart", points, [
    { key: "straddle", label: "ATM Straddle Premium", cls: "straddle", fmt: fmt },
  ], currentIndex);
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

// ---- total OI / OI change across the whole chain ----
function computeTotals(rows) {
  let callOI = 0, putOI = 0, callChg = 0, putChg = 0;
  rows.forEach((r) => {
    callOI += num(r[COLUMNS.callOI]) || 0;
    putOI += num(r[COLUMNS.putOI]) || 0;
    callChg += num(r[COLUMNS.callChgOI]) || 0;
    putChg += num(r[COLUMNS.putChgOI]) || 0;
  });
  return { callOI, putOI, callChg, putChg };
}

function renderTotals(rows) {
  const container = document.getElementById("totalsPanel");
  if (!rows.length) {
    container.innerHTML = `<div class="empty-state">No data yet.</div>`;
    return;
  }
  const t = computeTotals(rows);
  const signed = (n) => `${n >= 0 ? "+" : ""}${fmtCompact(n)}`;

  container.innerHTML = [
    statCard("Total Call OI", fmtCompact(t.callOI), "", "call"),
    statCard("Total Put OI", fmtCompact(t.putOI), "", "put"),
    statCard("Total Call OI Chg", signed(t.callChg), "vs previous day close", "call"),
    statCard("Total Put OI Chg", signed(t.putChg), "vs previous day close", "put"),
  ].join("");
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


// ---- 1. Long/Short buildup classification (near ATM, vs previous run) ----
function classifyBuildup(dOI, dLTP) {
  if (!dOI || !dLTP) return { label: "Neutral", cls: "neutral" };
  if (dOI > 0 && dLTP > 0) return { label: "Long Buildup", cls: "long-buildup" };
  if (dOI > 0 && dLTP < 0) return { label: "Short Buildup", cls: "short-buildup" };
  if (dOI < 0 && dLTP > 0) return { label: "Short Covering", cls: "short-covering" };
  if (dOI < 0 && dLTP < 0) return { label: "Long Unwinding", cls: "long-unwinding" };
  return { label: "Neutral", cls: "neutral" };
}

function renderBuildupSignals(current, previous) {
  const skewEl = document.getElementById("oiSkew");
  const tableEl = document.getElementById("buildupTable");
  const rows = current.rows || [];
  const atmIdx = computeATMIndex(rows);

  if (!previous || atmIdx < 0) {
    skewEl.textContent = previous ? "Not enough data yet." : "First snapshot today — signals appear from the next run.";
    tableEl.innerHTML = "";
    return;
  }

  const prevByStrike = {};
  (previous.rows || []).forEach((r) => {
    const s = num(r[COLUMNS.strike]);
    if (s !== null) prevByStrike[s] = r;
  });

  const lo = Math.max(0, atmIdx - NEAR_ATM_WINDOW);
  const hi = Math.min(rows.length - 1, atmIdx + NEAR_ATM_WINDOW);

  let callBuildupSum = 0, putBuildupSum = 0;
  const cells = [`<div class="bt-head">Strike</div><div class="bt-head">Call</div><div class="bt-head">Put</div>`];

  for (let i = lo; i <= hi; i++) {
    const row = rows[i];
    const strike = num(row[COLUMNS.strike]);
    const prevRow = prevByStrike[strike];
    if (!prevRow || strike === null) continue;

    const dCallOI = (num(row[COLUMNS.callOI]) || 0) - (num(prevRow[COLUMNS.callOI]) || 0);
    const dCallLTP = (num(row[COLUMNS.callLTP]) || 0) - (num(prevRow[COLUMNS.callLTP]) || 0);
    const dPutOI = (num(row[COLUMNS.putOI]) || 0) - (num(prevRow[COLUMNS.putOI]) || 0);
    const dPutLTP = (num(row[COLUMNS.putLTP]) || 0) - (num(prevRow[COLUMNS.putLTP]) || 0);

    const callSig = classifyBuildup(dCallOI, dCallLTP);
    const putSig = classifyBuildup(dPutOI, dPutLTP);

    // skew: call-side buildup only counts above ATM, put-side buildup only counts below ATM
    if (i >= atmIdx) callBuildupSum += Math.max(0, dCallOI);
    if (i <= atmIdx) putBuildupSum += Math.max(0, dPutOI);

    cells.push(`
      <div class="bt-strike">${fmt(strike)}${i === atmIdx ? " •" : ""}</div>
      <div class="bt-cell"><span class="badge ${callSig.cls}">${callSig.label}</span></div>
      <div class="bt-cell"><span class="badge ${putSig.cls}">${putSig.label}</span></div>
    `);
  }

  tableEl.innerHTML = cells.join("");

  // ---- 5. OI skew (directional bias near ATM) ----
  const diff = callBuildupSum - putBuildupSum;
  const total = callBuildupSum + putBuildupSum;
  let skewText;
  if (total === 0) {
    skewText = "No fresh OI buildup near ATM since the last run.";
  } else {
    const pct = ((Math.abs(diff) / total) * 100).toFixed(0);
    if (Math.abs(diff) < total * 0.15) {
      skewText = `Balanced buildup near ATM — Call side ${fmtCompact(callBuildupSum)}, Put side ${fmtCompact(putBuildupSum)}.`;
    } else if (diff > 0) {
      skewText = `Call-side OI building faster near ATM (+${fmtCompact(callBuildupSum)} vs +${fmtCompact(putBuildupSum)} on puts, ${pct}% skew) — resistance strengthening.`;
    } else {
      skewText = `Put-side OI building faster near ATM (+${fmtCompact(putBuildupSum)} vs +${fmtCompact(callBuildupSum)} on calls, ${pct}% skew) — support strengthening.`;
    }
  }
  skewEl.textContent = skewText;
}

// ---- 4. Most active strikes by volume ----
function renderMostActive(current) {
  const container = document.getElementById("mostActive");
  const rows = current.rows || [];
  if (!rows.length) {
    container.innerHTML = `<div class="empty-state">No data yet.</div>`;
    return;
  }

  const withVol = rows
    .map((r) => ({
      strike: num(r[COLUMNS.strike]),
      callVol: num(r[COLUMNS.callVol]) || 0,
      putVol: num(r[COLUMNS.putVol]) || 0,
    }))
    .filter((r) => r.strike !== null);

  withVol.forEach((r) => (r.totalVol = r.callVol + r.putVol));
  withVol.sort((a, b) => b.totalVol - a.totalVol);
  const top3 = withVol.slice(0, 3);

  container.innerHTML = top3
    .map((r, i) =>
      statCard(
        `#${i + 1} by Volume`,
        fmt(r.strike),
        `Call ${fmtCompact(r.callVol)} · Put ${fmtCompact(r.putVol)}`,
        "atm"
      )
    )
    .join("");
}

// ---- 6. Threshold alerts ----
function generateAlertsForSnapshot(current, dayFirstSnapshot) {
  const rows = current.rows || [];
  const atmIdx = computeATMIndex(rows);
  const alerts = [];

  const pcr = Number(computePCR(rows));
  if (!Number.isNaN(pcr)) {
    if (pcr > 1.3) alerts.push({ cls: "bearish", text: `PCR is high at ${pcr.toFixed(2)} — put writing dominant today.` });
    else if (pcr < 0.7) alerts.push({ cls: "bullish", text: `PCR is low at ${pcr.toFixed(2)} — call writing dominant today.` });
  }

  if (dayFirstSnapshot && atmIdx >= 0) {
    const { overallResistance, overallSupport } = computeSupportResistance(rows, atmIdx);
    const firstRows = dayFirstSnapshot.rows || [];
    const firstByStrike = {};
    firstRows.forEach((r) => {
      const s = num(r[COLUMNS.strike]);
      if (s !== null) firstByStrike[s] = r;
    });

    if (overallResistance) {
      const firstRow = firstByStrike[overallResistance.strike];
      const firstOI = firstRow ? num(firstRow[COLUMNS.callOI]) || 0 : null;
      if (firstOI && overallResistance.oi > firstOI * 1.2) {
        const pct = (((overallResistance.oi - firstOI) / firstOI) * 100).toFixed(0);
        alerts.push({ cls: "bearish", text: `Resistance at ${fmt(overallResistance.strike)} has grown +${pct}% today.` });
      }
    }
    if (overallSupport) {
      const firstRow = firstByStrike[overallSupport.strike];
      const firstOI = firstRow ? num(firstRow[COLUMNS.putOI]) || 0 : null;
      if (firstOI && overallSupport.oi > firstOI * 1.2) {
        const pct = (((overallSupport.oi - firstOI) / firstOI) * 100).toFixed(0);
        alerts.push({ cls: "bullish", text: `Support at ${fmt(overallSupport.strike)} has grown +${pct}% today.` });
      }
    }
  }

  return alerts;
}

// Full-day running log: shows every alert fired today up to (and including) uptoIdx, newest first.
function renderAlertsLog(snapshots, uptoIdx) {
  const container = document.getElementById("alertsPanel");
  if (!snapshots || !snapshots.length) {
    container.innerHTML = `<div class="empty-state">No data yet.</div>`;
    return;
  }
  const dayFirst = snapshots[0];
  const entries = [];

  for (let i = 0; i <= uptoIdx; i++) {
    const alerts = generateAlertsForSnapshot(snapshots[i], dayFirst);
    if (!alerts.length) continue;
    const t = snapshots[i].fetched_at_ist ? new Date(snapshots[i].fetched_at_ist) : null;
    const timeLabel = t ? t.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "";
    alerts.forEach((a) => entries.push({ ...a, time: timeLabel }));
  }

  if (!entries.length) {
    container.innerHTML = `<div class="alert-item info"><span class="alert-dot"></span>No threshold alerts today so far.</div>`;
    return;
  }

  container.innerHTML = entries
    .reverse()
    .map((a) => `<div class="alert-item ${a.cls}"><span class="alert-dot"></span><span class="alert-time">${a.time}</span><span>${a.text}</span></div>`)
    .join("");
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

// ---- market notes: auto-generated, compares this run against the previous one ----
function findPrevInDay(snapshots, current) {
  if (!snapshots || snapshots.length < 2) return null;
  const idx = snapshots.findIndex((s) => s.fetched_at_ist === current.fetched_at_ist);
  if (idx > 0) return snapshots[idx - 1];
  if (idx === -1) return snapshots[snapshots.length - 1]; // current not in list yet — most recent stored run
  return null; // idx === 0, this is the first run of the day
}

async function fetchTodaySnapshots(current) {
  try {
    const dateStr = (current.fetched_at_ist || "").split("T")[0];
    if (!dateStr) return [];
    const text = await (await fetch(`${HISTORY_FILE(dateStr)}?_=${Date.now()}`)).text();
    return text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch (e) {
    return [];
  }
}

function generateMarketNotes(current, previous) {
  const rows = current.rows || [];
  const atmIdx = computeATMIndex(rows);
  if (!rows.length || atmIdx < 0) return ["Not enough data yet."];
  if (!previous) return ["This is the first recorded snapshot today — comparison will appear from the next run."];

  const prevRows = previous.rows || [];
  const prevByStrike = {};
  prevRows.forEach((r) => {
    const s = num(r[COLUMNS.strike]);
    if (s !== null) prevByStrike[s] = r;
  });

  const lo = Math.max(0, atmIdx - NEAR_ATM_WINDOW);
  const hi = Math.min(rows.length - 1, atmIdx + NEAR_ATM_WINDOW);
  const movers = [];

  for (let i = lo; i <= hi; i++) {
    const row = rows[i];
    const strike = num(row[COLUMNS.strike]);
    const prevRow = prevByStrike[strike];
    if (!prevRow || strike === null) continue;

    const dCall = (num(row[COLUMNS.callOI]) || 0) - (num(prevRow[COLUMNS.callOI]) || 0);
    const dPut = (num(row[COLUMNS.putOI]) || 0) - (num(prevRow[COLUMNS.putOI]) || 0);
    const tag = i === atmIdx ? " (ATM)" : "";

    if (dCall !== 0) {
      movers.push({
        delta: dCall,
        text: `Strike ${fmt(strike)}${tag}: Call OI ${dCall > 0 ? "added" : "unwound"} ${fmtCompact(Math.abs(dCall))} — ${dCall > 0 ? "fresh resistance building" : "resistance easing"}.`,
      });
    }
    if (dPut !== 0) {
      movers.push({
        delta: dPut,
        text: `Strike ${fmt(strike)}${tag}: Put OI ${dPut > 0 ? "added" : "unwound"} ${fmtCompact(Math.abs(dPut))} — ${dPut > 0 ? "fresh support building" : "support easing"}.`,
      });
    }
  }

  movers.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const notes = movers.slice(0, 6).map((m) => m.text);

  const prevAtmIdx = computeATMIndex(prevRows);
  if (prevAtmIdx >= 0) {
    const prevAtmStrike = num(prevRows[prevAtmIdx][COLUMNS.strike]);
    const curAtmStrike = num(rows[atmIdx][COLUMNS.strike]);
    if (prevAtmStrike !== null && curAtmStrike !== prevAtmStrike) {
      const dir = curAtmStrike > prevAtmStrike ? "up" : "down";
      notes.unshift(`ATM moved ${dir}, from ${fmt(prevAtmStrike)} to ${fmt(curAtmStrike)}, since the last run.`);
    }
  }

  const curPcr = computePCR(rows);
  const prevPcr = computePCR(prevRows);
  if (curPcr !== null && prevPcr !== null && curPcr !== prevPcr) {
    const dir = Number(curPcr) > Number(prevPcr) ? "up" : "down";
    notes.push(`PCR moved ${dir}, from ${prevPcr} to ${curPcr}, since the last run.`);
  }

  if (!notes.length) notes.push("No notable OI movement near ATM since the last run.");
  return notes;
}

function renderMarketNotesLog(snapshots, uptoIdx) {
  const container = document.getElementById("marketNotes");
  if (!snapshots || !snapshots.length) {
    container.innerHTML = `<div class="empty-state">Waiting for data…</div>`;
    return;
  }

  const groups = [];
  for (let i = 0; i <= uptoIdx; i++) {
    const previous = i > 0 ? snapshots[i - 1] : null;
    if (!previous) continue; // first run of the day has nothing to compare against
    const notes = generateMarketNotes(snapshots[i], previous).slice(0, 3);
    const t = snapshots[i].fetched_at_ist ? new Date(snapshots[i].fetched_at_ist) : null;
    const timeLabel = t ? t.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "";
    groups.push({ timeLabel, notes });
  }

  if (!groups.length) {
    container.innerHTML = `<div class="empty-state">This is the first recorded snapshot today — the log builds up from the next run.</div>`;
    return;
  }

  container.innerHTML = groups
    .reverse()
    .map(
      (g) => `
      <div class="note-group">
        <div class="note-time">${g.timeLabel}</div>
        ${g.notes.map((n) => `<div class="note-line">${n}</div>`).join("")}
      </div>`
    )
    .join("");
}

async function refreshLiveDerived(current) {
  const snapshots = await fetchTodaySnapshots(current);
  const points = snapshots.length ? snapshots : [current];
  const idx = snapshots.length
    ? (() => {
        const i = snapshots.findIndex((s) => s.fetched_at_ist === current.fetched_at_ist);
        return i >= 0 ? i : snapshots.length - 1;
      })()
    : 0;
  const previous = findPrevInDay(points, current);

  renderMarketNotesLog(points, idx);
  renderOiTrendChart(points, idx);
  renderPcrTrendChart(points, idx);
  renderStraddleTrendChart(points, idx);
  renderBuildupSignals(current, previous);
  renderMostActive(current);
  renderAlertsLog(points, idx);
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
  renderTotals(rows);
  renderAnalysis(rows, atmIdx);
}

async function loadLive() {
  try {
    const payload = await fetchJSON(DATA_URL);
    renderPayload(payload);
    refreshLiveDerived(payload);
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
  const timeControls = document.getElementById("replayTimeControls");
  if (!date) {
    timeControls.classList.add("hidden");
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
  timeControls.classList.remove("hidden");

  if (currentDaySnapshots.length) {
    timeSelect.value = currentDaySnapshots.length - 1; // default to latest snapshot of that day
    renderPayload(currentDaySnapshots[currentDaySnapshots.length - 1]);
    renderDerivedForReplay(currentDaySnapshots.length - 1);
  }
}

function renderDerivedForReplay(i) {
  const current = currentDaySnapshots[i];
  const previous = i > 0 ? currentDaySnapshots[i - 1] : null;
  renderMarketNotesLog(currentDaySnapshots, i);
  renderOiTrendChart(currentDaySnapshots, i);
  renderPcrTrendChart(currentDaySnapshots, i);
  renderStraddleTrendChart(currentDaySnapshots, i);
  renderBuildupSignals(current, previous);
  renderMostActive(current);
  renderAlertsLog(currentDaySnapshots, i);
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
    if (currentDaySnapshots[i]) {
      renderPayload(currentDaySnapshots[i]);
      renderDerivedForReplay(i);
    }
  });

  function stepReplay(delta) {
    if (!currentDaySnapshots.length) return;
    const timeSelect = document.getElementById("historyTime");
    let i = Number(timeSelect.value) + delta;
    i = Math.max(0, Math.min(currentDaySnapshots.length - 1, i));
    timeSelect.value = i;
    renderPayload(currentDaySnapshots[i]);
    renderDerivedForReplay(i);
  }
  document.getElementById("replayPrev").addEventListener("click", () => stepReplay(-1));
  document.getElementById("replayNext").addEventListener("click", () => stepReplay(1));

  initColumnToggles();
}

(async function init() {
  initControls();
  await populateHistoryDropdown();
  await loadLive();
  liveTimer = setInterval(loadLive, 60_000); // frontend polls every minute; actual data cadence is set by the GitHub Action
})();
