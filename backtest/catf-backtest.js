/**
 * Backtest — CATF (Cross-Asset Trend Following).
 *
 * Monthly rebalance. For each rebalance date:
 *   - Compute 12-month return for each asset
 *   - Qualifying set = assets with positive 12-month return
 *   - Equal-weight across qualifying set (or 100% cash proxy if empty)
 *   - Mark portfolio to market daily for equity curve
 *
 * Usage:
 *   node backtest/catf-backtest.js
 *   node backtest/catf-backtest.js --start=2010-01-01 --end=2024-12-31 --holdout=2020-01-01
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { createAlpacaClient } from "../brokers/alpaca.js";
import { loadMandate } from "../portfolio/mandate.js";
import { loadYahooBars } from "./yahoo-data.js";

const CACHE_DIR = "backtest/cache";

function parseArgs() {
  return Object.fromEntries(
    process.argv.slice(2)
      .filter((a) => a.startsWith("--"))
      .map((a) => { const [k, v] = a.slice(2).split("="); return [k, v ?? true]; }),
  );
}

function ensureDir(p) { if (!existsSync(p)) mkdirSync(p, { recursive: true }); }

async function loadBars(broker, symbol, start, end) {
  ensureDir(CACHE_DIR);
  const safeName = symbol.replace("/", "_");
  const cachePath = join(CACHE_DIR, `${safeName}.json`);
  if (existsSync(cachePath)) {
    const c = JSON.parse(readFileSync(cachePath, "utf8"));
    if (c.start === start && c.end === end && c.bars?.length) return c.bars;
  }
  const bars = await broker.fetchCandles(symbol, "1D", { start, end, limit: 10000 });
  writeFileSync(cachePath, JSON.stringify({ symbol, start, end, bars }));
  return bars;
}

function isLastBusinessDay(date, allDates) {
  const next = allDates.find((d) => d > date);
  if (!next) return true;
  return date.slice(0, 7) !== next.slice(0, 7);
}

function simulate({ universe, barsBySymbol, allDates, rules, startCapital, startDate, endDate, cashProxy, cashProxyBars }) {
  const lookbackBars = Math.floor((rules.lookbackMonths ?? 12) * 21);
  const tradingDates = allDates.filter((d) => d >= startDate && d <= endDate);

  // Index bars by date per symbol for O(1) lookup
  const dateIdx = {};
  for (const [sym, bars] of Object.entries(barsBySymbol)) {
    dateIdx[sym] = Object.fromEntries(bars.map((b, i) => [b.date, { ...b, i }]));
  }
  const cashProxyIdx = Object.fromEntries(cashProxyBars.map((b, i) => [b.date, { ...b, i }]));

  // Portfolio: { cash, positions: { symbol: { shares, entryPrice } } }
  let cash = startCapital;
  const positions = {}; // symbol → shares
  const rebalanceDates = [];
  const equityCurve = [];
  const trades = [];

  function markToMarket(dateISO) {
    let eq = cash;
    for (const [sym, sh] of Object.entries(positions)) {
      const bar = dateIdx[sym]?.[dateISO] || cashProxyIdx[dateISO];
      if (bar && sym === cashProxy) eq += sh * cashProxyIdx[dateISO]?.close || 0;
      else if (bar) eq += sh * bar.close;
    }
    // Handle cashProxy which isn't in dateIdx
    if (positions[cashProxy] && cashProxyIdx[dateISO]) {
      // already counted? re-compute to avoid double-count
    }
    return eq;
  }

  const lastPrice = {}; // sym → last known close

  function updateLastPrices(dateISO) {
    for (const sym of Object.keys(dateIdx)) {
      const bar = dateIdx[sym]?.[dateISO];
      if (bar) lastPrice[sym] = bar.close;
    }
    const cBar = cashProxyIdx[dateISO];
    if (cBar) lastPrice[cashProxy] = cBar.close;
  }

  function markToMarketCorrect(dateISO) {
    let eq = cash;
    for (const [sym, sh] of Object.entries(positions)) {
      const px = lastPrice[sym];
      if (px != null) eq += sh * px;
    }
    return eq;
  }

  function rebalance(dateISO) {
    // Compute signals
    const qualifiers = [];
    for (const asset of universe) {
      const sym = asset.symbol;
      const bars = barsBySymbol[sym];
      if (!bars) continue;
      const bar = dateIdx[sym]?.[dateISO];
      if (!bar) continue;
      if (bar.i < lookbackBars) continue;
      const past = bars[bar.i - lookbackBars];
      if (!past) continue;
      const ret = (bar.close - past.close) / past.close;
      if (ret > 0) qualifiers.push({ symbol: sym, ret, close: bar.close });
    }

    // Mark current equity
    const equity = markToMarketCorrect(dateISO);
    const targetSymbols = new Set(qualifiers.map((q) => q.symbol));
    const cashOnly = qualifiers.length === 0;

    // 1. Sell positions no longer in target (incl trimming)
    for (const sym of Object.keys(positions)) {
      if (targetSymbols.has(sym)) continue;
      if (cashOnly && sym === cashProxy) continue;
      let bar;
      if (sym === cashProxy) bar = cashProxyIdx[dateISO];
      else bar = dateIdx[sym]?.[dateISO];
      if (!bar) continue;
      const shares = positions[sym];
      const proceeds = shares * bar.close;
      cash += proceeds;
      trades.push({ symbol: sym, side: "sell", date: dateISO, price: bar.close, shares, notional: proceeds });
      delete positions[sym];
    }

    if (cashOnly) {
      // Buy cash proxy with remaining cash
      const bar = cashProxyIdx[dateISO];
      if (bar && cash > 0) {
        const shares = cash / bar.close;
        positions[cashProxy] = (positions[cashProxy] || 0) + shares;
        trades.push({ symbol: cashProxy, side: "buy", date: dateISO, price: bar.close, shares, notional: cash });
        cash = 0;
      }
      rebalanceDates.push({ date: dateISO, cashOnly: true, targets: [cashProxy] });
      return;
    }

    // 2. Compute target notional per qualifier (equal weight)
    const targetNotional = equity / qualifiers.length;
    for (const q of qualifiers) {
      const bar = dateIdx[q.symbol]?.[dateISO];
      if (!bar) continue;
      const currentShares = positions[q.symbol] || 0;
      const currentNotional = currentShares * bar.close;
      const deltaNotional = targetNotional - currentNotional;
      const deltaShares = deltaNotional / bar.close;
      if (Math.abs(deltaNotional) < equity * 0.005) continue;
      if (deltaNotional > 0 && cash >= deltaNotional) {
        positions[q.symbol] = currentShares + deltaShares;
        cash -= deltaNotional;
        trades.push({ symbol: q.symbol, side: "buy", date: dateISO, price: bar.close, shares: deltaShares, notional: deltaNotional });
      } else if (deltaNotional < 0) {
        const sellShares = -deltaShares;
        positions[q.symbol] = currentShares - sellShares;
        cash += sellShares * bar.close;
        trades.push({ symbol: q.symbol, side: "sell", date: dateISO, price: bar.close, shares: sellShares, notional: sellShares * bar.close });
      } else if (deltaNotional > 0 && cash < deltaNotional && cash > 0) {
        // Partial fill with available cash
        const partialShares = cash / bar.close;
        positions[q.symbol] = currentShares + partialShares;
        trades.push({ symbol: q.symbol, side: "buy", date: dateISO, price: bar.close, shares: partialShares, notional: cash });
        cash = 0;
      }
    }

    rebalanceDates.push({ date: dateISO, cashOnly: false, targets: qualifiers.map((q) => q.symbol) });
  }

  for (const d of tradingDates) {
    updateLastPrices(d);
    if (isLastBusinessDay(d, allDates)) rebalance(d);
    equityCurve.push({ date: d, equity: markToMarketCorrect(d) });
  }

  return { trades, equityCurve, rebalanceDates, finalEquity: equityCurve.at(-1)?.equity ?? startCapital };
}

function computeMetrics(trades, equityCurve, startCapital) {
  if (!equityCurve.length) return { trades: 0 };

  const returns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const r = (equityCurve[i].equity - equityCurve[i - 1].equity) / equityCurve[i - 1].equity;
    if (Number.isFinite(r)) returns.push(r);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / Math.max(1, returns.length);
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  let peak = equityCurve[0].equity;
  let maxDD = 0;
  for (const pt of equityCurve) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = (peak - pt.equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const years = equityCurve.length / 252;
  const totalReturn = (equityCurve.at(-1).equity - startCapital) / startCapital;
  const cagr = years > 0 ? Math.pow(Math.max(0.0001, 1 + totalReturn), 1 / years) - 1 : 0;

  // Trade-level PF using net P&L per round-trip (approx: match buys/sells by symbol FIFO)
  const pairedTrades = pairTrades(trades);
  const wins = pairedTrades.filter((t) => t.pnl > 0);
  const losses = pairedTrades.filter((t) => t.pnl < 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const winRate = pairedTrades.length ? wins.length / pairedTrades.length : 0;

  const rMean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const rStd = std;
  const zScore = rStd > 0 ? (rMean * Math.sqrt(returns.length)) / rStd : 0;

  return {
    trades: pairedTrades.length,
    orderCount: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    profitFactor,
    cagr,
    sharpe,
    maxDrawdown: maxDD,
    totalReturn,
    finalEquity: equityCurve.at(-1).equity,
    zScore,
    avgWinPct: wins.length ? wins.reduce((a, t) => a + t.returnPct, 0) / wins.length : 0,
    avgLossPct: losses.length ? losses.reduce((a, t) => a + t.returnPct, 0) / losses.length : 0,
  };
}

function pairTrades(trades) {
  // FIFO match buys/sells per symbol → round-trip P&L list
  const open = {};
  const round = [];
  for (const t of trades) {
    if (!open[t.symbol]) open[t.symbol] = [];
    if (t.side === "buy") open[t.symbol].push({ ...t, remaining: t.shares });
    else {
      let remainingSell = t.shares;
      while (remainingSell > 0 && open[t.symbol].length > 0) {
        const lot = open[t.symbol][0];
        const take = Math.min(lot.remaining, remainingSell);
        const pnl = take * (t.price - lot.price);
        round.push({
          symbol: t.symbol,
          entryDate: lot.date,
          exitDate: t.date,
          entryPrice: lot.price,
          exitPrice: t.price,
          shares: take,
          pnl,
          returnPct: (t.price - lot.price) / lot.price,
        });
        lot.remaining -= take;
        remainingSell -= take;
        if (lot.remaining <= 1e-9) open[t.symbol].shift();
      }
    }
  }
  return round;
}

function formatMetrics(label, m) {
  if (!m.trades && !m.orderCount) return `\n  ${label}: no trades\n`;
  const pct = (x) => `${(x * 100).toFixed(2)}%`;
  const n = (x, d = 2) => x.toFixed(d);
  return `\n  ═══ ${label} ═══
    Round-trips:     ${m.trades} (${m.wins}W / ${m.losses}L)  [${m.orderCount} total orders]
    Win rate:        ${pct(m.winRate)}
    Profit factor:   ${n(m.profitFactor)}
    CAGR:            ${pct(m.cagr)}
    Sharpe:          ${n(m.sharpe)}
    Max drawdown:    ${pct(m.maxDrawdown)}
    Total return:    ${pct(m.totalReturn)}
    Final equity:    $${n(m.finalEquity)}
    Avg win:         ${pct(m.avgWinPct)}  Avg loss: ${pct(m.avgLossPct)}
    Z-score:         ${n(m.zScore)}
`;
}

function checkCriteria(m, mandate) {
  const ddCap = mandate.killSwitches.maxDrawdownPct;
  return [
    { name: "N ≥ 50",                     pass: m.trades >= 50,          val: `N=${m.trades}` },
    { name: "PF ≥ 1.3",                   pass: m.profitFactor >= 1.3,   val: `PF=${m.profitFactor.toFixed(4)}` },
    { name: "Z ≥ 1.5",                    pass: m.zScore >= 1.5,         val: `Z=${m.zScore.toFixed(2)}` },
    { name: `Max DD < kill (${(ddCap*100).toFixed(0)}%)`, pass: m.maxDrawdown < ddCap, val: `DD=${(m.maxDrawdown*100).toFixed(1)}%` },
    { name: "Sharpe ≥ 0.7",               pass: m.sharpe >= 0.7,         val: `S=${m.sharpe.toFixed(2)}` },
    { name: "CAGR ≥ 5%",                  pass: m.cagr >= 0.05,          val: `CAGR=${(m.cagr*100).toFixed(1)}%` },
  ];
}

async function main() {
  const args = parseArgs();
  const start = args.start || "2016-01-01";
  const end = args.end || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const holdoutStart = args.holdout || null;

  const mandate = loadMandate("catf");
  const rules = mandate.strategy;
  const startCapital = mandate.capital.startingEquity;
  const cashProxy = rules.cashProxy;

  console.log(`\n══ CATF Backtest ════════════════════════════════════════`);
  console.log(`  Period:       ${start} → ${end}`);
  if (holdoutStart) console.log(`  Holdout:      ${holdoutStart} → ${end}`);
  console.log(`  Universe:     ${rules.universe.map((u) => u.symbol).join(", ")}`);
  console.log(`  Cash proxy:   ${cashProxy}`);
  console.log(`  Capital:      $${startCapital.toLocaleString()}`);
  console.log(`  Lookback:     ${rules.lookbackMonths} months`);

  const useAlpaca = args.source === "alpaca";
  const source = useAlpaca ? "alpaca" : "yahoo";
  console.log(`  Source:       ${source}`);

  let broker = null;
  if (useAlpaca) {
    const apiKey = process.env.ALPACA_API_KEY;
    const secretKey = process.env.ALPACA_SECRET_KEY;
    if (!apiKey || !secretKey) throw new Error("Missing ALPACA_API_KEY / ALPACA_SECRET_KEY");
    broker = createAlpacaClient({
      apiKey, secretKey,
      baseUrl: process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets",
      dataUrl: process.env.ALPACA_DATA_URL || "https://data.alpaca.markets",
    });
  }

  const fetchStart = new Date(new Date(start).getTime() - 400 * 86400000).toISOString().slice(0, 10);
  console.log(`\n  Loading bars...`);

  const barsBySymbol = {};
  const allSymbols = [...rules.universe.map((u) => u.symbol), cashProxy];
  for (const sym of allSymbols) {
    try {
      const bars = useAlpaca
        ? await loadBars(broker, sym, fetchStart, end)
        : await loadYahooBars(sym, fetchStart, end);
      if (bars && bars.length > 260) {
        barsBySymbol[sym] = bars;
        console.log(`    ${sym.padEnd(9)} ${bars.length} bars  (${bars[0].date} → ${bars.at(-1).date})`);
      } else {
        console.log(`    ${sym.padEnd(9)} SKIP — only ${bars?.length ?? 0} bars`);
      }
    } catch (err) {
      console.log(`    ${sym.padEnd(9)} ERROR — ${err.message}`);
    }
  }

  const cashProxyBars = barsBySymbol[cashProxy];
  if (!cashProxyBars) {
    throw new Error(`Cash proxy ${cashProxy} has no bars — cannot proceed`);
  }
  delete barsBySymbol[cashProxy];

  // Build sorted union of dates
  const dateSet = new Set();
  for (const bars of Object.values(barsBySymbol)) for (const b of bars) dateSet.add(b.date);
  for (const b of cashProxyBars) dateSet.add(b.date);
  const allDates = [...dateSet].sort();

  const universe = rules.universe.filter((u) => barsBySymbol[u.symbol]);
  console.log(`\n  ${universe.length}/${rules.universe.length} universe assets have data; simulating...`);

  const fullResult = simulate({
    universe, barsBySymbol, allDates, rules, startCapital,
    startDate: start, endDate: end, cashProxy, cashProxyBars,
  });
  const fullMetrics = computeMetrics(fullResult.trades, fullResult.equityCurve, startCapital);
  console.log(formatMetrics("FULL PERIOD", fullMetrics));

  if (holdoutStart) {
    const trainEnd = new Date(new Date(holdoutStart).getTime() - 86400000).toISOString().slice(0, 10);
    const trainResult = simulate({
      universe, barsBySymbol, allDates, rules, startCapital,
      startDate: start, endDate: trainEnd, cashProxy, cashProxyBars,
    });
    const trainMetrics = computeMetrics(trainResult.trades, trainResult.equityCurve, startCapital);
    console.log(formatMetrics(`IN-SAMPLE (${start} → ${trainEnd})`, trainMetrics));

    const holdoutResult = simulate({
      universe, barsBySymbol, allDates, rules, startCapital,
      startDate: holdoutStart, endDate: end, cashProxy, cashProxyBars,
    });
    const holdoutMetrics = computeMetrics(holdoutResult.trades, holdoutResult.equityCurve, startCapital);
    console.log(formatMetrics(`HOLDOUT (${holdoutStart} → ${end})`, holdoutMetrics));
  }

  console.log(`\n  ═══ Pre-commit criteria (FULL PERIOD) ═══`);
  const checks = checkCriteria(fullMetrics, mandate);
  for (const c of checks) {
    console.log(`    ${c.pass ? "✅" : "❌"}  ${c.name.padEnd(20)} ${c.val}`);
  }
  const allPass = checks.every((c) => c.pass);
  console.log(`\n  ${allPass ? "✅ ALL CRITERIA PASSED — strategy may be deployed to paper." : "❌ CRITERIA NOT MET — do not deploy."}\n`);

  console.log(`  Rebalances: ${fullResult.rebalanceDates.length}`);
  const cashMonths = fullResult.rebalanceDates.filter((r) => r.cashOnly).length;
  console.log(`  Cash-only months: ${cashMonths}/${fullResult.rebalanceDates.length}`);

  writeFileSync(
    "backtest/catf-results.json",
    JSON.stringify({ args, fullMetrics, rebalanceDates: fullResult.rebalanceDates }, null, 2),
  );
  console.log(`\n  Results saved → backtest/catf-results.json\n`);
}

main().catch((err) => { console.error(err); process.exit(1); });
