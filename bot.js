/**
 * Multi-strategy trading bot dispatcher.
 *
 * Loads one or more strategy modules from strategies/, instantiates
 * a broker client per strategy using that strategy's configured
 * credentials, and runs each strategy in sequence.
 *
 * Usage:
 *   node bot.js                              # runs all enabled strategies
 *   node bot.js --strategies=dual-momentum   # runs only the named strategies
 *   node bot.js --manage-positions           # only runs exit management
 *   node bot.js --list                       # lists available strategies
 */

import "dotenv/config";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { createAlpacaClient } from "./brokers/alpaca.js";
import { createNotifier } from "./engine/telegram.js";
import { managePositions } from "./engine/exit-engine.js";
import { loadLog, saveLog } from "./engine/logging.js";

const RULES_DIR = "rules";

function listStrategies() {
  if (!existsSync(RULES_DIR)) return [];
  return readdirSync(RULES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

function loadRules(strategyName) {
  const path = join(RULES_DIR, `${strategyName}.json`);
  if (!existsSync(path)) {
    throw new Error(`No rules file for strategy "${strategyName}" at ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function createBrokerForStrategy(rules) {
  const brokerConfig = rules.broker || {};
  const prefix = brokerConfig.account_env_prefix || "ALPACA";

  if (brokerConfig.type === "alpaca" || !brokerConfig.type) {
    const apiKey = process.env[`${prefix}_API_KEY`];
    const secretKey = process.env[`${prefix}_SECRET_KEY`];
    if (!apiKey || !secretKey) {
      throw new Error(
        `Missing credentials for strategy — expected ${prefix}_API_KEY and ${prefix}_SECRET_KEY in .env`,
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

async function loadStrategyModule(strategyName) {
  const path = `./strategies/${strategyName}.js`;
  if (!existsSync(path)) {
    throw new Error(`Strategy module not found: ${path}`);
  }
  const mod = await import(path);
  return mod.default;
}

async function runStrategy(strategyName, { manageOnly = false } = {}) {
  console.log(`\n═══════════════════════════════════════════════════════════`);
  console.log(`  Strategy: ${strategyName}`);
  console.log(`  ${new Date().toISOString()}`);
  console.log(`═══════════════════════════════════════════════════════════`);

  let rules, broker, strategy;
  try {
    rules = loadRules(strategyName);
    broker = createBrokerForStrategy(rules);
    strategy = await loadStrategyModule(strategyName);
  } catch (err) {
    console.log(`  ❌ Failed to initialize: ${err.message}`);
    return;
  }

  const notify = createNotifier(strategy.name || strategyName);
  const state = {};

  // Every invocation: manage existing positions first (if strategy exposes shouldExit)
  if (typeof strategy.shouldExit === "function") {
    const log = loadLog(strategyName);
    state.log = log;
    try {
      await managePositions({ broker, strategy, log, notify });
      saveLog(strategyName, log);
    } catch (err) {
      console.log(`  ❌ Exit management error: ${err.message}`);
      await notify.error("Exit management", err.message);
    }
  }

  if (manageOnly) return;

  // Then run the strategy's main cycle
  if (typeof strategy.run === "function") {
    try {
      await strategy.run({ broker, notify, rules, state });
    } catch (err) {
      console.log(`  ❌ Strategy run error: ${err.message}`);
      console.error(err);
      await notify.error("Strategy run", err.message);
    }
  }
}

async function main() {
  if (process.argv.includes("--list")) {
    const strategies = listStrategies();
    console.log("Available strategies:");
    for (const s of strategies) console.log(`  - ${s}`);
    return;
  }

  // Resolve which strategies to run
  const strategiesArg = process.argv.find((a) => a.startsWith("--strategies="));
  let strategies;
  if (strategiesArg) {
    strategies = strategiesArg.split("=")[1].split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    strategies = listStrategies();
  }

  if (strategies.length === 0) {
    console.log("No strategies found in rules/. Create rules/<strategy>.json first.");
    return;
  }

  const manageOnly = process.argv.includes("--manage-positions");

  console.log(`Running ${strategies.length} strateg${strategies.length === 1 ? "y" : "ies"}: ${strategies.join(", ")}`);
  if (manageOnly) console.log("(manage-only mode — no entry scans)");

  for (const s of strategies) {
    try {
      await runStrategy(s, { manageOnly });
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
