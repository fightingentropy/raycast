# Stocks (Raycast)

Raycast command that shows stock prices vertically using Stooq.

## Setup

```bash
npm install
npm run dev
```

Configuration can come from command preferences or env vars:

- `STOCK_TICKERS` (comma-separated)

Symbol notes:
- Standard US equities are resolved as `<ticker>.us` on Stooq.
- `VIX` is resolved as `VI.F` on Stooq.
