# 📈 Stock Transaction Tracker

A retro pixel-game-themed web app for tracking your stock portfolio. Upload a CSV of
your trades and get live prices from Yahoo Finance, holdings with unrealized P/L,
allocation pie charts, a GitHub-style investment activity heatmap, cash tracking in
USD + THB, and professional performance analytics (TWR / MWR, risk stats, dividends)
benchmarked against QQQ and VOO.

Built for Google Sheets CSV exports with **Thai-language headers and dates**
(e.g. `31/กรกฎาคม/2023`), but generic English CSVs work too. Explanations on the
Performance tab are written in Thai.

## Features

- **CSV import** — drag & drop your trade history; parsed entirely in the browser
  - Header detected by name (not position), works with English and Thai headers
  - Thai month names (มกราคม–ธันวาคม) and Buddhist-era years supported
  - Google Sheets exports with extra summary columns are handled automatically
  - Actions: `Buy`, `Sell`, `Split`
- **Live prices** — current value and unrealized P/L from Yahoo Finance quotes
  (with automatic fallback to CSV snapshot values when the server is unavailable)
- **Summary cards** (always visible): current value, net invested (buy cost + fees −
  sells), and unrealized P/L in $ and %
- **Two themes** — a dark pixel-arcade theme and a light "creamy" theme, switchable
  with the toggle on the left edge; choice is remembered

### Activity tab
- **Investment heatmap** — GitHub contributions-style pixel grid of **buys** per day
  (sells and split re-adds excluded), one pixel per day, green intensity = USD invested,
  year selector buttons, hover tooltip with the exact amount
- **Transactions table** — filterable (ticker, action, free-text note search) and
  sortable, with price / shares / amount / fee / cost / note columns

### Holdings tab
- **Holdings table** — price with day change, shares, current value, avg cost, cost
  basis, unrealized P/L ($ and %); drag column headers to reorder (layout remembered)
- **Cash** — enter USD and THB balances; THB is converted at the live exchange rate
  and the total is shown. Saved to `data/cash.json`
- **Allocation pies** — by cost and by current price, slices sorted by %, each ticker
  (plus a **CASH** slice) toggleable via checkboxes

### Performance tab
- **Portfolio value over time** — line chart of your portfolio vs net invested vs
  mirrored QQQ/VOO, with a range selector (All / YTD / 6M / 3M / specific year),
  hover cursor + dots, and a day/month/year x-axis
- **Overall returns** — MWR (money-weighted, XIRR, annualized) and TWR (time-weighted,
  cumulative + annualized), with a Thai explainer box (คำอธิบาย)
- **Risk** — max drawdown, annualized volatility, best/worst day
- **Performance by year (TWR)** — your portfolio vs QQQ vs VOO per calendar year
  (current year marked YTD)
- **What-if benchmark** — every buy/sell mirrored into QQQ and VOO at that day's close
  (same dates, same dollars): net invested, value today, profit, return, and MWR
- **Dividends received (estimated)** — collapsible per-year boxes with a per-stock
  breakdown and grand total
- All explanatory notes on this tab are in **Thai**

### Persistence
- Parsed transactions → `data/transactions.json`, restored automatically on next visit
  (snapshot fields `curValue`/`pl` are stripped before saving)
- Cash balances → `data/cash.json`
- Historical price series → cached in `data/history/` for 12 hours
- UI preferences (theme, column order, pie filter, chart range, heatmap year, active
  tab) are remembered in the browser via localStorage

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
live prices, cash persistence, and the Performance tab, which need the local server.

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
├── css/styles.css      # pixel + creamy themes (palettes in :root / body.theme-b)
├── js/app.js           # CSV parsing, portfolio math, rendering, performance metrics
├── server.js           # Express server: static files + API
├── data/               # saved portfolio, cash, price cache — gitignored
│   ├── transactions.json
│   ├── cash.json
│   └── history/<SYM>.json
├── csv/                # your CSV exports (gitignored)
└── package.json
```

## API

The Express server ([server.js](server.js)) exposes:

| Endpoint | Description |
|---|---|
| `GET /api/quotes?symbols=VOO,MSFT` | Live quotes from Yahoo Finance. Tries the `yahoo-finance2` library first, falls back to Yahoo's public chart endpoint if the quote API is rate-limited. Also serves the `THB=X` exchange rate. |
| `GET /api/history?symbol=VOO&from=2023-07-24` | Daily dividend/split-adjusted closes + dividend events since `from`, cached in `data/history/` for 12 hours. |
| `GET` / `POST /api/transactions` | Load / save the parsed portfolio (`data/transactions.json`). Snapshot fields (`curValue`, `pl`) are stripped on save. |
| `GET` / `POST /api/cash` | Load / save cash balances (`data/cash.json`, `{ USD, THB }`). |

## How the numbers are calculated

- **Cost basis** per ticker = Σ cost of buys − Σ cost of sells (splits carry cost over)
- **Net invested** = buy amounts (fees included) − estimated sell proceeds
- **Current value** = live price × shares held
- **Unrealized P/L** = current value − cost basis (open positions only; realized gains
  from past sells are not included)
- **TWR** = daily-linked growth factors `V_t / (V_{t-1} + flow_t)` over every trading
  day since the first purchase; yearly figures link only that year's days
- **MWR** = XIRR over dated cash flows (buys negative, sell proceeds positive, today's
  portfolio value terminal), solved by bisection
- **Benchmarks** mirror every cash flow into QQQ/VOO at that day's adjusted close —
  sells included — so all three portfolios see identical deposits and withdrawals
- **Risk**: max drawdown = worst peak-to-bottom drop of the deposit-neutral TWR index;
  volatility = stdev of daily returns × √252
- **Dividends** = shares held on each ex-dividend date × dividend per share (from Yahoo
  history); shown separately because the return figures already include dividends via
  adjusted prices

**Approximations:** sell proceeds are estimated as `price × shares` (the source sheet
doesn't record them); positions held through a stock split are valued approximately
before the split date, since Yahoo's history is retroactively split-adjusted. Weekend
trades roll to the next trading session.

## Themes

Two palettes, toggled by the switch on the left edge (remembered in localStorage):

- **Dark pixel** (default) — `#0D0D0D · #7A4A2F · #E8E2D6 · #2E4A3B · #E11D24 ·
  #E4572E · #2B2B2B · #F7F7F5`
- **Creamy** (light) — warm cream / latte / caramel tones

Both use Press Start 2P + VT323 fonts, hard drop shadows, and a CRT scanline overlay.
Theme variables live in `:root` (dark) and `body.theme-b` (creamy) in
[css/styles.css](css/styles.css); the chart/pie color sets are in `PIE_COLORS` /
`CHART_COLORS` in [js/app.js](js/app.js). Thai text falls back to the system font,
since the pixel fonts don't include Thai glyphs.

## Privacy

Your trade data never leaves your machine: the CSV is parsed in the browser, saved
only to the local `data/` folder (gitignored along with `csv/`), and the only outbound
requests are ticker symbols sent to Yahoo Finance for prices.
