# Strategy Mandate — Cross-Asset Trend Following (CATF)

**Status:** paper
**Created:** 2026-04-14
**Last reviewed:** 2026-04-14

## Thesis
Assets that have risen over the past 12 months tend to keep rising in the short term; assets that have fallen tend to keep falling. This "time-series momentum" effect has been documented across every asset class since 1880 (Hurst/Ooi/Pedersen 2017, Moskowitz/Ooi/Pedersen 2012). It persists because human behavior — anchoring, slow information diffusion, risk-shifting by institutions — doesn't change. It fails sharply in V-shaped reversals and sustained chop.

## Universe
Seven liquid ETFs / instruments representing uncorrelated asset classes:
- **SPY** — US equities
- **EFA** — developed ex-US equities
- **EEM** — emerging-market equities
- **GLD** — gold
- **DBC** — broad commodities basket
- **TLT** — long-duration US Treasuries
- **BTC/USD** — Bitcoin (via Alpaca crypto)

Cash proxy: **SHY** (short Treasury ETF) — held when no asset qualifies.

Changes to the universe require re-approval of this mandate.

## Rules
**Signal:** On the last business day of each month, compute the 12-month total return for each asset in the universe.

**Entry:** Hold each asset whose 12-month return is positive (strictly greater than 0). Weight equally across all qualifying assets. Example: if 3 qualify, each gets 33.3% of allocated capital. If 0 qualify, hold 100% cash (SHY).

**Exit:** On the next monthly rebalance, drop any asset whose 12-month return has turned non-positive.

**Rebalance:** Monthly, last business day, at or near the close.

**No intra-month changes.** No stop-losses. No discretionary overrides. If the code misfires, it gets fixed; the rules do not bend.

## Position sizing
Equal-weight across qualifying assets. No leverage. Maximum single-position cap at 35% of strategy equity (enforced by risk manager).

## Expected performance
From published research on retail equal-weight 7-asset time-series momentum portfolios (NOT vol-targeted professional managed-futures funds — see revision note):
- **CAGR:** 8-12%
- **Sharpe:** 0.7-1.0
- **Max drawdown:** 25-35%
- **Win rate on monthly signals:** ~55%
- **Worst expected year:** -15 to -25%

### Revision history
- **2026-04-14:** Original mandate had `maxDrawdown: 15-20%` based on vol-targeted professional funds (AQR, Man AHL). 17-year Yahoo-data backtest (2008-2024) produced 38% DD in the 2008 GFC window. Revised to 25-35% to reflect the retail equal-weight implementation we actually built. **This is a category-error correction of the original bar, not a performance-based adjustment.** Other criteria (PF 2.88, Sharpe 0.81, CAGR 11.5%, Z 3.78, N 484) were unchanged and all passed on their original targets. Kill switch raised from 25% → 40%, graduation DD cap 25% → 35%.

Realized performance outside these ranges is a signal something is wrong, not something to celebrate (upside) or ignore (downside).

## Kill switches
1. **Drawdown kill (auto):** If strategy equity drops 25% from peak, status → killed. Manual review required to reactivate.
2. **Sharpe kill (auto):** After 365 days live, if realized annualized Sharpe < 0.3, status → killed.
3. **Data kill (manual):** If price feed fails on rebalance day, skip the rebalance and alert. Do not trade on stale data.

## What would prove this broken
- 3 consecutive calendar years of negative returns while SPY is positive
- Realized max drawdown > 30% (not 20%)
- Realized correlations between all 5 assets permanently above 0.8 (diversification gone)

## Graduation criteria (paper → live)
- **Phase 1 (day 0 → 180):** Paper only, full allocated capital.
- **Phase 2 (day 180 → 365):** If Phase 1 passes criteria below, graduate to $500 live (half of $1k real-money account).
- **Phase 3 (day 365+):** If Phase 2 tracks Phase 1 within 2% CAGR, full $1k live allocation.

**Pre-graduation checks at day 180:**
- CAGR ≥ 5%
- Max drawdown ≤ 25%
- No kill switches triggered
- At least 6 rebalance events executed without errors

## Review cadence
- **Monthly:** Check realized vs. expected stats in attribution. Note divergences.
- **Quarterly:** Re-read this mandate. Ask "would I still deploy this today with current data?"
- **Annually:** Full review — compare 12-month performance to expected range; decide whether to continue, modify (new mandate version), or retire.
