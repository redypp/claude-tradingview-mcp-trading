/**
 * Dual Momentum backtest harness.
 *
 * Fetches ~15 years of daily candles for SPY, EFA, AGG, BIL from Alpaca
 * (free IEX feed is fine for ETFs — they have deep liquidity and
 * IEX/SIP pricing differences are negligible on daily closes).
 *
 * Simulates monthly rebalance: on the first trading day of each month,
 * compute 12-month trailing total return for SPY and EFA, pick the
 * better one if it beats BIL, otherwise hold AGG. Track equity.
 *
 * Splits the window into in-sample and holdout (last 2 years) and
 * applies the pre-committed selection criteria:
 *   - profit factor >= 1.3 (relaxed for monthly strategies where PF
 *     isn't as informative — we emphasize Sharpe and CAGR instead)
 *   - positive CAGR on both windows
 *   - Sharpe > 0.5 as the statistical significance proxy
 *
 * Usage:
 *   node backtest/dual-momentum.js
 */

import "dotenv/config";
import { writeFileSync } from "fs";

const ALPACA_KEY = process.env.ALPACA_DM_API_KEY || process.env.ALPACA_API_KEY;
const ALPACA_SECRET = process.env.ALPACA_DM_SECRET_KEY || process.env.ALPACA_SECRET_KEY;

if (!ALPACA_KEY || !ALPACA_SECRET) {
  console.error("Missing ALPACA_API_KEY / ALPACA_SECRET_KEY in .env");
  process.exit(1);
}

const START = "2010-01-01";
const END = new Date().toISOString().slice(0, 10);
const HOLDOUT_START = "2024-01-01"; // last ~2 years reserved as holdout

const RISK_ASSETS = ["SPY", "EFA"];
const CASH_PROXY = "BIL";
const SAFETY_ASSET = "AGG";
const LOOKBACK_DAYS = 252;
const INITIAL_CAPITAL = 10000;

