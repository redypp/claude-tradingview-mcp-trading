import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const STATE_DIR = "state";
const STATE_FILE = join(STATE_DIR, "portfolio.json");

function ensureDir() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

export function loadPortfolioState() {
  ensureDir();
  if (!existsSync(STATE_FILE)) return { strategies: {} };
  return JSON.parse(readFileSync(STATE_FILE, "utf8"));
}

export function savePortfolioState(state) {
  ensureDir();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

export function getStrategyState(state, name) {
  return state.strategies[name];
}

export function initStrategyState(state, mandate) {
  if (state.strategies[mandate.name]) return state.strategies[mandate.name];
  const now = new Date().toISOString();
  const startingEquity = mandate.capital.startingEquity;
  state.strategies[mandate.name] = {
    name: mandate.name,
    startedAt: now,
    startingEquity,
    currentEquity: startingEquity,
    peakEquity: startingEquity,
    drawdownPct: 0,
    killed: false,
    killReason: null,
    killedAt: null,
    equityHistory: [{ date: now, equity: startingEquity }],
    tradeCount: 0,
    lastTradeAt: null,
  };
  return state.strategies[mandate.name];
}

export function updateEquity(strategyState, newEquity) {
  const now = new Date().toISOString();
  strategyState.currentEquity = newEquity;
  if (newEquity > strategyState.peakEquity) {
    strategyState.peakEquity = newEquity;
  }
  strategyState.drawdownPct = (strategyState.peakEquity - newEquity) / strategyState.peakEquity;

  const last = strategyState.equityHistory[strategyState.equityHistory.length - 1];
  const lastDate = last?.date.slice(0, 10);
  const today = now.slice(0, 10);
  if (lastDate !== today) {
    strategyState.equityHistory.push({ date: now, equity: newEquity });
    // cap history at 2000 entries (~8 years daily)
    if (strategyState.equityHistory.length > 2000) {
      strategyState.equityHistory.splice(0, strategyState.equityHistory.length - 2000);
    }
  } else {
    last.equity = newEquity;
    last.date = now;
  }
}

export function recordKill(strategyState, reason) {
  strategyState.killed = true;
  strategyState.killReason = reason;
  strategyState.killedAt = new Date().toISOString();
}

export function recordTrade(strategyState) {
  strategyState.tradeCount = (strategyState.tradeCount || 0) + 1;
  strategyState.lastTradeAt = new Date().toISOString();
}
