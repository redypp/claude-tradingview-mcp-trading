/**
 * Cross-Asset Trend Following (CATF).
 *
 * Monthly rebalance. On each run:
 *   1. Check if today is the last business day of the month — if not, no-op.
 *   2. For each asset in the universe, compute 12-month total return.
 *   3. Target set = assets with positive 12-month return.
 *   4. Target weights = equal across target set; if empty, 100% cash proxy.
 *   5. Compute current weights from broker positions.
 *   6. Place adjustment orders: close assets no longer in target, trim/add to match target weights.
 *
 * No shouldExit — positions are managed by monthly rotation, not individual exit rules.
 */

import { totalReturnPct } from "../engine/indicators.js";
import { recordTrade, getLastRebalanceDate, setLastRebalanceDate } from "../engine/logging.js";

const BARS_NEEDED = 260; // ~12 months + buffer

function isLastBusinessDayOfMonth(date = new Date()) {
  const today = new Date(date);
  today.setUTCHours(0, 0, 0, 0);
  const nextDay = new Date(today);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  while (nextDay.getUTCDay() === 0 || nextDay.getUTCDay() === 6) {
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  }
  return nextDay.getUTCMonth() !== today.getUTCMonth();
}

async function computeSignals(broker, universe, lookbackMonths) {
  const lookbackBars = Math.floor(lookbackMonths * 21);
  const signals = [];
  for (const asset of universe) {
    try {
      const bars = await broker.fetchCandles(asset.symbol, "1D", { limit: BARS_NEEDED });
      if (!bars || bars.length < lookbackBars + 1) {
        signals.push({ ...asset, eligible: false, reason: "insufficient history" });
        continue;
      }
      const closes = bars.map((b) => b.close);
      const window = closes.slice(closes.length - (lookbackBars + 1));
      const ret = totalReturnPct(window);
      signals.push({
        ...asset,
        eligible: true,
        ret,
        lastClose: closes[closes.length - 1],
        qualifies: ret > 0,
      });
    } catch (err) {
      signals.push({ ...asset, eligible: false, reason: err.message });
    }
  }
  return signals;
}

function computeTargetWeights(signals) {
  const qualifiers = signals.filter((s) => s.eligible && s.qualifies);
  if (qualifiers.length === 0) return { cashOnly: true, weights: {} };
  const w = 1 / qualifiers.length;
  const weights = {};
  for (const q of qualifiers) weights[q.symbol] = w;
  return { cashOnly: false, weights };
}

function currentWeightsFromPositions(positions, equity) {
  const weights = {};
  for (const p of positions) {
    const marketValue = Math.abs(Number(p.market_value ?? 0));
    if (equity > 0) weights[p.symbol] = marketValue / equity;
  }
  return weights;
}

function normalizeSymbol(s) {
  // BTC/USD stored with slash, Alpaca position symbol is "BTC/USD" for crypto
  return s;
}

