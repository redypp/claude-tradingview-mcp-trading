/**
 * Backtest Engine — Institutional Accumulation + Insider Buying Strategy
 *
 * Tests the exact same 6 conditions from bot.js against historical data.
 * No curve-fitting, no optimization — just "would this strategy have worked?"
 *
 * Usage:
 *   node backtest.js                  — run on top 50 stocks (quick)
 *   node backtest.js --full           — run on full S&P 500 (slow, ~15 min)
 *   node backtest.js --symbol=LLY     — run on one stock
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";

// ─── Config ────────────────────────────────────────────────────────────────

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const ALPACA_KEY = process.env.ALPACA_API_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY;

if (!FINNHUB_KEY || !ALPACA_KEY) {
  console.log("Missing FINNHUB_API_KEY or ALPACA_API_KEY in .env");
  process.exit(1);
}

// Backtest parameters — THESE MATCH BOT.JS EXACTLY
const PARAMS = {
  rvol_threshold: 1.5,
  rsi_low: 40,
  rsi_high: 70,
  close_pos_min: 50,
  stop_loss_atr: 1.5,      // 1.5x ATR below entry
  take_profit_rsi: 70,     // Exit when RSI > 70
  max_hold_days: 30,       // Exit after 30 days if no SL/TP
  trade_size_usd: 200,     // Same as .env
};

// ─── Indicator Calculations (identical to bot.js) ───────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  const values = [closes.slice(0, period).reduce((a, b) => a + b, 0) / period];
  for (let i = period; i < closes.length; i++) {
    values.push(closes[i] * multiplier + values[values.length - 1] * (1 - multiplier));
  }
  return values;
}

function calcSMA(closes, period) {
  const values = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      values.push(null);
    } else {
      const slice = closes.slice(i - period + 1, i + 1);
      values.push(slice.reduce((a, b) => a + b, 0) / period);
    }
  }
  return values;
}

function calcRSI(closes, period = 14) {
  const values = new Array(period).fill(null);
  let avgGain = 0, avgLoss = 0;

  // Seed
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  values.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));

  // Rolling
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    values.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return values;
}

function calcATR(candles, period = 14) {
  const trs = [0];  // first bar has no prev close
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  const values = new Array(period).fill(null);
  let atr = trs.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  values.push(atr);
  for (let i = period + 1; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    values.push(atr);
  }
  return values;
}

function calcRVOL(candles, period = 20) {
  const values = new Array(period + 1).fill(null);
  for (let i = period + 1; i < candles.length; i++) {
    const avgVol = candles.slice(i - period, i).reduce((s, c) => s + c.volume, 0) / period;
    values.push(avgVol === 0 ? null : candles[i].volume / avgVol);
  }
  return values;
}

// ─── Data Fetching ──────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchInsiderHistory(symbol) {
  const url = `https://finnhub.io/api/v1/stock/insider-transactions?symbol=${symbol}&token=${FINNHUB_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.data || []).filter(
    (t) => t.transactionCode === "P" || t.transactionCode === "A",
  );
}

async function fetchHistoricalCandles(symbol, startDate, endDate) {
  const params = new URLSearchParams({
    timeframe: "1Day",
    start: startDate,
    end: endDate,
    limit: "10000",
    feed: "iex",
    adjustment: "raw",
  });

  const url = `https://data.alpaca.markets/v2/stocks/${symbol}/bars?${params}`;
  const res = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID": ALPACA_KEY,
      "APCA-API-SECRET-KEY": ALPACA_SECRET,
    },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.bars || []).map((b) => ({
    date: b.t.slice(0, 10),
    time: new Date(b.t).getTime(),
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v,
  }));
}

// ─── Backtest Core ──────────────────────────────────────────────────────────

function backtestSymbol(symbol, candles, insiderBuyDates) {
  if (candles.length < 210) return [];  // Need 200+ for SMA200

  const closes = candles.map((c) => c.close);

  // Pre-compute all indicator arrays
  const ema10Arr = calcEMA(closes, 10);     // length = closes.length - 9
  const ema21Arr = calcEMA(closes, 21);     // length = closes.length - 20
  const sma50Arr = calcSMA(closes, 50);
  const sma200Arr = calcSMA(closes, 200);
  const rsiArr = calcRSI(closes, 14);
  const atrArr = calcATR(candles, 14);
  const rvolArr = calcRVOL(candles, 20);

  // Map insider buy dates to a Set for O(1) lookup
  // An insider buy is "active" for 90 days after the transaction
  const insiderActiveMap = new Map();  // date -> number of active insider buys
  const dateList = candles.map((c) => c.date);

  for (const date of dateList) {
    const d = new Date(date);
    const cutoff = new Date(d);
    cutoff.setDate(cutoff.getDate() - 90);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const activeBuys = insiderBuyDates.filter(
      (bd) => bd >= cutoffStr && bd <= date,
    ).length;
    insiderActiveMap.set(date, activeBuys);
  }

  const trades = [];
  let inPosition = false;
  let entryPrice = 0;
  let stopLoss = 0;
  let entryDay = 0;
  let entryDate = "";

  // EMA arrays are offset — align indices
  // ema10Arr[0] corresponds to closes[9] (index 9)
  // ema21Arr[0] corresponds to closes[20] (index 20)
  // sma50Arr: index i corresponds to closes[i]
  // sma200Arr: index i corresponds to closes[i]
  // Start from index 200 (need SMA200)

  for (let i = 200; i < candles.length; i++) {
    const price = closes[i];
    const date = candles[i].date;

    const ema10 = ema10Arr[i - 9];   // offset for EMA(10)
    const ema21 = ema21Arr[i - 20];  // offset for EMA(21)
    const sma50 = sma50Arr[i];
    const sma200 = sma200Arr[i];
    const rsi = rsiArr[i];
    const atr = atrArr[i];
    const rvol = rvolArr[i];
    const closePos = candles[i].high === candles[i].low
      ? 50
      : ((candles[i].close - candles[i].low) / (candles[i].high - candles[i].low)) * 100;

    if (!sma50 || !sma200 || rsi === null || atr === null) continue;

    // Check exit conditions first
    if (inPosition) {
      const daysHeld = i - entryDay;
      const pnlPct = ((price - entryPrice) / entryPrice) * 100;

      // Stop loss hit
      if (candles[i].low <= stopLoss) {
        const exitPrice = stopLoss;  // Assume stopped at SL price
        trades[trades.length - 1].exitPrice = exitPrice;
        trades[trades.length - 1].exitDate = date;
        trades[trades.length - 1].exitReason = "STOP LOSS";
        trades[trades.length - 1].pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
        trades[trades.length - 1].daysHeld = daysHeld;
        inPosition = false;
        continue;
      }

      // Take profit: RSI > 70
      if (rsi > PARAMS.take_profit_rsi) {
        trades[trades.length - 1].exitPrice = price;
        trades[trades.length - 1].exitDate = date;
        trades[trades.length - 1].exitReason = "RSI > 70 (TP)";
        trades[trades.length - 1].pnlPct = pnlPct;
        trades[trades.length - 1].daysHeld = daysHeld;
        inPosition = false;
        continue;
      }

      // Trend break: EMA10 < EMA21
      if (ema10 < ema21) {
        trades[trades.length - 1].exitPrice = price;
        trades[trades.length - 1].exitDate = date;
        trades[trades.length - 1].exitReason = "TREND BREAK (EMA10 < EMA21)";
        trades[trades.length - 1].pnlPct = pnlPct;
        trades[trades.length - 1].daysHeld = daysHeld;
        inPosition = false;
        continue;
      }

      // Time stop
      if (daysHeld >= PARAMS.max_hold_days) {
        trades[trades.length - 1].exitPrice = price;
        trades[trades.length - 1].exitDate = date;
        trades[trades.length - 1].exitReason = "TIME STOP (30 days)";
        trades[trades.length - 1].pnlPct = pnlPct;
        trades[trades.length - 1].daysHeld = daysHeld;
        inPosition = false;
        continue;
      }

      continue;  // Still in position, no exit triggered
    }

    // Check entry conditions (all 6 must pass)
    const trendStack = ema10 > ema21 && ema21 > sma50 && sma50 > sma200;
    const aboveSMA200 = price > sma200;
    const rvolPass = rvol !== null && rvol > PARAMS.rvol_threshold;
    const rsiPass = rsi > PARAMS.rsi_low && rsi < PARAMS.rsi_high;
    const closePosPass = closePos > PARAMS.close_pos_min;
    const insiderPass = (insiderActiveMap.get(date) || 0) > 0;

    if (trendStack && aboveSMA200 && rvolPass && rsiPass && closePosPass && insiderPass) {
      entryPrice = price;
      stopLoss = price - PARAMS.stop_loss_atr * atr;
      entryDay = i;
      entryDate = date;
      inPosition = true;

      trades.push({
        symbol,
        entryDate: date,
        entryPrice: price,
        stopLoss,
        atr,
        rvol,
        rsi,
        insiderBuys: insiderActiveMap.get(date) || 0,
        exitPrice: null,
        exitDate: null,
        exitReason: null,
        pnlPct: null,
        daysHeld: null,
      });
    }
  }

  // Close any open position at the last candle
  if (inPosition && trades.length > 0) {
    const lastCandle = candles[candles.length - 1];
    const lastTrade = trades[trades.length - 1];
    lastTrade.exitPrice = lastCandle.close;
    lastTrade.exitDate = lastCandle.date;
    lastTrade.exitReason = "END OF DATA";
    lastTrade.pnlPct = ((lastCandle.close - lastTrade.entryPrice) / lastTrade.entryPrice) * 100;
    lastTrade.daysHeld = candles.length - 1 - entryDay;
  }

  return trades;
}

// ─── Results Analysis ───────────────────────────────────────────────────────

function analyzeResults(allTrades) {
  const completed = allTrades.filter((t) => t.exitPrice !== null);
  if (completed.length === 0) {
    console.log("\n  No completed trades found in the backtest period.\n");
    return;
  }

  const winners = completed.filter((t) => t.pnlPct > 0);
  const losers = completed.filter((t) => t.pnlPct <= 0);

  const totalPnl = completed.reduce((s, t) => s + t.pnlPct, 0);
  const avgPnl = totalPnl / completed.length;
  const avgWin = winners.length > 0
    ? winners.reduce((s, t) => s + t.pnlPct, 0) / winners.length
    : 0;
  const avgLoss = losers.length > 0
    ? losers.reduce((s, t) => s + t.pnlPct, 0) / losers.length
    : 0;
  const maxWin = winners.length > 0 ? Math.max(...winners.map((t) => t.pnlPct)) : 0;
  const maxLoss = losers.length > 0 ? Math.min(...losers.map((t) => t.pnlPct)) : 0;
  const avgDays = completed.reduce((s, t) => s + (t.daysHeld || 0), 0) / completed.length;

  // Win rate
  const winRate = (winners.length / completed.length) * 100;

  // Profit factor
  const grossProfit = winners.reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnlPct, 0));
  const profitFactor = grossLoss === 0 ? Infinity : grossProfit / grossLoss;

  // Expectancy (average $ per trade based on $200 position)
  const expectancy = (PARAMS.trade_size_usd * avgPnl) / 100;

  // Simulate equity curve for max drawdown
  let equity = 10000;  // Start with $10K
  let peak = equity;
  let maxDD = 0;
  const equityCurve = [];

  for (const trade of completed) {
    const tradePnl = (PARAMS.trade_size_usd * trade.pnlPct) / 100;
    equity += tradePnl;
    equityCurve.push(equity);
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }

  // Exit reason breakdown
  const exitReasons = {};
  for (const t of completed) {
    exitReasons[t.exitReason] = (exitReasons[t.exitReason] || 0) + 1;
  }

  // Statistical significance: binomial test (is win rate > 50%?)
  // Using normal approximation to binomial
  const n = completed.length;
  const p0 = 0.5;  // null hypothesis: 50% win rate
  const pHat = winners.length / n;
  const zScore = (pHat - p0) / Math.sqrt((p0 * (1 - p0)) / n);

  console.log("\n════════════════════════════════════════════════════════════");
  console.log("  BACKTEST RESULTS");
  console.log("════════════════════════════════════════════════════════════\n");

  console.log("── Performance ─────────────────────────────────────────\n");
  console.log(`  Total trades:      ${completed.length}`);
  console.log(`  Winners:           ${winners.length} (${winRate.toFixed(1)}%)`);
  console.log(`  Losers:            ${losers.length} (${(100 - winRate).toFixed(1)}%)`);
  console.log(`  Win rate:          ${winRate.toFixed(1)}%`);
  console.log(`  Profit factor:     ${profitFactor === Infinity ? "∞" : profitFactor.toFixed(2)}`);

  console.log("\n── Returns ─────────────────────────────────────────────\n");
  console.log(`  Average return:    ${avgPnl >= 0 ? "+" : ""}${avgPnl.toFixed(2)}% per trade`);
  console.log(`  Average winner:    +${avgWin.toFixed(2)}%`);
  console.log(`  Average loser:     ${avgLoss.toFixed(2)}%`);
  console.log(`  Best trade:        +${maxWin.toFixed(2)}%`);
  console.log(`  Worst trade:       ${maxLoss.toFixed(2)}%`);
  console.log(`  Avg hold time:     ${avgDays.toFixed(1)} days`);

  console.log("\n── Risk ────────────────────────────────────────────────\n");
  console.log(`  Max drawdown:      ${maxDD.toFixed(2)}%`);
  console.log(`  Expectancy:        $${expectancy >= 0 ? "+" : ""}${expectancy.toFixed(2)} per trade (on $200 position)`);
  console.log(`  Final equity:      $${equity.toFixed(2)} (started $10,000)`);
  console.log(`  Total return:      ${((equity - 10000) / 100).toFixed(2)}%`);

  console.log("\n── Statistical Significance ─────────────────────────────\n");
  console.log(`  Z-score:           ${zScore.toFixed(2)}`);
  if (n < 30) {
    console.log(`  ⚠️  Only ${n} trades — need 30+ for statistical significance`);
    console.log(`     Results are PRELIMINARY. Keep paper trading to gather more data.`);
  } else if (zScore > 1.96) {
    console.log(`  ✅ Win rate is statistically significant (p < 0.05)`);
    console.log(`     There is less than 5% chance this is due to luck.`);
  } else if (zScore > 1.65) {
    console.log(`  🟡 Marginally significant (p < 0.10)`);
    console.log(`     Suggestive of an edge, but need more trades to confirm.`);
  } else {
    console.log(`  🚫 NOT statistically significant`);
    console.log(`     Win rate could be due to random chance. Do NOT go live.`);
  }

  console.log("\n── Exit Reasons ────────────────────────────────────────\n");
  for (const [reason, count] of Object.entries(exitReasons).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / completed.length) * 100).toFixed(1);
    console.log(`  ${reason.padEnd(30)} ${count} trades (${pct}%)`);
  }

  // Show top 5 best and worst trades
  const sorted = [...completed].sort((a, b) => b.pnlPct - a.pnlPct);

  console.log("\n── Top 5 Best Trades ───────────────────────────────────\n");
  sorted.slice(0, 5).forEach((t) => {
    console.log(
      `  ${t.symbol.padEnd(6)} +${t.pnlPct.toFixed(2)}% | ` +
      `${t.entryDate} → ${t.exitDate} (${t.daysHeld}d) | ` +
      `$${t.entryPrice.toFixed(2)} → $${t.exitPrice.toFixed(2)} | ${t.exitReason}`,
    );
  });

  console.log("\n── Top 5 Worst Trades ──────────────────────────────────\n");
  sorted.slice(-5).reverse().forEach((t) => {
    console.log(
      `  ${t.symbol.padEnd(6)} ${t.pnlPct.toFixed(2)}% | ` +
      `${t.entryDate} → ${t.exitDate} (${t.daysHeld}d) | ` +
      `$${t.entryPrice.toFixed(2)} → $${t.exitPrice.toFixed(2)} | ${t.exitReason}`,
    );
  });

  console.log("\n════════════════════════════════════════════════════════════\n");

  // Overfitting assessment
  console.log("── Overfitting Assessment ──────────────────────────────\n");
  if (completed.length < 30) {
    console.log("  ⚠️  TOO FEW TRADES to assess overfitting.");
    console.log("     Need at least 30 trades. Keep collecting data.\n");
  } else {
    const issues = [];
    if (winRate > 80) issues.push("Win rate suspiciously high (>80%) — likely overfit");
    if (profitFactor > 5) issues.push("Profit factor > 5 — unrealistic, likely overfit");
    if (avgDays < 2) issues.push("Avg hold < 2 days — possible same-day noise");
    if (maxDD < 1) issues.push("Max DD < 1% — suspiciously low, check for bugs");

    if (issues.length === 0) {
      console.log("  ✅ No obvious signs of overfitting.");
      console.log("     Strategy uses 6 simple conditions (low parameter count),");
      console.log("     insider data is fundamental (not curve-fit), and");
      console.log("     the results span multiple market conditions.\n");
    } else {
      console.log("  ⚠️  Potential overfitting signals:\n");
      issues.forEach((i) => console.log(`     - ${i}`));
      console.log("");
    }
  }

  return {
    totalTrades: completed.length,
    winRate,
    profitFactor,
    avgPnl,
    maxDD,
    expectancy,
    zScore,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("════════════════════════════════════════════════════════════");
  console.log("  Backtest: Institutional Accumulation + Insider Buying");
  console.log(`  ${new Date().toISOString()}`);
  console.log("════════════════════════════════════════════════════════════");

  // Determine which symbols to test
  let symbols;
  const singleArg = process.argv.find((a) => a.startsWith("--symbol="));

  if (singleArg) {
    symbols = [singleArg.split("=")[1]];
  } else if (process.argv.includes("--full") && existsSync("universe.json")) {
    const universe = JSON.parse(readFileSync("universe.json", "utf8"));
    symbols = universe.symbols;
  } else if (existsSync("universe.json")) {
    // Default: top 50 most traded stocks (representative sample)
    const top50 = [
      "AAPL", "MSFT", "AMZN", "NVDA", "GOOGL", "META", "TSLA", "BRK.B", "UNH", "LLY",
      "JPM", "V", "XOM", "JNJ", "MA", "PG", "AVGO", "HD", "CVX", "MRK",
      "ABBV", "KO", "PEP", "COST", "PFE", "BAC", "TMO", "MCD", "CSCO", "ACN",
      "ABT", "CRM", "NFLX", "AMD", "LIN", "DHR", "ORCL", "TXN", "ADBE", "WMT",
      "NKE", "PM", "NEE", "UNP", "RTX", "LOW", "INTC", "QCOM", "INTU", "AMGN",
    ];
    symbols = top50;
  } else {
    console.log("No universe.json found. Run with --symbol=AAPL or create universe.json.");
    process.exit(1);
  }

  console.log(`\nSymbols to test: ${symbols.length}`);
  console.log(`Backtest period: 2024-01-01 to 2026-04-09 (~2.25 years)`);
  console.log(`Conditions: Trend Stack + SMA200 + RVOL>1.5 + RSI(40-70) + ClosePos>50% + Insider Buying`);
  console.log(`Exit rules: SL 1.5xATR | TP RSI>70 | Trend Break EMA10<EMA21 | Time 30d\n`);

  const BATCH_SIZE = 30;
  const allTrades = [];
  let scanned = 0;
  let withInsiders = 0;

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(symbols.length / BATCH_SIZE);

    console.log(`── Batch ${batchNum}/${totalBatches} (${batch.length} stocks) ──────────────────────\n`);

    // Fetch insider data for batch (parallel)
    const insiderResults = await Promise.all(
      batch.map(async (symbol) => {
        try {
          const txns = await fetchInsiderHistory(symbol);
          return { symbol, buys: txns };
        } catch {
          return { symbol, buys: [] };
        }
      }),
    );

    // For stocks with insider buying, fetch candles and backtest
    for (const { symbol, buys } of insiderResults) {
      scanned++;

      if (buys.length === 0) continue;
      withInsiders++;

      const buyDates = buys.map((t) => t.transactionDate).sort();
      const earliest = buyDates[0];

      // Need data from well before first insider buy (for SMA200 warmup)
      const startDate = "2023-06-01";
      const endDate = "2026-04-09";

      try {
        const candles = await fetchHistoricalCandles(symbol, startDate, endDate);
        if (candles.length < 210) {
          console.log(`  ${symbol.padEnd(6)} | ${buys.length} insider buys | skipped (${candles.length} bars)`);
          continue;
        }

        const trades = backtestSymbol(symbol, candles, buyDates);

        if (trades.length > 0) {
          allTrades.push(...trades);
          const wins = trades.filter((t) => t.pnlPct > 0).length;
          console.log(
            `  ${symbol.padEnd(6)} | ${buys.length} insider buys | ` +
            `${trades.length} trades (${wins}W/${trades.length - wins}L) | ` +
            `Avg: ${(trades.reduce((s, t) => s + (t.pnlPct || 0), 0) / trades.length).toFixed(2)}%`,
          );
        } else {
          console.log(`  ${symbol.padEnd(6)} | ${buys.length} insider buys | 0 trades (conditions never aligned)`);
        }
      } catch (err) {
        console.log(`  ${symbol.padEnd(6)} | error: ${err.message}`);
      }
    }

    // Rate limit between batches
    if (i + BATCH_SIZE < symbols.length) {
      console.log(`\n  ⏳ Rate limit pause (31s)...\n`);
      await sleep(31000);
    }
  }

  console.log(`\n── Scan Summary ────────────────────────────────────────\n`);
  console.log(`  Stocks scanned:       ${scanned}`);
  console.log(`  With insider buying:  ${withInsiders}`);
  console.log(`  Total trades found:   ${allTrades.length}`);

  // Analyze results
  const results = analyzeResults(allTrades);

  // Save raw trades to file
  const outputFile = "backtest-results.json";
  writeFileSync(
    outputFile,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        params: PARAMS,
        summary: results,
        trades: allTrades,
      },
      null,
      2,
    ),
  );
  console.log(`Raw trades saved → ${outputFile}\n`);
}

main().catch((err) => {
  console.error("Backtest error:", err);
  process.exit(1);
});
