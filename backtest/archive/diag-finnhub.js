/**
 * Diagnostic: probe Finnhub's insider-transactions endpoint to see
 * how far back the free tier actually returns data.
 *
 * If the free tier is truncated to recent months/year, that explains
 * why our 5-year backtest produced so few insider-based trades.
 * If not, paying for Basic won't help and the insider thesis really
 * doesn't work.
 */

import "dotenv/config";

const KEY = process.env.FINNHUB_API_KEY;
if (!KEY) {
  console.error("FINNHUB_API_KEY missing from .env");
  process.exit(1);
}

// Known large-cap names with documented insider activity over the years
const PROBE_SYMBOLS = ["META", "GOOGL", "TSLA", "AMZN", "NVDA", "JPM", "INTC", "DIS"];

async function fetchInsiders(symbol) {
  const url = `https://finnhub.io/api/v1/stock/insider-transactions?symbol=${symbol}&token=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    return { error: `${res.status} ${res.statusText}` };
  }
  const data = await res.json();
  const all = data.data || [];
  const p = all.filter((t) => t.transactionCode === "P");
  const dates = all.map((t) => t.transactionDate).filter(Boolean).sort();
  const pDates = p.map((t) => t.transactionDate).filter(Boolean).sort();
  return {
    totalRows: all.length,
    earliestAny: dates[0] || null,
    latestAny: dates[dates.length - 1] || null,
    openMarketBuyRows: p.length,
    earliestBuy: pDates[0] || null,
    latestBuy: pDates[pDates.length - 1] || null,
  };
}

(async () => {
  console.log("── Finnhub insider-transactions coverage probe ──\n");
  console.log("symbol  | total rows | earliest any  latest any  | open-mkt buys | earliest buy  latest buy");
  console.log("─".repeat(100));
  for (const s of PROBE_SYMBOLS) {
    const r = await fetchInsiders(s);
    if (r.error) {
      console.log(`${s.padEnd(7)} | ERROR: ${r.error}`);
      continue;
    }
    console.log(
      `${s.padEnd(7)} | ${String(r.totalRows).padStart(10)} | ${(r.earliestAny || "—").padEnd(13)} ${(r.latestAny || "—").padEnd(11)} | ${String(r.openMarketBuyRows).padStart(13)} | ${(r.earliestBuy || "—").padEnd(13)} ${(r.latestBuy || "—")}`,
    );
  }
  console.log("\nIf earliestAny is within the last ~1 year for all symbols,");
  console.log("the free tier is truncating history — paying would help.");
  console.log("If earliestAny reaches 2020-2021, the free tier has full history");
  console.log("and the insider thesis genuinely doesn't hold up.");
})();
