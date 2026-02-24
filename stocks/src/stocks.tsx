import {
  Action,
  ActionPanel,
  Color,
  getPreferenceValues,
  Icon,
  LaunchProps,
  List,
} from "@raycast/api";
import { useCallback, useEffect, useMemo, useState } from "react";

const STOOQ_QUOTE_ENDPOINT = "https://stooq.com/q/l/";
const CBOE_DELAYED_QUOTES_ENDPOINT =
  "https://cdn.cboe.com/api/global/delayed_quotes/quotes";
const DEFAULT_TICKERS = [
  "SPX",
  "NDX",
  "NVDA",
  "GOOGL",
  "AMZN",
  "TSLA",
  "VIX",
  "HOOD",
  "SNDK",
  "USAR",
];
const REFRESH_INTERVAL_MS = 60_000;
const STOOQ_RETRY_COUNT = 2;
const STOOQ_RETRY_DELAY_MS = 250;
const STOOQ_CONCURRENCY = 2;

type Preferences = {
  defaultTickers?: string;
};

type Arguments = {
  tickers?: string;
};

type StockRow = {
  ticker: string;
  quoteUrlSymbol: string;
  priceLabel: string;
  changeLabel: string;
  changeColor?: Color;
  errorMessage?: string;
};

type CboeQuoteResponse = {
  data?: {
    current_price?: number;
    price_change_percent?: number;
  };
};

function parseTickers(raw?: string): string[] {
  if (!raw) return [];

  const items = raw
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter((value) => value.length > 0);

  return Array.from(new Set(items));
}

function resolveTickers(argTickers?: string, prefTickers?: string): string[] {
  const fromArgs = parseTickers(argTickers);
  if (fromArgs.length > 0) return fromArgs;

  const fromPrefs = parseTickers(prefTickers);
  if (fromPrefs.length > 0) return fromPrefs;

  const fromEnv = parseTickers(process.env.STOCK_TICKERS);
  if (fromEnv.length > 0) return fromEnv;

  return DEFAULT_TICKERS;
}

function formatPrice(value?: number): string {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0)
    return "N/A";
  return `$${value.toFixed(2)}`;
}

function formatChange(changePct?: number): { label: string; color?: Color } {
  if (typeof changePct !== "number" || Number.isNaN(changePct))
    return { label: "N/A" };
  if (changePct > 0)
    return { label: `+${changePct.toFixed(2)}%`, color: Color.Green };
  if (changePct < 0)
    return { label: `${changePct.toFixed(2)}%`, color: Color.Red };
  return { label: "0.00%", color: Color.SecondaryText };
}

function mapTickerToStooqSymbol(ticker: string): string {
  const normalized = ticker.trim().toUpperCase();
  if (normalized === "VIX" || normalized === "^VIX") return "vi.f";
  if (
    normalized === "SPX" ||
    normalized === "S&P" ||
    normalized === "S&P500" ||
    normalized === "SP500"
  )
    return "^spx";
  if (
    normalized === "NASDAQ" ||
    normalized === "NASDAW" ||
    normalized === "NDX"
  )
    return "^ndx";
  if (normalized.startsWith("^")) return normalized.toLowerCase();
  if (normalized.includes(".")) return normalized.toLowerCase();
  return `${normalized.toLowerCase()}.us`;
}

function isVixTicker(ticker: string): boolean {
  const normalized = ticker.trim().toUpperCase();
  return normalized === "VIX" || normalized === "^VIX";
}

function parseStooqCsvQuote(text: string): {
  open?: number;
  close?: number;
  hasData: boolean;
} {
  const fields = text.trim().split(",");
  if (fields.length < 7) return { hasData: false };

  const hasNoData = fields.some((value) => value === "N/D");
  if (hasNoData) return { hasData: false };

  const open = Number(fields[3]);
  const close = Number(fields[6]);

  return {
    open: Number.isFinite(open) && open > 0 ? open : undefined,
    close: Number.isFinite(close) && close > 0 ? close : undefined,
    hasData: true,
  };
}

