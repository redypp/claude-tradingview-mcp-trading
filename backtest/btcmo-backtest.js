/**
 * Backtest — BTC Momentum.
 *
 * Simple simulator: each day, check close vs SMA(N). Flip between
 * long-BTC and cash-only. No intraday logic.
 */

import "dotenv/config";
import { writeFileSync } from "fs";
import { loadMandate } from "../portfolio/mandate.js";
import { loadYahooBars } from "./yahoo-data.js";
import { calcSMA } from "../engine/indicators.js";

function parseArgs() {
  return Object.fromEntries(
    process.argv.slice(2)
      .filter((a) => a.startsWith("--"))
      .map((a) => { const [k, v] = a.slice(2).split("="); return [k, v ?? true]; }),
  );
}

function simulate({ bars, rules, startCapital, startDate, endDate }) {
  const smaPeriod = rules.smaPeriod ?? 200;
  const tradingBars = bars.filter((b) => b.date >= startDate && b.date <= endDate);

  let cash = startCapital;
  let btcShares = 0;
  const trades = [];
  const equityCurve = [];

  for (let i = 0; i < tradingBars.length; i++) {
    const bar = tradingBars[i];
    const globalIdx = bars.findIndex((b) => b.date === bar.date);
    if (globalIdx < smaPeriod) {
      equityCurve.push({ date: bar.date, equity: cash + btcShares * bar.close, inBtc: btcShares > 0 });
      continue;
    }
    const closes = bars.slice(0, globalIdx + 1).map((b) => b.close);
    const sma = calcSMA(closes, smaPeriod);
    const signalLong = bar.close > sma;

    if (signalLong && btcShares === 0 && cash > 0) {
      // Enter on next day's open (avoid lookahead)
      const next = tradingBars[i + 1];
      if (next) {
        const shares = cash / next.open;
        btcShares = shares;
        trades.push({ side: "buy", date: next.date, price: next.open, shares, notional: cash });
        cash = 0;
      }
    } else if (!signalLong && btcShares > 0) {
      const next = tradingBars[i + 1];
      if (next) {
        const proceeds = btcShares * next.open;
        cash += proceeds;
        trades.push({ side: "sell", date: next.date, price: next.open, shares: btcShares, notional: proceeds });
        btcShares = 0;
      }
    }

    equityCurve.push({ date: bar.date, equity: cash + btcShares * bar.close, inBtc: btcShares > 0 });
  }

  return { trades, equityCurve, finalEquity: equityCurve.at(-1)?.equity ?? startCapital };
}

