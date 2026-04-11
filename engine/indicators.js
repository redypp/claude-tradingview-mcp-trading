/**
 * Pure indicator functions. All return the indicator value at the
 * last bar. Backtest harnesses can wrap these in loops or reimplement
 * as rolling arrays for efficiency.
 */

export function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

export function calcSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(closes.length - period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  // Wilder's RSI: seed with simple average of first `period` diffs,
  // then exponentially smooth across all remaining bars. Matches
  // TradingView's built-in RSI.
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    trs.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - prevClose),
        Math.abs(c.low - prevClose),
      ),
    );
  }
  const recent = trs.slice(trs.length - period);
  return recent.reduce((a, b) => a + b, 0) / period;
}

/**
 * Total return (in percent) between the first and last close.
 * Used by momentum strategies: `totalReturnPct(closes.slice(-252))`
 * gives ~12-month return on daily data.
 */
export function totalReturnPct(closes) {
  if (!closes || closes.length < 2) return null;
  const first = closes[0];
  const last = closes[closes.length - 1];
  return ((last - first) / first) * 100;
}
