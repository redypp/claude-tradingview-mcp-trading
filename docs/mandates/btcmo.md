# Strategy Mandate — BTC Momentum (BTCMO)

**Status:** paper
**Created:** 2026-04-14
**Last reviewed:** 2026-04-14
**Classification:** satellite / low-frequency single-asset trend

## Thesis
Crypto is the last major retail-dominated asset class with strong trending behavior. A 200-day SMA filter on BTC has historically:
- Captured 60-80% of BTC's buy-and-hold upside
- Reduced max drawdown from ~80% (BHODL) to ~35-45% (trend-filtered)
- Produced Sharpe ~1.0-1.3 vs ~0.7-0.9 for buy-and-hold

Edge persists because: (1) crypto markets are still retail/narrative-driven, (2) institutional short capacity is limited, (3) halving-driven supply cycles create multi-year trends.

**Role in the fund:** Satellite / diversifier. Uncorrelated cycle timing to equities. NOT the fund's core return engine — sized at 25% because of higher volatility.

## Universe
- **BTC/USD** only (via Alpaca crypto)

Cash proxy: **SHY**.

ETH, SOL, and other alts excluded from v1. Less history (ETH 2017+, SOL 2020+) limits backtest validity.

## Rules
**Signal:** Daily close vs 200-day simple moving average.

**Entry:** When close > SMA(200) and no BTC position → buy BTC with full strategy capital.

**Exit:** When close ≤ SMA(200) and BTC position exists → sell all BTC, hold cash (or SHY — see below).

**Check frequency:** Daily (near market close or anytime since crypto trades 24/7).

**Rebalance frequency:** Only when signal flips. No periodic rebalance.

**Cash parking:** When in cash, hold as USD (default Alpaca cash) or optionally buy SHY for minor yield. For v1, hold as cash — crypto signals flip fast enough that SHY rotation adds cost.

**No intra-day changes.** Daily-close evaluation only. No overrides.

## Position sizing
100% of strategy equity in BTC when signal is long. 100% cash when signal is flat. Single-position cap = 100% (satellite strategy, concentrated by design).

## Expected performance
From Faber (2013) *A Quantitative Approach to Tactical Asset Allocation* and subsequent crypto-specific replications:
- **CAGR:** 25-50% (BTC's absolute returns over 10 years are very high; the filter captures most of this)
- **Sharpe:** 0.9-1.3
- **Max drawdown:** 30-45%
- **Win rate on regime changes:** ~50-60% (many false signals get stopped out, big winners pay for them)
- **Expected trades per decade:** 15-25

## Kill switches
1. **Drawdown kill (auto):** 50% peak-to-trough drop → killed. Wider than other strategies because BTC volatility is structurally higher. Historical worst-case for 200-SMA-filtered BTC is ~40-45%.
2. **Sharpe kill (auto):** After 365 days live, realized Sharpe < 0.5 → killed.
3. **Data kill (manual):** If BTC price feed fails, pause trading and alert.

## What would prove this broken
- BTC enters a structural 5+ year sideways regime (strategy would bleed whipsaws)
- Realized drawdown > 55%
- Crypto correlation to equities rises above 0.8 permanently (loses diversification benefit)
- BTC buy-and-hold starts outperforming trend-filtered by a wide margin consistently (edge has decayed)

## Evaluation criteria (pre-commit, pre-committed UPFRONT)
This strategy is evaluated on a class-appropriate criteria set. **N≥50 is NOT applicable** to single-asset trend strategies because signal flips happen ~2x/year by design.

Instead, must pass:
- **PF ≥ 1.3**
- **Z ≥ 2.0** (raised from 1.5 to compensate for lower N)
- **Sharpe ≥ 0.7** (below expected low-bound; any strategy weaker than this is uninteresting)
- **Max DD < kill (50%)**
- **CAGR ≥ 10%** (raised from 5% because this is BTC — lower returns aren't worth the volatility)

This criteria set was written **before running the backtest**, per `feedback_mandate_revisions.md`. Not a results-driven adjustment.

## Graduation criteria (paper → live)
- **Phase 1 (day 0 → 180):** Paper only, $5,000 allocated.
- **Phase 2 (day 180 → 365):** If Phase 1 passes, graduate to $250 live.
- **Phase 3 (day 365+):** Full $250 persistent.

**Pre-graduation checks at day 180:**
- CAGR ≥ 10% (annualized, ok if only partial cycle)
- Max drawdown ≤ 40%
- At least 2 signal changes executed without errors
- No kill switches triggered

## Regime behavior (expected)
- **BTC bull cycle (2017, 2020-21, 2023-24):** Excellent — hold through the ride.
- **BTC bear (2018, 2022):** Signal flips to cash by mid-drop. Avoid most of the bottom.
- **Choppy BTC (late 2019, mid-2023):** Whipsaw losses. Each false signal costs ~5-10%. Can stack to -20%.
- **Sideways years:** Probably break-even or small loss. Acceptable.

## Review cadence
- **Weekly:** Check signal state (long BTC / cash) and position correctness.
- **Monthly:** Full attribution review.
- **Quarterly:** Re-read mandate; check correlation to CATF and BTC buy-and-hold.