export default {
  name: "CATF",

  async run({ broker, notify, rules, mandate, state }) {
    console.log(`\n══ [${this.name}] Rebalance check ═══════════════════════════\n`);

    const log = state.log;
    const today = new Date().toISOString().slice(0, 10);
    const rebalanceDay = rules.rebalanceDay || "last_business_day";
    const forceRebalance = state.forceRebalance === true;

    if (!forceRebalance) {
      if (rebalanceDay === "last_business_day" && !isLastBusinessDayOfMonth()) {
        console.log(`  Not last business day of month — skipping.\n`);
        return;
      }
      const last = getLastRebalanceDate(log);
      if (last && last.slice(0, 7) === today.slice(0, 7)) {
        console.log(`  Already rebalanced this month (${last}) — skipping.\n`);
        return;
      }
    }

    console.log(`  Rebalancing on ${today}...`);

    const universe = rules.universe || [];
    const lookbackMonths = rules.lookbackMonths ?? 12;
    const cashProxy = rules.cashProxy || "SHY";

    const signals = await computeSignals(broker, universe, lookbackMonths);
    console.log(`  Signals:`);
    for (const s of signals) {
      if (!s.eligible) {
        console.log(`    ${s.symbol.padEnd(9)} SKIP (${s.reason})`);
        continue;
      }
      const mark = s.qualifies ? "✅" : "❌";
      console.log(`    ${s.symbol.padEnd(9)} ${mark}  12mo ret: ${s.ret >= 0 ? "+" : ""}${s.ret.toFixed(2)}%`);
    }

    const target = computeTargetWeights(signals);
    console.log(`\n  Target: ${target.cashOnly ? `100% cash (${cashProxy})` : `${Object.keys(target.weights).length} assets @ ${((1 / Object.keys(target.weights).length) * 100).toFixed(1)}% each`}`);

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

    const currWeights = currentWeightsFromPositions(positions, equity);
    const targetSymbols = new Set(Object.keys(target.weights));

    // 1) Close positions not in target (except cash proxy)
    for (const p of positions) {
      const sym = p.symbol;
      if (targetSymbols.has(sym)) continue;
      if (target.cashOnly && sym === cashProxy) continue;
      console.log(`  🔻 Closing ${sym} (no longer in target)`);
      try {
        await broker.closePosition(sym);
        if (log) recordTrade(log, { symbol: sym, side: "close_rotation", orderPlaced: true });
      } catch (err) {
        console.log(`    ❌ close failed: ${err.message}`);
        await notify.error(`close ${sym}`, err.message);
      }
    }

    // 2) If cash-only regime, optionally buy cash proxy with full equity
    if (target.cashOnly) {
      const existing = positions.find((p) => p.symbol === cashProxy);
      if (!existing) {
        const notional = equity * 0.98; // small buffer for fills
        console.log(`  🛡️  Buying ${cashProxy} $${notional.toFixed(2)} (cash regime)`);
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

    // 3) Size target positions — buy/trim each target to its target weight
    for (const [sym, w] of Object.entries(target.weights)) {
      const targetNotional = equity * w;
      const currentNotional = (currWeights[sym] || 0) * equity;
      const delta = targetNotional - currentNotional;
      if (Math.abs(delta) < equity * 0.01) {
        console.log(`    ${sym.padEnd(9)} HOLD  (target $${targetNotional.toFixed(0)}, current $${currentNotional.toFixed(0)})`);
        continue;
      }
      if (delta > 0) {
        console.log(`    ${sym.padEnd(9)} BUY  $${delta.toFixed(2)}  (target $${targetNotional.toFixed(0)})`);
        try {
          const res = await broker.placeOrder({
            symbol: sym, side: "buy", notional: delta, type: "market", timeInForce: "day",
          });
          if (log) recordTrade(log, {
            symbol: sym, side: "buy", orderPlaced: true, orderId: res.orderId,
            entryDate: today, notional: delta, signal: "CATF rebalance",
          });
          if (notify) {
            const sig = signals.find((s) => s.symbol === sym);
            await notify.tradeExecuted({
              symbol: sym, side: "buy", price: sig?.lastClose || 0, size: delta,
              orderId: res.orderId, note: `12mo ret +${sig?.ret.toFixed(1)}%`,
            });
          }
        } catch (err) {
          console.log(`    ❌ ${err.message}`);
          await notify.error(`${sym} buy`, err.message);
        }
      } else {
        // trim — close a fraction. Simpler path: close entirely and re-buy to target.
        // For v1 keep it simple — only act if trim is >5% of equity.
        if (Math.abs(delta) < equity * 0.05) continue;
        console.log(`    ${sym.padEnd(9)} TRIM $${(-delta).toFixed(2)}  (target $${targetNotional.toFixed(0)})`);
        try {
          await broker.closePosition(sym);
          const res = await broker.placeOrder({
            symbol: sym, side: "buy", notional: targetNotional, type: "market", timeInForce: "day",
          });
          if (log) recordTrade(log, {
            symbol: sym, side: "buy", orderPlaced: true, orderId: res.orderId,
            entryDate: today, notional: targetNotional, signal: "CATF rebalance (re-size)",
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
