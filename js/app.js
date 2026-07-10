"use strict";

// ---------- CSV parsing (handles quoted fields with commas) ----------
function parseCSV(text) {
  const rows = []; let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ""; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// ---------- Date parsing: Thai + English months, numeric ----------
const THAI_MONTHS = { "มกราคม":1,"กุมภาพันธ์":2,"มีนาคม":3,"เมษายน":4,"พฤษภาคม":5,"มิถุนายน":6,
  "กรกฎาคม":7,"สิงหาคม":8,"กันยายน":9,"ตุลาคม":10,"พฤศจิกายน":11,"ธันวาคม":12 };
const EN_MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };

function parseDate(s) {
  s = (s || "").trim();
  if (!s) return null;
  const parts = s.split(/[\/\-\.]/).map(p => p.trim());
  if (parts.length === 3) {
    let [a, b, c] = parts;
    let month = THAI_MONTHS[b] || EN_MONTHS[b.slice(0, 3).toLowerCase()] || null;
    let day, year;
    if (month) { day = +a; year = +c; }
    else if (a.length === 4) { year = +a; month = +b; day = +c; }   // YYYY-MM-DD
    else { day = +a; month = +b; year = +c; }                        // DD/MM/YYYY
    if (year > 2400) year -= 543;  // Buddhist era → CE
    if (year && month >= 1 && month <= 12 && day >= 1 && day <= 31)
      return new Date(Date.UTC(year, month - 1, day));
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function parseNum(s) {
  if (s == null) return null;
  s = String(s).replace(/[",\s%$]/g, "");
  if (s === "" || s === "-") return null;
  const n = Number(s);
  return isNaN(n) ? null : n;
}

// ---------- Column detection ----------
// Maps flexible header names → canonical keys. Works for the Thai sheet and generic CSVs.
const HEADER_MAP = [
  { key: "date",    match: h => /วันที่|^date/i.test(h) },
  { key: "ticker",  match: h => /ชื่อหุ้น|ticker|symbol|stock/i.test(h) },
  { key: "action",  match: h => /action|side|type|ประเภท/i.test(h) },
  { key: "price",   match: h => /ราคาตอนที่|^price|ราคาซื้อ/i.test(h) },
  { key: "shares",  match: h => /จำนวนหุ้น|shares|quantity|qty|units/i.test(h) },
  { key: "amount",  match: h => /ราคาที่จ่าย|^amount|total paid/i.test(h) },
  { key: "fee",     match: h => /ค่าธรรมเนียม|fee|commission/i.test(h) },
  { key: "cost",    match: h => /^ต้นทุน \(|^ต้นทุน$|^cost/i.test(h) },
  { key: "curValue",match: h => /มูลค่าปัจจุบัน|current value|market value/i.test(h) },
  { key: "pl",      match: h => /กำไร\/ขาดทุน \(USD|^p[\/&]?l$|profit/i.test(h) },
  { key: "note",    match: h => /note|หมายเหตุ|memo/i.test(h) },
];

function detectColumns(rows) {
  // Find the header row: the first row that mentions an action/date-like column.
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const cols = {};
    // Only scan up to the first big gap (the sheet has a summary block pasted to the right).
    let limit = rows[r].length;
    for (let c = 0; c < rows[r].length; c++) {
      const h = (rows[r][c] || "").trim();
      if (h === "" && c > 2 && rows[r].slice(c, c + 2).every(x => !x || !x.trim())) { limit = c; break; }
    }
    for (let c = 0; c < limit; c++) {
      const h = (rows[r][c] || "").trim();
      if (!h) continue;
      for (const m of HEADER_MAP)
        if (cols[m.key] === undefined && m.match(h)) { cols[m.key] = c; break; }
    }
    if (cols.date !== undefined && cols.ticker !== undefined && cols.action !== undefined)
      return { headerRow: r, cols };
  }
  return null;
}

// ---------- Build transactions ----------
function buildTransactions(rows, det) {
  const { headerRow, cols } = det;
  const txs = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    const get = k => cols[k] !== undefined ? (row[cols[k]] || "").trim() : "";
    const date = parseDate(get("date"));
    const ticker = get("ticker").toUpperCase();
    const actionRaw = get("action");
    if (!date || !ticker || !actionRaw) continue;
    const action = actionRaw.charAt(0).toUpperCase() + actionRaw.slice(1).toLowerCase();
    txs.push({
      date, ticker, action,
      price: parseNum(get("price")),
      shares: parseNum(get("shares")),
      amount: parseNum(get("amount")),
      fee: parseNum(get("fee")),
      cost: parseNum(get("cost")),
      curValue: parseNum(get("curValue")),
      pl: parseNum(get("pl")),
      note: get("note"),
    });
  }
  txs.sort((a, b) => a.date - b.date);
  return txs;
}

// ---------- Portfolio math ----------
function computeHoldings(txs) {
  const h = {};
  for (const t of txs) {
    if (!h[t.ticker]) h[t.ticker] = { ticker: t.ticker, shares: 0, cost: 0, curValue: 0, hasCur: false };
    const p = h[t.ticker];
    const isRemove = t.action === "Sell";
    const shares = t.shares || 0;
    const cost = t.cost != null ? t.cost : (t.amount || 0);
    if (isRemove) {
      // Remove current value proportionally to shares sold (sell rows carry no live value)
      if (p.shares > 0) p.curValue -= p.curValue * Math.min(shares / p.shares, 1);
      p.shares -= shares; p.cost -= cost;
    } else {
      p.shares += shares; p.cost += cost;
      if (t.curValue != null) { p.curValue += t.curValue; p.hasCur = true; }
    }
  }
  // Filter out fully sold positions (tiny float residue tolerated)
  return Object.values(h)
    .map(p => { if (Math.abs(p.shares) < 1e-9) { p.shares = 0; } if (Math.abs(p.cost) < 0.005) p.cost = 0; return p; })
    .filter(p => p.shares > 0)
    .sort((a, b) => b.cost - a.cost);
}

// ---------- Formatting ----------
const fmtUSD = n => n == null ? "–" : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtSh  = n => n == null ? "–" : n.toLocaleString("en-US", { maximumFractionDigits: 4 });
const fmtPct = n => n == null ? "–" : (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
const fmtDate = d => d.toISOString().slice(0, 10);
const plClass = n => n == null ? "" : n >= 0 ? "pos" : "neg";
// Theme palettes + derived shades (enough distinct pie slices for larger portfolios)
const PIE_COLORS = {
  a: ["#E4572E","#8FB89F","#7A4A2F","#E11D24","#F7F7F5","#2E4A3B","#C97B4A","#E8E2D6","#4F7A5C","#A33B20","#55442E","#22382D"],
  b: ["#C4763B","#6FA35D","#B99B72","#C0453F","#8A5A2B","#D9A05B","#5E8B5A","#4C3D2C","#A7C48E","#96482B","#7A6A50","#3E7A45"],
};
const CHART_COLORS = {
  a: { v: "#F7F7F5", inv: "#7A4A2F", qqq: "#E4572E", voo: "#8FB89F",
       grid: "rgba(122,74,47,.45)", axis: "rgba(232,226,214,.55)",
       cursor: "rgba(232,226,214,.35)", dotStroke: "#0D0D0D" },
  b: { v: "#2F2416", inv: "#B99B72", qqq: "#C4763B", voo: "#6FA35D",
       grid: "rgba(185,155,114,.5)", axis: "rgba(76,61,44,.6)",
       cursor: "rgba(76,61,44,.4)", dotStroke: "#FBF6EA" },
};
let THEME = localStorage.getItem("theme") === "b" ? "b" : "a";
let COLORS = PIE_COLORS[THEME];

// ---------- Live prices (Yahoo Finance via local server) ----------
let QUOTES = {}, QUOTES_AT = null;

async function fetchQuotes(tickers) {
  if (!tickers.length) return false;
  try {
    const res = await fetch("/api/quotes?symbols=" + encodeURIComponent(tickers.join(",")));
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    QUOTES = data.quotes || {};
    QUOTES_AT = data.fetchedAt ? new Date(data.fetchedAt) : new Date();
    return Object.keys(QUOTES).length > 0;
  } catch {
    QUOTES = {}; QUOTES_AT = null;
    return false;
  }
}

function applyLivePrices(holdings) {
  for (const p of holdings) {
    const q = QUOTES[p.ticker];
    if (q && q.price != null) {
      p.livePrice = q.price;
      p.liveChangePct = q.changePercent;
      p.curValue = q.price * p.shares;
      p.hasCur = true;
      p.live = true;
    }
  }
}

function renderPriceStatus(live) {
  const el = document.getElementById("priceStatus");
  if (!el) return;
  el.textContent = live
    ? "Live prices from Yahoo Finance · updated " + QUOTES_AT.toLocaleTimeString()
    : "Using snapshot values from the CSV — run `npm start` and open http://localhost:3000 for live Yahoo Finance prices";
  el.className = live ? "pos" : "";
}

// ---------- Persistence (data/transactions.json via local server) ----------
async function saveTransactions(txs, fname) {
  try {
    await fetch("/api/transactions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: fname,
        savedAt: new Date().toISOString(),
        // curValue/pl are point-in-time snapshot values — recomputed live, not persisted
        transactions: txs.map(({ curValue, pl, ...rest }) => rest),
      }),
    });
  } catch { /* server not running (opened as a plain file) — skip */ }
}

async function loadSavedTransactions() {
  try {
    const res = await fetch("/api/transactions");
    if (!res.ok) return false;
    const data = await res.json();
    if (!data || !Array.isArray(data.transactions) || !data.transactions.length) return false;
    const txs = data.transactions.map(t => ({ ...t, date: new Date(t.date) }));
    await render(txs, data.fileName || "saved portfolio");
    return true;
  } catch { return false; }
}

async function refreshPrices() {
  if (ALL_TXS.length) await render(ALL_TXS, CURRENT_FILE);
}

// ---------- Rendering ----------
let ALL_TXS = [], SORT = { k: "date", dir: -1 }, CURRENT_FILE = "";

async function render(txs, fname) {
  ALL_TXS = txs;
  CURRENT_FILE = fname;
  document.getElementById("dropzone").style.display = "none";
  document.getElementById("results").style.display = "block";
  document.getElementById("fileBadge").style.display = "block";

  const holdings = computeHoldings(txs);
  const live = await fetchQuotes(holdings.map(p => p.ticker));
  if (live) applyLivePrices(holdings);
  renderPriceStatus(live);
  renderCards(txs, holdings);
  renderHoldings(holdings);
  renderDonuts(holdings);
  renderHeatmap(txs);
  setupFilters(txs);
  renderTxTable();
  PERF_CACHE = null;
  if (document.getElementById("tab-performance")?.classList.contains("active")) renderPerformance();
}

function renderCards(txs, holdings) {
  // Net invested = actual cash deployed: buy amounts (fees included) − sell proceeds
  const netInvested = txs.reduce((s, t) => t.action === "Sell"
    ? s - ((t.price != null && t.shares != null) ? t.price * t.shares : (t.cost || 0))
    : s + (t.amount ?? t.cost ?? 0), 0);
  const curKnown = holdings.filter(p => p.hasCur);
  const curValue = curKnown.reduce((s, p) => s + p.curValue, 0);
  const curCost = curKnown.reduce((s, p) => s + p.cost, 0);
  const unreal = curValue - curCost;

  const anyLive = holdings.some(p => p.live);
  const cards = [
    { label: anyLive ? "Current value (live)" : "Current value (from CSV)", value: "$" + fmtUSD(curValue) },
    { label: "Net invested (buy cost + fee - sell)", value: "$" + fmtUSD(netInvested) },
    { label: "Unrealized P/L", value: (unreal >= 0 ? "+$" : "-$") + fmtUSD(Math.abs(unreal)),
      delta: fmtPct(curCost ? unreal / curCost * 100 : null), cls: plClass(unreal) },
  ];
  document.getElementById("cards").innerHTML = cards.map(c => `
    <div class="card">
      <div class="label">${c.label}</div>
      <div class="value ${c.cls || ""}">${c.value}</div>
      ${c.delta ? `<div class="delta ${c.cls || ""}">${c.delta}</div>` : ""}
    </div>`).join("");
}

// Holdings columns — order is user-adjustable (drag headers), persisted in localStorage
const HOLDING_COLS = {
  ticker:   { label: "Ticker", left: true, cell: p => `<td class="ticker left">${p.ticker}</td>` },
  price:    { label: "Price", cell: p => `<td>${p.live
                ? `$${fmtUSD(p.livePrice)} <span class="${plClass(p.liveChangePct)}" style="font-size:11px">${fmtPct(p.liveChangePct)}</span>`
                : "–"}</td>` },
  shares:   { label: "Shares", cell: p => `<td>${fmtSh(p.shares)}</td>` },
  curValue: { label: "Current value*", cell: p => `<td>${p.hasCur ? "$" + fmtUSD(p.curValue) : "–"}</td>` },
  avgCost:  { label: "Avg cost/share", cell: p => `<td>$${fmtUSD(p.shares ? p.cost / p.shares : null)}</td>` },
  cost:     { label: "Cost basis (USD)", cell: p => `<td>$${fmtUSD(p.cost)}</td>` },
  pl:       { label: "Unrealized P/L", cell: p => {
                const pl = p.hasCur ? p.curValue - p.cost : null;
                return `<td class="${plClass(pl)}">${pl == null ? "–" : (pl >= 0 ? "+$" : "-$") + fmtUSD(Math.abs(pl))}</td>`; } },
  plPct:    { label: "P/L %", cell: p => {
                const pl = p.hasCur ? p.curValue - p.cost : null;
                const pct = pl != null && p.cost ? pl / p.cost * 100 : null;
                return `<td class="${plClass(pct)}">${fmtPct(pct)}</td>`; } },
};
const DEFAULT_COL_ORDER = ["ticker", "price", "shares", "curValue", "avgCost", "cost", "pl", "plPct"];

function loadColOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem("holdingsColOrder"));
    if (Array.isArray(saved) && saved.length === DEFAULT_COL_ORDER.length &&
        DEFAULT_COL_ORDER.every(k => saved.includes(k))) return saved;
  } catch { /* fall through to default */ }
  return [...DEFAULT_COL_ORDER];
}
let COL_ORDER = loadColOrder(), HOLDINGS = [];