async function fetchTickerQuote(ticker: string): Promise<StockRow> {
  if (isVixTicker(ticker)) {
    const url = `${CBOE_DELAYED_QUOTES_ENDPOINT}/_VIX.json`;
    try {
      const response = await fetch(url);
      if (response.ok) {
        const payload = (await response.json()) as CboeQuoteResponse;
        const price = payload.data?.current_price;
        const change = formatChange(payload.data?.price_change_percent);
        if (typeof price === "number" && Number.isFinite(price) && price > 0) {
          return {
            ticker,
            quoteUrlSymbol: "vi.f",
            priceLabel: formatPrice(price),
            changeLabel: change.label,
            changeColor: change.color,
          };
        }
      }
    } catch {
      // Fall through to Stooq when Cboe is temporarily unavailable.
    }
  }

  const stooqSymbol = mapTickerToStooqSymbol(ticker);
  const quoteUrlSymbol = stooqSymbol;
  const url = `${STOOQ_QUOTE_ENDPOINT}?s=${encodeURIComponent(stooqSymbol)}&i=d`;

  let lastErrorMessage = "No quote data returned by Stooq for this symbol.";
  for (let attempt = 0; attempt <= STOOQ_RETRY_COUNT; attempt += 1) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        lastErrorMessage = `HTTP ${response.status}`;
      } else {
        const payload = await response.text();
        const parsed = parseStooqCsvQuote(payload);
        if (parsed.hasData && parsed.close) {
          const changePct =
            typeof parsed.open === "number" && parsed.open > 0
              ? ((parsed.close - parsed.open) / parsed.open) * 100
              : undefined;
          const change = formatChange(changePct);

          return {
            ticker,
            quoteUrlSymbol,
            priceLabel: formatPrice(parsed.close),
            changeLabel: change.label,
            changeColor: change.color,
          };
        }
        lastErrorMessage = "No quote data returned by Stooq for this symbol.";
      }
    } catch (error) {
      lastErrorMessage =
        error instanceof Error ? error.message : "Network error";
    }

    if (attempt < STOOQ_RETRY_COUNT) {
      await new Promise((resolve) =>
        setTimeout(resolve, STOOQ_RETRY_DELAY_MS * (attempt + 1)),
      );
    }
  }

  return {
    ticker,
    quoteUrlSymbol,
    priceLabel: "N/A",
    changeLabel: "ERR",
    changeColor: Color.Orange,
    errorMessage: lastErrorMessage,
  };
}

async function fetchTickerQuotes(tickers: string[]): Promise<StockRow[]> {
  const rows: StockRow[] = [];
  for (let index = 0; index < tickers.length; index += STOOQ_CONCURRENCY) {
    const chunk = tickers.slice(index, index + STOOQ_CONCURRENCY);
    const chunkRows = await Promise.all(
      chunk.map((ticker) => fetchTickerQuote(ticker)),
    );
    rows.push(...chunkRows);
  }
  return rows;
}

export default function StocksCommand(
  props: LaunchProps<{ arguments: Arguments }>,
) {
  const preferences = getPreferenceValues<Preferences>();
  const tickers = useMemo(
    () => resolveTickers(props.arguments.tickers, preferences.defaultTickers),
    [preferences.defaultTickers, props.arguments.tickers],
  );

  const [rows, setRows] = useState<StockRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadQuotes = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);

    try {
      const fetched = await fetchTickerQuotes(tickers);
      setRows(fetched);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Failed to load quotes",
      );
      setRows([]);
    } finally {
      setIsLoading(false);
    }
  }, [tickers]);

  useEffect(() => {
    void loadQuotes();
    const intervalId = setInterval(
      () => void loadQuotes(),
      REFRESH_INTERVAL_MS,
    );
    return () => clearInterval(intervalId);
  }, [loadQuotes]);

  return (
    <List
      isLoading={isLoading}
      searchBarPlaceholder="Stocks update every minute"
      navigationTitle="Stocks"
      isShowingDetail={false}
    >
      {loadError ? (
        <List.EmptyView
          title="Unable to load stocks"
          description={loadError}
          actions={
            <ActionPanel>
              <Action
                title="Refresh"
                icon={Icon.ArrowClockwise}
                onAction={loadQuotes}
              />
            </ActionPanel>
          }
        />
      ) : null}

      {rows.map((row) => (
        <List.Item
          key={row.ticker}
          icon={Icon.Building}
          title={row.ticker}
          subtitle={row.priceLabel}
          accessories={[
            {
              tag: {
                value: row.changeLabel,
                color: row.changeColor,
              },
            },
          ]}
          actions={
            <ActionPanel>
              <Action
                title="Refresh"
                icon={Icon.ArrowClockwise}
                onAction={loadQuotes}
              />
              <Action.OpenInBrowser
                title="Open in Stooq"
                url={`https://stooq.com/q/?s=${encodeURIComponent(row.quoteUrlSymbol)}`}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
