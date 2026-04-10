/**
 * Backtest: A+D Combination (Wider Stop + Trailing Stop)
 *
 * Entry: same 6 conditions
 * Stop: 2.5x ATR initial, then trails at 2x ATR from highest point
 * Exit: RSI > 70, trend break, or trailing stop
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const ALPACA_KEY = process.env.ALPACA_API_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY;

const PARAMS = {
  stop_loss_atr: 2.5,       // Wider initial stop (from A)
  trailing_stop_atr: 2.0,   // Trailing stop once in profit (from D)
  rsi_low: 40,
  rsi_high: 70,
  close_pos_min: 50,
  rvol_threshold: 1.5,
  min_insider_buys: 1,
};

function calcEMA(closes, period) {
  const m = 2 / (period + 1);
  const v = [closes.slice(0, period).reduce((a, b) => a + b, 0) / period];
  for (let i = period; i < closes.length; i++) v.push(closes[i] * m + v[v.length - 1] * (1 - m));
  return v;
}
function calcSMA(closes, period) {
  const v = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) v.push(null);
    else v.push(closes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period);
  }
  return v;
}
function calcRSI(closes, period = 14) {
  const v = new Array(period).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i-1]; if (d > 0) ag += d; else al -= d; }
  ag /= period; al /= period;
  v.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag * (period-1) + Math.max(d, 0)) / period;
    al = (al * (period-1) + Math.max(-d, 0)) / period;
    v.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return v;
}
function calcATR(candles, period = 14) {
  const trs = [0];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], pc = candles[i-1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)));
  }
  const v = new Array(period).fill(null);
  let atr = trs.slice(1, period+1).reduce((a, b) => a + b, 0) / period;
  v.push(atr);
  for (let i = period+1; i < trs.length; i++) { atr = (atr*(period-1) + trs[i]) / period; v.push(atr); }
  return v;
}
function calcRVOL(candles, period = 20) {
  const v = new Array(period + 1).fill(null);
  for (let i = period + 1; i < candles.length; i++) {
    const avg = candles.slice(i-period, i).reduce((s, c) => s + c.volume, 0) / period;
    v.push(avg === 0 ? null : candles[i].volume / avg);
  }
  return v;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchInsiders(symbol) {
  const res = await fetch(`https://finnhub.io/api/v1/stock/insider-transactions?symbol=${symbol}&token=${FINNHUB_KEY}`);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.data || []).filter(t => t.transactionCode === "P" || t.transactionCode === "A");
}

async function fetchCandles(symbol) {
  const params = new URLSearchParams({ timeframe: "1Day", start: "2023-06-01", end: "2026-04-09", limit: "10000", feed: "iex", adjustment: "raw" });
  const res = await fetch(`https://data.alpaca.markets/v2/stocks/${symbol}/bars?${params}`, {
    headers: { "APCA-API-KEY-ID": ALPACA_KEY, "APCA-API-SECRET-KEY": ALPACA_SECRET },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.bars || []).map(b => ({ date: b.t.slice(0,10), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }));
}

function backtest(symbol, candles, buyDates) {
  if (candles.length < 210) return [];
  const closes = candles.map(c => c.close);
  const ema10 = calcEMA(closes, 10);
  const ema21 = calcEMA(closes, 21);
  const sma50 = calcSMA(closes, 50);
  const sma200 = calcSMA(closes, 200);
  const rsi = calcRSI(closes, 14);
  const atr = calcATR(candles, 14);
  const rvol = calcRVOL(candles, 20);

  const insiderMap = new Map();
  for (const date of candles.map(c => c.date)) {
    const cutoff = new Date(new Date(date).getTime() - 90*24*60*60*1000).toISOString().slice(0,10);
    insiderMap.set(date, buyDates.filter(bd => bd >= cutoff && bd <= date).length);
  }

  const trades = [];
  let inPos = false, entry = 0, sl = 0, high = 0, entryDay = 0;

  for (let i = 200; i < candles.length; i++) {
    const p = closes[i], d = candles[i].date;
    const e10 = ema10[i-9], e21 = ema21[i-20], s50 = sma50[i], s200 = sma200[i];
    const r = rsi[i], a = atr[i], rv = rvol[i];
    const cp = candles[i].high === candles[i].low ? 50 : ((candles[i].close - candles[i].low) / (candles[i].high - candles[i].low)) * 100;
    if (!s50 || !s200 || r === null || a === null) continue;

    if (inPos) {
      const days = i - entryDay;
      const pnl = ((p - entry) / entry) * 100;

      // Update trailing stop: once price moves up, ratchet stop higher
      if (candles[i].high > high) {
        high = candles[i].high;
        const newSl = high - PARAMS.trailing_stop_atr * a;
        if (newSl > sl) sl = newSl;
      }

      if (candles[i].low <= sl) {
        const exit = Math.max(sl, candles[i].low);  // Realistic fill
        trades[trades.length-1].exitPrice = exit;
        trades[trades.length-1].exitDate = d;
        trades[trades.length-1].exitReason = sl > entry ? "TRAILING STOP (profit)" : "STOP LOSS";
        trades[trades.length-1].pnlPct = ((exit - entry) / entry) * 100;
        trades[trades.length-1].daysHeld = days;
        inPos = false; continue;
      }
      if (r > 70) {
        trades[trades.length-1].exitPrice = p; trades[trades.length-1].exitDate = d;
        trades[trades.length-1].exitReason = "RSI > 70 (TP)";
        trades[trades.length-1].pnlPct = pnl; trades[trades.length-1].daysHeld = days;
        inPos = false; continue;
      }
      if (e10 < e21) {
        trades[trades.length-1].exitPrice = p; trades[trades.length-1].exitDate = d;
        trades[trades.length-1].exitReason = "TREND BREAK";
        trades[trades.length-1].pnlPct = pnl; trades[trades.length-1].daysHeld = days;
        inPos = false; continue;
      }
      if (days >= 30) {
        trades[trades.length-1].exitPrice = p; trades[trades.length-1].exitDate = d;
        trades[trades.length-1].exitReason = "TIME STOP";
        trades[trades.length-1].pnlPct = pnl; trades[trades.length-1].daysHeld = days;
        inPos = false; continue;
      }
      continue;
    }

    // Entry
    const stack = e10 > e21 && e21 > s50 && s50 > s200;
    const above200 = p > s200;
    const rvPass = rv !== null && rv > PARAMS.rvol_threshold;
    const rsiPass = r > PARAMS.rsi_low && r < PARAMS.rsi_high;
    const cpPass = cp > PARAMS.close_pos_min;
    const insPass = (insiderMap.get(d) || 0) >= PARAMS.min_insider_buys;

    if (stack && above200 && rvPass && rsiPass && cpPass && insPass) {
      entry = p;
      sl = p - PARAMS.stop_loss_atr * a;  // 2.5x ATR initial
      high = candles[i].high;
      entryDay = i;
      inPos = true;
      trades.push({
        symbol, entryDate: d, entryPrice: p, initialStop: sl,
        insiderBuys: insiderMap.get(d) || 0,
        exitPrice: null, exitDate: null, exitReason: null, pnlPct: null, daysHeld: null,
      });
    }
  }

  // Close open
  if (inPos && trades.length > 0) {
    const last = candles[candles.length-1];
    const t = trades[trades.length-1];
    t.exitPrice = last.close; t.exitDate = last.date; t.exitReason = "END OF DATA";
    t.pnlPct = ((last.close - t.entryPrice) / t.entryPrice) * 100;
    t.daysHeld = candles.length - 1 - entryDay;
  }
  return trades;
}

async function main() {
  console.log("════════════════════════════════════════════════════════════");
  console.log("  Backtest: A+D Combo (Wide Stop 2.5x + Trailing Stop 2x)");
  console.log(`  ${new Date().toISOString()}`);
  console.log("════════════════════════════════════════════════════════════\n");

  const symbols = [
    "AAPL","MSFT","AMZN","NVDA","GOOGL","META","TSLA","BRK.B","UNH","LLY",
    "JPM","V","XOM","JNJ","MA","PG","AVGO","HD","CVX","MRK",
    "ABBV","KO","PEP","COST","PFE","BAC","TMO","MCD","CSCO","ACN",
    "ABT","CRM","NFLX","AMD","LIN","DHR","ORCL","TXN","ADBE","WMT",
    "NKE","PM","NEE","UNP","RTX","LOW","INTC","QCOM","INTU","AMGN",
  ];

  console.log(`Scanning ${symbols.length} stocks...\n`);

  const allTrades = [];
  const BATCH = 30;

  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    const batchNum = Math.floor(i / BATCH) + 1;
    console.log(`── Batch ${batchNum}/${Math.ceil(symbols.length / BATCH)} ──\n`);

    const insiderResults = await Promise.all(batch.map(async s => {
      try { return { symbol: s, buys: await fetchInsiders(s) }; }
      catch { return { symbol: s, buys: [] }; }
    }));

    for (const { symbol, buys } of insiderResults) {
      if (buys.length === 0) continue;
      try {
        const candles = await fetchCandles(symbol);
        if (candles.length < 210) continue;
        const buyDates = buys.map(t => t.transactionDate).sort();
        const trades = backtest(symbol, candles, buyDates);
        allTrades.push(...trades);
        if (trades.length > 0) {
          const wins = trades.filter(t => t.pnlPct > 0).length;
          const avg = trades.reduce((s, t) => s + (t.pnlPct || 0), 0) / trades.length;
          console.log(`  ${symbol.padEnd(6)} | ${trades.length} trades (${wins}W/${trades.length-wins}L) | Avg: ${avg >= 0 ? "+" : ""}${avg.toFixed(2)}%`);
          // Show each trade
          for (const t of trades) {
            const arrow = t.pnlPct >= 0 ? "✅" : "❌";
            console.log(`           ${arrow} ${t.entryDate} → ${t.exitDate} | $${t.entryPrice.toFixed(2)} → $${t.exitPrice.toFixed(2)} | ${t.pnlPct >= 0 ? "+" : ""}${t.pnlPct.toFixed(2)}% | ${t.exitReason} | ${t.daysHeld}d`);
          }
        } else {
          console.log(`  ${symbol.padEnd(6)} | 0 trades`);
        }
      } catch {}
    }

    if (i + BATCH < symbols.length) {
      console.log(`\n  ⏳ Rate limit pause (31s)...\n`);
      await sleep(31000);
    }
  }

  // Analysis
  const completed = allTrades.filter(t => t.exitPrice !== null);
  const winners = completed.filter(t => t.pnlPct > 0);
  const losers = completed.filter(t => t.pnlPct <= 0);

  if (completed.length === 0) {
    console.log("\nNo completed trades. Exiting.");
    return;
  }

  const totalPnl = completed.reduce((s, t) => s + t.pnlPct, 0);
  const avgPnl = totalPnl / completed.length;
  const avgWin = winners.length > 0 ? winners.reduce((s, t) => s + t.pnlPct, 0) / winners.length : 0;
  const avgLoss = losers.length > 0 ? losers.reduce((s, t) => s + t.pnlPct, 0) / losers.length : 0;
  const winRate = (winners.length / completed.length) * 100;
  const gp = winners.reduce((s, t) => s + t.pnlPct, 0);
  const gl = Math.abs(losers.reduce((s, t) => s + t.pnlPct, 0));
  const pf = gl === 0 ? Infinity : gp / gl;
  const wlRatio = avgLoss === 0 ? Infinity : Math.abs(avgWin / avgLoss);

  let equity = 10000, peak = 10000, maxDD = 0;
  for (const t of completed) {
    equity += (200 * t.pnlPct) / 100;
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }

  const n = completed.length;
  const z = (winners.length / n - 0.5) / Math.sqrt(0.25 / n);

  // Exit breakdown
  const exits = {};
  for (const t of completed) exits[t.exitReason] = (exits[t.exitReason] || 0) + 1;

  // Trailing stop profit vs loss breakdown
  const trailingProfits = completed.filter(t => t.exitReason === "TRAILING STOP (profit)");
  const stopLosses = completed.filter(t => t.exitReason === "STOP LOSS");

  console.log("\n════════════════════════════════════════════════════════════");
  console.log("  RESULTS: A+D Combo (Wide Stop 2.5x + Trailing Stop 2x)");
  console.log("════════════════════════════════════════════════════════════\n");

  console.log("── Performance ─────────────────────────────────────────\n");
  console.log(`  Total trades:      ${completed.length}`);
  console.log(`  Winners:           ${winners.length} (${winRate.toFixed(1)}%)`);
  console.log(`  Losers:            ${losers.length} (${(100-winRate).toFixed(1)}%)`);
  console.log(`  Win rate:          ${winRate.toFixed(1)}%`);
  console.log(`  Profit factor:     ${pf === Infinity ? "∞" : pf.toFixed(2)}`);

  console.log("\n── Returns ─────────────────────────────────────────────\n");
  console.log(`  Average return:    ${avgPnl >= 0 ? "+" : ""}${avgPnl.toFixed(2)}% per trade`);
  console.log(`  Average winner:    +${avgWin.toFixed(2)}%`);
  console.log(`  Average loser:     ${avgLoss.toFixed(2)}%`);
  console.log(`  W/L ratio:         ${wlRatio.toFixed(2)}x (winners ${wlRatio.toFixed(1)}x larger than losers)`);
  console.log(`  Best trade:        +${Math.max(...completed.map(t => t.pnlPct)).toFixed(2)}%`);
  console.log(`  Worst trade:       ${Math.min(...completed.map(t => t.pnlPct)).toFixed(2)}%`);
  console.log(`  Avg hold time:     ${(completed.reduce((s,t) => s + (t.daysHeld||0), 0) / n).toFixed(1)} days`);

  console.log("\n── Risk ────────────────────────────────────────────────\n");
  console.log(`  Max drawdown:      ${maxDD.toFixed(2)}%`);
  console.log(`  Expectancy:        $${((200*avgPnl)/100).toFixed(2)} per trade (on $200)`);
  console.log(`  Final equity:      $${equity.toFixed(2)} (started $10,000)`);
  console.log(`  Total return:      ${((equity - 10000) / 100).toFixed(2)}%`);

  console.log("\n── Statistical Significance ─────────────────────────────\n");
  console.log(`  Z-score:           ${z.toFixed(2)}`);
  if (n < 30) {
    console.log(`  ⚠️  Only ${n} trades — need 30+ for statistical significance`);
  } else if (z > 1.96) {
    console.log(`  ✅ STATISTICALLY SIGNIFICANT (p < 0.05)`);
  } else if (z > 1.65) {
    console.log(`  🟡 Marginally significant (p < 0.10)`);
  } else {
    console.log(`  🚫 Not yet significant — need more trades or a stronger edge`);
  }

  console.log("\n── Exit Breakdown ──────────────────────────────────────\n");
  for (const [reason, count] of Object.entries(exits).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / n) * 100).toFixed(1);
    const avgR = completed.filter(t => t.exitReason === reason);
    const avgRet = avgR.reduce((s, t) => s + t.pnlPct, 0) / avgR.length;
    console.log(`  ${reason.padEnd(28)} ${String(count).padStart(3)} (${pct.padStart(5)}%) | avg: ${avgRet >= 0 ? "+" : ""}${avgRet.toFixed(2)}%`);
  }

  // Comparison vs baseline
  console.log("\n── vs BASELINE Comparison ──────────────────────────────\n");
  console.log("  Metric              BASELINE     A+D COMBO    Change");
  console.log("  ─────────────────────────────────────────────────────");
  console.log(`  Win rate            45.0%        ${winRate.toFixed(1)}%        ${winRate > 45 ? "⬆️" : "⬇️"} ${(winRate - 45).toFixed(1)}%`);
  console.log(`  Profit factor       1.13         ${pf.toFixed(2)}         ${pf > 1.13 ? "⬆️" : "⬇️"} ${(pf - 1.13).toFixed(2)}`);
  console.log(`  Avg return          +0.21%       ${avgPnl >= 0 ? "+" : ""}${avgPnl.toFixed(2)}%       ${avgPnl > 0.21 ? "⬆️" : "⬇️"} ${(avgPnl - 0.21).toFixed(2)}%`);
  console.log(`  W/L ratio           1.38         ${wlRatio.toFixed(2)}         ${wlRatio > 1.38 ? "⬆️" : "⬇️"} ${(wlRatio - 1.38).toFixed(2)}`);
  console.log(`  Avg loser           -2.89%       ${avgLoss.toFixed(2)}%       ${Math.abs(avgLoss) < 2.89 ? "⬆️ smaller" : "⬇️ bigger"}`);
  console.log(`  $/trade             $0.42        $${((200*avgPnl)/100).toFixed(2)}        ${avgPnl*200/100 > 0.42 ? "⬆️" : "⬇️"}`);

  console.log("\n════════════════════════════════════════════════════════════\n");

  writeFileSync("backtest-ad-results.json", JSON.stringify({ params: PARAMS, trades: allTrades, summary: { n, winRate, pf, avgPnl, avgWin, avgLoss, wlRatio, maxDD, z, equity } }, null, 2));
  console.log("Full results saved → backtest-ad-results.json\n");
}

main().catch(err => { console.error("Error:", err); process.exit(1); });