function renderHoldings(holdings) {
  HOLDINGS = holdings;
  const thead = document.querySelector("#holdingsTable thead");
  thead.innerHTML = "<tr>" + COL_ORDER.map(k =>
    `<th class="${HOLDING_COLS[k].left ? "left" : ""}" draggable="true" data-col="${k}"
       title="Drag to reorder columns">${HOLDING_COLS[k].label}</th>`).join("") + "</tr>";
  document.querySelector("#holdingsTable tbody").innerHTML = holdings.map(p =>
    "<tr>" + COL_ORDER.map(k => HOLDING_COLS[k].cell(p)).join("") + "</tr>").join("")
    || `<tr><td colspan="${COL_ORDER.length}" class="empty">No open positions</td></tr>`;
  attachColumnDrag(thead);
}

function attachColumnDrag(thead) {
  let dragKey = null;
  thead.querySelectorAll("th").forEach(th => {
    th.addEventListener("dragstart", e => { dragKey = th.dataset.col; e.dataTransfer.effectAllowed = "move"; });
    th.addEventListener("dragover", e => { e.preventDefault(); th.classList.add("drag-over"); });
    th.addEventListener("dragleave", () => th.classList.remove("drag-over"));
    th.addEventListener("drop", e => {
      e.preventDefault(); th.classList.remove("drag-over");
      const target = th.dataset.col;
      if (!dragKey || dragKey === target) return;
      COL_ORDER.splice(COL_ORDER.indexOf(target), 0, ...COL_ORDER.splice(COL_ORDER.indexOf(dragKey), 1));
      localStorage.setItem("holdingsColOrder", JSON.stringify(COL_ORDER));
      renderHoldings(HOLDINGS);
    });
  });
}

