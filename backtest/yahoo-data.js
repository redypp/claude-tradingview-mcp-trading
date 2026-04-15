/**
 * Yahoo Finance daily bar loader for backtests.
 *
 * Free, unauthenticated. Uses the v8 chart endpoint which returns JSON
 * candles. Covers all the ETFs we care about back 20-30 years and BTC
 * from 2014. No API key required.
 *
 * Symbol mapping: our mandates use Alpaca-style symbols (e.g. "BTC/USD").
 * Yahoo uses hyphenated crypto ("BTC-USD"). We translate here.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const CACHE_DIR = "backtest/cache-yahoo";

function ensureDir(p) { if (!existsSync(p)) mkdirSync(p, { recursive: true }); }

function toYahooSymbol(symbol) {
  if (symbol.includes("/")) return symbol.replace("/", "-");
  return symbol;
}

function toUnixSec(dateISO) {
  return Math.floor(new Date(dateISO + "T00:00:00Z").getTime() / 1000);
}

async function fetchYahoo(symbol, startSec, endSec) {
  const ySym = toYahooSymbol(symbol);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}` +
    `?period1=${startSec}&period2=${endSec}&interval=1d&events=history&includeAdjustedClose=true`;
  const res = await fetch(url, {
    headers: {
      // Yahoo occasionally blocks no-UA requests
      "User-Agent": "Mozilla/5.0 (backtest-loader)",
    },
  });
  if (!res.ok) {
    throw new Error(`Yahoo fetch ${ySym} failed: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo: no result for ${ySym}`);
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const adj = result.indicators?.adjclose?.[0]?.adjclose || [];
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    const v = q.volume?.[i] ?? 0;
    const ac = adj[i] ?? c;
    if (o == null || h == null || l == null || c == null) continue;
    const date = new Date(ts[i] * 1000).toISOString().slice(0, 10);
    // Use adjusted close for close to handle splits/dividends; scale OHLV proportionally
    const scale = c !== 0 ? ac / c : 1;
    bars.push({
      date,
      time: ts[i] * 1000,
      open: o * scale,
      high: h * scale,
      low: l * scale,
      close: ac,
      volume: v,
    });
  }
  return bars;
}

export async function loadYahooBars(symbol, startISO, endISO) {
  ensureDir(CACHE_DIR);
  const safe = symbol.replace("/", "_");
  const cachePath = join(CACHE_DIR, `${safe}.json`);
  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    if (cached.start === startISO && cached.end === endISO && cached.bars?.length) {
      return cached.bars;
    }
  }
  const startSec = toUnixSec(startISO);
  const endSec = toUnixSec(endISO) + 86400;
  const bars = await fetchYahoo(symbol, startSec, endSec);
  writeFileSync(cachePath, JSON.stringify({ symbol, start: startISO, end: endISO, bars }));
  return bars;
}
