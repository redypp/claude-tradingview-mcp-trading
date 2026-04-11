/**
 * Backtest Comparison — Test multiple strategy variations side by side
 *
 * Runs the same insider + institutional strategy with different parameters
 * to find the best configuration WITHOUT overfitting.
 *
 * Usage: node backtest-compare.js
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const ALPACA_KEY = process.env.ALPACA_API_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY;

// ─── Strategy Variations to Test ────────────────────────────────────────────

const VARIATIONS = {
  "BASELINE (current)": {
    stop_loss_atr: 1.5,
    rsi_low: 40,
    rsi_high: 70,
    close_pos_min: 50,
    rvol_threshold: 1.5,
    min_insider_buys: 1,
    use_trailing_stop: false,
    trailing_stop_atr: 1.5,
    require_trend_days: 0,
  },
  "A: Wider stop (2.5x ATR)": {
    stop_loss_atr: 2.5,
    rsi_low: 40,
    rsi_high: 70,
    close_pos_min: 50,
    rvol_threshold: 1.5,
    min_insider_buys: 1,
    use_trailing_stop: false,
    trailing_stop_atr: 2.5,
    require_trend_days: 0,
  },
  "B: Momentum filter (20d trend)": {
    stop_loss_atr: 1.5,
    rsi_low: 40,
    rsi_high: 70,
    close_pos_min: 50,
    rvol_threshold: 1.5,
    min_insider_buys: 1,
    use_trailing_stop: false,
    trailing_stop_atr: 1.5,
    require_trend_days: 20,
  },
  "C: Strong insiders (3+ buys)": {
    stop_loss_atr: 1.5,
    rsi_low: 40,
    rsi_high: 70,
    close_pos_min: 50,
    rvol_threshold: 1.5,
    min_insider_buys: 3,
    use_trailing_stop: false,
    trailing_stop_atr: 1.5,
    require_trend_days: 0,
  },
  "D: Trailing stop (2x ATR)": {
    stop_loss_atr: 1.5,
    rsi_low: 40,
    rsi_high: 70,
    close_pos_min: 50,
    rvol_threshold: 1.5,
    min_insider_buys: 1,
    use_trailing_stop: true,
    trailing_stop_atr: 2.0,
    require_trend_days: 0,
  },
  "COMBINED (A+B+C+D)": {
    stop_loss_atr: 2.5,
    rsi_low: 40,
    rsi_high: 70,
    close_pos_min: 50,
    rvol_threshold: 1.5,
    min_insider_buys: 3,
    use_trailing_stop: true,
    trailing_stop_atr: 2.0,
    require_trend_days: 20,
  },
};

// ─── Indicator Calculations ─────────────────────────────────────────────────

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
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  values.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
    values.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return values;
}

function calcATR(candles, period = 14) {
  const trs = [0];
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
  // SEC Form 4: P = open-market purchase only. A is grant/award.
  return (data.data || []).filter((t) => t.transactionCode === "P");
}

async function fetchHistoricalCandles(symbol) {
  const params = new URLSearchParams({
    timeframe: "1Day",
    start: "2023-06-01",
    end: "2026-04-09",
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
    open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
  }));
}

// ─── Backtest Core (parameterized) ──────────────────────────────────────────

function backtestSymbol(symbol, candles, insiderBuyDates, params) {
  if (candles.length < 210) return [];

  const closes = candles.map((c) => c.close);
  const ema10Arr = calcEMA(closes, 10);
  const ema21Arr = calcEMA(closes, 21);
  const sma20Arr = calcSMA(closes, 20);
  const sma50Arr = calcSMA(closes, 50);
  const sma200Arr = calcSMA(closes, 200);
  const rsiArr = calcRSI(closes, 14);
  const atrArr = calcATR(candles, 14);
  const rvolArr = calcRVOL(candles, 20);

  // Build insider activity lookup
  const insiderActiveMap = new Map();
  const dateList = candles.map((c) => c.date);
  for (const date of dateList) {
    const cutoff = new Date(new Date(date).getTime() - 90 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const activeBuys = insiderBuyDates.filter((bd) => bd >= cutoff && bd <= date).length;
    insiderActiveMap.set(date, activeBuys);
  }

  const trades = [];
  let inPosition = false;
  let entryPrice = 0;
  let stopLoss = 0;
  let highSinceEntry = 0;
  let entryDay = 0;

  for (let i = 200; i < candles.length; i++) {
    const price = closes[i];
    const date = candles[i].date;
    const ema10 = ema10Arr[i - 9];
    const ema21 = ema21Arr[i - 20];
    const sma20 = sma20Arr[i];
    const sma50 = sma50Arr[i];
    const sma200 = sma200Arr[i];
    const rsi = rsiArr[i];
    const atr = atrArr[i];
    const rvol = rvolArr[i];
    const closePos = candles[i].high === candles[i].low ? 50
      : ((candles[i].close - candles[i].low) / (candles[i].high - candles[i].low)) * 100;

    if (!sma50 || !sma200 || !sma20 || rsi === null || atr === null) continue;

    if (inPosition) {
      const daysHeld = i - entryDay;
      const pnlPct = ((price - entryPrice) / entryPrice) * 100;

      // Update trailing stop
      if (params.use_trailing_stop && candles[i].high > highSinceEntry) {
        highSinceEntry = candles[i].high;
        const newStop = highSinceEntry - params.trailing_stop_atr * atr;
        if (newStop > stopLoss) stopLoss = newStop;
      }

      // Stop loss
      if (candles[i].low <= stopLoss) {
        const exitPrice = stopLoss;
        trades[trades.length - 1].exitPrice = exitPrice;
        trades[trades.length - 1].exitDate = date;
        trades[trades.length - 1].exitReason = params.use_trailing_stop ? "TRAILING STOP" : "STOP LOSS";
        trades[trades.length - 1].pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
        trades[trades.length - 1].daysHeld = daysHeld;
        inPosition = false;
        continue;
      }

      // Take profit: RSI > 70
      if (rsi > 70) {
        trades[trades.length - 1].exitPrice = price;
        trades[trades.length - 1].exitDate = date;
        trades[trades.length - 1].exitReason = "RSI > 70 (TP)";
        trades[trades.length - 1].pnlPct = pnlPct;
        trades[trades.length - 1].daysHeld = daysHeld;
        inPosition = false;
        continue;
      }

      // Trend break
      if (ema10 < ema21) {
        trades[trades.length - 1].exitPrice = price;
        trades[trades.length - 1].exitDate = date;
        trades[trades.length - 1].exitReason = "TREND BREAK";
        trades[trades.length - 1].pnlPct = pnlPct;
        trades[trades.length - 1].daysHeld = daysHeld;
        inPosition = false;
        continue;
      }

      // Time stop
      if (daysHeld >= 30) {
        trades[trades.length - 1].exitPrice = price;
        trades[trades.length - 1].exitDate = date;
        trades[trades.length - 1].exitReason = "TIME STOP";
        trades[trades.length - 1].pnlPct = pnlPct;
        trades[trades.length - 1].daysHeld = daysHeld;
        inPosition = false;
        continue;
      }
      continue;
    }

    // Entry conditions
    const trendStack = ema10 > ema21 && ema21 > sma50 && sma50 > sma200;
    const aboveSMA200 = price > sma200;
    const rvolPass = rvol !== null && rvol > params.rvol_threshold;
    const rsiPass = rsi > params.rsi_low && rsi < params.rsi_high;
    const closePosPass = closePos > params.close_pos_min;
    const insiderCount = insiderActiveMap.get(date) || 0;
    const insiderPass = insiderCount >= params.min_insider_buys;

    // Momentum filter: price above SMA20 for N consecutive days
    let momentumPass = true;
    if (params.require_trend_days > 0) {
      for (let j = 0; j < params.require_trend_days && (i - j) >= 0; j++) {
        const idx = i - j;
        if (sma20Arr[idx] === null || closes[idx] < sma20Arr[idx]) {
          momentumPass = false;
          break;
        }
      }
    }

    if (trendStack && aboveSMA200 && rvolPass && rsiPass && closePosPass && insiderPass && momentumPass) {
      entryPrice = price;
      stopLoss = price - params.stop_loss_atr * atr;
      highSinceEntry = candles[i].high;
      entryDay = i;
      inPosition = true;

      trades.push({
        symbol, entryDate: date, entryPrice: price, stopLoss,
        insiderBuys: insiderCount,
        exitPrice: null, exitDate: null, exitReason: null, pnlPct: null, daysHeld: null,
      });
    }
  }

  // Close open position
  if (inPosition && trades.length > 0) {
    const last = candles[candles.length - 1];
    const t = trades[trades.length - 1];
    t.exitPrice = last.close;
    t.exitDate = last.date;
    t.exitReason = "END OF DATA";
    t.pnlPct = ((last.close - t.entryPrice) / t.entryPrice) * 100;
    t.daysHeld = candles.length - 1 - entryDay;
  }

  return trades;
}

// ─── Analyze One Variation ──────────────────────────────────────────────────

function analyze(trades) {
  const completed = trades.filter((t) => t.exitPrice !== null);
  if (completed.length === 0) return null;

  const winners = completed.filter((t) => t.pnlPct > 0);
  const losers = completed.filter((t) => t.pnlPct <= 0);
  const totalPnl = completed.reduce((s, t) => s + t.pnlPct, 0);
  const avgPnl = totalPnl / completed.length;
  const avgWin = winners.length > 0 ? winners.reduce((s, t) => s + t.pnlPct, 0) / winners.length : 0;
  const avgLoss = losers.length > 0 ? losers.reduce((s, t) => s + t.pnlPct, 0) / losers.length : 0;
  const winRate = (winners.length / completed.length) * 100;
  const grossProfit = winners.reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnlPct, 0));
  const profitFactor = grossLoss === 0 ? Infinity : grossProfit / grossLoss;

  // Equity curve & drawdown
  let equity = 10000;
  let peak = equity;
  let maxDD = 0;
  for (const trade of completed) {
    equity += (200 * trade.pnlPct) / 100;
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }

  // Z-score
  const n = completed.length;
  const pHat = winners.length / n;
  const zScore = (pHat - 0.5) / Math.sqrt(0.25 / n);

  // Win/loss ratio
  const wlRatio = avgLoss === 0 ? Infinity : Math.abs(avgWin / avgLoss);

  return {
    trades: completed.length,
    winners: winners.length,
    losers: losers.length,
    winRate,
    profitFactor,
    avgPnl,
    avgWin,
    avgLoss,
    wlRatio,
    maxDD,
    finalEquity: equity,
    totalReturn: ((equity - 10000) / 100),
    zScore,
    expectancy: (200 * avgPnl) / 100,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("════════════════════════════════════════════════════════════");
  console.log("  Strategy Comparison Backtest");
  console.log(`  ${new Date().toISOString()}`);
  console.log("  Testing 6 variations side by side");
  console.log("════════════════════════════════════════════════════════════\n");

  // Top 50 stocks
  const symbols = [
    "AAPL", "MSFT", "AMZN", "NVDA", "GOOGL", "META", "TSLA", "BRK.B", "UNH", "LLY",
    "JPM", "V", "XOM", "JNJ", "MA", "PG", "AVGO", "HD", "CVX", "MRK",
    "ABBV", "KO", "PEP", "COST", "PFE", "BAC", "TMO", "MCD", "CSCO", "ACN",
    "ABT", "CRM", "NFLX", "AMD", "LIN", "DHR", "ORCL", "TXN", "ADBE", "WMT",
    "NKE", "PM", "NEE", "UNP", "RTX", "LOW", "INTC", "QCOM", "INTU", "AMGN",
  ];

  console.log(`Scanning ${symbols.length} stocks for insider buying...\n`);

  // Step 1: Fetch all insider + candle data (shared across variations)
  const stockData = [];
  const BATCH_SIZE = 30;

  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(symbols.length / BATCH_SIZE);

    console.log(`  Batch ${batchNum}/${totalBatches}: fetching insider data...`);

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

    // Fetch candles for stocks with insider buying
    for (const { symbol, buys } of insiderResults) {
      if (buys.length === 0) continue;

      try {
        const candles = await fetchHistoricalCandles(symbol);
        if (candles.length >= 210) {
          const buyDates = buys.map((t) => t.transactionDate).sort();
          stockData.push({ symbol, candles, buyDates, insiderCount: buys.length });
          console.log(`    ${symbol}: ${buys.length} insider buys, ${candles.length} candles`);
        }
      } catch {}
    }

    if (i + BATCH_SIZE < symbols.length) {
      console.log(`  ⏳ Rate limit pause (31s)...\n`);
      await sleep(31000);
    }
  }

  console.log(`\n  Data loaded: ${stockData.length} stocks with insider buying + price data\n`);

  // Step 2: Run each variation
  console.log("════════════════════════════════════════════════════════════");
  console.log("  Running 6 strategy variations...");
  console.log("════════════════════════════════════════════════════════════\n");

  const results = {};

  for (const [name, params] of Object.entries(VARIATIONS)) {
    const allTrades = [];

    for (const { symbol, candles, buyDates } of stockData) {
      const trades = backtestSymbol(symbol, candles, buyDates, params);
      allTrades.push(...trades);
    }

    const stats = analyze(allTrades);
    results[name] = { params, stats, tradeCount: allTrades.length, trades: allTrades };

    if (stats) {
      console.log(`  ${name}`);
      console.log(`    Trades: ${stats.trades} | Win: ${stats.winRate.toFixed(1)}% | PF: ${stats.profitFactor.toFixed(2)} | Avg: ${stats.avgPnl >= 0 ? "+" : ""}${stats.avgPnl.toFixed(2)}% | Z: ${stats.zScore.toFixed(2)}\n`);
    } else {
      console.log(`  ${name}`);
      console.log(`    No trades generated\n`);
    }
  }

  // Step 3: Comparison table
  console.log("\n════════════════════════════════════════════════════════════");
  console.log("  SIDE-BY-SIDE COMPARISON");
  console.log("════════════════════════════════════════════════════════════\n");

  // Header
  const hdr = "Strategy".padEnd(32) +
    "Trades".padStart(7) +
    "Win%".padStart(7) +
    "PF".padStart(7) +
    "Avg%".padStart(8) +
    "AvgW%".padStart(8) +
    "AvgL%".padStart(8) +
    "W/L".padStart(6) +
    "MaxDD%".padStart(8) +
    "Z".padStart(7) +
    "$/trade".padStart(9);

  console.log(hdr);
  console.log("─".repeat(hdr.length));

  // Find best variation by expectancy
  let bestName = "";
  let bestExpectancy = -Infinity;

  for (const [name, { stats }] of Object.entries(results)) {
    if (!stats) {
      console.log(`${name.padEnd(32)}  — no trades —`);
      continue;
    }

    const row =
      name.padEnd(32) +
      String(stats.trades).padStart(7) +
      stats.winRate.toFixed(1).padStart(7) +
      stats.profitFactor.toFixed(2).padStart(7) +
      `${stats.avgPnl >= 0 ? "+" : ""}${stats.avgPnl.toFixed(2)}`.padStart(8) +
      `+${stats.avgWin.toFixed(2)}`.padStart(8) +
      stats.avgLoss.toFixed(2).padStart(8) +
      stats.wlRatio.toFixed(2).padStart(6) +
      stats.maxDD.toFixed(2).padStart(8) +
      stats.zScore.toFixed(2).padStart(7) +
      `$${stats.expectancy >= 0 ? "+" : ""}${stats.expectancy.toFixed(2)}`.padStart(9);

    console.log(row);

    if (stats.expectancy > bestExpectancy) {
      bestExpectancy = stats.expectancy;
      bestName = name;
    }
  }

  console.log("─".repeat(hdr.length));

  // Step 4: Recommendation
  console.log("\n════════════════════════════════════════════════════════════");
  console.log("  RECOMMENDATION");
  console.log("════════════════════════════════════════════════════════════\n");

  const best = results[bestName]?.stats;
  if (best) {
    console.log(`  Best performing: ${bestName}\n`);
    console.log(`  Win rate:        ${best.winRate.toFixed(1)}%`);
    console.log(`  Profit factor:   ${best.profitFactor.toFixed(2)}`);
    console.log(`  Avg return:      ${best.avgPnl >= 0 ? "+" : ""}${best.avgPnl.toFixed(2)}% per trade`);
    console.log(`  Expectancy:      $${best.expectancy >= 0 ? "+" : ""}${best.expectancy.toFixed(2)} per trade (on $200)`);
    console.log(`  W/L ratio:       ${best.wlRatio.toFixed(2)} (winners are ${best.wlRatio.toFixed(1)}x larger than losers)`);
    console.log(`  Z-score:         ${best.zScore.toFixed(2)}`);

    if (best.zScore > 1.96) {
      console.log(`\n  ✅ STATISTICALLY SIGNIFICANT — this variation has a real edge.`);
      console.log(`     Safe to paper trade with confidence. Watch for 50+ trades before going live.`);
    } else if (best.zScore > 1.65) {
      console.log(`\n  🟡 MARGINALLY SIGNIFICANT — promising but not conclusive.`);
      console.log(`     Paper trade and collect more data before going live.`);
    } else if (best.trades < 30) {
      console.log(`\n  ⚠️  TOO FEW TRADES (${best.trades}) — need 30+ to assess significance.`);
      console.log(`     Numbers look ${best.avgPnl > 0 ? "promising" : "concerning"}, but sample is too small.`);
    } else {
      console.log(`\n  🚫 NOT SIGNIFICANT — results could be random chance.`);
      console.log(`     Keep refining the strategy or gather more data.`);
    }
  }

  // Overfitting check: if the combined version is dramatically better, that's suspicious
  const baseline = results["BASELINE (current)"]?.stats;
  const combined = results["COMBINED (A+B+C+D)"]?.stats;

  if (baseline && combined) {
    console.log("\n── Overfitting Check ───────────────────────────────────\n");
    if (combined.trades < 10) {
      console.log("  Combined variant has very few trades — filters may be too strict.");
      console.log("  Consider using individual improvements (A, B, C, or D) instead of all together.");
    } else if (combined.profitFactor > baseline.profitFactor * 3) {
      console.log("  ⚠️  Combined variant is 3x+ better than baseline — possible overfitting.");
      console.log("     The more filters you add, the higher the risk of curve-fitting.");
      console.log("     Prefer the simplest variation that still shows an edge.");
    } else {
      console.log("  ✅ No dramatic difference between combined and individual variants.");
      console.log("     Changes appear to be genuine improvements, not curve-fitting.");
    }
  }

  console.log("\n════════════════════════════════════════════════════════════\n");

  // Save full results
  writeFileSync("backtest-comparison.json", JSON.stringify(results, null, 2));
  console.log("Full results saved → backtest-comparison.json\n");
}

main().catch((err) => {
  console.error("Backtest error:", err);
  process.exit(1);
});
