# Strategy Mandate — Mean Reversion RSI(2) on Quality S&P 500

**Status:** paper
**Created:** 2026-04-14
**Last reviewed:** 2026-04-14

## Thesis
Short-term oversold conditions in high-quality, uptrending stocks mean-revert within days. When a fundamentally sound stock in a long-term uptrend briefly sells off hard, institutional buyers step in to defend positions, producing a reliable bounce over 1-5 trading days.

Larry Connors documented this pattern (*Short Term Trading Strategies That Work*, 2009) using the 2-period RSI. The edge has persisted in published academic replications through 2024. It fails in sustained bear markets (the 200-day SMA filter is meant to keep us out of those).

## Universe
**Source:** Current S&P 500 constituents.

**Daily screen filters (applied every day before signal scan):**
- Price ≥ $10 (skip low-priced penny-like names where spreads eat edge)
- 20-day average dollar volume ≥ $10M (ensure liquidity for $625 positions)
- Close > 200-day SMA (the quality/trend filter — only buy dips in uptrends, never catch falling knives)

Stocks not passing the screen are ineligible that day.

## Rules
**Signal (end of day):** For each eligible stock, compute RSI with period 2 on daily closes. If RSI(2) < 10 and no existing position in the name, mark as a buy candidate.

**Entry:** Place a market-on-open order for the next trading day. All entries at the open, not intraday.

**Exit (checked daily at close):** Close the position when any of:
1. RSI(2) > 70 (primary exit — mean reversion has played out)
2. Held for 5 trading days (time stop — thesis didn't work in time)
3. Close price ≤ 95% of entry price (stop loss — thesis is broken)

Exits execute at next open via market-on-open, consistent with entry mechanics.

**No intraday changes.** Daily bar signals only. No overrides.

## Position sizing
- **Equal dollar per position.** Each new position = 12.5% of strategy equity.
- **Maximum 8 concurrent positions.** If 8 positions are already open and more candidates trigger, ignore them that day.
- Single-position hard cap enforced by risk manager at 15% of strategy equity (defensive margin over the 12.5% target).

## Expected performance
Based on published RSI-2 backtests on S&P 500 with the 200-SMA quality filter:
- **CAGR:** 8-12%
- **Sharpe:** 1.0-1.3 (higher than trend strategies because of short holding period)
- **Max drawdown:** 10-15%
- **Win rate:** ~65-72% per trade
- **Average hold:** 2-3 days
- **Trade frequency:** 100-300 per year across the portfolio

Realized stats outside these ranges — especially a drawdown >20% or win rate <55% — indicate something is wrong.

## Kill switches
1. **Drawdown kill (auto):** 20% peak-to-trough equity drop → status killed. Tighter than CATF's 25% because mean reversion should be smoother; a 20% drawdown means the edge has broken.
2. **Sharpe kill (auto):** After 365 days live, realized Sharpe < 0.5 → status killed. Mean reversion should deliver Sharpe ≥ 0.7 live even in bad regimes.
3. **Data kill (manual):** If daily data for >10% of universe fails to fetch, skip the day and alert.

## What would prove this broken
- 3 consecutive quarters of negative returns while SPY is flat-to-positive
- Realized win rate drops below 55% over 100+ trades
- Realized max drawdown > 20%
- Sharpe < 0.5 after 12 months

## Graduation criteria (paper → live)
- **Phase 1 (day 0 → 180):** Paper only, $5,000 allocated.
- **Phase 2 (day 180 → 365):** If Phase 1 passes, graduate to $250 live (25% of $1k real-money).
- **Phase 3 (day 365+):** Full $250 persistent; add capital only if fund as a whole validates.

**Pre-graduation checks at day 180:**
- CAGR ≥ 5% annualized
- Max drawdown ≤ 20%
- Win rate ≥ 60%
- At least 50 completed trades
- No kill switches triggered

## Regime behavior (expected, so we don't panic during bad periods)
- **Choppy/range markets:** Best regime — this is when MR strategies print money.
- **Steady bull markets:** Works but generates fewer signals (stocks rarely get oversold). Expect 5-8% CAGR, not 12%.
- **V-shaped crashes (2020, 2023 banking):** Dangerous. Entry signals trigger as stocks are still falling. The 5% stop and 200-SMA filter are designed for this but don't fully prevent drawdowns. Expect 8-15% drawdown in these events.
- **Sustained bear markets (2008, 2022):** 200-SMA filter removes most names from the universe. Strategy holds mostly cash. Low returns but low losses — intended behavior.

## Review cadence
- **Weekly:** Check kill-switch status, position count, any data errors.
- **Monthly:** Full attribution review — realized vs. expected stats, win rate, hold time.
- **Quarterly:** Re-read this mandate. Ask "would I still deploy this today?"
- **Annually:** Full review; decide continue / modify (new version) / retire.