// Pie ticker filter — unchecked tickers are excluded from both pies; persisted in localStorage
let PIE_UNCHECKED = new Set(JSON.parse(localStorage.getItem("pieUnchecked") || "[]"));

function renderDonuts(holdings) {
  // Cash joins the pies as a pseudo-holding (same value on both charts)
  const cash = getCashUSD();
  const items = cash > 0.005
    ? [...holdings, { ticker: "CASH", cost: cash, curValue: cash, hasCur: true }]
    : holdings.slice();

  // Stable color per ticker (based on full list order), so filtering doesn't recolor slices
  const colorOf = t => COLORS[Math.max(0, items.findIndex(p => p.ticker === t)) % COLORS.length];

  const bar = document.getElementById("pieTickers");
  bar.innerHTML = items.map(p => {
    const off = PIE_UNCHECKED.has(p.ticker);
    return `<label class="${off ? "off" : ""}">
      <input type="checkbox" data-ticker="${p.ticker}" ${off ? "" : "checked"}>
      <span class="swatch" style="background:${colorOf(p.ticker)}"></span>${p.ticker}</label>`;
  }).join("");
  bar.querySelectorAll("input").forEach(cb => cb.addEventListener("change", () => {
    cb.checked ? PIE_UNCHECKED.delete(cb.dataset.ticker) : PIE_UNCHECKED.add(cb.dataset.ticker);
    localStorage.setItem("pieUnchecked", JSON.stringify([...PIE_UNCHECKED]));
    renderDonuts(HOLDINGS);
  }));

  const shown = items.filter(p => !PIE_UNCHECKED.has(p.ticker));
  renderDonut("donutCost", "donutCostLegend", shown, p => p.cost, colorOf);
  renderDonut("donutCur", "donutCurLegend", shown, p => p.hasCur ? p.curValue : p.cost, colorOf);
}

function renderDonut(svgId, legendId, holdings, valueOf, colorOf) {
  holdings = holdings.slice().sort((a, b) => valueOf(b) - valueOf(a));
  const total = holdings.reduce((s, p) => s + valueOf(p), 0);
  const svg = document.getElementById(svgId);
  const legend = document.getElementById(legendId);
  if (!total) { svg.innerHTML = ""; legend.innerHTML = '<div class="empty">No data</div>'; return; }
  const R = 15.9155, C = 100; // circumference = 100 for percent-based dasharray
  let offset = 25, parts = "", leg = "";
  holdings.forEach((p, i) => {
    const pct = valueOf(p) / total * 100;
    const color = colorOf ? colorOf(p.ticker) : COLORS[i % COLORS.length];
    parts += `<circle cx="21" cy="21" r="${R}" fill="transparent" stroke="${color}" stroke-width="5"
      stroke-dasharray="${pct} ${C - pct}" stroke-dashoffset="${offset}"></circle>`;
    offset -= pct;
    leg += `<div class="row"><span class="swatch" style="background:${color}"></span>
      <span>${p.ticker}</span><span class="pct">${pct.toFixed(1)}%</span></div>`;
  });
  svg.innerHTML = parts;
  legend.innerHTML = leg;
}

// GitHub contributions-style heatmap: a pixel per day, color intensity = USD
// bought that day (sells excluded). Shows one year at a time, chosen via year buttons.
let HEATMAP_YEAR = +(localStorage.getItem("heatmapYear") || 0);

function renderHeatmap(txs) {
  const byDay = {};
  for (const t of txs) {
    if (t.action !== "Buy") continue; // only real purchases — no sells, no split re-adds
    const k = t.date.toISOString().slice(0, 10);
    byDay[k] = (byDay[k] || 0) + (t.cost ?? t.amount ?? 0);
  }
  const container = document.getElementById("heatmap");
  const keys = Object.keys(byDay).sort();
  if (!keys.length) { container.innerHTML = '<div class="empty">No data</div>'; return; }

  const max = Math.max(...Object.values(byDay));
  const level = v => v <= 0 ? 0 : v <= max * 0.25 ? 1 : v <= max * 0.5 ? 2 : v <= max * 0.75 ? 3 : 4;
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const yStart = +keys[0].slice(0, 4), yEnd = +keys[keys.length - 1].slice(0, 4);
  const years = [];
  for (let y = yStart; y <= yEnd; y++) years.push(y);
  if (!years.includes(HEATMAP_YEAR)) HEATMAP_YEAR = yEnd; // default: most recent year

  const yearsBar = `<div class="hm-years">` + years.map(y =>
    `<button class="hm-year-btn${y === HEATMAP_YEAR ? " active" : ""}" data-year="${y}">${y}</button>`).join("") + `</div>`;

  const y = HEATMAP_YEAR;
  const startDow = new Date(Date.UTC(y, 0, 1)).getUTCDay(); // 0 = Sunday
  const daysInYear = (Date.UTC(y + 1, 0, 1) - Date.UTC(y, 0, 1)) / 86400000;
  let cells = "";
  for (let i = 0; i < startDow; i++) cells += '<span class="hm-cell hm-blank"></span>';
  let yearTotal = 0;
  const monthStartWeek = {};
  for (let d = 0; d < daysInYear; d++) {
    const dt = new Date(Date.UTC(y, 0, 1 + d));
    const key = dt.toISOString().slice(0, 10);
    const v = byDay[key] || 0;
    yearTotal += v;
    const m = dt.getUTCMonth();
    if (monthStartWeek[m] === undefined) monthStartWeek[m] = Math.floor((d + startDow) / 7);
    cells += `<span class="hm-cell${v ? " hm-l" + level(v) : ""}" data-date="${key}" data-v="${v}"></span>`;
  }
  const weeks = Math.ceil((startDow + daysInYear) / 7);
  let monthLabels = "";
  for (let m = 0; m < 12; m++)
    monthLabels += `<span style="grid-column-start:${monthStartWeek[m] + 1}">${MONTHS[m]}</span>`;

  container.innerHTML = yearsBar + `
    <div class="heatmap-year">
      <div class="hm-head"><b>${y}</b><span>$${fmtUSD(yearTotal)} invested</span></div>
      <div class="hm-months" style="grid-template-columns:repeat(${weeks},15px)">${monthLabels}</div>
      <div class="hm-wrap">
        <div class="hm-days"><span></span><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span></div>
        <div class="hm-grid">${cells}</div>
      </div>
    </div>
    <div class="hm-legend">Less
      <span class="hm-cell"></span><span class="hm-cell hm-l1"></span><span class="hm-cell hm-l2"></span>
      <span class="hm-cell hm-l3"></span><span class="hm-cell hm-l4"></span> More
      · brightest = $${fmtUSD(max)} in one day</div>`;

  container.querySelectorAll(".hm-year-btn").forEach(b => b.addEventListener("click", () => {
    HEATMAP_YEAR = +b.dataset.year;
    localStorage.setItem("heatmapYear", HEATMAP_YEAR);
    renderHeatmap(ALL_TXS);
  }));
  attachHeatmapTooltip(container);
}

