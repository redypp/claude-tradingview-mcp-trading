/**
 * Generic exit manager. Iterates over open positions and calls a
 * strategy-provided shouldExit(position, context) function for each.
 * Triggered positions are closed via the broker and logged.
 *
 * Strategies that manage their own exits (like dual momentum, which
 * rotates holdings instead of using standalone exit rules) should
 * simply not call managePositions.
 */

import { recordExit } from "./logging.js";

function countTradingDaysBetween(startISO, endISO) {
  const start = new Date(startISO + "T00:00:00Z");
  const end = new Date(endISO + "T00:00:00Z");
  let count = 0;
  const cursor = new Date(start);
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  while (cursor <= end) {
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

function findEntryContext(log, symbol) {
  const matches = (log.trades || []).filter(
    (t) => t.symbol === symbol && t.orderPlaced && t.entryDate,
  );
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

/**
 * @param {object} opts
 * @param {object} opts.broker — broker client with fetchPositions / closePosition / fetchCandles
 * @param {object} opts.strategy — strategy module with shouldExit(position, context)
 * @param {object} opts.log — mutable log object (loaded via loadLog)
 * @param {object} opts.notify — notifier from createNotifier()
 * @param {object} [opts.rules] — strategy-specific params from mandate.strategy
 */
export async function managePositions({ broker, strategy, log, notify, rules = {} }) {
  console.log(`\n══ [${strategy.name}] Managing Open Positions ═══════════\n`);

  let positions;
  try {
    positions = await broker.fetchPositions();
  } catch (err) {
    console.log(`  ❌ Failed to fetch positions: ${err.message}`);
    await notify.error("Fetch positions", err.message);
    return;
  }

  if (!positions || positions.length === 0) {
    console.log("  No open positions to manage.\n");
    return;
  }

  console.log(`  Found ${positions.length} open position${positions.length === 1 ? "" : "s"}.\n`);

  for (const position of positions) {
    const symbol = position.symbol;
    const entryCtx = findEntryContext(log, symbol);
    const entryDate =
      entryCtx?.entryDate ||
      new Date(position.created_at || Date.now()).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const daysHeld = countTradingDaysBetween(entryDate, today);

    console.log(`── ${symbol} ──`);
    if (entryCtx) {
      console.log(`  Entry: ${entryCtx.entryDate} @ $${entryCtx.entryPrice?.toFixed(2) ?? "?"}`);
    } else {
      console.log(`  ⚠️  No log match — using Alpaca avg_entry_price / created_at`);
    }

    const context = {
      broker,
      log,
      daysHeld,
      entryContext: entryCtx,
      rules,
      fetchCandles: (sym, interval, opts) => broker.fetchCandles(sym, interval, opts),
    };

    let decision;
    try {
      decision = await strategy.shouldExit(position, context);
    } catch (err) {
      console.log(`  ❌ shouldExit error: ${err.message}`);
      await notify.error(`Exit eval ${symbol}`, err.message);
      continue;
    }

    if (!decision || !decision.triggered) {
      console.log(`  ✅ HOLD — ${decision?.note || "no exit rule triggered"}\n`);
      continue;
    }

    console.log(`  🚨 EXIT — ${decision.reason}`);
    const entryPrice = entryCtx?.entryPrice ?? parseFloat(position.avg_entry_price);
    const currentPrice = decision.currentPrice ?? parseFloat(position.current_price ?? position.avg_entry_price);
    const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
    console.log(`     Entry $${entryPrice.toFixed(2)} → Current $${currentPrice.toFixed(2)} | ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}% | ${daysHeld}d`);

    try {
      const closeResult = await broker.closePosition(symbol);
      console.log(`     ✅ Close order submitted — ${closeResult.orderId} (${closeResult.status})`);
      await notify.positionClosed({
        symbol,
        reason: decision.reason,
        entryPrice,
        exitPrice: currentPrice,
        pnlPct,
        daysHeld,
      });
      recordExit(log, {
        symbol,
        reason: decision.reason,
        entryPrice,
        exitPrice: currentPrice,
        pnlPct,
        daysHeld,
        closeOrderId: closeResult.orderId,
      });
    } catch (err) {
      console.log(`     ❌ Close failed: ${err.message}`);
      await notify.error(`Close ${symbol}`, err.message);
    }
    console.log("");
  }

  console.log("══ Position management complete ═════════════════════════════\n");
}
