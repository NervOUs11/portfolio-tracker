# 📈 Stock Transaction Tracker

A pixel-game-themed web app for tracking your stock portfolio. Upload a CSV of your
trades and get live prices from Yahoo Finance, holdings with unrealized P/L, allocation
pie charts, a GitHub-style investment activity heatmap, and professional performance
metrics (TWR / MWR) benchmarked against QQQ and VOO.

## Features

- **CSV import** — drag & drop your trade history; parsed entirely in the browser
  - Header detected by name (not position), works with English and Thai headers
  - Thai month names (มกราคม–ธันวาคม) and Buddhist-era years supported
  - Google Sheets exports with extra summary columns are handled automatically
  - Actions: `Buy`, `Sell`, `Split`
- **Live prices** — current value and unrealized P/L computed from Yahoo Finance
  quotes (with automatic fallback to CSV snapshot values when offline)
- **Summary cards** — current value, total cost, unrealized P/L ($ and %) — always visible

### Activity tab
- GitHub contributions-style heatmap of buys per day — one pixel per day, green
  intensity = USD invested, year selector buttons, hover tooltip with the exact amount
- Filterable, sortable transactions table (by ticker, action, free-text note search)

### Holdings tab
- Holdings table: price with day change, shares, current value, avg cost, cost basis, P/L
- Drag column headers to reorder — layout is remembered
- Two allocation pies (by cost and by current price), slices sorted by %, with
  per-ticker checkboxes to include/exclude positions

### Performance tab
- **Performance by year** — your portfolio vs QQQ vs VOO for each calendar year
  (current year marked YTD), computed from daily historical closes
- **MWR** (money-weighted return, XIRR, annualized) — your personal return, counting
  the timing and size of every deposit
- **TWR** (time-weighted return, cumulative + annualized) — the strategy's return with
  deposit timing neutralized, daily linked
- **What-if benchmark** — every buy/sell mirrored into QQQ and VOO at that day's actual
  close (same dates, same dollars): net invested, value today, profit, and MWR side by side
- Thai-language explainer (คำอธิบาย) of all three metrics

### Persistence
- Parsed transactions are saved to `data/transactions.json` and restored automatically
  on the next visit (snapshot fields `curValue`/`pl` are stripped before saving)
- Historical price series are cached in `data/history/` for 12 hours
- Preferences (column order, pie filter, selected year, active tab) are remembered
  in the browser via localStorage

## Getting started

```bash
npm install
npm start        # → http://localhost:3000
```

For development with auto-restart on server changes:

```bash
npm run dev
```

Use a different port:

```bash
PORT=8080 npm start
```

Then open the app, drop your CSV on the upload zone, and you're done.
The page can also be opened directly as a file (no server) — everything works except
live prices, persistence, and the Performance tab, which need the local server.

## CSV format

The parser scans the first 10 rows for a header row and matches columns by name.
Only **date**, **ticker**, and **action** are required; everything else is optional.

| Column | Accepted header names (examples) |
|---|---|
| Date *(required)* | `Date`, `วันที่` |
| Ticker *(required)* | `Ticker`, `Symbol`, `ชื่อหุ้น` |
| Action *(required)* | `Action`, `Side`, `Type` — values `Buy` / `Sell` / `Split` |
| Price | `Price`, `ราคาตอนที่ซื้อ/ขาย (USD)` |
| Shares | `Shares`, `Qty`, `Quantity`, `จำนวนหุ้น` |
| Amount | `Amount`, `ราคาที่จ่าย (USD)` |
| Fee | `Fee`, `Commission`, `ค่าธรรมเนียม (USD)` |
| Cost | `Cost`, `ต้นทุน (USD)` |
| Current value | `Current value`, `มูลค่าปัจจุบัน (USD)` — snapshot fallback only |
| Note | `Note`, `Memo`, `หมายเหตุ` |

Dates accept `DD/MM/YYYY`, `YYYY-MM-DD`, English month names, and Thai month
names with Buddhist-era years (e.g. `31/กรกฎาคม/2566`).

## Project structure

```
portfolio-tracker/
├── index.html          # page structure (tabs, tables, charts)
├── css/styles.css      # pixel game theme (palette in :root)
├── js/app.js           # CSV parsing, portfolio math, rendering, performance metrics
├── server.js           # Express server: static files + API
├── data/               # saved portfolio & price cache — gitignored
│   ├── transactions.json
│   └── history/<SYM>.json
└── package.json
```

## API

The Express server ([server.js](server.js)) exposes:

| Endpoint | Description |
|---|---|
| `GET /api/quotes?symbols=VOO,MSFT` | Live quotes from Yahoo Finance. Tries the `yahoo-finance2` library first, falls back to Yahoo's public chart endpoint if the quote API is rate-limited. |
| `GET /api/history?symbol=VOO&from=2023-07-24` | Daily dividend/split-adjusted closes since `from`, cached in `data/history/` for 12 hours. |
| `GET /api/transactions` | Returns the saved portfolio JSON (or `null`). |
| `POST /api/transactions` | Saves the parsed portfolio to `data/transactions.json`. Snapshot fields (`curValue`, `pl`) are stripped before saving. |

## How the numbers are calculated

- **Cost basis** per ticker = Σ cost of buys − Σ cost of sells (splits carry cost over)
- **Current value** = live price × shares held
- **Unrealized P/L** = current value − cost basis (open positions only;
  realized gains from past sells are not included)
- **TWR** = daily-linked growth factors `V_t / (V_{t-1} + flow_t)` over every trading
  day since the first purchase; yearly figures link only that year's days
- **MWR** = XIRR over dated cash flows (buys negative, sell proceeds positive,
  today's portfolio value terminal), solved by bisection
- **Benchmarks** mirror every cash flow into QQQ/VOO at that day's adjusted close —
  sells included — so all three portfolios see identical deposits and withdrawals

**Approximations:** sell proceeds are estimated as `price × shares` (the source sheet
doesn't record them); positions held through a stock split are valued approximately
before the split date, since Yahoo's history is retroactively split-adjusted. Weekend
trades roll to the next trading session.

## Theme

The pixel-game palette lives in `:root` of [css/styles.css](css/styles.css):
`#0D0D0D · #7A4A2F · #E8E2D6 · #2E4A3B · #E11D24 · #E4572E · #2B2B2B · #F7F7F5`
with Press Start 2P + VT323 fonts, hard drop shadows, and a CRT scanline overlay.
Edit the CSS variables to retheme.

## Privacy

Your trade data never leaves your machine: the CSV is parsed in the browser,
saved only to the local `data/` folder (gitignored along with `csv/`), and the
only outbound requests are ticker symbols sent to Yahoo Finance for prices.
