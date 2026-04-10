/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Strategy: Institutional Accumulation + Insider Buying
 * Reads indicator values from TradingView (IVB, EMAs, RSI, ATR),
 * checks insider buying via Finnhub (SEC Form 4), executes via Alpaca.
 *
 * Local mode: run manually — node bot.js
 * Cloud mode: deploy to Railway, set env vars, Railway triggers on cron schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { execSync } from "child_process";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const required = ["ALPACA_API_KEY", "ALPACA_SECRET_KEY"];
  const missing = required.filter((k) => !process.env[k]);

  if (!existsSync(".env")) {
    console.log(
      "\n⚠️  No .env file found — opening it for you to fill in...\n",
    );
    writeFileSync(
      ".env",
      [
        "# Alpaca credentials",
        "ALPACA_API_KEY=",
        "ALPACA_SECRET_KEY=",
        "",
        "# Finnhub (insider data)",
        "FINNHUB_API_KEY=",
        "",
        "# Trading config",
        "PORTFOLIO_VALUE_USD=1000",
        "MAX_TRADE_SIZE_USD=100",
        "MAX_TRADES_PER_DAY=3",
        "PAPER_TRADING=true",
        "SYMBOL=SPY",
        "TIMEFRAME=1D",
      ].join("\n") + "\n",
    );
    try {
      execSync("open .env");
    } catch {}
    console.log(
      "Fill in your credentials in .env then re-run: node bot.js\n",
    );
    process.exit(0);
  }

  if (missing.length > 0) {
    console.log(`\n⚠️  Missing credentials in .env: ${missing.join(", ")}`);
    console.log("Opening .env for you now...\n");
    try {
      execSync("open .env");
    } catch {}
    console.log("Add the missing values then re-run: node bot.js\n");
    process.exit(0);
  }

  if (!process.env.FINNHUB_API_KEY) {
    console.log(
      "\n⚠️  FINNHUB_API_KEY missing — insider data check will be skipped.",
    );
    console.log(
      "   Get a free key at https://finnhub.io/register\n",
    );
  }

  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "SPY",
  timeframe: process.env.TIMEFRAME || "1D",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  alpaca: {
    apiKey: process.env.ALPACA_API_KEY,
    secretKey: process.env.ALPACA_SECRET_KEY,
    get baseUrl() {
      return CONFIG.paperTrading
        ? "https://paper-api.alpaca.markets"
        : "https://api.alpaca.markets";
    },
    dataUrl: "https://data.alpaca.markets",
  },
  finnhub: {
    apiKey: process.env.FINNHUB_API_KEY,
  },
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },
};

const LOG_FILE = "safety-check-log.json";

// ─── Telegram Alerts ────────────────────────────────────────────────────────

async function sendTelegram(message) {
  if (!CONFIG.telegram.token || !CONFIG.telegram.chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${CONFIG.telegram.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CONFIG.telegram.chatId,
        text: message,
        parse_mode: "HTML",
      }),
    });
  } catch (err) {
    console.log(`  Telegram error: ${err.message}`);
  }
}

async function notifyTradeExecuted(symbol, side, price, size, orderId, bias) {
  const icon = side === "buy" ? "🟢" : "🔴";
  const mode = CONFIG.paperTrading ? "📋 PAPER" : "🔴 LIVE";
  await sendTelegram(
    `${icon} <b>TRADE PLACED</b>\n\n` +
    `Symbol: <b>${symbol}</b>\n` +
    `Side: ${side.toUpperCase()}\n` +
    `Price: $${price.toFixed(2)}\n` +
    `Size: $${size.toFixed(2)}\n` +
    `Bias: ${bias}\n` +
    `Mode: ${mode}\n` +
    `Order: ${orderId}`
  );
}

async function notifyBlocked(symbol, failedConditions, indicators) {
  const failed = failedConditions.join("\n• ");
  await sendTelegram(
    `🚫 <b>TRADE BLOCKED</b> — ${symbol}\n\n` +
    `Failed:\n• ${failed}\n\n` +
    `Price: $${indicators.price?.toFixed(2) || "N/A"} | ` +
    `RSI: ${indicators.rsi?.toFixed(1) || "N/A"}`
  );
}