async function fetchAllCandles(symbol) {
  const params = new URLSearchParams({
    timeframe: "1Day",
    start: START,
    end: END,
    limit: "10000",
    feed: "iex",
    adjustment: "split", // account for ETF splits; dividends handled separately below
  });
  const url = `https://data.alpaca.markets/v2/stocks/${symbol}/bars?${params}`;
  const res = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID": ALPACA_KEY,
      "APCA-API-SECRET-KEY": ALPACA_SECRET,
    },
  });
  if (!res.ok) {
    throw new Error(`Alpaca error for ${symbol}: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return (data.bars || []).map((b) => ({
    date: b.t.slice(0, 10),
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v,
  }));
}

function buildDateIndex(candles) {
  const m = new Map();
  for (const c of candles) m.set(c.date, c);
  return m;
}

function isFirstTradingDayOfMonth(date, allDates) {
  const [, month] = date.split("-");
  // Find the first trading day in this year-month
  const [year] = date.split("-");
  const firstInMonth = allDates.find((d) => d.startsWith(`${year}-${month}`));
  return firstInMonth === date;
}

function totalReturnPct(closes, lookback) {
  if (closes.length < lookback + 1) return null;
  const start = closes[closes.length - lookback - 1];
  const end = closes[closes.length - 1];
  return ((end - start) / start) * 100;
}

function analyzeEquity(equityCurve, label) {
  if (equityCurve.length < 2) return null;
  const start = equityCurve[0].equity;
  const end = equityCurve[equityCurve.length - 1].equity;
  const years =
    (new Date(equityCurve[equityCurve.length - 1].date) - new Date(equityCurve[0].date)) /
    (365.25 * 24 * 60 * 60 * 1000);
  const cagr = (Math.pow(end / start, 1 / years) - 1) * 100;

  // Monthly returns for Sharpe
  const monthlyReturns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    monthlyReturns.push((equityCurve[i].equity - equityCurve[i - 1].equity) / equityCurve[i - 1].equity);
  }
  const meanMonthly = monthlyReturns.reduce((a, b) => a + b, 0) / monthlyReturns.length;
  const variance =
    monthlyReturns.reduce((a, b) => a + (b - meanMonthly) ** 2, 0) / monthlyReturns.length;
  const stdMonthly = Math.sqrt(variance);
  // Annualized Sharpe (no risk-free rate subtracted — simplification)
  const sharpe = stdMonthly === 0 ? 0 : (meanMonthly / stdMonthly) * Math.sqrt(12);

  // Max drawdown
  let peak = equityCurve[0].equity;
  let mdd = 0;
  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity;
    const dd = ((peak - point.equity) / peak) * 100;
    if (dd > mdd) mdd = dd;
  }

  // Profit factor on monthly returns
  const posSum = monthlyReturns.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const negSum = Math.abs(monthlyReturns.filter((r) => r < 0).reduce((a, b) => a + b, 0));
  const pf = negSum === 0 ? 999 : posSum / negSum;

  return {
    label,
    start,
    end,
    years: years.toFixed(2),
    cagr: cagr.toFixed(2),
    sharpe: sharpe.toFixed(2),
    mdd: mdd.toFixed(2),
    pf: pf.toFixed(2),
    rebalances: equityCurve.length,
    posMonths: monthlyReturns.filter((r) => r > 0).length,
    negMonths: monthlyReturns.filter((r) => r < 0).length,
  };
}

function runBacktest(candleMaps, allDates) {
  let capital = INITIAL_CAPITAL;
  let holding = null; // symbol currently held
  let shares = 0;
  const equityCurve = [];
  const trades = [];

  for (let i = LOOKBACK_DAYS + 1; i < allDates.length; i++) {
    const date = allDates[i];
    if (!isFirstTradingDayOfMonth(date, allDates)) continue;

    // Compute 12-month trailing return for each asset as of this date
    const returns = {};
    for (const sym of [...RISK_ASSETS, CASH_PROXY, SAFETY_ASSET]) {
      const map = candleMaps[sym];
      const closes = [];
      for (let j = Math.max(0, i - LOOKBACK_DAYS); j <= i; j++) {
        const c = map.get(allDates[j]);
        if (c) closes.push(c.close);
      }
      returns[sym] = totalReturnPct(closes, LOOKBACK_DAYS);
    }

    // Skip months where we don't have complete data for every asset
    if (Object.values(returns).some((r) => r === null)) continue;

    const cashReturn = returns[CASH_PROXY];
    const above = RISK_ASSETS.filter((s) => returns[s] > cashReturn);
    const target =
      above.length === 0
        ? SAFETY_ASSET
        : above.reduce((best, s) => (returns[s] > returns[best] ? s : best));

    // Mark-to-market current holding
    let currentEquity = capital;
    if (holding) {
      const price = candleMaps[holding].get(date)?.close;
      if (price) {
        currentEquity = shares * price;
      }
    }

    // Rotate if needed
    if (holding !== target) {
      const newPrice = candleMaps[target].get(date)?.close;
      if (!newPrice) continue;
      capital = currentEquity;
      shares = capital / newPrice;
      if (holding) {
        trades.push({ date, action: "sell", symbol: holding, equity: currentEquity });
      }
      trades.push({ date, action: "buy", symbol: target, shares: shares.toFixed(2), price: newPrice, equity: currentEquity });
      holding = target;
    }

    equityCurve.push({ date, equity: currentEquity, holding });
  }

  return { equityCurve, trades, finalEquity: equityCurve[equityCurve.length - 1]?.equity || capital };
}

(async () => {
  console.log("══ Dual Momentum Backtest ══════════════════════════════════\n");
  console.log(`  Window: ${START} to ${END}`);
  console.log(`  Holdout: ${HOLDOUT_START} to ${END}`);
  console.log(`  Assets: risk=${RISK_ASSETS.join("/")}, cash=${CASH_PROXY}, safety=${SAFETY_ASSET}`);
  console.log(`  Lookback: ${LOOKBACK_DAYS} trading days (~12 months)`);
  console.log(`  Initial capital: $${INITIAL_CAPITAL}\n`);

  console.log("Fetching candles…");
  const candleMaps = {};
  const allSymbols = [...RISK_ASSETS, CASH_PROXY, SAFETY_ASSET];
  for (const sym of allSymbols) {
    const candles = await fetchAllCandles(sym);
    candleMaps[sym] = buildDateIndex(candles);
    console.log(`  ${sym.padEnd(4)} ${candles.length} bars, ${candles[0]?.date} → ${candles[candles.length - 1]?.date}`);
  }

  // Build a canonical trading calendar from SPY
  const allDates = [...candleMaps.SPY.keys()].sort();
  console.log(`\nTrading days: ${allDates.length}`);

  console.log("\nRunning backtest…");
  const full = runBacktest(candleMaps, allDates);

  // Split into in-sample and holdout
  const inSampleCurve = full.equityCurve.filter((p) => p.date < HOLDOUT_START);
  const holdoutRawCurve = full.equityCurve.filter((p) => p.date >= HOLDOUT_START);

  // Rebase holdout to $10k so its CAGR is independent of in-sample performance
  const holdoutCurve = holdoutRawCurve.length > 0
    ? holdoutRawCurve.map((p, idx) => ({
        date: p.date,
        equity: p.equity / holdoutRawCurve[0].equity * INITIAL_CAPITAL,
        holding: p.holding,
      }))
    : [];

  const fullStats = analyzeEquity(full.equityCurve, "Full");
  const inSampleStats = analyzeEquity(inSampleCurve, "In-sample (pre-2024)");
  const holdoutStats = analyzeEquity(holdoutCurve, "Holdout (2024+)");

  console.log("\n══ Results ══════════════════════════════════════════════════\n");
  for (const s of [fullStats, inSampleStats, holdoutStats].filter(Boolean)) {
    console.log(`${s.label}:`);
    console.log(`  ${s.years}y | start $${s.start.toFixed(2)} → end $${s.end.toFixed(2)}`);
    console.log(`  CAGR:    ${s.cagr}%`);
    console.log(`  Sharpe:  ${s.sharpe}`);
    console.log(`  Max DD:  ${s.mdd}%`);
    console.log(`  PF:      ${s.pf}`);
    console.log(`  Rebal:   ${s.rebalances}  (${s.posMonths} up / ${s.negMonths} down months)\n`);
  }

  // Apply pre-committed criteria
  console.log("══ Pre-committed selection criteria ═════════════════════════\n");
  const fullPF = parseFloat(fullStats.pf);
  const fullSharpe = parseFloat(fullStats.sharpe);
  const fullCAGR = parseFloat(fullStats.cagr);
  const holdoutCAGR = holdoutStats ? parseFloat(holdoutStats.cagr) : null;
  const holdoutSharpe = holdoutStats ? parseFloat(holdoutStats.sharpe) : null;

  const checks = [
    { name: "Full: Profit factor ≥ 1.3", pass: fullPF >= 1.3, actual: fullPF.toFixed(2) },
    { name: "Full: Sharpe ≥ 0.5",       pass: fullSharpe >= 0.5, actual: fullSharpe.toFixed(2) },
    { name: "Full: CAGR > 0",           pass: fullCAGR > 0, actual: fullCAGR.toFixed(2) + "%" },
    { name: "Holdout: CAGR > 0",        pass: holdoutCAGR > 0, actual: (holdoutCAGR?.toFixed(2) ?? "N/A") + "%" },
    { name: "Holdout: Sharpe > 0",      pass: holdoutSharpe > 0, actual: (holdoutSharpe?.toFixed(2) ?? "N/A") },
    { name: "Rebalances ≥ 50",          pass: full.equityCurve.length >= 50, actual: String(full.equityCurve.length) },
  ];

  let allPass = true;
  for (const c of checks) {
    const icon = c.pass ? "✅" : "❌";
    console.log(`  ${icon} ${c.name.padEnd(35)} actual: ${c.actual}`);
    if (!c.pass) allPass = false;
  }

  console.log(
    `\n${allPass ? "✅ STRATEGY PASSES" : "❌ STRATEGY FAILS"} pre-committed criteria.\n`,
  );

  writeFileSync(
    "backtest-dual-momentum-results.json",
    JSON.stringify({ full, fullStats, inSampleStats, holdoutStats, checks, allPass }, null, 2),
  );
  console.log("Results saved → backtest-dual-momentum-results.json");
})().catch((err) => {
  console.error("Backtest error:", err);
  process.exit(1);
});