function pairTrades(trades) {
  const round = [];
  let lot = null;
  for (const t of trades) {
    if (t.side === "buy") lot = t;
    else if (t.side === "sell" && lot) {
      round.push({
        entryDate: lot.date, exitDate: t.date,
        entryPrice: lot.price, exitPrice: t.price, shares: lot.shares,
        pnl: (t.price - lot.price) * lot.shares,
        returnPct: (t.price - lot.price) / lot.price,
      });
      lot = null;
    }
  }
  return round;
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

  const paired = pairTrades(trades);
  const wins = paired.filter((t) => t.pnl > 0);
  const losses = paired.filter((t) => t.pnl < 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const winRate = paired.length ? wins.length / paired.length : 0;
  const zScore = std > 0 ? (mean * Math.sqrt(returns.length)) / std : 0;

  const timeInMarket = equityCurve.filter((p) => p.inBtc).length / equityCurve.length;

  return {
    trades: paired.length, orderCount: trades.length, wins: wins.length, losses: losses.length,
    winRate, profitFactor, cagr, sharpe, maxDrawdown: maxDD, totalReturn,
    finalEquity: equityCurve.at(-1).equity, zScore,
    avgWinPct: wins.length ? wins.reduce((a, t) => a + t.returnPct, 0) / wins.length : 0,
    avgLossPct: losses.length ? losses.reduce((a, t) => a + t.returnPct, 0) / losses.length : 0,
    timeInMarket,
  };
}

function formatMetrics(label, m) {
  if (!m.trades && !m.orderCount) return `\n  ${label}: no trades\n`;
  const pct = (x) => `${(x * 100).toFixed(2)}%`;
  const n = (x, d = 2) => x.toFixed(d);
  return `\n  ═══ ${label} ═══
    Round-trips:     ${m.trades} (${m.wins}W / ${m.losses}L)
    Win rate:        ${pct(m.winRate)}
    Profit factor:   ${n(m.profitFactor)}
    CAGR:            ${pct(m.cagr)}
    Sharpe:          ${n(m.sharpe)}
    Max drawdown:    ${pct(m.maxDrawdown)}
    Total return:    ${pct(m.totalReturn)}
    Final equity:    $${n(m.finalEquity)}
    Avg win:         ${pct(m.avgWinPct)}  Avg loss: ${pct(m.avgLossPct)}
    Time in market:  ${pct(m.timeInMarket)}
    Z-score:         ${n(m.zScore)}
`;
}

function checkCriteria(m, mandate) {
  const ddCap = mandate.killSwitches.maxDrawdownPct;
  const skipN = mandate.evaluation?.skipCriteria?.includes("N_ge_50");
  const zThresh = skipN ? 2.0 : 1.5;
  const cagrThresh = mandate.evaluation?.minCagr ?? 0.10;
  return [
    ...(skipN ? [] : [{ name: "N ≥ 50", pass: m.trades >= 50, val: `N=${m.trades}` }]),
    { name: "PF ≥ 1.3",                                            pass: m.profitFactor >= 1.3, val: `PF=${m.profitFactor.toFixed(4)}` },
    { name: `Z ≥ ${zThresh.toFixed(1)}`,                           pass: m.zScore >= zThresh,   val: `Z=${m.zScore.toFixed(2)}` },
    { name: `Max DD < kill (${(ddCap*100).toFixed(0)}%)`,          pass: m.maxDrawdown < ddCap, val: `DD=${(m.maxDrawdown*100).toFixed(1)}%` },
    { name: "Sharpe ≥ 0.7",                                        pass: m.sharpe >= 0.7,       val: `S=${m.sharpe.toFixed(2)}` },
    { name: `CAGR ≥ ${(cagrThresh*100).toFixed(0)}%`,              pass: m.cagr >= cagrThresh,  val: `CAGR=${(m.cagr*100).toFixed(1)}%` },
  ];
}

async function main() {
  const args = parseArgs();
  const start = args.start || "2015-01-01";
  const end = args.end || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const holdoutStart = args.holdout || null;

  const mandate = loadMandate("btcmo");
  const rules = mandate.strategy;
  const startCapital = mandate.capital.startingEquity;

  console.log(`\n══ BTCMO Backtest ════════════════════════════════════════`);
  console.log(`  Period:       ${start} → ${end}`);
  if (holdoutStart) console.log(`  Holdout:      ${holdoutStart} → ${end}`);
  console.log(`  SMA period:   ${rules.smaPeriod}`);
  console.log(`  Capital:      $${startCapital.toLocaleString()}`);
  if (mandate.evaluation?.skipCriteria) {
    console.log(`  Criteria:     skipping ${mandate.evaluation.skipCriteria.join(", ")} (${mandate.evaluation.classification})`);
  }

  const fetchStart = new Date(new Date(start).getTime() - 300 * 86400000).toISOString().slice(0, 10);
  console.log(`\n  Loading BTC bars...`);
  const bars = await loadYahooBars("BTC/USD", fetchStart, end);
  console.log(`    BTC/USD  ${bars.length} bars  (${bars[0].date} → ${bars.at(-1).date})`);

  const fullResult = simulate({ bars, rules, startCapital, startDate: start, endDate: end });
  const fullMetrics = computeMetrics(fullResult.trades, fullResult.equityCurve, startCapital);
  console.log(formatMetrics("FULL PERIOD", fullMetrics));

  if (holdoutStart) {
    const trainEnd = new Date(new Date(holdoutStart).getTime() - 86400000).toISOString().slice(0, 10);
    const trainResult = simulate({ bars, rules, startCapital, startDate: start, endDate: trainEnd });
    console.log(formatMetrics(`IN-SAMPLE (${start} → ${trainEnd})`, computeMetrics(trainResult.trades, trainResult.equityCurve, startCapital)));

    const holdoutResult = simulate({ bars, rules, startCapital, startDate: holdoutStart, endDate: end });
    console.log(formatMetrics(`HOLDOUT (${holdoutStart} → ${end})`, computeMetrics(holdoutResult.trades, holdoutResult.equityCurve, startCapital)));
  }

  console.log(`\n  ═══ Pre-commit criteria (FULL PERIOD) ═══`);
  const checks = checkCriteria(fullMetrics, mandate);
  for (const c of checks) console.log(`    ${c.pass ? "✅" : "❌"}  ${c.name.padEnd(28)} ${c.val}`);
  const allPass = checks.every((c) => c.pass);
  console.log(`\n  ${allPass ? "✅ ALL CRITERIA PASSED — strategy may be deployed to paper." : "❌ CRITERIA NOT MET — do not deploy."}\n`);

  writeFileSync("backtest/btcmo-results.json", JSON.stringify({ args, fullMetrics, trades: fullResult.trades }, null, 2));
  console.log(`  Results saved → backtest/btcmo-results.json\n`);
}

main().catch((err) => { console.error(err); process.exit(1); });