async function notifyScanSummary(scanned, insiderPicks, readyToTrade, ranked) {
  const top = (ranked || []).slice(0, 5).map(s =>
    `  ${s.symbol}: ${s.passCount}/3 conditions, ${s.insiderData.buys} insider buys`
  ).join("\n");

  const readyList = readyToTrade > 0
    ? `\n\n✅ ${readyToTrade} stocks ready to trade!`
    : "\n\nNo stocks pass all conditions yet.";

  await sendTelegram(
    `📊 <b>SCAN COMPLETE</b>\n\n` +
    `Stocks scanned: ${scanned}\n` +
    `Insider buying: ${insiderPicks}\n` +
    `Ready to trade: ${readyToTrade}` +
    readyList +
    (top ? `\n\n<b>Top watchlist:</b>\n${top}` : "")
  );
}

async function notifyError(context, error) {
  await sendTelegram(
    `❌ <b>BOT ERROR</b>\n\n` +
    `Context: ${context}\n` +
    `Error: ${error}`
  );
}

async function notifyStartup() {
  const mode = CONFIG.paperTrading ? "📋 PAPER" : "🔴 LIVE";
  await sendTelegram(
    `🤖 <b>Bot starting</b>\n\n` +
    `Mode: ${mode}\n` +
    `Time: ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET\n` +
    `Strategy: V5 Heavy Insiders`
  );
}

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Market Data (Alpaca Data API) ──────────────────────────────────────────

async function fetchCandles(symbol, interval, limit = 100) {
  const intervalMap = {
    "1m": "1Min",
    "5m": "5Min",
    "15m": "15Min",
    "30m": "30Min",
    "1H": "1Hour",
    "4H": "4Hour",
    "1D": "1Day",
    "1W": "1Week",
  };
  const alpacaTimeframe = intervalMap[interval] || "1Day";

  const isCrypto = symbol.includes("/");
  const endpoint = isCrypto
    ? `/v1beta3/crypto/us/bars`
    : `/v2/stocks/${symbol}/bars`;

  // Calculate date range — go back far enough for SMA(200) on daily
  const end = new Date().toISOString().slice(0, 10);
  const msBack = interval === "1D" || interval === "1W"
    ? 400 * 24 * 60 * 60 * 1000   // ~400 days for daily
    : 30 * 24 * 60 * 60 * 1000;   // 30 days for intraday
  const start = new Date(Date.now() - msBack).toISOString().slice(0, 10);

  const params = new URLSearchParams({
    timeframe: alpacaTimeframe,
    limit: limit.toString(),
    start,
    end,
  });
  if (isCrypto) {
    params.set("symbols", symbol);
  } else {
    params.set("feed", "iex");
    params.set("adjustment", "raw");
  }

  const url = `${CONFIG.alpaca.dataUrl}${endpoint}?${params}`;
  const res = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID": CONFIG.alpaca.apiKey,
      "APCA-API-SECRET-KEY": CONFIG.alpaca.secretKey,
    },
  });
  if (!res.ok) throw new Error(`Alpaca Data API error: ${res.status} ${await res.text()}`);
  const data = await res.json();

  const bars = isCrypto ? (data.bars[symbol] || []) : (data.bars || []);

  return bars.map((b) => ({
    time: new Date(b.t).getTime(),
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v,
  }));
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(closes.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
    trs.push(tr);
  }
  const recent = trs.slice(trs.length - period);
  return recent.reduce((a, b) => a + b, 0) / period;
}

function calcRVOL(candles, period = 20) {
  if (candles.length < period + 1) return null;
  const currentVol = candles[candles.length - 1].volume;
  const avgVol =
    candles
      .slice(candles.length - period - 1, candles.length - 1)
      .reduce((sum, c) => sum + c.volume, 0) / period;
  return avgVol === 0 ? null : currentVol / avgVol;
}

