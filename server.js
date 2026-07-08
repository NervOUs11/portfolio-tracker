import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YahooFinance from "yahoo-finance2";

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const TX_FILE = path.join(DATA_DIR, "transactions.json");

app.use(express.json({ limit: "5mb" }));
app.use(express.static(__dirname, { index: "index.html" }));

// ---- Live quotes from Yahoo Finance ----
async function quotesViaLibrary(symbols) {
  const results = await yahooFinance.quote(symbols);
  const arr = Array.isArray(results) ? results : [results];
  const out = {};
  for (const q of arr) {
    out[q.symbol] = {
      price: q.regularMarketPrice ?? null,
      changePercent: q.regularMarketChangePercent ?? null,
      currency: q.currency ?? "USD",
      marketState: q.marketState ?? null,
    };
  }
  return out;
}

// Fallback: Yahoo's public chart endpoint — no cookie/crumb handshake,
// which the quote API sometimes blocks with 429.
async function quotesViaChart(symbols) {
  const out = {};
  await Promise.all(symbols.map(async (sym) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`;
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" } });
      if (!res.ok) return;
      const meta = (await res.json())?.chart?.result?.[0]?.meta;
      if (!meta || meta.regularMarketPrice == null) return;
      const prev = meta.chartPreviousClose ?? meta.previousClose;
      out[meta.symbol || sym] = {
        price: meta.regularMarketPrice,
        changePercent: prev ? (meta.regularMarketPrice - prev) / prev * 100 : null,
        currency: meta.currency ?? "USD",
        marketState: null,
      };
    } catch { /* skip symbol */ }
  }));
  return out;
}

// GET /api/quotes?symbols=VOO,MSFT,AAPL
app.get("/api/quotes", async (req, res) => {
  const symbols = (req.query.symbols || "")
    .split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length) return res.status(400).json({ error: "symbols query param required" });
  let quotes = {};
  try { quotes = await quotesViaLibrary(symbols); }
  catch { quotes = await quotesViaChart(symbols); }
  if (!Object.keys(quotes).length)
    return res.status(502).json({ error: "Yahoo Finance request failed for all symbols" });
  res.json({ quotes, fetchedAt: new Date().toISOString() });
});

// ---- Historical daily closes (for the Performance tab) ----
// GET /api/history?symbol=VOO&from=2023-07-24 → { series: [{date, close}, …] }
// Uses dividend/split-adjusted closes; cached in data/history/<SYM>.json for 12h.
const HIST_DIR = path.join(DATA_DIR, "history");

app.get("/api/history", async (req, res) => {
  const symbol = (req.query.symbol || "").trim().toUpperCase();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) return res.status(400).json({ error: "valid symbol required" });
  const fromSec = Math.floor(new Date(req.query.from || "2020-01-01").getTime() / 1000);
  const file = path.join(HIST_DIR, symbol + ".json");

  try {
    const cached = JSON.parse(fs.readFileSync(file, "utf8"));
    if (cached.v === 2 && cached.fromSec <= fromSec && Date.now() - cached.fetchedAt < 12 * 3600e3)
      return res.json(cached);
  } catch { /* no usable cache */ }

  try {
    const now = Math.floor(Date.now() / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
      + `?period1=${fromSec}&period2=${now}&interval=1d&events=div`;
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const result = (await r.json())?.chart?.result?.[0];
    const ts = result?.timestamp || [];
    const close = result?.indicators?.quote?.[0]?.close || [];
    const adj = result?.indicators?.adjclose?.[0]?.adjclose;
    const series = ts
      .map((t, i) => ({ date: new Date(t * 1000).toISOString().slice(0, 10), close: adj?.[i] ?? close[i] }))
      .filter(x => x.close != null);
    if (!series.length) throw new Error("no data");
    const dividends = Object.values(result?.events?.dividends || {})
      .map(d => ({ date: new Date(d.date * 1000).toISOString().slice(0, 10), amount: d.amount }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    const payload = { v: 2, symbol, fromSec, fetchedAt: Date.now(), series, dividends };
    fs.mkdirSync(HIST_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(payload));
    res.json(payload);
  } catch (e) {
    res.status(502).json({ error: `history fetch failed for ${symbol}: ` + e.message });
  }
});

// ---- Cash balances (USD + THB) stored in data/cash.json ----
const CASH_FILE = path.join(DATA_DIR, "cash.json");

app.get("/api/cash", (req, res) => {
  if (!fs.existsSync(CASH_FILE)) return res.json({ USD: 0, THB: 0 });
  res.type("json").send(fs.readFileSync(CASH_FILE, "utf8"));
});

app.post("/api/cash", (req, res) => {
  const { USD = 0, THB = 0 } = req.body || {};
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CASH_FILE, JSON.stringify({ USD: +USD || 0, THB: +THB || 0 }, null, 2));
  res.json({ ok: true, file: "data/cash.json" });
});

// ---- Persist parsed transactions as JSON in data/ ----
app.get("/api/transactions", (req, res) => {
  if (!fs.existsSync(TX_FILE)) return res.json(null);
  res.type("json").send(fs.readFileSync(TX_FILE, "utf8"));
});

app.post("/api/transactions", (req, res) => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TX_FILE, JSON.stringify(req.body, null, 2));
  res.json({ ok: true, file: "data/transactions.json" });
});

app.listen(PORT, () => {
  console.log(`Portfolio tracker running at http://localhost:${PORT}`);
});
