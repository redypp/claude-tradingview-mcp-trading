/**
 * Dual Momentum (Gary Antonacci, "Dual Momentum Investing", 2014).
 *
 * Rules:
 *   - Monthly rebalance (first trading day of the month).
 *   - Compute 12-month total return for the risk assets (SPY, EFA).
 *   - Absolute momentum filter: risk asset must also beat the cash proxy
 *     (BIL — 1-3mo T-bills) over the same period.
 *   - Relative momentum: if both risk assets pass the filter, hold the
 *     one with the higher 12-month return.
 *   - If neither risk asset beats cash, hold the bond proxy (AGG) as
 *     the safety position. Antonacci's original version holds BIL directly
 *     but AGG produces slightly better historical results with modest risk.
 *
 * Why it works:
 *   - Absolute momentum acts as a crash filter (the 2008 and 2020 drawdowns
 *     are captured by the SPY-below-BIL rule, which forces a flight to safety).
 *   - Relative momentum captures the well-documented cross-sectional
 *     momentum anomaly across equity regions.
 *   - Only 3 parameters (lookback, safety asset, rebalance cadence), so the
 *     overfitting surface is tiny.
 */

import { totalReturnPct } from "../engine/indicators.js";
import {
  loadLog,
  saveLog,
  recordTrade,
  getLastRebalanceDate,
  setLastRebalanceDate,
} from "../engine/logging.js";

const STRATEGY_NAME = "dual-momentum";
const LOOKBACK_DAYS = 252; // ~12 months of trading days

function isFirstTradingDayOfMonth(todayISO, candles) {
  // A date is the "first trading day of the month" if there's no earlier
  // trading day in the same month. Use SPY candles as the trading calendar.
  const [, month] = todayISO.split("-");
  const thisMonthDates = candles
    .map((c) => c.date)
    .filter((d) => d.split("-")[1] === month && d <= todayISO);
  return thisMonthDates.length > 0 && thisMonthDates[0] === todayISO;
}

async function fetchYearlyReturn(broker, symbol) {
  // Fetch ~14 months of daily candles so we have >252 trading bars.
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 430 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const candles = await broker.fetchCandles(symbol, "1D", { start, end, limit: 1000 });
  if (!candles || candles.length < LOOKBACK_DAYS) {
    return { symbol, totalReturn: null, candles: candles || [] };
  }
  const closes = candles.map((c) => c.close);
  const windowCloses = closes.slice(-LOOKBACK_DAYS - 1);
  return { symbol, totalReturn: totalReturnPct(windowCloses), candles };
}

