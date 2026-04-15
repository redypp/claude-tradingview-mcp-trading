/**
 * Multi-strategy trading bot — governance-first dispatcher.
 *
 * Loads strategy mandates from mandates/, enforces portfolio-level
 * risk limits and kill switches, and tracks per-strategy attribution.
 *
 * Usage:
 *   node bot.js                              # runs all active strategies
 *   node bot.js --strategies=name1,name2     # runs only the named strategies
 *   node bot.js --manage-positions           # exit management only
 *   node bot.js --list                       # lists mandates + status
 *   node bot.js --stats                      # prints attribution stats
 */

import "dotenv/config";
import { existsSync } from "fs";
import { createAlpacaClient } from "./brokers/alpaca.js";
import { createNotifier } from "./engine/telegram.js";
import { managePositions } from "./engine/exit-engine.js";
import { loadLog, saveLog } from "./engine/logging.js";
import { listMandates, loadMandate, isActive } from "./portfolio/mandate.js";
import {
  loadPortfolioState,
  savePortfolioState,
  initStrategyState,
} from "./portfolio/state.js";
import { wrapBroker } from "./portfolio/risk-manager.js";
import { computeStats, compareToMandate } from "./portfolio/attribution.js";

function createBrokerFromMandate(mandate) {
  const brokerConfig = mandate.broker || {};
  const prefix = brokerConfig.account_env_prefix || "ALPACA";

  if (brokerConfig.type === "alpaca" || !brokerConfig.type) {
    const apiKey = process.env[`${prefix}_API_KEY`];
    const secretKey = process.env[`${prefix}_SECRET_KEY`];
    if (!apiKey || !secretKey) {
      throw new Error(
        `Missing credentials — expected ${prefix}_API_KEY and ${prefix}_SECRET_KEY in .env`,
      );
    }
    return createAlpacaClient({
      apiKey,
      secretKey,
      baseUrl: process.env[`${prefix}_BASE_URL`] || "https://paper-api.alpaca.markets",
      dataUrl: process.env[`${prefix}_DATA_URL`] || "https://data.alpaca.markets",
    });
  }

  throw new Error(`Unsupported broker type: ${brokerConfig.type}`);
}

async function loadStrategyModule(name) {
  const path = `./strategies/${name}.js`;
  if (!existsSync(path)) {
    throw new Error(`Strategy module not found: ${path}`);
  }
  const mod = await import(path);
  return mod.default;
}

function wrapDryRun(broker) {
  return {
    ...broker,
    async placeOrder(args) {
      console.log(`  🧪 [dry-run] placeOrder(${JSON.stringify(args)})`);
      return { orderId: `dry-${Date.now()}`, status: "dry-run", symbol: args.symbol };
    },
    async closePosition(symbol) {
      console.log(`  🧪 [dry-run] closePosition(${symbol})`);
      return { orderId: `dry-close-${Date.now()}`, status: "dry-run" };
    },
  };
}

