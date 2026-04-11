/**
 * Per-strategy log persistence. Each strategy gets its own JSON
 * log file under state/log-<strategy>.json, so strategy A's trades
 * and exit history don't pollute strategy B's.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";

const STATE_DIR = "state";

function logPath(strategyName) {
  return join(STATE_DIR, `log-${strategyName}.json`);
}

function ensureStateDir() {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
  }
}

export function loadLog(strategyName) {
  const path = logPath(strategyName);
  if (!existsSync(path)) {
    return { strategy: strategyName, trades: [], exits: [], meta: {} };
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

export function saveLog(strategyName, log) {
  ensureStateDir();
  writeFileSync(logPath(strategyName), JSON.stringify(log, null, 2));
}

export function recordTrade(log, trade) {
  log.trades.push({ timestamp: new Date().toISOString(), ...trade });
}

export function recordExit(log, exit) {
  log.exits.push({ timestamp: new Date().toISOString(), ...exit });
}

export function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

/**
 * For strategies that rebalance on a fixed cadence (e.g., monthly),
 * record the last-evaluated date in meta so we can short-circuit
 * repeated evaluations within the same period.
 */
export function getLastRebalanceDate(log) {
  return log.meta?.lastRebalanceDate || null;
}

export function setLastRebalanceDate(log, dateISO) {
  if (!log.meta) log.meta = {};
  log.meta.lastRebalanceDate = dateISO;
}
