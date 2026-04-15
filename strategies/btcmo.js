/**
 * BTC Momentum — single-asset trend filter.
 *
 * Daily:
 *   1. Fetch BTC candles. Compute close vs SMA(N).
 *   2. If close > SMA and no BTC position → buy full equity.
 *   3. If close ≤ SMA and BTC position exists → sell all.
 *   4. Otherwise hold.
 */

import { calcSMA } from "../engine/indicators.js";
import { recordTrade } from "../engine/logging.js";

export default {
  name: "BTCMO",

  async run({ broker, notify, rules, mandate, state }) {
    console.log(`\n══ [${this.name}] Signal check ═══════════════════════════\n`);

    const log = state.log;
    const smaPeriod = rules.smaPeriod ?? 200;
    const btcSymbol = rules.universe?.[0]?.symbol || "BTC/USD";
    const today = new Date().toISOString().slice(0, 10);

    let candles;
    try {
      candles = await broker.fetchCandles(btcSymbol, "1D", { limit: smaPeriod + 20 });
    } catch (err) {
      console.log(`  ❌ candles fetch failed: ${err.message}`);
      await notify.error("BTC candles", err.message);
      return;
    }

    if (!candles || candles.length < smaPeriod + 1) {
      console.log(`  ❌ insufficient BTC history (${candles?.length ?? 0} bars, need ${smaPeriod + 1})`);
      return;
    }

    const closes = candles.map((c) => c.close);
    const lastClose = closes[closes.length - 1];
    const sma = calcSMA(closes, smaPeriod);
    const signalLong = lastClose > sma;

    console.log(`  BTC: $${lastClose.toFixed(2)}  SMA(${smaPeriod}): $${sma.toFixed(2)}  → ${signalLong ? "LONG" : "CASH"}`);

    let positions = [];
    try { positions = await broker.fetchPositions(); }
    catch (err) {
      console.log(`  ❌ positions fetch failed: ${err.message}`);
      return;
    }
    const hasBtc = positions.some((p) => p.symbol === "BTCUSD" || p.symbol === "BTC/USD");

    if (signalLong && !hasBtc) {
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
      const notional = equity * 0.98;
      console.log(`  🟢 ENTER BTC @ ${(equity).toFixed(2)}  → $${notional.toFixed(2)}`);
      try {
        const res = await broker.placeOrder({
          symbol: btcSymbol, side: "buy", notional, type: "market",
        });
        if (log) recordTrade(log, {
          symbol: btcSymbol, side: "buy", orderPlaced: true, orderId: res.orderId,
          entryDate: today, entryPrice: lastClose, notional,
          signal: `close $${lastClose.toFixed(2)} > SMA(${smaPeriod}) $${sma.toFixed(2)}`,
        });
        if (notify) await notify.tradeExecuted({
          symbol: btcSymbol, side: "buy", price: lastClose, size: notional,
          orderId: res.orderId, note: `BTC > SMA(${smaPeriod})`,
        });
      } catch (err) {
        console.log(`    ❌ ${err.message}`);
        await notify.error(`${btcSymbol} buy`, err.message);
      }
    } else if (!signalLong && hasBtc) {
      console.log(`  🔴 EXIT BTC  (close $${lastClose.toFixed(2)} ≤ SMA $${sma.toFixed(2)})`);
      try {
        await broker.closePosition("BTC/USD");
        if (log) recordTrade(log, {
          symbol: btcSymbol, side: "sell", orderPlaced: true,
          entryDate: today, signal: `BTC ≤ SMA(${smaPeriod})`,
        });
      } catch (err) {
        console.log(`    ❌ ${err.message}`);
        await notify.error(`${btcSymbol} close`, err.message);
      }
    } else {
      console.log(`  ⏸  no action — ${signalLong ? "already long" : "already cash"}`);
    }
    console.log("");
  },
};