function getTip() {
  let tip = document.getElementById("hmTip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "hmTip";
    document.body.appendChild(tip);
  }
  return tip;
}

// Place the tip beside the cursor; flip to the left when close to the right window edge
function positionTip(tip, e) {
  tip.style.display = "block";
  const w = tip.offsetWidth;
  const flip = e.clientX + 14 + w > window.innerWidth - 8;
  tip.style.left = (flip ? e.clientX - 14 - w : e.clientX + 14) + "px";
  tip.style.top = (e.clientY + 14) + "px";
}

function attachHeatmapTooltip(container) {
  const tip = getTip();
  const grid = container.querySelector(".hm-grid");
  grid.addEventListener("mouseover", e => {
    const c = e.target.closest(".hm-cell");
    if (!c || !c.dataset.date) { tip.style.display = "none"; return; }
    const v = +c.dataset.v;
    tip.textContent = (v ? "$" + fmtUSD(v) + " invested" : "No purchases") + " · " + c.dataset.date;
    tip.style.display = "block";
  });
  grid.addEventListener("mousemove", e => positionTip(tip, e));
  grid.addEventListener("mouseleave", () => { tip.style.display = "none"; });
}

// ---------- Transactions table with filter + sort ----------
function setupFilters(txs) {
  const tickers = [...new Set(txs.map(t => t.ticker))].sort();
  const actions = [...new Set(txs.map(t => t.action))].sort();
  document.getElementById("filterTicker").innerHTML =
    '<option value="">All tickers</option>' + tickers.map(t => `<option>${t}</option>`).join("");
  document.getElementById("filterAction").innerHTML =
    '<option value="">All actions</option>' + actions.map(a => `<option>${a}</option>`).join("");
}

function renderTxTable() {
  const ft = document.getElementById("filterTicker").value;
  const fa = document.getElementById("filterAction").value;
  const fx = document.getElementById("filterText").value.toLowerCase();
  let rows = ALL_TXS.filter(t =>
    (!ft || t.ticker === ft) && (!fa || t.action === fa) &&
    (!fx || t.ticker.toLowerCase().includes(fx) || (t.note || "").toLowerCase().includes(fx)));
  const { k, dir } = SORT;
  rows = rows.slice().sort((a, b) => {
    let va = a[k], vb = b[k];
    if (va == null) return 1; if (vb == null) return -1;
    if (va instanceof Date) return (va - vb) * dir;
    if (typeof va === "string") return va.localeCompare(vb) * dir;
    return (va - vb) * dir;
  });
  document.querySelector("#txTable tbody").innerHTML = rows.map(t => `<tr>
    <td>${fmtDate(t.date)}</td>
    <td class="ticker left">${t.ticker}</td>
    <td class="left"><span class="tag ${t.action}">${t.action}</span></td>
    <td>${t.price != null ? "$" + fmtUSD(t.price) : "–"}</td>
    <td>${fmtSh(t.shares)}</td>
    <td>${t.amount != null ? "$" + fmtUSD(t.amount) : "–"}</td>
    <td>${t.fee != null ? "$" + fmtUSD(t.fee) : "–"}</td>
    <td>${t.cost != null ? "$" + fmtUSD(t.cost) : "–"}</td>
    <td class="note left">${t.note || ""}</td>
  </tr>`).join("") || `<tr><td colspan="9" class="empty">No matching transactions</td></tr>`;
}

document.querySelectorAll("#txTable thead th").forEach(th => {
  th.addEventListener("click", () => {
    const k = th.dataset.k;
    if (SORT.k === k) SORT.dir *= -1; else SORT = { k, dir: 1 };
    renderTxTable();
  });
});
["filterTicker", "filterAction", "filterText"].forEach(id =>
  document.getElementById(id).addEventListener("input", renderTxTable));

// ---------- File handling ----------
function handleFile(file) {
  const reader = new FileReader();
  reader.onload = async e => {
    const rows = parseCSV(e.target.result);
    const det = detectColumns(rows);
    if (!det) { alert("Could not find columns for date / ticker / action in this CSV. Check the header row."); return; }
    const txs = buildTransactions(rows, det);
    if (!txs.length) { alert("Header found, but no valid transaction rows could be parsed."); return; }
    await render(txs, file.name);
    saveTransactions(txs, file.name);
  };
  reader.readAsText(file, "UTF-8");
}

function resetApp() {
  document.getElementById("dropzone").style.display = "block";
  document.getElementById("results").style.display = "none";
  document.getElementById("fileBadge").style.display = "none";
  document.getElementById("fileInput").value = "";
}

const dz = document.getElementById("dropzone");
const fi = document.getElementById("fileInput");
dz.addEventListener("click", () => fi.click());
fi.addEventListener("change", () => fi.files[0] && handleFile(fi.files[0]));
dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("dragover"); });
dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
dz.addEventListener("drop", e => {
  e.preventDefault(); dz.classList.remove("dragover");
  if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});

// ---------- Performance (yearly TWR, MWR/XIRR, benchmark what-if) ----------
const BENCHMARKS = ["QQQ", "VOO"];
let PERF_CACHE = null; // html; invalidated whenever transactions re-render
let PERF_DATA = null;  // computed metrics (kept for chart hover)

async function fetchHistory(symbol, fromISO) {
  const res = await fetch(`/api/history?symbol=${encodeURIComponent(symbol)}&from=${fromISO}`);
  if (!res.ok) throw new Error(symbol);
  return await res.json(); // { series: [{date, close}], dividends: [{date, amount}] }
}

