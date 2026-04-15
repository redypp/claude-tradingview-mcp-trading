/**
 * Sector Momentum (SECMO).
 *
 * Monthly rebalance. On last business day of month:
 *   1. Compute 63-bar return for each sector ETF.
 *   2. Rank; apply absolute-momentum filter on top-ranked sector.
 *   3. If filter fails → hold 100% cash proxy (SHY).
 *   4. Else → hold top N sectors, equal-weight.
 */

import { totalReturnPct } from "../engine/indicators.js";
import { recordTrade, getLastRebalanceDate, setLastRebalanceDate } from "../engine/logging.js";

function isLastBusinessDayOfMonth(date = new Date()) {
  const today = new Date(date);
  today.setUTCHours(0, 0, 0, 0);
  const next = new Date(today);
  next.setUTCDate(next.getUTCDate() + 1);
  while (next.getUTCDay() === 0 || next.getUTCDay() === 6) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getUTCMonth() !== today.getUTCMonth();
}

async function computeSignals(broker, universe, lookbackBars) {
  const signals = [];
  for (const asset of universe) {
    try {
      const bars = await broker.fetchCandles(asset.symbol, "1D", { limit: lookbackBars + 10 });
      if (!bars || bars.length < lookbackBars + 1) {
        signals.push({ ...asset, eligible: false, reason: "insufficient history" });
        continue;
      }
      const closes = bars.map((b) => b.close);
      const window = closes.slice(closes.length - (lookbackBars + 1));
      const ret = totalReturnPct(window);
      signals.push({ ...asset, eligible: true, ret, lastClose: closes[closes.length - 1] });
    } catch (err) {
      signals.push({ ...asset, eligible: false, reason: err.message });
    }
  }
  return signals;
}

