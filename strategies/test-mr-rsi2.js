/**
 * Offline smoke test — exercises mr-rsi2 with a mock broker and
 * synthetic price data. Verifies: screen, entry signal, exit rules.
 * Run: node strategies/test-mr-rsi2.js
 */

import strategy from "./mr-rsi2.js";

function makeCandles({ days = 260, basePrice = 100, trend = 0.0003, volatility = 0.015, shock = null } = {}) {
  const candles = [];
  let price = basePrice;
  const today = Date.now();
  for (let i = 0; i < days; i++) {
    const seedDate = new Date(today - (days - i) * 24 * 60 * 60 * 1000);
    const r = ((i * 9301 + 49297) % 233280) / 233280 - 0.5;
    let change = trend + r * volatility;
    if (shock && i === days - shock.daysAgo) change = shock.pct;
    price *= 1 + change;
    candles.push({
      date: seedDate.toISOString().slice(0, 10),
      time: seedDate.getTime(),
      open: price * 0.999,
      high: price * 1.005,
      low: price * 0.995,
      close: price,
      volume: 10_000_000,
    });
  }
  return candles;
}

function mockBroker({ universeCandles, equity = 5000, existingPositions = [] } = {}) {
  const orders = [];
  return {
    orders,
    async placeOrder(args) {
      orders.push(args);
      return { orderId: `mock-${orders.length}`, status: "accepted", symbol: args.symbol };
    },
    async fetchPositions() { return existingPositions; },
    async fetchAccount() { return { equity, portfolio_value: equity }; },
    async closePosition() { return { orderId: "mock-close", status: "accepted" }; },
    async fetchCandles(symbol) {
      return universeCandles[symbol] || [];
    },
  };
}

const rules = {
  screenFilters: { minPriceUsd: 10, minAvgDollarVolume: 10_000_000, aboveSma200: true },
  entry: { rsiPeriod: 2, rsiEntryThreshold: 10 },
  exit: { rsiExitThreshold: 70, maxHoldDays: 5, stopLossPct: 0.05 },
  sizing: { maxConcurrentPositions: 8, positionPctOfEquity: 0.125 },
};