// XIRR: internal rate of return for dated cash flows (negative = money in), via bisection
function xirr(flows) {
  if (flows.length < 2) return null;
  const t0 = flows[0].date;
  const yrs = f => (f.date - t0) / (365.25 * 86400000);
  const npv = r => flows.reduce((s, f) => s + f.amount / Math.pow(1 + r, yrs(f)), 0);
  let lo = -0.999, hi = 10, flo = npv(lo), fhi = npv(hi);
  if (isNaN(flo) || isNaN(fhi) || flo * fhi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2, fm = npv(mid);
    if (Math.abs(fm) < 1e-7) return mid;
    if (flo * fm < 0) { hi = mid; fhi = fm; } else { lo = mid; flo = fm; }
  }
  return (lo + hi) / 2;
}

async function computePerformance(txs) {
  const tickers = [...new Set(txs.map(t => t.ticker))];
  const symbols = [...new Set([...tickers, ...BENCHMARKS])];
  const fromISO = new Date(txs[0].date.getTime() - 7 * 86400000).toISOString().slice(0, 10);

  // Fetch daily history for every symbol (portfolio + benchmarks)
  const results = await Promise.allSettled(symbols.map(s => fetchHistory(s, fromISO)));
  const failed = symbols.filter((s, i) => results[i].status === "rejected");
  if (failed.length) throw new Error("no price history for: " + failed.join(", "));
  const priceMap = {}, divMap = {};
  symbols.forEach((s, i) => {
    priceMap[s] = new Map(results[i].value.series.map(x => [x.date, x.close]));
    divMap[s] = results[i].value.dividends || [];
  });

  // Live quotes for today's values (fall back to last close)
  let quotes = {};
  try {
    const r = await fetch("/api/quotes?symbols=" + symbols.join(","));
    if (r.ok) quotes = (await r.json()).quotes || {};
  } catch { /* use last closes */ }

  // Trading-day timeline (VOO trades every US market day); carry prices forward over gaps
  const days = [...priceMap.VOO.keys()].sort();
  const aligned = {};
  for (const s of symbols) {
    let last = null;
    aligned[s] = days.map(d => (priceMap[s].has(d) ? (last = priceMap[s].get(d)) : last));
  }
  const lastPrice = s => quotes[s]?.price ?? aligned[s][days.length - 1];
  const rollIdx = d => { // first trading day >= d (clamped to last)
    let lo = 0, hi = days.length - 1, ans = days.length - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (days[m] >= d) { ans = m; hi = m - 1; } else lo = m + 1; }
    return ans;
  };

  // External flows & share changes per trading day (weekend trades roll to next session)
  const flowByIdx = new Map(), deltaByIdx = new Map();
  for (const t of txs) {
    const idx = rollIdx(t.date.toISOString().slice(0, 10));
    const isSell = t.action === "Sell";
    // money out of pocket for buys; sale proceeds for sells (price × shares ≈ actual proceeds)
    const flow = isSell
      ? -((t.price != null && t.shares != null) ? t.price * t.shares : (t.cost || 0))
      : (t.amount ?? t.cost ?? 0);
    flowByIdx.set(idx, (flowByIdx.get(idx) || 0) + flow);
    const dm = deltaByIdx.get(idx) || new Map();
    dm.set(t.ticker, (dm.get(t.ticker) || 0) + (isSell ? -(t.shares || 0) : (t.shares || 0)));
    deltaByIdx.set(idx, dm);
  }
  const firstFlowIdx = Math.min(...flowByIdx.keys());

  // Dividend events per trading day (portfolio tickers only)
  const divByIdx = new Map();
  for (const s of tickers) for (const d of divMap[s]) {
    const idx = rollIdx(d.date);
    if (!divByIdx.has(idx)) divByIdx.set(idx, []);
    divByIdx.get(idx).push({ sym: s, amount: d.amount });
  }

  // Walk the timeline: daily-linked TWR (per year + overall), benchmark mirroring,
  // XIRR flows, daily value series for the chart, risk stats, dividend accrual
  const sharesNow = new Map();
  const benchShares = Object.fromEntries(BENCHMARKS.map(b => [b, 0]));
  const yearTWR = {}, etfYearTWR = Object.fromEntries(BENCHMARKS.map(b => [b, {}]));
  const xirrFlows = [], chart = [], dailyR = [], divBySym = {}, divByYear = {};
  let twr = 1, prevV = 0, cumFlow = 0, ddIndex = 1, ddPeak = 1, maxDD = 0;

  for (let i = 0; i < days.length; i++) {
    const year = days[i].slice(0, 4);
    const F = flowByIdx.get(i) || 0;
    const dm = deltaByIdx.get(i);
    if (dm) for (const [sym, ds] of dm) sharesNow.set(sym, (sharesNow.get(sym) || 0) + ds);
    if (F) {
      cumFlow += F;
      for (const b of BENCHMARKS) { const p = aligned[b][i]; if (p) benchShares[b] += F / p; }
      xirrFlows.push({ date: new Date(days[i]), amount: -F });
    }
    const divs = divByIdx.get(i);
    if (divs) for (const dv of divs) {
      const sh = sharesNow.get(dv.sym) || 0;
      if (sh > 1e-9) {
        const amt = sh * dv.amount;
        divBySym[dv.sym] = (divBySym[dv.sym] || 0) + amt;
        divByYear[year] = divByYear[year] || {};
        divByYear[year][dv.sym] = (divByYear[year][dv.sym] || 0) + amt;
      }
    }
    let V = 0;
    for (const [sym, sh] of sharesNow) {
      if (sh > 1e-9) { const p = aligned[sym][i]; if (p) V += sh * p; }
    }
    const base = prevV + F;
    if (base > 1e-9 && (prevV > 1e-9 || F > 0)) {
      const f = V / base;
      if (isFinite(f) && f > 0) {
        twr *= f; yearTWR[year] = (yearTWR[year] || 1) * f;
        dailyR.push({ d: days[i], r: f - 1 });
        ddIndex *= f; if (ddIndex > ddPeak) ddPeak = ddIndex;
        maxDD = Math.min(maxDD, ddIndex / ddPeak - 1);
      }
    }
    if (i > firstFlowIdx) {
      for (const b of BENCHMARKS) {
        const p0 = aligned[b][i - 1], p1 = aligned[b][i];
        if (p0 && p1) etfYearTWR[b][year] = (etfYearTWR[b][year] || 1) * (p1 / p0);
      }
    }
    if (i >= firstFlowIdx) chart.push({
      d: days[i], v: V, inv: cumFlow,
      qqq: benchShares.QQQ * (aligned.QQQ[i] || 0),
      voo: benchShares.VOO * (aligned.VOO[i] || 0),
    });
    prevV = V;
  }

  // Risk stats from the daily TWR factors
  const meanR = dailyR.reduce((s, x) => s + x.r, 0) / (dailyR.length || 1);
  const vol = dailyR.length > 1
    ? Math.sqrt(dailyR.reduce((s, x) => s + (x.r - meanR) ** 2, 0) / (dailyR.length - 1)) * Math.sqrt(252)
    : null;
  let best = null, worst = null;
  for (const x of dailyR) {
    if (!best || x.r > best.r) best = x;
    if (!worst || x.r < worst.r) worst = x;
  }
  const divTotal = Object.values(divBySym).reduce((s, v) => s + v, 0);

  // Today's values
  let myValue = 0;
  for (const [sym, sh] of sharesNow) if (sh > 1e-9) myValue += sh * lastPrice(sym);
  const netInvested = [...flowByIdx.values()].reduce((s, v) => s + v, 0);
  const today = new Date();
  const yearsSpan = (today - new Date(days[firstFlowIdx])) / (365.25 * 86400000);

  const mine = { name: "My portfolio", value: myValue, mwr: xirr([...xirrFlows, { date: today, amount: myValue }]) };
  const bench = BENCHMARKS.map(b => {
    const value = benchShares[b] * lastPrice(b);
    return { name: b, value, mwr: xirr([...xirrFlows, { date: today, amount: value }]) };
  });

  return {
    yearTWR, etfYearTWR, twr,
    twrAnnual: yearsSpan > 0 ? Math.pow(twr, 1 / yearsSpan) - 1 : null,
    mine, bench, netInvested, yearsSpan,
    since: days[firstFlowIdx], currentYear: String(today.getUTCFullYear()),
    chart, maxDD, vol, best, worst, divBySym, divByYear, divTotal,
  };
}