async function runStrategy(name, { manageOnly = false, forceRebalance = false, dryRun = false } = {}) {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Strategy: ${name}`);
  console.log(`  ${new Date().toISOString()}`);
  console.log(`═══════════════════════════════════════════════════════════`);

  let mandate;
  try {
    mandate = loadMandate(name);
  } catch (err) {
    console.log(`  ❌ Mandate load failed: ${err.message}`);
    return;
  }

  if (!isActive(mandate)) {
    console.log(`  ⏸  Skipped — status=${mandate.status}${mandate.killReason ? ` (${mandate.killReason})` : ""}`);
    return;
  }

  const portfolioState = loadPortfolioState();
  const strategyState = initStrategyState(portfolioState, mandate);
  savePortfolioState(portfolioState);

  if (strategyState.killed) {
    console.log(`  ⛔ Strategy killed — ${strategyState.killReason}`);
    return;
  }

  let rawBroker, strategy;
  try {
    rawBroker = createBrokerFromMandate(mandate);
    strategy = await loadStrategyModule(name);
  } catch (err) {
    console.log(`  ❌ Init failed: ${err.message}`);
    return;
  }

  if (dryRun) {
    console.log(`  🧪 DRY-RUN MODE — no real orders will be placed`);
    rawBroker = wrapDryRun(rawBroker);
  }

  const notify = createNotifier(strategy.name || name);
  const broker = wrapBroker({
    broker: rawBroker,
    mandate,
    strategyState,
    savePortfolioState,
    portfolioState,
    notify,
  });

  await broker.__governance.syncEquity();

  const kill = await broker.__governance.checkKillSwitches();
  if (kill.killed) {
    console.log(`  ⛔ Kill switch — ${kill.reason}`);
    return;
  }

  const rules = mandate.strategy || {};
  const log = loadLog(name);
  const state = { log };

  if (typeof strategy.shouldExit === "function") {
    try {
      await managePositions({ broker, strategy, log, notify, rules });
    } catch (err) {
      console.log(`  ❌ Exit management error: ${err.message}`);
      await notify.error("Exit management", err.message);
    }
  }

  if (manageOnly) {
    saveLog(name, log);
    await broker.__governance.syncEquity();
    return;
  }

  if (typeof strategy.run === "function") {
    try {
      if (forceRebalance) state.forceRebalance = true;
      await strategy.run({ broker, notify, rules, mandate, state });
    } catch (err) {
      console.log(`  ❌ Strategy run error: ${err.message}`);
      console.error(err);
      await notify.error("Strategy run", err.message);
    }
  }

  saveLog(name, log);

  await broker.__governance.syncEquity();

  const fresh = loadPortfolioState();
  const freshState = fresh.strategies[name];
  if (freshState) {
    const stats = computeStats(freshState);
    const flags = compareToMandate(stats, mandate);
    console.log(
      `  📊 Equity: $${stats.currentEquity.toFixed(2)} | DD: ${(stats.drawdownPct * 100).toFixed(1)}% | CAGR: ${(stats.cagr * 100).toFixed(1)}% | Sharpe: ${stats.sharpe.toFixed(2)} | Trades: ${stats.tradeCount}`,
    );
    if (flags.length) {
      for (const f of flags) console.log(`  ⚠️  ${f}`);
    }
  }
}

function printList() {
  const names = listMandates();
  if (!names.length) {
    console.log("No mandates found in mandates/.");
    return;
  }
  console.log("Mandates:");
  for (const n of names) {
    try {
      const m = loadMandate(n);
      console.log(`  ${m.status === "killed" ? "⛔" : isActive(m) ? "✅" : "⏸ "} ${n}  [${m.status}]  ${m.displayName}`);
    } catch (err) {
      console.log(`  ❌ ${n}  — ${err.message}`);
    }
  }
}

function printStats() {
  const portfolioState = loadPortfolioState();
  const names = Object.keys(portfolioState.strategies);
  if (!names.length) {
    console.log("No portfolio state yet. Run the bot first.");
    return;
  }
  console.log("Portfolio attribution:");
  for (const n of names) {
    const s = portfolioState.strategies[n];
    let mandate = null;
    try { mandate = loadMandate(n); } catch {}
    const stats = computeStats(s);
    console.log(`\n  ${n}`);
    console.log(`    Equity:     $${stats.currentEquity.toFixed(2)} (peak $${stats.peakEquity.toFixed(2)})`);
    console.log(`    Total ret:  ${(stats.totalReturnPct * 100).toFixed(2)}%`);
    console.log(`    CAGR:       ${(stats.cagr * 100).toFixed(2)}%`);
    console.log(`    Sharpe:     ${stats.sharpe.toFixed(2)}`);
    console.log(`    Drawdown:   ${(stats.drawdownPct * 100).toFixed(2)}%`);
    console.log(`    Trades:     ${stats.tradeCount}`);
    console.log(`    Days live:  ${stats.daysLive}`);
    if (s.killed) console.log(`    ⛔ Killed:  ${s.killReason}`);
    if (mandate) {
      const flags = compareToMandate(stats, mandate);
      for (const f of flags) console.log(`    ⚠️  ${f}`);
    }
  }
}

async function main() {
  if (process.argv.includes("--list")) return printList();
  if (process.argv.includes("--stats")) return printStats();

  const arg = process.argv.find((a) => a.startsWith("--strategies="));
  const strategies = arg
    ? arg.split("=")[1].split(",").map((s) => s.trim()).filter(Boolean)
    : listMandates();

  if (!strategies.length) {
    console.log("No mandates found in mandates/. Create one from mandates/TEMPLATE.json.");
    return;
  }

  const manageOnly = process.argv.includes("--manage-positions");
  const forceRebalance = process.argv.includes("--force-rebalance");
  const dryRun = process.argv.includes("--dry-run");

  console.log(`Running ${strategies.length} strateg${strategies.length === 1 ? "y" : "ies"}: ${strategies.join(", ")}`);
  if (manageOnly) console.log("(manage-only mode — no entry scans)");
  if (forceRebalance) console.log("(force-rebalance — strategies may rebalance off-schedule)");
  if (dryRun) console.log("(dry-run — orders logged, nothing submitted)");

  for (const s of strategies) {
    try {
      await runStrategy(s, { manageOnly, forceRebalance, dryRun });
    } catch (err) {
      console.error(`Fatal error running ${s}:`, err);
    }
  }

  console.log(`\nAll strategies complete. ${new Date().toISOString()}\n`);
}

main().catch((err) => {
  console.error("Bot error:", err);
  process.exit(1);
});
