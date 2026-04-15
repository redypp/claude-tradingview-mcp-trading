/**
 * Smoke test — exercises the governance layer with a mock broker.
 * Run: node portfolio/test-governance.js
 */

import { loadMandate, saveMandate, validateMandate } from "./mandate.js";
import { initStrategyState, updateEquity, recordKill } from "./state.js";
import { wrapBroker } from "./risk-manager.js";
import { computeStats } from "./attribution.js";
import { writeFileSync, unlinkSync, existsSync } from "fs";

const TEST_NAME = "__test_gov";
const TEST_PATH = `mandates/${TEST_NAME}.json`;

function createMockBroker({ equity = 10000, positions = [] } = {}) {
  const orders = [];
  return {
    orders,
    async placeOrder(args) {
      orders.push(args);
      return { orderId: `mock-${orders.length}`, status: "accepted", symbol: args.symbol };
    },
    async fetchPositions() { return positions; },
    async fetchAccount() { return { equity, portfolio_value: equity }; },
    async closePosition() { return { orderId: "mock-close", status: "accepted" }; },
    async fetchCandles() { return []; },
  };
}

function makeMandate(overrides = {}) {
  return {
    name: TEST_NAME,
    displayName: "Governance Test",
    status: "paper",
    thesis: "test",
    broker: { type: "alpaca", account_env_prefix: "ALPACA_PAPER" },
    capital: { allocationPct: 1, startingEquity: 10000 },
    limits: { maxGrossExposurePct: 1, maxSinglePositionPct: 0.35 },
    killSwitches: { maxDrawdownPct: 0.25 },
    expected: { cagr: [0.08, 0.12], maxDrawdown: [0.15, 0.2], sharpe: [0.7, 1.0] },
    ...overrides,
  };
}

let passed = 0;
let failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ ${label}`); failed++; }
}

async function test_validation() {
  console.log("\n[validation]");
  try { validateMandate({}); assert(false, "rejects empty"); }
  catch { assert(true, "rejects empty mandate"); }

  try { validateMandate(makeMandate({ status: "weird" })); assert(false, "rejects bad status"); }
  catch { assert(true, "rejects bad status"); }

  try { validateMandate(makeMandate()); assert(true, "accepts valid mandate"); }
  catch (e) { assert(false, `rejects valid: ${e.message}`); }
}

async function test_single_position_clamp() {
  console.log("\n[single-position clamp]");
  const mandate = makeMandate();
  const portfolioState = { strategies: {} };
  const strategyState = initStrategyState(portfolioState, mandate);
  updateEquity(strategyState, 10000);
  const mock = createMockBroker({ equity: 10000 });
  const broker = wrapBroker({
    broker: mock, mandate, strategyState,
    savePortfolioState: () => {}, portfolioState,
    notify: { info: async () => {}, error: async () => {} },
  });
  await broker.placeOrder({ symbol: "SPY", side: "buy", notional: 5000 });
  const order = mock.orders[0];
  assert(Number(order.notional) === 3500, `notional 5000 clamped to max-single (35% = 3500), got ${order.notional}`);
}

async function test_gross_exposure_clip() {
  console.log("\n[gross-exposure clip]");
  const mandate = makeMandate({ limits: { maxGrossExposurePct: 1.0, maxSinglePositionPct: 1.0 } });
  const portfolioState = { strategies: {} };
  const strategyState = initStrategyState(portfolioState, mandate);
  updateEquity(strategyState, 10000);
  const mock = createMockBroker({
    equity: 10000,
    positions: [{ symbol: "SPY", market_value: "9000" }],
  });
  const broker = wrapBroker({
    broker: mock, mandate, strategyState,
    savePortfolioState: () => {}, portfolioState,
    notify: { info: async () => {}, error: async () => {} },
  });
  await broker.placeOrder({ symbol: "QQQ", side: "buy", notional: 5000 });
  const order = mock.orders[0];
  assert(Number(order.notional) === 1000, `order clipped to 1000 remaining gross headroom, got ${order.notional}`);
}

async function test_gross_exposure_hard_reject() {
  console.log("\n[gross-exposure hard reject at 0 headroom]");
  const mandate = makeMandate({ limits: { maxGrossExposurePct: 1.0, maxSinglePositionPct: 1.0 } });
  const portfolioState = { strategies: {} };
  const strategyState = initStrategyState(portfolioState, mandate);
  updateEquity(strategyState, 10000);
  const mock = createMockBroker({
    equity: 10000,
    positions: [{ symbol: "SPY", market_value: "10000" }],
  });
  const broker = wrapBroker({
    broker: mock, mandate, strategyState,
    savePortfolioState: () => {}, portfolioState,
    notify: { info: async () => {}, error: async () => {} },
  });
  let threw = false;
  try { await broker.placeOrder({ symbol: "QQQ", side: "buy", notional: 5000 }); }
  catch (e) { threw = /Gross exposure limit/.test(e.message); }
  assert(threw, "throws when no headroom remains");
  assert(mock.orders.length === 0, "no order reaches broker");
}

async function test_drawdown_kill() {
  console.log("\n[drawdown kill switch]");
  // Use a real file so markKilled() can save it
  saveMandate(makeMandate());
  const mandate = loadMandate(TEST_NAME);
  const portfolioState = { strategies: {} };
  const strategyState = initStrategyState(portfolioState, mandate);
  updateEquity(strategyState, 10000);
  updateEquity(strategyState, 7000); // 30% drawdown — past 25% limit

  const mock = createMockBroker({ equity: 7000 });
  const broker = wrapBroker({
    broker: mock, mandate, strategyState,
    savePortfolioState: () => {}, portfolioState,
    notify: { info: async () => {}, error: async () => {} },
  });

  let threw = false;
  try { await broker.placeOrder({ symbol: "SPY", side: "buy", notional: 1000 }); }
  catch (e) { threw = /killed/i.test(e.message); }
  assert(threw, "order rejected after drawdown breach");
  assert(strategyState.killed, "strategyState marked killed");

  const reloaded = loadMandate(TEST_NAME);
  assert(reloaded.status === "killed", "mandate status persisted as killed");
  unlinkSync(TEST_PATH);
}

async function test_stats() {
  console.log("\n[attribution stats]");
  const mandate = makeMandate();
  const portfolioState = { strategies: {} };
  const strategyState = initStrategyState(portfolioState, mandate);
  // Backdate startedAt by 1 year so CAGR calc is meaningful
  strategyState.startedAt = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  strategyState.equityHistory[0].date = strategyState.startedAt;
  // Add a synthetic year of equity points
  for (let i = 1; i <= 12; i++) {
    const date = new Date(Date.now() - (365 - i * 30) * 24 * 60 * 60 * 1000).toISOString();
    const equity = 10000 * (1 + 0.01 * i); // +1% per month
    strategyState.equityHistory.push({ date, equity });
  }
  updateEquity(strategyState, 11200);

  const stats = computeStats(strategyState);
  assert(stats.cagr > 0.08 && stats.cagr < 0.15, `CAGR in reasonable range: ${stats.cagr}`);
  assert(stats.totalReturnPct > 0.1, `total return > 10%: ${stats.totalReturnPct}`);
  assert(stats.daysLive > 300 && stats.daysLive < 400, `daysLive near 365: ${stats.daysLive}`);
}

async function main() {
  if (existsSync(TEST_PATH)) unlinkSync(TEST_PATH);
  await test_validation();
  await test_single_position_clamp();
  await test_gross_exposure_clip();
  await test_gross_exposure_hard_reject();
  await test_drawdown_kill();
  await test_stats();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