function calcClosePosition(candle) {
  const range = candle.high - candle.low;
  if (range === 0) return 50;
  return ((candle.close - candle.low) / range) * 100;
}

// ─── Insider Data (Finnhub — SEC Form 4 Filings) ───────────────────────────

async function fetchInsiderTransactions(symbol) {
  if (!CONFIG.finnhub.apiKey) {
    return { available: false, reason: "No FINNHUB_API_KEY configured" };
  }

  const url = `https://finnhub.io/api/v1/stock/insider-transactions?symbol=${symbol}&token=${CONFIG.finnhub.apiKey}`;
  const res = await fetch(url);
  if (!res.ok) {
    return { available: false, reason: `Finnhub API error: ${res.status}` };
  }

  const data = await res.json();
  const transactions = data.data || [];

  // Filter to last 90 days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const recent = transactions.filter(
    (t) => t.transactionDate >= cutoffStr,
  );

  // Count buys vs sells (acquisition = buy, disposition = sell)
  const buys = recent.filter(
    (t) => t.transactionCode === "P" || t.transactionCode === "A",
  );
  const sells = recent.filter(
    (t) => t.transactionCode === "S" || t.transactionCode === "D",
  );

  const buyShares = buys.reduce((sum, t) => sum + Math.abs(t.share || 0), 0);
  const sellShares = sells.reduce((sum, t) => sum + Math.abs(t.share || 0), 0);
  const netBuying = buyShares > sellShares;

  return {
    available: true,
    totalTransactions: recent.length,
    buys: buys.length,
    sells: sells.length,
    buyShares,
    sellShares,
    netBuying,
    recentBuyers: buys.slice(0, 5).map((t) => ({
      name: t.name,
      shares: t.share,
      date: t.transactionDate,
    })),
  };
}

// ─── Stock Screener ─────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadUniverse() {
  if (!existsSync("universe.json")) {
    console.log("  ⚠️  No universe.json found — falling back to single symbol mode.");
    return null;
  }
  const data = JSON.parse(readFileSync("universe.json", "utf8"));
  return data.symbols;
}

// Step 1: Scan all stocks for insider buying (Finnhub, rate-limited)
// V5 strategy: require 5+ insider buys for strong conviction
async function screenInsiderBuying(symbols) {
  console.log(`\n── Insider Scan: Screening ${symbols.length} stocks ─────────────\n`);

  const BATCH_SIZE = 30;  // Finnhub free tier: 60 calls/min — stay safe
  const BATCH_DELAY_MS = 31000;  // Wait 31s between batches
  const MIN_INSIDER_BUYS = 5;  // V5: require heavy insider buying
  const candidates = [];

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(symbols.length / BATCH_SIZE);

    console.log(`  Batch ${batchNum}/${totalBatches}: scanning ${batch.join(", ").slice(0, 80)}...`);

    const results = await Promise.all(
      batch.map(async (symbol) => {
        try {
          const data = await fetchInsiderTransactions(symbol);
          if (data.available && data.buys >= MIN_INSIDER_BUYS && data.netBuying) {
            return { symbol, insiderData: data };
          }
        } catch {
          // Skip symbols that fail
        }
        return null;
      }),
    );

    const hits = results.filter(Boolean);
    candidates.push(...hits);

    if (hits.length > 0) {
      console.log(`    → Found ${hits.length}: ${hits.map((h) => `${h.symbol}(${h.insiderData.buys})`).join(", ")}`);
    }

    // Rate limit: wait between batches (skip after last batch)
    if (i + BATCH_SIZE < symbols.length) {
      console.log(`    ⏳ Rate limit pause (${BATCH_DELAY_MS / 1000}s)...`);
      await sleep(BATCH_DELAY_MS);
    }
  }

  console.log(`\n  Insider scan complete: ${candidates.length} stocks with 5+ insider buys\n`);
  return candidates;
}

