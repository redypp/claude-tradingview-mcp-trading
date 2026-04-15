/**
 * Mean Reversion — RSI(2) on Quality S&P 500.
 *
 * Daily workflow:
 *   1. shouldExit: for each open position, check RSI(2)>exit, time stop,
 *      or stop-loss. Close via exit-engine.
 *   2. run: screen the universe for candidates with RSI(2)<entry AND
 *      close > SMA(200) AND liquidity/price filters passed. Place
 *      market-on-open orders sized by mandate.
 *
 * Governance layer sizes and caps positions; this module only
 * produces intents (buy X at notional Y).
 */

import { calcRSI, calcSMA } from "../engine/indicators.js";
import { recordTrade } from "../engine/logging.js";
import { SP500_TOP_LIQUID } from "./universes/sp500-top-liquid.js";

const FETCH_CONCURRENCY = 4;
const FETCH_LIMIT = 250; // ~1 trading year — enough for SMA(200) + buffer

async function withLimit(items, limit, fn) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await fn(items[idx]);
      } catch (err) {
        results[idx] = { error: err.message };
      }
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

function avgDollarVolume(candles, lookback = 20) {
  const slice = candles.slice(-lookback);
  if (slice.length === 0) return 0;
  const sum = slice.reduce((acc, b) => acc + b.close * b.volume, 0);
  return sum / slice.length;
}

async function scoreSymbol(broker, symbol, rules) {
  const candles = await broker.fetchCandles(symbol, "1D", { limit: FETCH_LIMIT });
  if (!candles || candles.length < 205) {
    return { symbol, eligible: false, reason: "insufficient history" };
  }
  const closes = candles.map((c) => c.close);
  const lastClose = closes[closes.length - 1];

  const screen = rules.screenFilters || {};
  if (screen.minPriceUsd != null && lastClose < screen.minPriceUsd) {
    return { symbol, eligible: false, reason: `price $${lastClose.toFixed(2)} < $${screen.minPriceUsd}` };
  }
  if (screen.minAvgDollarVolume != null) {
    const dv = avgDollarVolume(candles, 20);
    if (dv < screen.minAvgDollarVolume) {
      return { symbol, eligible: false, reason: `avg $vol ${(dv / 1e6).toFixed(1)}M < ${(screen.minAvgDollarVolume / 1e6).toFixed(0)}M` };
    }
  }

  const sma200 = calcSMA(closes, 200);
  if (screen.aboveSma200 && (sma200 == null || lastClose <= sma200)) {
    return { symbol, eligible: false, reason: `below SMA200 ($${lastClose.toFixed(2)} ≤ $${sma200?.toFixed(2)})` };
  }

  const rsiPeriod = rules.entry?.rsiPeriod ?? 2;
  const rsi = calcRSI(closes, rsiPeriod);
  const entryThreshold = rules.entry?.rsiEntryThreshold ?? 10;

  if (rsi == null) return { symbol, eligible: false, reason: "RSI null" };

  const triggered = rsi < entryThreshold;
  return {
    symbol,
    eligible: true,
    triggered,
    rsi,
    lastClose,
    sma200,
    note: triggered ? `RSI(${rsiPeriod})=${rsi.toFixed(1)} < ${entryThreshold}` : `RSI=${rsi.toFixed(1)}`,
  };
}

