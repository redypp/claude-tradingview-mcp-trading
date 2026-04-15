const DAY_MS = 24 * 60 * 60 * 1000;

function dailyReturns(history) {
  if (!history || history.length < 2) return [];
  const sampled = [];
  let lastDate = null;
  for (const point of history) {
    const d = point.date.slice(0, 10);
    if (d !== lastDate) {
      sampled.push({ date: d, equity: point.equity });
      lastDate = d;
    } else {
      sampled[sampled.length - 1] = { date: d, equity: point.equity };
    }
  }
  const returns = [];
  for (let i = 1; i < sampled.length; i++) {
    const prev = sampled[i - 1].equity;
    const curr = sampled[i].equity;
    if (prev > 0) returns.push((curr - prev) / prev);
  }
  return returns;
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

export function computeStats(strategyState) {
  const history = strategyState.equityHistory || [];
  const returns = dailyReturns(history);

  const startEquity = strategyState.startingEquity;
  const currentEquity = strategyState.currentEquity;
  const totalReturn = startEquity > 0 ? (currentEquity - startEquity) / startEquity : 0;

  const startedAt = new Date(strategyState.startedAt).getTime();
  const now = Date.now();
  const daysElapsed = Math.max(1, (now - startedAt) / DAY_MS);
  const years = daysElapsed / 365.25;

  // Annualizing sub-30-day windows produces absurd numbers. Gate CAGR
  // until the strategy has enough history for the number to mean something.
  const cagr = daysElapsed >= 30 && years > 0 && startEquity > 0
    ? Math.pow(currentEquity / startEquity, 1 / years) - 1
    : 0;

  const dailyMean = mean(returns);
  const dailySd = stdev(returns);
  const sharpe = dailySd > 0 ? (dailyMean / dailySd) * Math.sqrt(252) : 0;

  return {
    totalReturnPct: totalReturn,
    cagr,
    sharpe,
    drawdownPct: strategyState.drawdownPct,
    peakEquity: strategyState.peakEquity,
    currentEquity,
    startingEquity: startEquity,
    tradeCount: strategyState.tradeCount || 0,
    daysLive: Math.round(daysElapsed),
    dataPoints: returns.length,
  };
}

export function compareToMandate(stats, mandate) {
  const flags = [];
  const exp = mandate.expected || {};
  const ks = mandate.killSwitches || {};

  if (stats.daysLive >= 90) {
    if (exp.cagr) {
      const [lo, hi] = exp.cagr;
      if (stats.cagr < lo * 0.5) flags.push(`CAGR ${(stats.cagr * 100).toFixed(1)}% far below expected ${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%`);
    }
    if (exp.maxDrawdown && stats.drawdownPct > exp.maxDrawdown[1]) {
      flags.push(`Drawdown ${(stats.drawdownPct * 100).toFixed(1)}% exceeds expected max ${(exp.maxDrawdown[1] * 100).toFixed(0)}%`);
    }
    if (exp.sharpe && stats.sharpe < exp.sharpe[0] * 0.5) {
      flags.push(`Sharpe ${stats.sharpe.toFixed(2)} far below expected ${exp.sharpe[0].toFixed(1)}-${exp.sharpe[1].toFixed(1)}`);
    }
  }

  if (ks.minSharpeAfterDays && stats.daysLive >= ks.minSharpeAfterDays.days) {
    if (stats.sharpe < ks.minSharpeAfterDays.minSharpe) {
      flags.push(`KILL-CANDIDATE: Sharpe ${stats.sharpe.toFixed(2)} below ${ks.minSharpeAfterDays.minSharpe} after ${stats.daysLive} days`);
    }
  }

  return flags;
}
