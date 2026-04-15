/**
 * Backtest — SECMO (Sector Momentum).
 *
 * Monthly rebalance. Rank 11 sector ETFs by 63-bar return; hold top N
 * equal-weight. If top-ranked sector has non-positive return, absolute
 * filter sends us to the cash proxy (SHY).
 */

import "dotenv/config";
import { writeFileSync } from "fs";
import { loadMandate } from "../portfolio/mandate.js";
import { loadYahooBars } from "./yahoo-data.js";

function parseArgs() {
  return Object.fromEntries(
    process.argv.slice(2)
      .filter((a) => a.startsWith("--"))
      .map((a) => { const [k, v] = a.slice(2).split("="); return [k, v ?? true]; }),
  );
}

function isLastBusinessDay(date, allDates) {
  const next = allDates.find((d) => d > date);
  if (!next) return true;
  return date.slice(0, 7) !== next.slice(0, 7);
}

function simulate({ universe, barsBySymbol, allDates, rules, startCapital, startDate, endDate, cashProxy, cashProxyBars }) {
  const lookbackBars = rules.lookbackBars ?? 63;
  const topN = rules.topN ?? 3;
  const absoluteFilter = rules.absoluteMomentumFilter !== false;
  const tradingDates = allDates.filter((d) => d >= startDate && d <= endDate);

  const dateIdx = {};
  for (const [sym, bars] of Object.entries(barsBySymbol)) {
    dateIdx[sym] = Object.fromEntries(bars.map((b, i) => [b.date, { ...b, i }]));
  }
  const cashProxyIdx = Object.fromEntries(cashProxyBars.map((b, i) => [b.date, { ...b, i }]));

  let cash = startCapital;
  const positions = {};
  const trades = [];
  const equityCurve = [];
  const rebalanceDates = [];
  const lastPrice = {};

  function updateLastPrices(dateISO) {
    for (const sym of Object.keys(dateIdx)) {
      const bar = dateIdx[sym]?.[dateISO];
      if (bar) lastPrice[sym] = bar.close;
    }
    const cBar = cashProxyIdx[dateISO];
    if (cBar) lastPrice[cashProxy] = cBar.close;
  }

  function markToMarket() {
    let eq = cash;
    for (const [sym, sh] of Object.entries(positions)) {
      const px = lastPrice[sym];
      if (px != null) eq += sh * px;
    }
    return eq;
  }

  function getBar(sym, dateISO) {
    if (sym === cashProxy) return cashProxyIdx[dateISO];
    return dateIdx[sym]?.[dateISO];
  }

  function rebalance(dateISO) {
    // Compute 63-bar return for each eligible sector
    const signals = [];
    for (const asset of universe) {
      const bars = barsBySymbol[asset.symbol];
      if (!bars) continue;
      const bar = dateIdx[asset.symbol]?.[dateISO];
      if (!bar || bar.i < lookbackBars) continue;
      const past = bars[bar.i - lookbackBars];
      if (!past) continue;
      signals.push({ symbol: asset.symbol, ret: (bar.close - past.close) / past.close });
    }
    signals.sort((a, b) => b.ret - a.ret);

    const topRanked = signals.slice(0, topN);
    const absoluteFail = absoluteFilter && (topRanked.length === 0 || topRanked[0].ret <= 0);
    const targetSymbols = new Set(absoluteFail ? [] : topRanked.map((t) => t.symbol));

    const equity = markToMarket();

    // Sell anything not in target
    for (const sym of Object.keys(positions)) {
      if (targetSymbols.has(sym)) continue;
      if (absoluteFail && sym === cashProxy) continue;
      const bar = getBar(sym, dateISO);
      if (!bar) continue;
      const shares = positions[sym];
      const proceeds = shares * bar.close;
      cash += proceeds;
      trades.push({ symbol: sym, side: "sell", date: dateISO, price: bar.close, shares, notional: proceeds });
      delete positions[sym];
    }

    if (absoluteFail) {
      const bar = cashProxyIdx[dateISO];
      if (bar && cash > 0) {
        const shares = cash / bar.close;
        positions[cashProxy] = (positions[cashProxy] || 0) + shares;
        trades.push({ symbol: cashProxy, side: "buy", date: dateISO, price: bar.close, shares, notional: cash });
        cash = 0;
      }
      rebalanceDates.push({ date: dateISO, cashOnly: true, targets: [cashProxy], topRanked });
      return;
    }

    const targetNotional = equity / topRanked.length;
    for (const t of topRanked) {
      const bar = dateIdx[t.symbol]?.[dateISO];
      if (!bar) continue;
      const currentShares = positions[t.symbol] || 0;
      const currentNotional = currentShares * bar.close;
      const deltaNotional = targetNotional - currentNotional;
      if (Math.abs(deltaNotional) < equity * 0.005) continue;
      if (deltaNotional > 0 && cash >= deltaNotional) {
        const shares = deltaNotional / bar.close;
        positions[t.symbol] = currentShares + shares;
        cash -= deltaNotional;
        trades.push({ symbol: t.symbol, side: "buy", date: dateISO, price: bar.close, shares, notional: deltaNotional });
      } else if (deltaNotional > 0 && cash > 0) {
        const shares = cash / bar.close;
        positions[t.symbol] = currentShares + shares;
        trades.push({ symbol: t.symbol, side: "buy", date: dateISO, price: bar.close, shares, notional: cash });
        cash = 0;
      } else if (deltaNotional < 0) {
        const shares = -deltaNotional / bar.close;
        positions[t.symbol] = currentShares - shares;
        cash += shares * bar.close;
        trades.push({ symbol: t.symbol, side: "sell", date: dateISO, price: bar.close, shares, notional: shares * bar.close });
      }
    }

    rebalanceDates.push({ date: dateISO, cashOnly: false, targets: topRanked.map((t) => t.symbol), topRanked });
  }

  for (const d of tradingDates) {
    updateLastPrices(d);
    if (isLastBusinessDay(d, allDates)) rebalance(d);
    equityCurve.push({ date: d, equity: markToMarket() });
  }

  return { trades, equityCurve, rebalanceDates, finalEquity: equityCurve.at(-1)?.equity ?? startCapital };
}

