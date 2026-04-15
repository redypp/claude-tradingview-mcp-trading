/**
 * Backtest — MR-RSI2.
 *
 * Usage:
 *   node backtest/mr-rsi2-backtest.js              # default: 2019-01-01 → yesterday
 *   node backtest/mr-rsi2-backtest.js --start=2019-01-01 --end=2024-12-31
 *   node backtest/mr-rsi2-backtest.js --holdout=2024-01-01
 *
 * Data: fetched from Alpaca daily bars, cached to backtest/cache/<symbol>.json.
 * Honors the mandate rules — RSI(2)<10, above SMA200, liquidity/price screen,
 * 12.5% per position, max 8 concurrent, RSI>70 / 5-day stop / 5% stop-loss.
 *
 * Execution model: signal at close of day D → entry at open of D+1,
 * exit at open of the day after the exit signal fires.
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { createAlpacaClient } from "../brokers/alpaca.js";
import { loadMandate } from "../portfolio/mandate.js";
import { calcRSI, calcSMA } from "../engine/indicators.js";
import { SP500_TOP_LIQUID } from "../strategies/universes/sp500-top-liquid.js";

const CACHE_DIR = "backtest/cache";

function parseArgs() {
  const args = Object.fromEntries(
    process.argv
      .slice(2)
      .filter((a) => a.startsWith("--"))
      .map((a) => { const [k, v] = a.slice(2).split("="); return [k, v ?? true]; }),
  );
  return args;
}

function ensureDir(p) { if (!existsSync(p)) mkdirSync(p, { recursive: true }); }

async function loadBars(broker, symbol, start, end) {
  ensureDir(CACHE_DIR);
  const cachePath = join(CACHE_DIR, `${symbol}.json`);
  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, "utf8"));
    if (cached.start === start && cached.end === end && cached.bars?.length) {
      return cached.bars;
    }
  }
  const bars = await broker.fetchCandles(symbol, "1D", { start, end, limit: 10000 });
  writeFileSync(cachePath, JSON.stringify({ symbol, start, end, bars }));
  return bars;
}

async function loadUniverseBars(broker, symbols, start, end) {
  const result = {};
  let done = 0;
  for (const s of symbols) {
    try {
      const bars = await loadBars(broker, s, start, end);
      if (bars && bars.length > 250) result[s] = bars;
      done++;
      if (done % 10 === 0) process.stdout.write(`\r  loaded ${done}/${symbols.length}`);
    } catch (err) {
      console.log(`\n  ⚠️  ${s}: ${err.message}`);
    }
  }
  process.stdout.write(`\r  loaded ${done}/${symbols.length}\n`);
  return result;
}

function buildDateIndex(universeBars) {
  const dateSet = new Set();
  for (const bars of Object.values(universeBars)) {
    for (const b of bars) dateSet.add(b.date);
  }
  const dates = [...dateSet].sort();
  const index = {};
  for (const [symbol, bars] of Object.entries(universeBars)) {
    index[symbol] = Object.fromEntries(bars.map((b, i) => [b.date, { ...b, i }]));
  }
  return { dates, index };
}

function rangeBars(barsAll, endIdx, lookback) {
  return barsAll.slice(Math.max(0, endIdx - lookback + 1), endIdx + 1);
}

function simulate({ dates, index, universeBars, rules, startCapital, startDate, endDate }) {
  const screen = rules.screenFilters || {};
  const rsiPeriod = rules.entry.rsiPeriod;
  const rsiEntry = rules.entry.rsiEntryThreshold;
  const rsiExit = rules.exit.rsiExitThreshold;
  const maxHold = rules.exit.maxHoldDays;
  const stopLoss = rules.exit.stopLossPct;
  const maxConcurrent = rules.sizing.maxConcurrentPositions;
  const positionPct = rules.sizing.positionPctOfEquity;

  let cash = startCapital;
  const positions = new Map(); // symbol → { entryPrice, entryDate, entryIdx, shares, daysHeld }
  const trades = []; // completed trades
  const equityCurve = []; // { date, equity }

  const tradingDates = dates.filter((d) => d >= startDate && d <= endDate);

  for (let di = 0; di < tradingDates.length; di++) {
    const today = tradingDates[di];
    const nextDay = tradingDates[di + 1];

    // End-of-day: evaluate existing positions for exit signals
    const toExitOnNextOpen = [];
    for (const [symbol, pos] of positions) {
      const bar = index[symbol]?.[today];
      if (!bar) continue;
      pos.daysHeld = di - pos.entryDayIdx;
      const barsAll = universeBars[symbol];
      const closesThroughToday = barsAll.slice(0, bar.i + 1).map((b) => b.close);
      const rsi = calcRSI(closesThroughToday, rsiPeriod);
      const drawdown = (pos.entryPrice - bar.close) / pos.entryPrice;

      let reason = null;
      if (drawdown >= stopLoss) reason = `stop-loss -${(drawdown * 100).toFixed(1)}%`;
      else if (rsi != null && rsi > rsiExit) reason = `rsi ${rsi.toFixed(1)} > ${rsiExit}`;
      else if (pos.daysHeld >= maxHold) reason = `time stop ${pos.daysHeld}d`;
      if (reason) toExitOnNextOpen.push({ symbol, reason });
    }

    // End-of-day: scan for new entries
    const candidates = [];
    if (nextDay && positions.size < maxConcurrent) {
      for (const symbol of Object.keys(universeBars)) {
        if (positions.has(symbol)) continue;
        const bar = index[symbol]?.[today];
        if (!bar) continue;
        if (screen.minPriceUsd != null && bar.close < screen.minPriceUsd) continue;
        const barsAll = universeBars[symbol];
        const recent = rangeBars(barsAll, bar.i, 20);
        if (recent.length < 20) continue;
        if (screen.minAvgDollarVolume != null) {
          const adv = recent.reduce((a, b) => a + b.close * b.volume, 0) / recent.length;
          if (adv < screen.minAvgDollarVolume) continue;
        }
        const closesThroughToday = barsAll.slice(0, bar.i + 1).map((b) => b.close);
        if (closesThroughToday.length < 205) continue;
        const sma = calcSMA(closesThroughToday, 200);
        if (screen.aboveSma200 && (sma == null || bar.close <= sma)) continue;
        const rsi = calcRSI(closesThroughToday, rsiPeriod);
        if (rsi == null) continue;
        if (rsi < rsiEntry) candidates.push({ symbol, rsi, close: bar.close });
      }
      candidates.sort((a, b) => a.rsi - b.rsi);
    }

    // Next open: execute exits
    if (nextDay) {
      for (const { symbol, reason } of toExitOnNextOpen) {
        const nextBar = index[symbol]?.[nextDay];
        if (!nextBar) continue;
        const pos = positions.get(symbol);
        const exitPrice = nextBar.open;
        const proceeds = pos.shares * exitPrice;
        cash += proceeds;
        trades.push({
          symbol,
          entryDate: pos.entryDate,
          exitDate: nextDay,
          entryPrice: pos.entryPrice,
          exitPrice,
          shares: pos.shares,
          pnl: proceeds - pos.cost,
          returnPct: (exitPrice - pos.entryPrice) / pos.entryPrice,
          daysHeld: pos.daysHeld + 1,
          reason,
        });
        positions.delete(symbol);
      }

      // Next open: execute entries (respecting slot cap at this moment)
      for (const c of candidates) {
        if (positions.size >= maxConcurrent) break;
        const nextBar = index[c.symbol]?.[nextDay];
        if (!nextBar) continue;
        // mark-to-market current equity for notional calculation
        let equity = cash;
        for (const [sym, p] of positions) {
          const b = index[sym]?.[nextDay] || index[sym]?.[today];
          if (b) equity += p.shares * b.open;
        }
        const notional = equity * positionPct;
        if (notional > cash) continue;
        const shares = notional / nextBar.open;
        cash -= notional;
        positions.set(c.symbol, {
          entryPrice: nextBar.open,
          entryDate: nextDay,
          entryDayIdx: di + 1,
          shares,
          cost: notional,
          daysHeld: 0,
        });
      }
    }

    // End-of-day mark-to-market equity (using today's close)
    let equity = cash;
    for (const [symbol, pos] of positions) {
      const bar = index[symbol]?.[today];
      if (bar) equity += pos.shares * bar.close;
      else equity += pos.cost;
    }
    equityCurve.push({ date: today, equity });
  }

  // Final liquidation at last close
  const lastDate = tradingDates[tradingDates.length - 1];
  for (const [symbol, pos] of positions) {
    const bar = index[symbol]?.[lastDate];
    if (!bar) continue;
    const proceeds = pos.shares * bar.close;
    cash += proceeds;
    trades.push({
      symbol,
      entryDate: pos.entryDate,
      exitDate: lastDate,
      entryPrice: pos.entryPrice,
      exitPrice: bar.close,
      shares: pos.shares,
      pnl: proceeds - pos.cost,
      returnPct: (bar.close - pos.entryPrice) / pos.entryPrice,
      daysHeld: pos.daysHeld,
      reason: "EOT liquidation",
    });
  }

  return { trades, equityCurve, finalEquity: equityCurve.at(-1)?.equity ?? startCapital };
}

function computeMetrics(trades, equityCurve, startCapital) {
  if (!trades.length) return { trades: 0 };

  const returns = trades.map((t) => t.returnPct);
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : Infinity;
  const winRate = wins.length / trades.length;

  // Daily equity returns for Sharpe
  const dailyReturns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const r = (equityCurve[i].equity - equityCurve[i - 1].equity) / equityCurve[i - 1].equity;
    dailyReturns.push(r);
  }
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, dailyReturns.length - 1);
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  let peak = equityCurve[0].equity;
  let maxDD = 0;
  for (const pt of equityCurve) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = (peak - pt.equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const days = equityCurve.length;
  const years = days / 252;
  const totalReturn = (equityCurve.at(-1).equity - startCapital) / startCapital;
  const cagr = years > 0 ? Math.pow(1 + totalReturn, 1 / years) - 1 : 0;

  const rMean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const rVar = returns.reduce((a, r) => a + (r - rMean) ** 2, 0) / Math.max(1, returns.length - 1);
  const rStd = Math.sqrt(rVar);
  const zScore = rStd > 0 ? (rMean * Math.sqrt(returns.length)) / rStd : 0;

  const avgWinPct = wins.length
    ? wins.reduce((a, t) => a + t.returnPct, 0) / wins.length
    : 0;
  const avgLossPct = losses.length
    ? losses.reduce((a, t) => a + t.returnPct, 0) / losses.length
    : 0;
  const avgHoldDays = trades.reduce((a, t) => a + t.daysHeld, 0) / trades.length;

  return {
    trades: trades.length,
    winRate,
    profitFactor,
    cagr,
    sharpe,
    maxDrawdown: maxDD,
    totalReturn,
    finalEquity: equityCurve.at(-1).equity,
    zScore,
    avgWinPct,
    avgLossPct,
    avgHoldDays,
    wins: wins.length,
    losses: losses.length,
  };
}

function formatMetrics(label, m) {
  if (!m.trades) return `\n  ${label}: no trades\n`;
  const pct = (x) => `${(x * 100).toFixed(2)}%`;
  const n = (x, d = 2) => x.toFixed(d);
  return `\n  ═══ ${label} ═══
    Trades:          ${m.trades} (${m.wins}W / ${m.losses}L)
    Win rate:        ${pct(m.winRate)}
    Profit factor:   ${n(m.profitFactor)}
    CAGR:            ${pct(m.cagr)}
    Sharpe:          ${n(m.sharpe)}
    Max drawdown:    ${pct(m.maxDrawdown)}
    Total return:    ${pct(m.totalReturn)}
    Final equity:    $${n(m.finalEquity)}
    Avg win:         ${pct(m.avgWinPct)}  Avg loss: ${pct(m.avgLossPct)}
    Avg hold:        ${n(m.avgHoldDays, 1)} days
    Z-score:         ${n(m.zScore)}
`;
}

function checkCriteria(m) {
  const results = [
    { name: "N ≥ 50",         pass: m.trades >= 50,          val: `N=${m.trades}` },
    { name: "PF ≥ 1.3",       pass: m.profitFactor >= 1.3,   val: `PF=${m.profitFactor.toFixed(4)}` },
    { name: "Z ≥ 1.5",        pass: m.zScore >= 1.5,         val: `Z=${m.zScore.toFixed(2)}` },
    { name: "Max DD ≤ 20%",   pass: m.maxDrawdown <= 0.20,   val: `DD=${(m.maxDrawdown*100).toFixed(1)}%` },
    { name: "Sharpe ≥ 0.7",   pass: m.sharpe >= 0.7,         val: `S=${m.sharpe.toFixed(2)}` },
    { name: "Win rate ≥ 55%", pass: m.winRate >= 0.55,       val: `WR=${(m.winRate*100).toFixed(1)}%` },
  ];
  return results;
}

async function main() {
  const args = parseArgs();
  const start = args.start || "2019-01-01";
  const end = args.end || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const holdoutStart = args.holdout || null;

  const mandate = loadMandate("mr-rsi2");
  const rules = mandate.strategy;
  const startCapital = mandate.capital.startingEquity;

  console.log(`\n══ MR-RSI2 Backtest ════════════════════════════════════════`);
  console.log(`  Period:       ${start} → ${end}`);
  if (holdoutStart) console.log(`  Holdout:      ${holdoutStart} → ${end}`);
  console.log(`  Universe:     ${SP500_TOP_LIQUID.length} symbols`);
  console.log(`  Capital:      $${startCapital.toLocaleString()}`);
  console.log(`  Rules:        RSI(${rules.entry.rsiPeriod})<${rules.entry.rsiEntryThreshold}, above SMA200, ${rules.sizing.maxConcurrentPositions} max positions, ${(rules.sizing.positionPctOfEquity*100)}% each`);

  const apiKey = process.env.ALPACA_API_KEY;
  const secretKey = process.env.ALPACA_SECRET_KEY;
  if (!apiKey || !secretKey) {
    throw new Error("Missing ALPACA_API_KEY / ALPACA_SECRET_KEY in .env");
  }
  const broker = createAlpacaClient({
    apiKey, secretKey,
    baseUrl: process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets",
    dataUrl: process.env.ALPACA_DATA_URL || "https://data.alpaca.markets",
  });

  console.log(`\n  Loading bars...`);
  const fetchStart = new Date(new Date(start).getTime() - 400 * 86400000).toISOString().slice(0, 10);
  const universeBars = await loadUniverseBars(broker, SP500_TOP_LIQUID, fetchStart, end);
  console.log(`  Loaded ${Object.keys(universeBars).length}/${SP500_TOP_LIQUID.length} symbols with ≥250 bars.`);

  const { dates, index } = buildDateIndex(universeBars);

  console.log(`\n  Simulating...`);
  const fullResult = simulate({
    dates, index, universeBars, rules, startCapital,
    startDate: start, endDate: end,
  });
  const fullMetrics = computeMetrics(fullResult.trades, fullResult.equityCurve, startCapital);
  console.log(formatMetrics("FULL PERIOD", fullMetrics));

  if (holdoutStart) {
    const trainEnd = new Date(new Date(holdoutStart).getTime() - 86400000).toISOString().slice(0, 10);
    const trainResult = simulate({
      dates, index, universeBars, rules, startCapital,
      startDate: start, endDate: trainEnd,
    });
    const trainMetrics = computeMetrics(trainResult.trades, trainResult.equityCurve, startCapital);
    console.log(formatMetrics(`IN-SAMPLE (${start} → ${trainEnd})`, trainMetrics));

    const holdoutResult = simulate({
      dates, index, universeBars, rules, startCapital,
      startDate: holdoutStart, endDate: end,
    });
    const holdoutMetrics = computeMetrics(holdoutResult.trades, holdoutResult.equityCurve, startCapital);
    console.log(formatMetrics(`HOLDOUT (${holdoutStart} → ${end})`, holdoutMetrics));
  }

  console.log(`\n  ═══ Pre-commit criteria (FULL PERIOD) ═══`);
  const checks = checkCriteria(fullMetrics);
  for (const c of checks) {
    console.log(`    ${c.pass ? "✅" : "❌"}  ${c.name.padEnd(20)} ${c.val}`);
  }
  const allPass = checks.every((c) => c.pass);
  console.log(`\n  ${allPass ? "✅ ALL CRITERIA PASSED — strategy may be deployed to paper." : "❌ CRITERIA NOT MET — do not deploy."}\n`);

  writeFileSync(
    "backtest/mr-rsi2-results.json",
    JSON.stringify({ args, fullMetrics, trades: fullResult.trades.slice(-200) }, null, 2),
  );
  console.log(`  Results saved → backtest/mr-rsi2-results.json\n`);
}

main().catch((err) => { console.error(err); process.exit(1); });