// ---- Chart range selection (All / YTD / 6M / 3M / specific year) ----
let CHART_RANGE = localStorage.getItem("chartRange") || "all";
let FILTERED_CHART = null;

function filterChart(chart) {
  if (!chart.length || CHART_RANGE === "all") return chart;
  let filtered;
  if (CHART_RANGE.startsWith("y:")) {
    const y = CHART_RANGE.slice(2);
    filtered = chart.filter(p => p.d.startsWith(y));
  } else {
    const last = new Date(chart[chart.length - 1].d);
    let from;
    if (CHART_RANGE === "ytd") from = last.getUTCFullYear() + "-01-01";
    else {
      const d = new Date(last);
      d.setUTCMonth(d.getUTCMonth() - (CHART_RANGE === "6m" ? 6 : 3));
      from = d.toISOString().slice(0, 10);
    }
    filtered = chart.filter(p => p.d >= from);
  }
  return filtered.length > 1 ? filtered : chart; // fall back if the range has no data
}

function renderChartBox() {
  const box = document.getElementById("chartBox");
  if (!box || !PERF_DATA) return;
  FILTERED_CHART = filterChart(PERF_DATA.chart);
  box.innerHTML = chartSVG(FILTERED_CHART);
  attachChartHover();
  document.querySelectorAll(".chart-range .cr-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.range === CHART_RANGE));
  const sel = document.getElementById("chartYearSel");
  if (sel) sel.value = CHART_RANGE.startsWith("y:") ? CHART_RANGE.slice(2) : "";
}

function attachChartControls() {
  const wrap = document.querySelector(".chart-range");
  if (!wrap) return;
  wrap.querySelectorAll(".cr-btn").forEach(b => b.addEventListener("click", () => {
    CHART_RANGE = b.dataset.range;
    localStorage.setItem("chartRange", CHART_RANGE);
    renderChartBox();
  }));
  document.getElementById("chartYearSel")?.addEventListener("change", e => {
    if (!e.target.value) return;
    CHART_RANGE = "y:" + e.target.value;
    localStorage.setItem("chartRange", CHART_RANGE);
    renderChartBox();
  });
  renderChartBox();
}

// SVG line chart: portfolio value vs net invested vs mirrored QQQ/VOO
function chartSVG(chart) {
  const C = CHART_COLORS[THEME];
  const W = 860, H = 300, padL = 64, padR = 14, padT = 14, padB = 28;
  const n = chart.length;
  if (n < 2) return "";
  const maxV = Math.max(...chart.map(p => Math.max(p.v, p.inv, p.qqq, p.voo))) * 1.05;
  const X = i => padL + (W - padL - padR) * i / (n - 1);
  const Y = v => padT + (H - padT - padB) * (1 - v / maxV);
  const line = (key, color, w, dash) =>
    `<polyline fill="none" stroke="${color}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ""}
      points="${chart.map((p, i) => X(i).toFixed(1) + "," + Y(p[key]).toFixed(1)).join(" ")}"/>`;
  let grid = "";
  for (let g = 0; g <= 4; g++) {
    const v = maxV * g / 4, y = Y(v).toFixed(1);
    grid += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${C.grid}"/>`
      + `<text x="${padL - 8}" y="${+y + 4}" text-anchor="end" font-size="13" fill="${C.axis}" font-family="VT323, monospace">$${Math.round(v).toLocaleString()}</text>`;
  }
  // X-axis: evenly spaced date labels as day/month/year (e.g. 1/12/2023)
  const fmtTick = d => { const [y, m, dd] = d.split("-"); return `${+dd}/${+m}/${y}`; };
  const tickCount = Math.min(6, n);
  let ticks = "";
  for (let t = 0; t < tickCount; t++) {
    const i = Math.round(t * (n - 1) / (tickCount - 1));
    const anchor = t === 0 ? "start" : t === tickCount - 1 ? "end" : "middle";
    ticks += `<line x1="${X(i).toFixed(1)}" y1="${H - padB}" x2="${X(i).toFixed(1)}" y2="${H - padB + 4}" stroke="${C.grid}"/>`
      + `<text x="${X(i).toFixed(1)}" y="${H - 8}" text-anchor="${anchor}" font-size="13" fill="${C.axis}" font-family="VT323, monospace">${fmtTick(chart[i].d)}</text>`;
  }
  return `<svg id="valueChart" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
    ${grid}${ticks}
    ${line("inv", C.inv, 2, "4 3")}
    ${line("qqq", C.qqq, 1.5)}
    ${line("voo", C.voo, 1.5)}
    ${line("v", C.v, 2.5)}
    <g id="chartHoverG" style="display:none">
      <line id="chartCursor" y1="${padT}" y2="${H - padB}" stroke="${C.cursor}" stroke-width="1"/>
      <rect id="chartDot-inv" width="7" height="7" fill="${C.inv}" stroke="${C.dotStroke}"/>
      <rect id="chartDot-qqq" width="7" height="7" fill="${C.qqq}" stroke="${C.dotStroke}"/>
      <rect id="chartDot-voo" width="7" height="7" fill="${C.voo}" stroke="${C.dotStroke}"/>
      <rect id="chartDot-v" width="7" height="7" fill="${C.v}" stroke="${C.dotStroke}"/>
    </g>
  </svg>
  <div class="chart-legend">
    <span><i style="background:${C.v}"></i>My portfolio</span>
    <span><i style="background:${C.inv}"></i>Net invested</span>
    <span><i style="background:${C.qqq}"></i>QQQ (same flows)</span>
    <span><i style="background:${C.voo}"></i>VOO (same flows)</span>
  </div>`;
}

function attachChartHover() {
  const svg = document.getElementById("valueChart");
  const chart = FILTERED_CHART || PERF_DATA?.chart;
  if (!svg || !chart || chart.length < 2) return;
  const tip = getTip();
  // Same scale as chartSVG
  const W = 860, H = 300, padL = 64, padR = 14, padT = 14, padB = 28;
  const maxV = Math.max(...chart.map(p => Math.max(p.v, p.inv, p.qqq, p.voo))) * 1.05;
  const X = i => padL + (W - padL - padR) * i / (chart.length - 1);
  const Y = v => padT + (H - padT - padB) * (1 - v / maxV);
  const hoverG = svg.querySelector("#chartHoverG");
  const cursor = svg.querySelector("#chartCursor");
  const dots = { v: "#chartDot-v", inv: "#chartDot-inv", qqq: "#chartDot-qqq", voo: "#chartDot-voo" };

  svg.addEventListener("mousemove", e => {
    const rect = svg.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width * W;
    let i = Math.round((x - padL) / (W - padL - padR) * (chart.length - 1));
    i = Math.max(0, Math.min(chart.length - 1, i));
    const p = chart[i], px = X(i);
    cursor.setAttribute("x1", px); cursor.setAttribute("x2", px);
    for (const [key, sel] of Object.entries(dots)) {
      const dot = svg.querySelector(sel);
      dot.setAttribute("x", px - 3.5);
      dot.setAttribute("y", Y(p[key]) - 3.5);
    }
    hoverG.style.display = "block";
    tip.innerHTML = `<b>${p.d}</b><br>My portfolio: $${fmtUSD(p.v)}<br>Net invested: $${fmtUSD(p.inv)}<br>QQQ: $${fmtUSD(p.qqq)} · VOO: $${fmtUSD(p.voo)}`;
    positionTip(tip, e);
  });
  svg.addEventListener("mouseleave", () => {
    tip.style.display = "none";
    hoverG.style.display = "none";
  });
}

function perfHTML(P) {
  const pctCell = v => v == null ? "<td>–</td>"
    : `<td class="${plClass(v)}">${fmtPct(v * 100)}</td>`;
  const years = Object.keys(P.yearTWR).sort();

  const yearRows = years.map(y => {
    const label = y + (y === P.currentYear ? " (YTD)" : "");
    return `<tr><td class="left"><b>${label}</b></td>${pctCell(P.yearTWR[y] - 1)}`
      + BENCHMARKS.map(b => pctCell(P.etfYearTWR[b][y] != null ? P.etfYearTWR[b][y] - 1 : null)).join("") + "</tr>";
  }).join("");

  const whatIfRows = [P.mine, ...P.bench].map(r => {
    const profit = r.value - P.netInvested;
    return `<tr>
      <td class="left"><b class="ticker">${r.name}</b></td>
      <td>$${fmtUSD(P.netInvested)}</td>
      <td>$${fmtUSD(r.value)}</td>
      <td class="${plClass(profit)}">${(profit >= 0 ? "+$" : "-$") + fmtUSD(Math.abs(profit))}</td>
      <td class="${plClass(profit)}">${fmtPct(P.netInvested ? profit / P.netInvested * 100 : null)}</td>
      <td class="${plClass(r.mwr)}">${r.mwr == null ? "–" : fmtPct(r.mwr * 100) + "/yr"}</td>
    </tr>`;
  }).join("");

  const diffs = P.bench.map(b => {
    const d = P.mine.value - b.value;
    return `เทียบกับ ${b.name}: คุณ<span class="${plClass(d)}">${d >= 0 ? "นำอยู่ +$" : "ตามหลัง -$"}${fmtUSD(Math.abs(d))}</span>`;
  }).join(" · ");

  const divYears = Object.keys(P.divByYear).sort().reverse();
  const divDetails = divYears.map((y, i) => {
    const entries = Object.entries(P.divByYear[y]).filter(([, v]) => v > 0.005).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return "";
    const yTotal = entries.reduce((s, [, v]) => s + v, 0);
    const rows = entries.map(([sym, v]) =>
      `<tr><td class="ticker left">${sym}</td><td>$${fmtUSD(v)}</td></tr>`).join("");
    return `<details class="div-year"${i === 0 ? " open" : ""}>
      <summary>${y}${y === P.currentYear ? " (YTD)" : ""} · $${fmtUSD(yTotal)}</summary>
      <table>
        <thead><tr><th class="left">Ticker</th><th>Dividends</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </details>`;
  }).join("");

  const yFirst = +P.chart[0].d.slice(0, 4), yLast = +P.chart[P.chart.length - 1].d.slice(0, 4);
  let yearOpts = '<option value="">Year…</option>';
  for (let y = yLast; y >= yFirst; y--) yearOpts += `<option value="${y}">${y}</option>`;

  return `
  <section>
    <h2>Portfolio value over time</h2>
    <div class="panel">
      <div class="chart-range">
        <button class="cr-btn" data-range="all">All</button>
        <button class="cr-btn" data-range="ytd">YTD</button>
        <button class="cr-btn" data-range="6m">6M</button>
        <button class="cr-btn" data-range="3m">3M</button>
        <select id="chartYearSel">${yearOpts}</select>
      </div>
      <div id="chartBox"></div>
    </div>
  </section>

  <section>
    <h2>Overall returns (since ${P.since})</h2>
    <div class="cards">
      <div class="card"><div class="label">MWR · money-weighted, annualized</div>
        <div class="value ${plClass(P.mine.mwr)}">${P.mine.mwr == null ? "–" : fmtPct(P.mine.mwr * 100)}</div></div>
      <div class="card"><div class="label">TWR · time-weighted, cumulative</div>
        <div class="value ${plClass(P.twr - 1)}">${fmtPct((P.twr - 1) * 100)}</div></div>
      <div class="card"><div class="label">TWR · annualized</div>
        <div class="value ${plClass(P.twrAnnual)}">${P.twrAnnual == null ? "–" : fmtPct(P.twrAnnual * 100)}</div></div>
    </div>
    <div class="panel explain" style="margin-top:14px">
      <h2>คำอธิบาย</h2>
      <p><b>MWR · Money-weighted, annualized</b> — ผลตอบแทนต่อปีแบบ "ถ่วงน้ำหนักด้วยเงินลงทุน" (คำนวณแบบ XIRR)
        เป็นผลตอบแทนส่วนตัวของคุณจริง ๆ เพราะคิดรวมจังหวะเวลาและจำนวนเงินที่ใส่เข้าไปในแต่ละครั้ง
        เช่น ถ้าใส่เงินก้อนใหญ่ช่วงตลาดกำลังขึ้น ค่านี้จะสูงขึ้นตาม ตอบคำถามว่า
        "เงินของฉันโตเฉลี่ยปีละกี่เปอร์เซ็นต์"</p>
      <p><b>TWR · Time-weighted, cumulative</b> — ผลตอบแทนสะสมแบบ "ถ่วงน้ำหนักด้วยเวลา"
        ตั้งแต่ซื้อครั้งแรกจนถึงวันนี้ โดยตัดผลของการฝากเงินเข้า-ออกทิ้งไป
        วัดฝีมือการเลือกหุ้น/กลยุทธ์ล้วน ๆ ไม่เกี่ยวกับจังหวะใส่เงิน ตอบคำถามว่า
        "ถ้าลงเงิน 100 บาทตั้งแต่วันแรกแล้วถือมาตลอด ตอนนี้จะกลายเป็นเท่าไร"</p>
      <p><b>TWR · Annualized</b> — ค่า TWR สะสมข้างบน แปลงเป็นอัตราเฉลี่ยต่อปี
        เพื่อให้เอาไปเทียบกับกองทุนหรือดัชนี (เช่น QQQ, VOO) ที่รายงานผลตอบแทนเป็นรายปีได้ทันที</p>
      <p style="margin-bottom:0"><b>ดูยังไง?</b> — ถ้า MWR สูงกว่า TWR แปลว่าคุณจับจังหวะใส่เงินได้ดี (ใส่เงินก่อนตลาดขึ้น)
        ถ้าต่ำกว่า แปลว่าจังหวะใส่เงินยังไม่ค่อยดี ส่วน TWR ใช้เทียบกับ benchmark ในตารางด้านล่างได้เลย</p>
    </div>
  </section>

  <section>
    <h2>Risk</h2>
    <div class="cards">
      <div class="card"><div class="label">Max drawdown</div>
        <div class="value ${plClass(P.maxDD)}">${fmtPct(P.maxDD * 100)}</div></div>
      <div class="card"><div class="label">Volatility · annualized</div>
        <div class="value">${P.vol == null ? "–" : (P.vol * 100).toFixed(2) + "%"}</div></div>
      <div class="card"><div class="label">Best day</div>
        <div class="value pos">${P.best ? fmtPct(P.best.r * 100) : "–"}</div>
        <div class="delta">${P.best?.d || ""}</div></div>
      <div class="card"><div class="label">Worst day</div>
        <div class="value neg">${P.worst ? fmtPct(P.worst.r * 100) : "–"}</div>
        <div class="delta">${P.worst?.d || ""}</div></div>
    </div>
    <div class="hint" style="color:var(--muted);font-size:15px">
      Max drawdown = worst peak-to-bottom drop of the strategy (deposit-neutral TWR index).
    </div>
    <div class="hint" style="color:var(--muted);font-size:15px">
      Volatility = standard deviation of daily returns x √252.
    </div>
  </section>

  <section>
    <h2>Performance by year (TWR)</h2>
    <div class="panel table-wrap">
      <table>
        <thead><tr><th class="left">Year</th><th>My portfolio</th>${BENCHMARKS.map(b => `<th>${b}</th>`).join("")}</tr></thead>
        <tbody>${yearRows}</tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>What if: same money into QQQ / VOO?</h2>
    <div class="panel table-wrap">
      <table>
        <thead><tr><th class="left">Portfolio</th><th>Net invested</th><th>Value today</th><th>Profit</th><th>Return</th><th>MWR</th></tr></thead>
        <tbody>${whatIfRows}</tbody>
      </table>
    </div>
  </section>

  <section>
    <h2>Dividends received (estimated)</h2>
    <div class="panel table-wrap">
      ${divDetails ? `${divDetails}
        <div class="div-total">Total received: <b>$${fmtUSD(P.divTotal)}</b></div>`
        : `<div class="empty">No dividends detected for your holding periods</div>`}
    </div>
  </section>`;
}

async function renderPerformance() {
  const el = document.getElementById("perfContent");
  if (!ALL_TXS.length) { el.innerHTML = '<div class="empty">Load a CSV first</div>'; return; }
  if (PERF_CACHE) { el.innerHTML = PERF_CACHE; attachChartControls(); return; }
  el.innerHTML = '<div class="empty">Loading historical prices… (first run fetches a few years of data)</div>';
  try {
    const P = await computePerformance(ALL_TXS);
    PERF_DATA = P;
    PERF_CACHE = perfHTML(P);
    el.innerHTML = PERF_CACHE;
    attachChartControls();
  } catch (e) {
    el.innerHTML = `<div class="empty">Could not compute performance: ${e.message}.<br>
      The server must be running (npm start) with internet access to Yahoo Finance.</div>`;
  }
}

// ---------- Cash (USD + THB, persisted in data/cash.json) ----------
let USDTHB = null; // THB per 1 USD

function getCashUSD() {
  const usd = +document.getElementById("cashUSD")?.value || 0;
  const thb = +document.getElementById("cashTHB")?.value || 0;
  return usd + (USDTHB ? thb / USDTHB : 0);
}

function updateCashSummary() {
  const usd = +document.getElementById("cashUSD").value || 0;
  const thb = +document.getElementById("cashTHB").value || 0;
  const el = document.getElementById("cashSummary");
  const thbInUsd = USDTHB ? thb / USDTHB : null;
  let text = `Total cash ≈ $${fmtUSD(usd + (thbInUsd || 0))}`;
  if (USDTHB) text += ` · ฿${fmtUSD(thb)} ≈ $${fmtUSD(thbInUsd)} at 1 USD = ${USDTHB.toFixed(2)} THB`;
  else if (thb) text += ` · THB not converted (exchange rate unavailable)`;
  el.textContent = text;
  if (HOLDINGS.length) renderDonuts(HOLDINGS); // keep the CASH pie slice in sync
}

async function loadCash() {
  try {
    const res = await fetch("/api/cash");
    if (!res.ok) return;
    const c = await res.json();
    document.getElementById("cashUSD").value = c.USD ?? 0;
    document.getElementById("cashTHB").value = c.THB ?? 0;
  } catch { /* server not running */ }
  try {
    const r = await fetch("/api/quotes?symbols=" + encodeURIComponent("THB=X"));
    if (r.ok) USDTHB = (await r.json()).quotes?.["THB=X"]?.price ?? null;
  } catch { /* keep null */ }
  updateCashSummary();
}

async function saveCash() {
  const btn = document.getElementById("cashSave");
  try {
    await fetch("/api/cash", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        USD: +document.getElementById("cashUSD").value || 0,
        THB: +document.getElementById("cashTHB").value || 0,
      }),
    });
    btn.textContent = "Saved ✓";
  } catch {
    btn.textContent = "Failed ✗";
  }
  setTimeout(() => { btn.textContent = "Save"; }, 1500);
  updateCashSummary();
}