export default {
  name: STRATEGY_NAME,
  description: "Dual Momentum (Antonacci) — monthly rotation between SPY/EFA/AGG",

  /**
   * Dual momentum doesn't use the generic exit engine. Its "exit" is
   * the rotation step inside run(). shouldExit always says HOLD so
   * the exit engine becomes a no-op if it's ever wired in.
   */
  async shouldExit() {
    return { triggered: false, note: "dual momentum rotates on run(), not on exit rules" };
  },

  async run({ broker, notify, rules, state }) {
    const log = loadLog(STRATEGY_NAME);
    state.log = log;

    const RISK_ASSETS = rules.risk_assets || ["SPY", "EFA"];
    const CASH_PROXY = rules.cash_proxy || "BIL";
    const SAFETY_ASSET = rules.safety_asset || "AGG";

    const today = new Date().toISOString().slice(0, 10);
    const lastRebalance = getLastRebalanceDate(log);

    // Fetch SPY candles first — we use them as the trading calendar.
    const spyResult = await fetchYearlyReturn(broker, "SPY");
    if (!spyResult.candles || spyResult.candles.length === 0) {
      console.log(`  ⚠️  No SPY candles returned — skipping evaluation.`);
      return;
    }

    const isRebalanceDay = isFirstTradingDayOfMonth(today, spyResult.candles);
    if (!isRebalanceDay) {
      console.log(
        `  [${STRATEGY_NAME}] Not a rebalance day (${today}). Last rebalance: ${lastRebalance || "never"}. No-op.`,
      );
      return;
    }

    if (lastRebalance === today) {
      console.log(`  [${STRATEGY_NAME}] Already rebalanced today. No-op.`);
      return;
    }

    console.log(`\n══ [${STRATEGY_NAME}] Monthly rebalance — ${today} ═══════════\n`);

    // Fetch all required assets
    const assetsToFetch = [...RISK_ASSETS, CASH_PROXY, SAFETY_ASSET].filter(
      (s) => s !== "SPY",
    );
    const fetched = [spyResult];
    for (const s of assetsToFetch) {
      const r = await fetchYearlyReturn(broker, s);
      fetched.push(r);
    }
    const returns = Object.fromEntries(fetched.map((r) => [r.symbol, r.totalReturn]));

    console.log(`  12-month total returns:`);
    for (const [sym, ret] of Object.entries(returns)) {
      console.log(`    ${sym.padEnd(6)} ${ret === null ? "N/A" : (ret >= 0 ? "+" : "") + ret.toFixed(2) + "%"}`);
    }

    // Validate data
    for (const asset of [...RISK_ASSETS, CASH_PROXY, SAFETY_ASSET]) {
      if (returns[asset] === null) {
        console.log(`  ⚠️  Missing return data for ${asset} — aborting rebalance.`);
        await notify.error("Dual momentum rebalance", `Missing return data for ${asset}`);
        return;
      }
    }

    const cashReturn = returns[CASH_PROXY];
    const riskAssetsAboveCash = RISK_ASSETS.filter((s) => returns[s] > cashReturn);

    let target;
    let reason;
    if (riskAssetsAboveCash.length === 0) {
      target = SAFETY_ASSET;
      reason = `Both risk assets below cash (${CASH_PROXY}) — flight to safety`;
    } else {
      target = riskAssetsAboveCash.reduce((best, s) =>
        returns[s] > returns[best] ? s : best,
      );
      reason = `${target} has highest 12-month return (${returns[target].toFixed(2)}%)`;
    }

    console.log(`\n  🎯 Target: ${target} — ${reason}\n`);

    // Determine current holding
    let positions;
    try {
      positions = await broker.fetchPositions();
    } catch (err) {
      console.log(`  ❌ Failed to fetch positions: ${err.message}`);
      await notify.error("Fetch positions", err.message);
      return;
    }

    const currentHoldings = positions.map((p) => p.symbol);
    const needToClose = currentHoldings.filter((s) => s !== target);
    const alreadyHolding = currentHoldings.includes(target);

    if (alreadyHolding && needToClose.length === 0) {
      console.log(`  ✅ Already holding ${target} — no rotation needed.\n`);
      setLastRebalanceDate(log, today);
      saveLog(STRATEGY_NAME, log);
      return;
    }

    // Close any position that isn't the target
    for (const sym of needToClose) {
      console.log(`  🔴 Closing ${sym}…`);
      try {
        const closeResult = await broker.closePosition(sym);
        console.log(`     ✅ Close submitted — ${closeResult.orderId}`);
        const pos = positions.find((p) => p.symbol === sym);
        const entryPrice = pos ? parseFloat(pos.avg_entry_price) : null;
        const exitPrice = pos ? parseFloat(pos.current_price || pos.avg_entry_price) : null;
        const pnlPct = entryPrice && exitPrice ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0;
        await notify.positionClosed({
          symbol: sym,
          reason: `Monthly rotation → ${target}`,
          entryPrice: entryPrice || 0,
          exitPrice: exitPrice || 0,
          pnlPct,
          daysHeld: 0,
        });
      } catch (err) {
        console.log(`     ❌ Close failed: ${err.message}`);
        await notify.error(`Close ${sym}`, err.message);
      }
    }

    // Open the target position if we're not already holding it
    if (!alreadyHolding) {
      // Use the full account equity for the single-position sizing
      const account = await broker.fetchAccount();
      const equity = parseFloat(account.equity);
      const notional = equity * (rules.allocation_pct || 0.98); // leave a small buffer

      console.log(`  🟢 Opening ${target} at market — notional $${notional.toFixed(2)}`);
      try {
        const order = await broker.placeOrder({
          symbol: target,
          side: "buy",
          notional,
        });
        console.log(`     ✅ Order submitted — ${order.orderId} (${order.status})`);

        // Record entry context for auditability
        const targetCandles = fetched.find((r) => r.symbol === target)?.candles || [];
        const lastClose = targetCandles[targetCandles.length - 1]?.close || 0;
        recordTrade(log, {
          symbol: target,
          side: "buy",
          orderPlaced: true,
          orderId: order.orderId,
          entryPrice: lastClose,
          entryDate: today,
          notional,
          reason,
        });
        await notify.tradeExecuted({
          symbol: target,
          side: "buy",
          price: lastClose,
          size: notional,
          orderId: order.orderId,
          note: reason,
        });
      } catch (err) {
        console.log(`     ❌ Order failed: ${err.message}`);
        await notify.error(`Open ${target}`, err.message);
      }
    }

    setLastRebalanceDate(log, today);
    saveLog(STRATEGY_NAME, log);
    console.log(`\n══ Rebalance complete ═════════════════════════════════════\n`);
  },
};
