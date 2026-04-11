/**
 * Strategy Overhaul Backtest — Finding a Profitable Edge
 *
 * The current strategy breaks even because:
 * - Winners and losers are the same size (~3.7%)
 * - Win rate is ~50% (coin flip)
 * - Insider buying is a good FILTER but a bad TRIGGER
 *
 * Key insight from data: winning trades work FAST (1-5 days).
 * Losing trades drag on. We need to cut losers faster and let winners run.
 *
 * Testing 7 fundamentally different approaches.
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync } from "fs";

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;
const ALPACA_KEY = process.env.ALPACA_API_KEY;
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY;

// ─── Strategy Variations ────────────────────────────────────────────────────

const STRATEGIES = {
  "V0: BASELINE (current)": {
    description: "Original 6 conditions, 1.5x ATR stop, RSI>70 TP",
    entry: (d) => d.trendStack && d.above200 && d.rvol > 1.5 && d.rsi > 40 && d.rsi < 70 && d.closePos > 50 && d.insiders >= 1,
    stopAtr: 1.5,
    quickExit: false,
    quickExitDays: 999,
    trailingStop: false,
    trailingAtr: 1.5,
    tpRsi: 70,
  },

  "V1: Quick Exit (5d losers)": {
    description: "Same entry, but exit losers after 5 days",
    entry: (d) => d.trendStack && d.above200 && d.rvol > 1.5 && d.rsi > 40 && d.rsi < 70 && d.closePos > 50 && d.insiders >= 1,
    stopAtr: 1.5,
    quickExit: true,
    quickExitDays: 5,
    trailingStop: false,
    trailingAtr: 1.5,
    tpRsi: 70,
  },

  "V2: Drop RVOL": {
    description: "Remove RVOL requirement — let more insider picks through",
    entry: (d) => d.trendStack && d.above200 && d.rsi > 40 && d.rsi < 70 && d.closePos > 50 && d.insiders >= 1,
    stopAtr: 1.5,
    quickExit: false,
    quickExitDays: 999,
    trailingStop: false,
    trailingAtr: 1.5,
    tpRsi: 70,
  },

  "V3: Pullback Entry": {
    description: "Buy the dip: RSI 40-55 instead of 40-70 (enter on weakness, not strength)",
    entry: (d) => d.trendStack && d.above200 && d.rsi > 40 && d.rsi < 55 && d.closePos > 50 && d.insiders >= 1,
    stopAtr: 1.5,
    quickExit: false,
    quickExitDays: 999,
    trailingStop: false,
    trailingAtr: 1.5,
    tpRsi: 70,
  },

  "V4: Simplified Trend": {
    description: "Just EMA10>EMA21 + above SMA200 (drop SMA50 requirement for more trades)",
    entry: (d) => d.ema10 > d.ema21 && d.above200 && d.rsi > 40 && d.rsi < 70 && d.closePos > 50 && d.insiders >= 1,
    stopAtr: 1.5,
    quickExit: false,
    quickExitDays: 999,
    trailingStop: false,
    trailingAtr: 1.5,
    tpRsi: 70,
  },

  "V5: Heavy Insiders Only": {
    description: "5+ insider buys required, relaxed technicals (just above SMA200 + EMA10>EMA21)",
    entry: (d) => d.ema10 > d.ema21 && d.above200 && d.rsi > 35 && d.rsi < 70 && d.insiders >= 5,
    stopAtr: 1.5,
    quickExit: true,
    quickExitDays: 5,
    trailingStop: false,
    trailingAtr: 1.5,
    tpRsi: 70,
  },

  "V5a: Insiders >=3": {
    description: "3+ insider buys — lower bar to recover sample size post Form 4 fix",
    entry: (d) => d.ema10 > d.ema21 && d.above200 && d.rsi > 35 && d.rsi < 70 && d.insiders >= 3,
    stopAtr: 1.5,
    quickExit: true,
    quickExitDays: 5,
    trailingStop: false,
    trailingAtr: 1.5,
    tpRsi: 70,
  },

  "V5b: Insiders >=2": {
    description: "2+ insider buys — lowest meaningful threshold",
    entry: (d) => d.ema10 > d.ema21 && d.above200 && d.rsi > 35 && d.rsi < 70 && d.insiders >= 2,
    stopAtr: 1.5,
    quickExit: true,
    quickExitDays: 5,
    trailingStop: false,
    trailingAtr: 1.5,
    tpRsi: 70,
  },

  "V6: BEST COMBO": {
    description: "Simplified trend + drop RVOL + quick exit losers at 5d + pullback entry (RSI 40-55)",
    entry: (d) => d.ema10 > d.ema21 && d.above200 && d.rsi > 40 && d.rsi < 55 && d.closePos > 50 && d.insiders >= 1,
    stopAtr: 1.5,
    quickExit: true,
    quickExitDays: 5,
    trailingStop: false,
    trailingAtr: 1.5,
    tpRsi: 70,
  },
};

// ─── Indicators ─────────────────────────────────────────────────────────────

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
  for (let i = 1; i <= period; i++) { const d = closes[i]-closes[i-1]; if (d>0) ag+=d; else al-=d; }
  ag /= period; al /= period;
  v.push(al===0 ? 100 : 100-100/(1+ag/al));
  for (let i = period+1; i < closes.length; i++) {
    const d = closes[i]-closes[i-1];
    ag = (ag*(period-1)+Math.max(d,0))/period;
    al = (al*(period-1)+Math.max(-d,0))/period;
    v.push(al===0 ? 100 : 100-100/(1+ag/al));
  }
  return v;
}
function calcATR(candles, period = 14) {
  const trs = [0];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], pc = candles[i-1].close;
    trs.push(Math.max(c.high-c.low, Math.abs(c.high-pc), Math.abs(c.low-pc)));
  }
  const v = new Array(period).fill(null);
  let a = trs.slice(1,period+1).reduce((a,b)=>a+b,0)/period;
  v.push(a);
  for (let i = period+1; i < trs.length; i++) { a=(a*(period-1)+trs[i])/period; v.push(a); }
  return v;
}
function calcRVOL(candles, period = 20) {
  const v = new Array(period+1).fill(null);
  for (let i = period+1; i < candles.length; i++) {
    const avg = candles.slice(i-period,i).reduce((s,c)=>s+c.volume,0)/period;
    v.push(avg===0 ? null : candles[i].volume/avg);
  }
  return v;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Data ───────────────────────────────────────────────────────────────────

async function fetchInsiders(symbol) {
  const res = await fetch(`https://finnhub.io/api/v1/stock/insider-transactions?symbol=${symbol}&token=${FINNHUB_KEY}`);
  if (!res.ok) return [];
  const data = await res.json();
  // SEC Form 4: P = open-market purchase only. A (grant/award) is
  // compensation, not conviction — excluding it.
  return (data.data||[]).filter(t => t.transactionCode==="P");
}
async function fetchCandles(symbol) {
  const params = new URLSearchParams({timeframe:"1Day",start:"2021-01-01",end:"2026-04-09",limit:"10000",feed:"iex",adjustment:"raw"});
  const res = await fetch(`https://data.alpaca.markets/v2/stocks/${symbol}/bars?${params}`, {
    headers: {"APCA-API-KEY-ID":ALPACA_KEY,"APCA-API-SECRET-KEY":ALPACA_SECRET},
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.bars||[]).map(b => ({date:b.t.slice(0,10),open:b.o,high:b.h,low:b.l,close:b.c,volume:b.v}));
}

// ─── Backtest Engine ────────────────────────────────────────────────────────

function runBacktest(candles, buyDates, strategy) {
  if (candles.length < 210) return [];
  const closes = candles.map(c => c.close);
  const ema10Arr = calcEMA(closes, 10);
  const ema21Arr = calcEMA(closes, 21);
  const sma50Arr = calcSMA(closes, 50);
  const sma200Arr = calcSMA(closes, 200);
  const rsiArr = calcRSI(closes, 14);
  const atrArr = calcATR(candles, 14);
  const rvolArr = calcRVOL(candles, 20);

  const insiderMap = new Map();
  for (const date of candles.map(c => c.date)) {
    const cutoff = new Date(new Date(date).getTime()-90*24*60*60*1000).toISOString().slice(0,10);
    insiderMap.set(date, buyDates.filter(bd => bd >= cutoff && bd <= date).length);
  }

  const trades = [];
  let inPos = false, entry = 0, sl = 0, high = 0, eDay = 0;

  for (let i = 200; i < candles.length; i++) {
    const p = closes[i], date = candles[i].date;
    const ema10 = ema10Arr[i-9], ema21 = ema21Arr[i-20];
    const sma50 = sma50Arr[i], sma200 = sma200Arr[i];
    const rsi = rsiArr[i], atr = atrArr[i], rvol = rvolArr[i];
    const cp = candles[i].high===candles[i].low ? 50 : ((candles[i].close-candles[i].low)/(candles[i].high-candles[i].low))*100;
    if (!sma50 || !sma200 || rsi===null || atr===null) continue;

    if (inPos) {
      const days = i - eDay;
      const pnl = ((p - entry) / entry) * 100;

      // Trailing stop update
      if (strategy.trailingStop && candles[i].high > high) {
        high = candles[i].high;
        const ns = high - strategy.trailingAtr * atr;
        if (ns > sl) sl = ns;
      }

      // Stop loss
      if (candles[i].low <= sl) {
        const exit = Math.max(sl, candles[i].low);
        trades[trades.length-1].exit = exit; trades[trades.length-1].exitDate = date;
        trades[trades.length-1].reason = "STOP LOSS";
        trades[trades.length-1].pnl = ((exit-entry)/entry)*100;
        trades[trades.length-1].days = days;
        inPos = false; continue;
      }
      // Quick exit: if losing after N days, cut it
      if (strategy.quickExit && days >= strategy.quickExitDays && pnl < 0) {
        trades[trades.length-1].exit = p; trades[trades.length-1].exitDate = date;
        trades[trades.length-1].reason = `CUT LOSER (${strategy.quickExitDays}d)`;
        trades[trades.length-1].pnl = pnl; trades[trades.length-1].days = days;
        inPos = false; continue;
      }
      // RSI TP
      if (rsi > strategy.tpRsi) {
        trades[trades.length-1].exit = p; trades[trades.length-1].exitDate = date;
        trades[trades.length-1].reason = "RSI > 70 (TP)";
        trades[trades.length-1].pnl = pnl; trades[trades.length-1].days = days;
        inPos = false; continue;
      }
      // Trend break
      if (ema10 < ema21) {
        trades[trades.length-1].exit = p; trades[trades.length-1].exitDate = date;
        trades[trades.length-1].reason = "TREND BREAK";
        trades[trades.length-1].pnl = pnl; trades[trades.length-1].days = days;
        inPos = false; continue;
      }
      // Time stop 30d
      if (days >= 30) {
        trades[trades.length-1].exit = p; trades[trades.length-1].exitDate = date;
        trades[trades.length-1].reason = "TIME 30D";
        trades[trades.length-1].pnl = pnl; trades[trades.length-1].days = days;
        inPos = false; continue;
      }
      continue;
    }

    // Build indicator snapshot for entry check
    const trendStack = ema10 > ema21 && ema21 > sma50 && sma50 > sma200;
    const d = {
      price: p, ema10, ema21, sma50, sma200, rsi, atr, rvol: rvol || 0,
      closePos: cp, insiders: insiderMap.get(date) || 0,
      trendStack, above200: p > sma200,
    };

    if (strategy.entry(d)) {
      entry = p; sl = p - strategy.stopAtr * atr; high = candles[i].high; eDay = i;
      inPos = true;
      trades.push({ sym: candles[0] ? "" : "", entryDate: date, entry: p, sl, insiders: d.insiders,
        exit: null, exitDate: null, reason: null, pnl: null, days: null });
    }
  }

  // Close open
  if (inPos && trades.length > 0) {
    const last = candles[candles.length-1], t = trades[trades.length-1];
    t.exit = last.close; t.exitDate = last.date; t.reason = "END OF DATA";
    t.pnl = ((last.close-t.entry)/t.entry)*100; t.days = candles.length-1-eDay;
  }
  return trades;
}

// ─── Analysis ───────────────────────────────────────────────────────────────

function analyze(trades) {
  const c = trades.filter(t => t.exit !== null);
  if (c.length === 0) return null;
  const w = c.filter(t => t.pnl > 0), l = c.filter(t => t.pnl <= 0);
  const avgPnl = c.reduce((s,t)=>s+t.pnl,0)/c.length;
  const avgW = w.length>0 ? w.reduce((s,t)=>s+t.pnl,0)/w.length : 0;
  const avgL = l.length>0 ? l.reduce((s,t)=>s+t.pnl,0)/l.length : 0;
  const wr = (w.length/c.length)*100;
  const gp = w.reduce((s,t)=>s+t.pnl,0);
  const gl = Math.abs(l.reduce((s,t)=>s+t.pnl,0));
  const pf = gl===0 ? 999 : gp/gl;
  const wl = avgL===0 ? 999 : Math.abs(avgW/avgL);

  let eq = 10000, pk = 10000, mdd = 0;
  for (const t of c) {
    eq += (200*t.pnl)/100;
    if (eq>pk) pk=eq;
    const dd = ((pk-eq)/pk)*100;
    if (dd>mdd) mdd=dd;
  }

  const z = (w.length/c.length - 0.5) / Math.sqrt(0.25/c.length);

  // Edge score: combines win rate, PF, and sample size
  const edge = (wr/100) * wl;  // Expectancy ratio

  return {
    n: c.length, w: w.length, l: l.length, wr, pf, avgPnl, avgW, avgL, wl,
    mdd, eq, z, edge, expectancy: (200*avgPnl)/100,
    avgDays: c.reduce((s,t)=>s+(t.days||0),0)/c.length,
    best: Math.max(...c.map(t=>t.pnl)),
    worst: Math.min(...c.map(t=>t.pnl)),
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("════════════════════════════════════════════════════════════");
  console.log("  Strategy Overhaul — Finding a Profitable Edge");
  console.log(`  ${new Date().toISOString()}`);
  console.log("  Testing 7 fundamentally different approaches");
  console.log("════════════════════════════════════════════════════════════\n");

  // Load full S&P 500 universe from universe.json
  const universe = JSON.parse(readFileSync("universe.json", "utf8"));
  const symbols = universe.symbols;

  console.log(`Loading data for ${symbols.length} stocks...\n`);

  // Fetch all data once
  const stockData = [];
  const BATCH = 30;

  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    const batchNum = Math.floor(i/BATCH)+1;
    const totalBatches = Math.ceil(symbols.length/BATCH);
    console.log(`  Batch ${batchNum}/${totalBatches}: ${batch.slice(0,8).join(", ")}...`);

    const results = await Promise.all(batch.map(async s => {
      try { return { symbol: s, buys: await fetchInsiders(s) }; }
      catch { return { symbol: s, buys: [] }; }
    }));

    for (const { symbol, buys } of results) {
      if (buys.length === 0) continue;
      try {
        const candles = await fetchCandles(symbol);
        if (candles.length >= 210) {
          stockData.push({ symbol, candles, buyDates: buys.map(t=>t.transactionDate).sort(), insiderCount: buys.length });
        }
      } catch {}
    }

    if (i + BATCH < symbols.length) {
      console.log(`  ⏳ Rate limit (31s)...\n`);
      await sleep(31000);
    }
  }

  console.log(`\n  Loaded: ${stockData.length} stocks with insider buying\n`);

  // Run all strategies
  console.log("════════════════════════════════════════════════════════════");
  console.log("  Running 7 strategy variations...");
  console.log("════════════════════════════════════════════════════════════\n");

  const allResults = {};

  for (const [name, strategy] of Object.entries(STRATEGIES)) {
    const trades = [];
    for (const { symbol, candles, buyDates } of stockData) {
      const t = runBacktest(candles, buyDates, strategy);
      t.forEach(tr => tr.sym = symbol);
      trades.push(...t);
    }

    const stats = analyze(trades);
    allResults[name] = { strategy: strategy.description, stats, trades };

    if (stats) {
      const bar = stats.avgPnl > 0 ? "+" : "";
      console.log(`  ${name}`);
      console.log(`  ${strategy.description}`);
      console.log(`  → ${stats.n} trades | Win: ${stats.wr.toFixed(1)}% | PF: ${stats.pf.toFixed(2)} | Avg: ${bar}${stats.avgPnl.toFixed(2)}% | W/L: ${stats.wl.toFixed(2)} | Z: ${stats.z.toFixed(2)} | $${stats.expectancy.toFixed(2)}/trade\n`);
    } else {
      console.log(`  ${name}: No trades\n`);
    }
  }

  // Comparison table
  console.log("\n════════════════════════════════════════════════════════════");
  console.log("  COMPARISON TABLE");
  console.log("════════════════════════════════════════════════════════════\n");

  const hdr = "Strategy".padEnd(35) + "Trades".padStart(6) + " Win%".padStart(6) + "   PF".padStart(6) + "  Avg%".padStart(7) + " AvgW%".padStart(7) + " AvgL%".padStart(7) + "  W/L".padStart(6) + "    Z".padStart(6) + " $/trade".padStart(9);
  console.log(hdr);
  console.log("─".repeat(hdr.length));

  let bestName = "", bestScore = -Infinity;

  for (const [name, { stats }] of Object.entries(allResults)) {
    if (!stats) { console.log(`${name.padEnd(35)}  — no trades —`); continue; }
    const row = name.padEnd(35) +
      String(stats.n).padStart(6) +
      stats.wr.toFixed(1).padStart(6) +
      stats.pf.toFixed(2).padStart(6) +
      `${stats.avgPnl>=0?"+":""}${stats.avgPnl.toFixed(2)}`.padStart(7) +
      `+${stats.avgW.toFixed(2)}`.padStart(7) +
      stats.avgL.toFixed(2).padStart(7) +
      stats.wl.toFixed(2).padStart(6) +
      stats.z.toFixed(2).padStart(6) +
      `$${stats.expectancy>=0?"+":""}${stats.expectancy.toFixed(2)}`.padStart(9);
    console.log(row);

    // Score: reward PF, win rate, and penalize too-few trades
    const score = stats.n >= 15 ? stats.pf * Math.sqrt(stats.n) * (stats.avgPnl > 0 ? 1 : 0.1) : 0;
    if (score > bestScore) { bestScore = score; bestName = name; }
  }

  console.log("─".repeat(hdr.length));

  // Winner analysis
  const best = allResults[bestName];
  if (best?.stats) {
    const s = best.stats;
    console.log(`\n════════════════════════════════════════════════════════════`);
    console.log(`  WINNER: ${bestName}`);
    console.log(`  ${best.strategy}`);
    console.log(`════════════════════════════════════════════════════════════\n`);

    console.log(`  Trades:       ${s.n}`);
    console.log(`  Win rate:     ${s.wr.toFixed(1)}%`);
    console.log(`  Profit factor: ${s.pf.toFixed(2)}`);
    console.log(`  Avg return:   ${s.avgPnl>=0?"+":""}${s.avgPnl.toFixed(2)}% per trade`);
    console.log(`  Avg winner:   +${s.avgW.toFixed(2)}%`);
    console.log(`  Avg loser:    ${s.avgL.toFixed(2)}%`);
    console.log(`  W/L ratio:    ${s.wl.toFixed(2)}x`);
    console.log(`  Best trade:   +${s.best.toFixed(2)}%`);
    console.log(`  Worst trade:  ${s.worst.toFixed(2)}%`);
    console.log(`  Avg hold:     ${s.avgDays.toFixed(1)} days`);
    console.log(`  Max DD:       ${s.mdd.toFixed(2)}%`);
    console.log(`  Final equity: $${s.eq.toFixed(2)} (started $10,000)`);
    console.log(`  Z-score:      ${s.z.toFixed(2)}`);

    if (s.z > 1.96) console.log(`\n  ✅ STATISTICALLY SIGNIFICANT — this has a real edge`);
    else if (s.z > 1.65) console.log(`\n  🟡 MARGINALLY SIGNIFICANT — promising, needs more trades`);
    else if (s.n < 30) console.log(`\n  ⚠️  Too few trades (${s.n}) for statistical significance`);
    else console.log(`\n  🚫 Not yet significant — Z=${s.z.toFixed(2)}, need >1.96`);

    // Show exit breakdown
    const exits = {};
    for (const t of best.trades.filter(t=>t.exit)) exits[t.reason] = (exits[t.reason]||0)+1;
    console.log(`\n  Exit breakdown:`);
    for (const [r, c] of Object.entries(exits).sort((a,b)=>b[1]-a[1])) {
      const pct = (c/s.n*100).toFixed(1);
      const avg = best.trades.filter(t=>t.reason===r);
      const avgR = avg.reduce((s,t)=>s+t.pnl,0)/avg.length;
      console.log(`    ${r.padEnd(25)} ${String(c).padStart(3)} (${pct.padStart(5)}%) | avg: ${avgR>=0?"+":""}${avgR.toFixed(2)}%`);
    }

    // Show top individual trades
    const sorted = best.trades.filter(t=>t.exit).sort((a,b) => b.pnl - a.pnl);
    console.log(`\n  Top 5 winners:`);
    sorted.slice(0,5).forEach(t => {
      console.log(`    ${t.sym.padEnd(6)} +${t.pnl.toFixed(2)}% | ${t.entryDate} → ${t.exitDate} (${t.days}d) | ${t.reason}`);
    });
    console.log(`\n  Top 5 losers:`);
    sorted.slice(-5).reverse().forEach(t => {
      console.log(`    ${t.sym.padEnd(6)} ${t.pnl.toFixed(2)}% | ${t.entryDate} → ${t.exitDate} (${t.days}d) | ${t.reason}`);
    });
  }

  // Practical recommendation
  console.log(`\n════════════════════════════════════════════════════════════`);
  console.log(`  PRACTICAL RECOMMENDATIONS`);
  console.log(`════════════════════════════════════════════════════════════\n`);

  // Find all profitable variants
  const profitable = Object.entries(allResults)
    .filter(([_, v]) => v.stats && v.stats.avgPnl > 0 && v.stats.n >= 10)
    .sort((a, b) => b[1].stats.pf - a[1].stats.pf);

  if (profitable.length === 0) {
    console.log("  None of the variations produced a clear edge with 10+ trades.");
    console.log("  The insider + technical approach may need a fundamentally");
    console.log("  different entry mechanism. Consider:\n");
    console.log("  1. Use insider buying purely as a WATCHLIST filter");
    console.log("     (which stocks to watch, not when to buy)");
    console.log("  2. Add a catalyst trigger: earnings, FDA approval, sector rotation");
    console.log("  3. Mean reversion entry: buy insider stocks when RSI < 30");
    console.log("     (buy the panic dip in a stock insiders are accumulating)");
    console.log("  4. Longer hold period: insider buying is a 3-6 month signal,");
    console.log("     not a daily trigger. Consider holding 30-90 days.\n");
  } else {
    console.log("  Profitable variations (sorted by profit factor):\n");
    for (const [name, { stats }] of profitable) {
      console.log(`  → ${name}`);
      console.log(`    PF: ${stats.pf.toFixed(2)} | Win: ${stats.wr.toFixed(1)}% | ${stats.n} trades | $${stats.expectancy.toFixed(2)}/trade\n`);
    }
  }

  console.log("════════════════════════════════════════════════════════════\n");

  writeFileSync("backtest-v2-results.json", JSON.stringify(allResults, null, 2));
  console.log("Full results saved → backtest-v2-results.json\n");
}

main().catch(err => { console.error("Error:", err); process.exit(1); });