export default {
  name: "SECMO",

  async run({ broker, notify, rules, mandate, state }) {
    console.log(`\n══ [${this.name}] Rebalance check ═══════════════════════════\n`);

    const log = state.log;
    const today = new Date().toISOString().slice(0, 10);
    const forceRebalance = state.forceRebalance === true;

    if (!forceRebalance) {
      if (!isLastBusinessDayOfMonth()) {
        console.log(`  Not last business day of month — skipping.\n`);
        return;
      }
      const last = getLastRebalanceDate(log);
      if (last && last.slice(0, 7) === today.slice(0, 7)) {
        console.log(`  Already rebalanced this month (${last}) — skipping.\n`);
        return;
      }
    }

    const universe = rules.universe || [];
    const lookbackBars = rules.lookbackBars ?? 63;
    const topN = rules.topN ?? 3;
    const cashProxy = rules.cashProxy || "SHY";
    const absoluteFilter = rules.absoluteMomentumFilter !== false;

    console.log(`  Rebalancing on ${today}...`);
    const signals = await computeSignals(broker, universe, lookbackBars);
    const eligible = signals.filter((s) => s.eligible);
    eligible.sort((a, b) => b.ret - a.ret);

    console.log(`  Ranking (${lookbackBars}-bar return):`);
    for (let i = 0; i < eligible.length; i++) {
      const s = eligible[i];
      const mark = i < topN ? "✅" : "  ";
      console.log(`    ${mark} ${s.symbol.padEnd(5)} ${s.ret >= 0 ? "+" : ""}${s.ret.toFixed(2)}%  ${s.description || ""}`);
    }
    for (const s of signals.filter((x) => !x.eligible)) {
      console.log(`      ${s.symbol.padEnd(5)} SKIP (${s.reason})`);
    }

    const topRanked = eligible.slice(0, topN);
    const absoluteFail = absoluteFilter && (topRanked.length === 0 || topRanked[0].ret <= 0);
    const targets = absoluteFail ? [] : topRanked;

    console.log(`\n  Target: ${absoluteFail ? `100% cash (${cashProxy}) — absolute-momentum filter failed` : `${targets.length} sectors @ ${((1/targets.length)*100).toFixed(1)}% each`}`);

    let account;
    try { account = await broker.fetchAccount(); }
    catch (err) {
      console.log(`  ❌ account fetch failed: ${err.message}`);
      return;
    }
    const equity = Number(account.equity ?? account.portfolio_value ?? 0);
    if (!Number.isFinite(equity) || equity <= 0) {
      console.log(`  ❌ bad equity reading: ${account.equity}`);
      return;
    }

    let positions = [];
    try { positions = await broker.fetchPositions(); }
    catch (err) {
      console.log(`  ❌ positions fetch failed: ${err.message}`);
      return;
    }

    const targetSymbols = new Set(targets.map((t) => t.symbol));

    // 1. Close positions not in target (except cash proxy if we want to keep it)
    const ourAssets = new Set([...universe.map((u) => u.symbol), cashProxy]);
    for (const p of positions) {
      if (!ourAssets.has(p.symbol)) continue; // not our concern
      if (targetSymbols.has(p.symbol)) continue;
      if (absoluteFail && p.symbol === cashProxy) continue;
      console.log(`  🔻 Closing ${p.symbol}`);
      try {
        await broker.closePosition(p.symbol);
        if (log) recordTrade(log, { symbol: p.symbol, side: "close_rotation", orderPlaced: true });
      } catch (err) {
        console.log(`    ❌ ${err.message}`);
        await notify.error(`close ${p.symbol}`, err.message);
      }
    }

    // 2. Handle cash-only regime
    if (absoluteFail) {
      const existing = positions.find((p) => p.symbol === cashProxy);
      if (!existing) {
        const notional = equity * 0.98;
        console.log(`  🛡️  Buying ${cashProxy} $${notional.toFixed(2)}`);
        try {
          const res = await broker.placeOrder({
            symbol: cashProxy, side: "buy", notional, type: "market", timeInForce: "day",
          });
          if (log) recordTrade(log, {
            symbol: cashProxy, side: "buy", orderPlaced: true, orderId: res.orderId,
            entryDate: today, notional, signal: "cash regime",
          });
        } catch (err) {
          console.log(`    ❌ ${err.message}`);
          await notify.error(`${cashProxy} buy`, err.message);
        }
      }
      setLastRebalanceDate(log, today);
      return;
    }

    // 3. Buy/resize targets
    const targetNotional = equity / targets.length;
    for (const t of targets) {
      const existing = positions.find((p) => p.symbol === t.symbol);
      const currentNotional = existing ? Math.abs(Number(existing.market_value ?? 0)) : 0;
      const delta = targetNotional - currentNotional;
      if (Math.abs(delta) < equity * 0.01) {
        console.log(`    ${t.symbol.padEnd(5)} HOLD  (target $${targetNotional.toFixed(0)}, current $${currentNotional.toFixed(0)})`);
        continue;
      }
      if (delta > 0) {
        console.log(`    ${t.symbol.padEnd(5)} BUY  $${delta.toFixed(2)}  (target $${targetNotional.toFixed(0)})`);
        try {
          const res = await broker.placeOrder({
            symbol: t.symbol, side: "buy", notional: delta, type: "market", timeInForce: "day",
          });
          if (log) recordTrade(log, {
            symbol: t.symbol, side: "buy", orderPlaced: true, orderId: res.orderId,
            entryDate: today, notional: delta, signal: `SECMO rank, +${t.ret.toFixed(1)}%`,
          });
          if (notify) {
            await notify.tradeExecuted({
              symbol: t.symbol, side: "buy", price: t.lastClose, size: delta,
              orderId: res.orderId, note: `${lookbackBars}-bar ret +${t.ret.toFixed(1)}%`,
            });
          }
        } catch (err) {
          console.log(`    ❌ ${err.message}`);
          await notify.error(`${t.symbol} buy`, err.message);
        }
      } else {
        if (Math.abs(delta) < equity * 0.05) continue;
        console.log(`    ${t.symbol.padEnd(5)} TRIM $${(-delta).toFixed(2)}  (close & re-buy to target)`);
        try {
          await broker.closePosition(t.symbol);
          const res = await broker.placeOrder({
            symbol: t.symbol, side: "buy", notional: targetNotional, type: "market", timeInForce: "day",
          });
          if (log) recordTrade(log, {
            symbol: t.symbol, side: "buy", orderPlaced: true, orderId: res.orderId,
            entryDate: today, notional: targetNotional, signal: "SECMO rebalance (re-size)",
          });
        } catch (err) {
          console.log(`    ❌ trim failed: ${err.message}`);
        }
      }
    }

    setLastRebalanceDate(log, today);
    console.log("");
  },
};