document.getElementById("cashSave").addEventListener("click", saveCash);
["cashUSD", "cashTHB"].forEach(id =>
  document.getElementById(id).addEventListener("input", updateCashSummary));
loadCash();

// ---------- Theme toggle ----------
function applyTheme(t, rerender = true) {
  THEME = t;
  localStorage.setItem("theme", t);
  COLORS = PIE_COLORS[t];
  document.body.classList.toggle("theme-b", t === "b");
  document.getElementById("themeSwitch")?.classList.toggle("b", t === "b");
  if (!rerender) return;
  if (HOLDINGS.length) renderDonuts(HOLDINGS);
  if (PERF_DATA) {
    // regenerate the performance HTML so the value chart picks up the new colors
    PERF_CACHE = perfHTML(PERF_DATA);
    if (document.getElementById("tab-performance")?.classList.contains("active")) {
      document.getElementById("perfContent").innerHTML = PERF_CACHE;
      attachChartControls();
    }
  }
}
document.getElementById("themeSwitch").addEventListener("click",
  () => applyTheme(THEME === "a" ? "b" : "a"));
applyTheme(THEME, false);

// ---------- Tabs ----------
function switchTab(id) {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === id));
  document.querySelectorAll(".tab-page").forEach(p => p.classList.toggle("active", p.id === id));
  localStorage.setItem("activeTab", id);
  if (id === "tab-performance") renderPerformance();
}
document.querySelectorAll(".tab-btn").forEach(b =>
  b.addEventListener("click", () => switchTab(b.dataset.tab)));
const savedTab = localStorage.getItem("activeTab");
if (savedTab && document.getElementById(savedTab)) switchTab(savedTab);

// Restore the last uploaded portfolio from data/transactions.json (if the server is running)
loadSavedTransactions();