function pairTrades(trades) {
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

  return {
    trades: paired.length, orderCount: trades.length, wins: wins.length, losses: losses.length,
    winRate, profitFactor, cagr, sharpe, maxDrawdown: maxDD, totalReturn,
    finalEquity: equityCurve.at(-1).equity, zScore,
    avgWinPct: wins.length ? wins.reduce((a, t) => a + t.returnPct, 0) / wins.length : 0,
    avgLossPct: losses.length ? losses.reduce((a, t) => a + t.returnPct, 0) / losses.length : 0,
  };
}

function formatMetrics(label, m) {
  if (!m.trades && !m.orderCount) return `\n  ${label}: no trades\n`;
  const pct = (x) => `${(x * 100).toFixed(2)}%`;
  const n = (x, d = 2) => x.toFixed(d);
  return `\n  ═══ ${label} ═══
    Round-trips:     ${m.trades} (${m.wins}W / ${m.losses}L)  [${m.orderCount} orders]
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
  const start = args.start || "2008-01-01";
  const end = args.end || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const holdoutStart = args.holdout || null;

  const mandate = loadMandate("secmo");
  const rules = mandate.strategy;
  const startCapital = mandate.capital.startingEquity;
  const cashProxy = rules.cashProxy;

  console.log(`\n══ SECMO Backtest ════════════════════════════════════════`);
  console.log(`  Period:       ${start} → ${end}`);
  if (holdoutStart) console.log(`  Holdout:      ${holdoutStart} → ${end}`);
  console.log(`  Universe:     ${rules.universe.map((u) => u.symbol).join(", ")}`);
  console.log(`  Top-N:        ${rules.topN}`);
  console.log(`  Lookback:     ${rules.lookbackBars} bars`);
  console.log(`  Capital:      $${startCapital.toLocaleString()}`);
  console.log(`  Abs filter:   ${rules.absoluteMomentumFilter ? "yes" : "no"}`);

  const fetchStart = new Date(new Date(start).getTime() - 200 * 86400000).toISOString().slice(0, 10);
  console.log(`\n  Loading Yahoo bars...`);
  const barsBySymbol = {};
  const allSymbols = [...rules.universe.map((u) => u.symbol), cashProxy];
  for (const sym of allSymbols) {
    try {
      const bars = await loadYahooBars(sym, fetchStart, end);
      if (bars && bars.length > 100) {
        barsBySymbol[sym] = bars;
        console.log(`    ${sym.padEnd(6)} ${bars.length} bars  (${bars[0].date} → ${bars.at(-1).date})`);
      } else {
        console.log(`    ${sym.padEnd(6)} SKIP — only ${bars?.length ?? 0} bars`);
      }
    } catch (err) {
      console.log(`    ${sym.padEnd(6)} ERROR — ${err.message}`);
    }
  }

  const cashProxyBars = barsBySymbol[cashProxy];
  if (!cashProxyBars) throw new Error(`Cash proxy ${cashProxy} has no bars`);
  delete barsBySymbol[cashProxy];

  const dateSet = new Set();
  for (const bars of Object.values(barsBySymbol)) for (const b of bars) dateSet.add(b.date);
  for (const b of cashProxyBars) dateSet.add(b.date);
  const allDates = [...dateSet].sort();

  const universe = rules.universe.filter((u) => barsBySymbol[u.symbol]);
  console.log(`\n  ${universe.length}/${rules.universe.length} universe sectors have data; simulating...`);

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
    console.log(formatMetrics(`IN-SAMPLE (${start} → ${trainEnd})`, computeMetrics(trainResult.trades, trainResult.equityCurve, startCapital)));

    const holdoutResult = simulate({
      universe, barsBySymbol, allDates, rules, startCapital,
      startDate: holdoutStart, endDate: end, cashProxy, cashProxyBars,
    });
    console.log(formatMetrics(`HOLDOUT (${holdoutStart} → ${end})`, computeMetrics(holdoutResult.trades, holdoutResult.equityCurve, startCapital)));
  }

  console.log(`\n  ═══ Pre-commit criteria (FULL PERIOD) ═══`);
  const checks = checkCriteria(fullMetrics, mandate);
  for (const c of checks) console.log(`    ${c.pass ? "✅" : "❌"}  ${c.name.padEnd(26)} ${c.val}`);
  const allPass = checks.every((c) => c.pass);
  console.log(`\n  ${allPass ? "✅ ALL CRITERIA PASSED — strategy may be deployed to paper." : "❌ CRITERIA NOT MET — do not deploy."}\n`);

  const cashMonths = fullResult.rebalanceDates.filter((r) => r.cashOnly).length;
  console.log(`  Rebalances: ${fullResult.rebalanceDates.length}`);
  console.log(`  Cash-only months: ${cashMonths}/${fullResult.rebalanceDates.length}`);

  writeFileSync("backtest/secmo-results.json", JSON.stringify({ args, fullMetrics, rebalanceDates: fullResult.rebalanceDates }, null, 2));
  console.log(`\n  Results saved → backtest/secmo-results.json\n`);
}

main().catch((err) => { console.error(err); process.exit(1); });