let passed = 0, failed = 0;
const assert = (cond, label) => {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ ${label}`); failed++; }
};

async function test_shouldExit_rsi_high() {
  console.log("\n[shouldExit — RSI > exit threshold]");
  // Build candles ending with a strong rally → high RSI
  const candles = makeCandles({ days: 50, basePrice: 100, trend: 0.01, volatility: 0.005 });
  const broker = mockBroker({ universeCandles: { FAKE: candles } });
  const decision = await strategy.shouldExit(
    { symbol: "FAKE", avg_entry_price: candles[candles.length - 5].close },
    {
      fetchCandles: broker.fetchCandles,
      daysHeld: 2,
      entryContext: { entryPrice: candles[candles.length - 5].close },
      rules,
    },
  );
  assert(decision.triggered, `exit triggered (${decision.reason || decision.note})`);
}

async function test_shouldExit_time_stop() {
  console.log("\n[shouldExit — time stop]");
  const candles = makeCandles({ days: 50, basePrice: 100 });
  const broker = mockBroker({ universeCandles: { FAKE: candles } });
  const decision = await strategy.shouldExit(
    { symbol: "FAKE", avg_entry_price: candles[candles.length - 1].close },
    {
      fetchCandles: broker.fetchCandles,
      daysHeld: 6,
      entryContext: { entryPrice: candles[candles.length - 1].close },
      rules,
    },
  );
  assert(decision.triggered && /time stop/i.test(decision.reason), `time stop fires (${decision.reason})`);
}

async function test_shouldExit_stop_loss() {
  console.log("\n[shouldExit — stop loss]");
  const candles = makeCandles({ days: 50, basePrice: 100 });
  const entryPrice = candles[candles.length - 1].close * 1.10; // entry 10% above current
  const broker = mockBroker({ universeCandles: { FAKE: candles } });
  const decision = await strategy.shouldExit(
    { symbol: "FAKE", avg_entry_price: entryPrice },
    {
      fetchCandles: broker.fetchCandles,
      daysHeld: 2,
      entryContext: { entryPrice },
      rules,
    },
  );
  assert(decision.triggered && /stop-loss/i.test(decision.reason), `stop-loss fires (${decision.reason})`);
}

async function test_run_picks_oversold() {
  console.log("\n[run — picks oversold stock in uptrend]");
  // Build two universes:
  //   AAPL: steady uptrend then sharp dip → should be above SMA200 AND RSI low → triggered
  //   MSFT: steady uptrend, no dip → RSI normal → not triggered
  const oversold = makeCandles({ days: 260, basePrice: 100, trend: 0.003 });
  // Force a moderate down move on last 2 days — still above SMA200 due to strong uptrend
  oversold[oversold.length - 2].close *= 0.97;
  oversold[oversold.length - 1].close = oversold[oversold.length - 2].close * 0.97;
  const steady = makeCandles({ days: 260, basePrice: 100, trend: 0.003 });

  const universeCandles = {};
  // Put our signals on symbols that are actually in SP500_TOP_LIQUID
  universeCandles.AAPL = oversold;
  universeCandles.MSFT = steady;
  // everything else gets steady candles too so they pass the screen but don't trigger
  const { SP500_TOP_LIQUID } = await import("./universes/sp500-top-liquid.js");
  for (const s of SP500_TOP_LIQUID) {
    if (!universeCandles[s]) universeCandles[s] = makeCandles({ days: 260, basePrice: 100, trend: 0.003 });
  }

  const broker = mockBroker({ universeCandles, equity: 5000 });
  const notify = {
    info: async () => {}, tradeExecuted: async () => {}, error: async () => {},
  };
  const state = { log: { strategy: "MR-RSI2", trades: [], exits: [], meta: {} } };

  await strategy.run({ broker, notify, rules, mandate: {}, state });

  const aaplOrder = broker.orders.find((o) => o.symbol === "AAPL");
  assert(!!aaplOrder, "AAPL order placed (oversold + uptrend)");
  assert(aaplOrder?.side === "buy", "AAPL order is a buy");
  const msftOrder = broker.orders.find((o) => o.symbol === "MSFT");
  assert(!msftOrder, "MSFT NOT ordered (no oversold signal)");

  const expectedNotional = 5000 * 0.125;
  assert(Math.abs(aaplOrder?.notional - expectedNotional) < 0.01, `notional ${aaplOrder?.notional} ≈ ${expectedNotional}`);
}

async function test_run_respects_slots() {
  console.log("\n[run — respects maxConcurrentPositions]");
  const { SP500_TOP_LIQUID } = await import("./universes/sp500-top-liquid.js");
  const universeCandles = {};
  for (const s of SP500_TOP_LIQUID) {
    // Make ALL of them oversold so we'd trigger every slot
    const c = makeCandles({ days: 260, basePrice: 100, trend: 0.003 });
    c[c.length - 2].close *= 0.97;
    c[c.length - 1].close = c[c.length - 2].close * 0.97;
    universeCandles[s] = c;
  }
  // 7 held already — only 1 slot free
  const existingPositions = SP500_TOP_LIQUID.slice(0, 7).map((s) => ({ symbol: s }));
  const broker = mockBroker({ universeCandles, equity: 5000, existingPositions });
  const notify = { info: async () => {}, tradeExecuted: async () => {}, error: async () => {} };
  const state = { log: { strategy: "MR-RSI2", trades: [], exits: [], meta: {} } };

  await strategy.run({ broker, notify, rules, mandate: {}, state });

  assert(broker.orders.length === 1, `only 1 order placed despite many triggers (got ${broker.orders.length})`);
}

async function main() {
  await test_shouldExit_rsi_high();
  await test_shouldExit_time_stop();
  await test_shouldExit_stop_loss();
  await test_run_picks_oversold();
  await test_run_respects_slots();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