// Step 2: Run technical filter on insider candidates
async function screenTechnicals(candidates) {
  console.log(`── Technical Filter: Checking ${candidates.length} insider picks ──\n`);

  const scored = [];

  for (const { symbol, insiderData } of candidates) {
    try {
      const candles = await fetchCandles(symbol, CONFIG.timeframe, 250);
      if (!candles || candles.length < 200) {
        console.log(`  ${symbol}: skipped — not enough data (${candles ? candles.length : 0} bars)`);
        continue;
      }

      const closes = candles.map((c) => c.close);
      const price = closes[closes.length - 1];
      const latestCandle = candles[candles.length - 1];

      const ema10 = calcEMA(closes, 10);
      const ema21 = calcEMA(closes, 21);
      const sma50 = calcSMA(closes, 50);
      const sma200 = calcSMA(closes, 200);
      const rsi = calcRSI(closes, 14);
      const atr = calcATR(candles, 14);
      const rvol = calcRVOL(candles, 20);
      const closePos = calcClosePosition(latestCandle);

      if (!sma200 || !rsi) continue;

      // V5 conditions: simplified trend + relaxed RSI
      const trendUp = ema10 > ema21;
      const aboveSMA200 = price > sma200;
      const rsiPass = rsi > 35 && rsi < 70;

      const conditions = [trendUp, aboveSMA200, rsiPass];
      const passCount = conditions.filter(Boolean).length;

      // Score: technical conditions (0-3) * 10 + insider strength bonus
      const insiderScore = Math.min(insiderData.buys, 20);  // Cap at 20
      const totalScore = passCount * 10 + insiderScore;

      const status = passCount === 3 ? "✅ ALL PASS" : `${passCount}/3 conditions`;

      console.log(
        `  ${symbol.padEnd(6)} | ${status} | ` +
        `Insiders: ${insiderData.buys} buys | ` +
        `EMA10${ema10 > ema21 ? ">" : "<"}EMA21 | ` +
        `RSI: ${rsi.toFixed(0)} | ` +
        `Score: ${totalScore}`,
      );

      scored.push({
        symbol,
        price,
        indicators: { ema10, ema21, sma50, sma200, rsi, atr, rvol, closePos },
        insiderData,
        passCount,
        allPass: passCount === 3,
        totalScore,
      });
    } catch (err) {
      console.log(`  ${symbol}: error — ${err.message}`);
    }
  }

  // Sort by score (highest first), then by pass count
  scored.sort((a, b) => b.totalScore - a.totalScore || b.passCount - a.passCount);

  return scored;
}