export default {
  name: "MR-RSI2",

  async shouldExit(position, context) {
    const rules = context.rules || {};
    const exitCfg = rules.exit || {};
    const rsiPeriod = rules.entry?.rsiPeriod ?? 2;
    const exitThreshold = exitCfg.rsiExitThreshold ?? 70;
    const maxHoldDays = exitCfg.maxHoldDays ?? 5;
    const stopLossPct = exitCfg.stopLossPct ?? 0.05;

    const candles = await context.fetchCandles(position.symbol, "1D", { limit: 50 });
    if (!candles || candles.length < rsiPeriod + 2) {
      return { triggered: false, note: "insufficient data — holding" };
    }
    const closes = candles.map((c) => c.close);
    const lastClose = closes[closes.length - 1];
    const rsi = calcRSI(closes, rsiPeriod);

    const entryPrice = context.entryContext?.entryPrice ?? parseFloat(position.avg_entry_price);
    const drawdownPct = entryPrice > 0 ? (entryPrice - lastClose) / entryPrice : 0;

    if (drawdownPct >= stopLossPct) {
      return {
        triggered: true,
        reason: `stop-loss: ${(drawdownPct * 100).toFixed(1)}% below entry $${entryPrice.toFixed(2)}`,
        currentPrice: lastClose,
      };
    }
    if (rsi != null && rsi > exitThreshold) {
      return {
        triggered: true,
        reason: `RSI(${rsiPeriod})=${rsi.toFixed(1)} > ${exitThreshold}`,
        currentPrice: lastClose,
      };
    }
    if (context.daysHeld >= maxHoldDays) {
      return {
        triggered: true,
        reason: `time stop: held ${context.daysHeld}d ≥ ${maxHoldDays}d`,
        currentPrice: lastClose,
      };
    }
    return {
      triggered: false,
      note: `RSI=${rsi?.toFixed(1) ?? "?"} | held ${context.daysHeld}d | -${(drawdownPct * 100).toFixed(1)}%`,
    };
  },

  async run({ broker, notify, rules, mandate, state }) {
    console.log(`\n══ [${this.name}] Scanning for entries ═══════════════════════\n`);

    const sizing = rules.sizing || {};
    const maxConcurrent = sizing.maxConcurrentPositions ?? 8;
    const positionPct = sizing.positionPctOfEquity ?? 0.125;

    let positions;
    try { positions = await broker.fetchPositions(); }
    catch (err) {
      console.log(`  ❌ positions fetch failed: ${err.message}`);
      await notify.error("positions fetch", err.message);
      return;
    }
    const held = new Set(positions.map((p) => p.symbol));
    const slotsFree = Math.max(0, maxConcurrent - positions.length);
    console.log(`  Held: ${positions.length} | Slots free: ${slotsFree}`);
    if (slotsFree === 0) {
      console.log("  No capacity — skipping scan.\n");
      return;
    }

    const universe = SP500_TOP_LIQUID.filter((s) => !held.has(s));
    console.log(`  Scanning ${universe.length} symbols...`);
    const scored = await withLimit(universe, FETCH_CONCURRENCY, (sym) => scoreSymbol(broker, sym, rules));

    const errors = scored.filter((s) => s.error);
    if (errors.length) console.log(`  ⚠️  ${errors.length} fetch errors (skipped)`);

    const triggered = scored
      .filter((s) => s && s.eligible && s.triggered)
      .sort((a, b) => a.rsi - b.rsi); // most oversold first

    console.log(`  Triggered: ${triggered.length} candidate${triggered.length === 1 ? "" : "s"}`);
    for (const c of triggered.slice(0, 10)) {
      console.log(`    ${c.symbol}  ${c.note}  @ $${c.lastClose.toFixed(2)}`);
    }

    if (triggered.length === 0) {
      console.log("  No entries today.\n");
      return;
    }

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
    const notionalPerPosition = equity * positionPct;

    const toOpen = triggered.slice(0, slotsFree);
    const log = state.log;
    console.log(`  Opening ${toOpen.length} position${toOpen.length === 1 ? "" : "s"} @ $${notionalPerPosition.toFixed(2)} each...`);

    for (const c of toOpen) {
      try {
        const res = await broker.placeOrder({
          symbol: c.symbol,
          side: "buy",
          notional: notionalPerPosition,
          type: "market",
          timeInForce: "day",
        });
        const entryDate = new Date().toISOString().slice(0, 10);
        console.log(`    ✅ ${c.symbol}  order ${res.orderId} (${res.status})`);
        if (log) {
          recordTrade(log, {
            symbol: c.symbol,
            side: "buy",
            orderPlaced: true,
            orderId: res.orderId,
            entryDate,
            entryPrice: c.lastClose,
            notional: notionalPerPosition,
            signal: c.note,
          });
        }
        if (notify) {
          await notify.tradeExecuted({
            symbol: c.symbol,
            side: "buy",
            price: c.lastClose,
            size: notionalPerPosition,
            orderId: res.orderId,
            note: c.note,
          });
        }
      } catch (err) {
        console.log(`    ❌ ${c.symbol}  ${err.message}`);
        await notify.error(`${c.symbol} order`, err.message);
      }
    }

    console.log("");
  },
};