// Step 3: Run the full screener pipeline
async function runScreener() {
  const symbols = await loadUniverse();
  if (!symbols) return null;

  // Step 1: Insider scan
  const insiderPicks = await screenInsiderBuying(symbols);
  if (insiderPicks.length === 0) {
    console.log("  No stocks with insider buying found. No trades today.");
    return [];
  }

  // Step 2: Technical filter
  const ranked = await screenTechnicals(insiderPicks);

  // Show top 10 results
  console.log("\n── Top Candidates (ranked by score) ─────────────────────\n");
  const top10 = ranked.slice(0, 10);
  top10.forEach((s, i) => {
    const badge = s.allPass ? "🟢 READY" : "🟡 WAIT ";
    console.log(
      `  ${i + 1}. ${badge} ${s.symbol.padEnd(6)} | ` +
      `Score: ${s.totalScore} | ${s.passCount}/3 technical | ` +
      `${s.insiderData.buys} insider buys | ` +
      `$${s.price.toFixed(2)}`,
    );
  });

  return ranked;
}

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(indicators, insiderData) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check (V5: Heavy Insiders) ────────────────────\n");

  const { price, ema10, ema21, sma50, sma200, rsi, atr, rvol, closePos } = indicators;

  // V5: Simplified trend — just EMA10 > EMA21 + above SMA200
  const trendUp = ema10 > ema21;
  const aboveSMA200 = price > sma200;

  if (trendUp && aboveSMA200) {
    console.log("  Bias: BULLISH — checking entry conditions\n");

    // 1. EMA10 > EMA21 (short-term uptrend)
    check(
      "EMA(10) > EMA(21) (short-term trend up)",
      `EMA10 > EMA21`,
      `EMA10: ${ema10.toFixed(2)} | EMA21: ${ema21.toFixed(2)}`,
      trendUp,
    );

    // 2. Price above SMA 200
    check(
      "Price above SMA 200 (long-term uptrend)",
      `> ${sma200.toFixed(2)}`,
      price.toFixed(2),
      aboveSMA200,
    );

    // 3. RSI between 35-70 (wider range than before)
    check(
      "RSI(14) between 35-70 (not overbought)",
      "35 < RSI < 70",
      rsi ? rsi.toFixed(2) : "N/A",
      rsi !== null && rsi > 35 && rsi < 70,
    );

    // 4. Heavy insider buying (5+ buys in 90 days)
    if (insiderData.available) {
      check(
        "Heavy insider buying (5+ purchases in 90 days)",
        ">= 5 insider buys, net buying",
        `${insiderData.buys} buys, ${insiderData.sells} sells (net: ${insiderData.netBuying ? "BUYING" : "SELLING"})`,
        insiderData.buys >= 5 && insiderData.netBuying,
      );
    } else {
      check(
        "Heavy insider buying (5+ purchases in 90 days)",
        "Data available",
        insiderData.reason,
        false,
      );
    }

  } else {
    console.log("  Bias: NO ENTRY — trend conditions not met.\n");
    console.log(`     EMA10: ${ema10.toFixed(2)} | EMA21: ${ema21.toFixed(2)} | SMA200: ${sma200.toFixed(2)}`);
    console.log(`     Price: ${price.toFixed(2)} | EMA10>EMA21: ${trendUp ? "YES" : "NO"} | Above SMA200: ${aboveSMA200 ? "YES" : "NO"}`);
    results.push({
      label: "Trend direction",
      required: "EMA10 > EMA21 and price > SMA200",
      actual: `EMA10${trendUp ? ">" : "<"}EMA21, price ${aboveSMA200 ? "above" : "below"} SMA200`,
      pass: false,
    });
  }

  const allPass = results.every((r) => r.pass);
  return { results, allPass, bias: trendUp && aboveSMA200 ? "BULLISH" : "NEUTRAL" };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(
      `🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`,
    );
    return false;
  }

  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`,
  );

  return true;
}

// ─── Alpaca Execution ───────────────────────────────────────────────────────

async function placeAlpacaOrder(symbol, side, sizeUSD, price) {
  const body = JSON.stringify({
    symbol: symbol.replace("/", ""),
    side,
    type: "market",
    time_in_force: "day",
    notional: sizeUSD.toFixed(2),
  });

  const res = await fetch(`${CONFIG.alpaca.baseUrl}/v2/orders`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "APCA-API-KEY-ID": CONFIG.alpaca.apiKey,
      "APCA-API-SECRET-KEY": CONFIG.alpaca.secretKey,
    },
    body,
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Alpaca order failed: ${data.message || JSON.stringify(data)}`);
  }

  return { orderId: data.id, status: data.status };
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = logEntry.bias === "BEARISH" ? "SELL" : "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    notes = "All conditions met";
  } else {
    side = logEntry.bias === "BEARISH" ? "SELL" : "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
  }

  const row = [
    date,
    time,
    "Alpaca",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Execute Trade on a Single Symbol ───────────────────────────────────────

async function evaluateAndTrade(symbol, log) {
  console.log(`\n══ Evaluating ${symbol} ══════════════════════════════════════\n`);

  // Fetch candle data
  console.log("── Fetching market data from Alpaca ────────────────────\n");
  const candles = await fetchCandles(symbol, CONFIG.timeframe, 250);
  if (!candles || candles.length < 200) {
    console.log(`  ⚠️  Not enough data for ${symbol} (${candles ? candles.length : 0} bars). Skipping.`);
    return null;
  }
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  const latestCandle = candles[candles.length - 1];
  console.log(`  Current price: $${price.toFixed(2)}`);

  // Calculate indicators
  const ema10 = calcEMA(closes, 10);
  const ema21 = calcEMA(closes, 21);
  const sma50 = calcSMA(closes, 50);
  const sma200 = calcSMA(closes, 200);
  const rsi = calcRSI(closes, 14);
  const atr = calcATR(candles, 14);
  const rvol = calcRVOL(candles, 20);
  const closePos = calcClosePosition(latestCandle);

  console.log(`  EMA(10):  $${ema10.toFixed(2)}`);
  console.log(`  EMA(21):  $${ema21.toFixed(2)}`);
  console.log(`  SMA(50):  ${sma50 ? "$" + sma50.toFixed(2) : "N/A"}`);
  console.log(`  SMA(200): ${sma200 ? "$" + sma200.toFixed(2) : "N/A"}`);
  console.log(`  RSI(14):  ${rsi ? rsi.toFixed(2) : "N/A"}`);
  console.log(`  ATR(14):  ${atr ? "$" + atr.toFixed(2) : "N/A"}`);
  console.log(`  RVOL:     ${rvol ? rvol.toFixed(2) + "x" : "N/A"}`);
  console.log(`  Close Pos: ${closePos.toFixed(1)}%`);

  if (!sma200 || !rsi) {
    console.log("  ⚠️  Not enough data to calculate all indicators. Skipping.");
    return null;
  }

  // Fetch insider data
  console.log("\n── Checking Insider Activity (SEC Form 4) ──────────────\n");
  const insiderData = await fetchInsiderTransactions(symbol);

  if (insiderData.available) {
    console.log(`  Transactions (90 days): ${insiderData.totalTransactions}`);
    console.log(`  Insider buys:  ${insiderData.buys} (${insiderData.buyShares.toLocaleString()} shares)`);
    console.log(`  Insider sells: ${insiderData.sells} (${insiderData.sellShares.toLocaleString()} shares)`);
    console.log(`  Net activity:  ${insiderData.netBuying ? "BUYING" : "SELLING"}`);
    if (insiderData.recentBuyers.length > 0) {
      console.log(`  Recent buyers:`);
      insiderData.recentBuyers.forEach((b) => {
        console.log(`    - ${b.name}: ${Math.abs(b.shares).toLocaleString()} shares on ${b.date}`);
      });
    }
  } else {
    console.log(`  ⚠️  ${insiderData.reason}`);
  }

  // Run safety check
  const indicators = { price, ema10, ema21, sma50, sma200, rsi, atr, rvol, closePos };
  const { results, allPass, bias } = runSafetyCheck(indicators, insiderData);

  // Calculate position size
  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  // Decision
  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol,
    timeframe: CONFIG.timeframe,
    price,
    bias,
    indicators: { ema10, ema21, sma50, sma200, rsi, atr, rvol, closePos },
    insiderData: insiderData.available ? {
      buys: insiderData.buys,
      sells: insiderData.sells,
      netBuying: insiderData.netBuying,
    } : null,
    conditions: results,
    allPass,
    tradeSize,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED — ${symbol}`);
    console.log(`   Failed conditions:`);
    failed.forEach((f) => console.log(`   - ${f}`));
    await notifyBlocked(symbol, failed, { price, rsi });
  } else {
    const side = bias === "BEARISH" ? "sell" : "buy";
    console.log(`✅ ALL CONDITIONS MET — ${symbol} ${bias}`);

    if (CONFIG.paperTrading) {
      console.log(
        `\n📋 PAPER TRADE — would ${side} ${symbol} ~$${tradeSize.toFixed(2)} at market`,
      );
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
      await notifyTradeExecuted(symbol, side, price, tradeSize, logEntry.orderId, bias);
    } else {
      console.log(
        `\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} ${side.toUpperCase()} ${symbol}`,
      );
      try {
        const order = await placeAlpacaOrder(symbol, side, tradeSize, price);
        logEntry.orderPlaced = true;
        logEntry.orderId = order.orderId;
        console.log(`✅ ORDER PLACED — ${order.orderId}`);
        await notifyTradeExecuted(symbol, side, price, tradeSize, order.orderId, bias);
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
        await notifyError("Order placement", `${symbol}: ${err.message}`);
      }
    }
  }

  // Stop loss info
  if (allPass && atr) {
    const slPrice = bias === "BEARISH"
      ? price + 1.5 * atr
      : price - 1.5 * atr;
    console.log(`\n   Stop loss: $${slPrice.toFixed(2)} (1.5x ATR = $${(1.5 * atr).toFixed(2)})`);
  }

  // Save to log
  log.trades.push(logEntry);
  saveLog(log);
  writeTradeCsv(logEntry);

  return logEntry;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot — Institutional + Insider Strategy");
  console.log(`  ${new Date().toISOString()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`,
  );
  console.log("═══════════════════════════════════════════════════════════");

  await notifyStartup();

  const rules = JSON.parse(readFileSync("rules.json", "utf8"));
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Timeframe: ${CONFIG.timeframe}`);

  // Load log and check daily limits
  const log = loadLog();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    await sendTelegram("⚠️ <b>Daily trade limit reached</b> — bot is done for today.");
    return;
  }

  const screenerMode = process.argv.includes("--scan") || existsSync("universe.json");
  const singleSymbol = process.argv.find((a) => a.startsWith("--symbol="));

  if (singleSymbol) {
    // Single symbol mode: node bot.js --symbol=LLY
    const symbol = singleSymbol.split("=")[1];
    console.log(`\nMode: Single symbol — ${symbol}`);
    await evaluateAndTrade(symbol, log);

  } else if (screenerMode) {
    // Screener mode: scan universe for best trades
    console.log(`\nMode: Screener — scanning S&P 500 for institutional accumulation`);

    const ranked = await runScreener();
    if (!ranked || ranked.length === 0) {
      console.log("\nNo candidates found. No trades today.");
      await notifyScanSummary(518, 0, 0, []);
      console.log("═══════════════════════════════════════════════════════════\n");
      return;
    }

    // Trade the top candidates that pass all conditions (up to daily limit)
    const readyToTrade = ranked.filter((s) => s.allPass);
    const tradesRemaining = CONFIG.maxTradesPerDay - countTodaysTrades(log);

    // Send scan summary to Telegram
    await notifyScanSummary(518, ranked.length, readyToTrade.length, ranked);

    if (readyToTrade.length === 0) {
      console.log("\n── No stocks pass all conditions today ──────────────────");
      console.log("  Closest candidates (waiting for conditions to align):");
      ranked.slice(0, 5).forEach((s) => {
        console.log(`    ${s.symbol}: ${s.passCount}/3 conditions, ${s.insiderData.buys} insider buys`);
      });
      console.log("\n  The bot will check again at the next scheduled run.");
    } else {
      console.log(`\n── ${readyToTrade.length} stocks pass all conditions — trading top ${Math.min(readyToTrade.length, tradesRemaining)} ──\n`);

      for (const candidate of readyToTrade.slice(0, tradesRemaining)) {
        if (countTodaysTrades(log) >= CONFIG.maxTradesPerDay) {
          console.log("  Daily trade limit reached — stopping.");
          break;
        }
        await evaluateAndTrade(candidate.symbol, log);
      }
    }

  } else {
    // Fallback: single symbol from .env
    console.log(`\nMode: Single symbol — ${CONFIG.symbol}`);
    console.log(`  (Add universe.json or run with --scan to enable screener mode)`);
    await evaluateAndTrade(CONFIG.symbol, log);
  }

  console.log(`\nDecision log saved → ${LOG_FILE}`);
  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else {
  run().catch(async (err) => {
    console.error("Bot error:", err);
    await notifyError("Bot crash", err.message);
    process.exit(1);
  });
}
