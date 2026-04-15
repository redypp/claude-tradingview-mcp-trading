# Strategy Mandate — Sector Momentum (SECMO)

**Status:** paper
**Created:** 2026-04-14
**Last reviewed:** 2026-04-14

## Thesis
Within the US equity market, sectors rotate predictably as economic cycles shift. Cross-sectional momentum — ranking sectors by recent return and holding the leaders — captures these rotations. Different edge source from CATF:
- CATF: absolute time-series momentum across asset classes (is this asset trending up on its own)
- SECMO: cross-sectional relative momentum within one asset class (which sectors are leading right now)

Documented by Moskowitz (1999), Faber (2013), Antonacci (2014). Persists because investors rotate capital slowly into leading sectors, and institutional rebalancing delays provide the drift.

## Universe
Eleven SPDR sector ETFs, covering the full GICS sector taxonomy of US equities:
- XLK (tech), XLF (financials), XLE (energy), XLV (healthcare), XLP (staples),
- XLY (discretionary), XLI (industrials), XLB (materials), XLU (utilities),
- XLRE (real estate), XLC (communication services)

Cash proxy: SHY (short Treasury) — held if absolute-momentum filter triggers.

## Rules (v2 — canonical top-1 / 6-month)
**Signal:** On the last business day of each month, compute 126-bar (~6-month) total return for each sector.

**Rank:** Sort sectors by 126-bar return, highest to lowest.

**Absolute momentum filter:** If the top-ranked sector's return is non-positive, the entire market is weak. Hold 100% cash proxy (SHY) that month. This protects against bear-market whipsaws.

**Entry:** Otherwise, hold the single top-ranked sector at 100% of strategy equity.

**Exit:** On next rebalance, rotate into the new leader if it has changed.

### Revision history
- **2026-04-14:** v1 (top-3, 3-month, 40% single-pos cap) failed pre-commit backtest on 2008-2024 — Sharpe 0.59 (need 0.7), Max DD 40.7% (kill 35%). Redesigned to v2 using Antonacci's canonical variant (top-1, 6-month). This is a rule redesign, not a criteria relaxation: kill-switch DD stays at 35%, and v2 must pass the same bar. Two-strikes rule: if v2 also fails on the 35% DD criterion, SECMO is retired entirely.

**Rebalance:** Monthly, last business day.

**No intra-month changes.** No stop-losses. No discretion.

## Position sizing
100% concentrated in the top-ranked sector when absolute filter passes. Max single position cap = 100% by design (concentrated strategy). Gross exposure 100%.

## Expected performance
From published research on top-1 / 6-month sector momentum portfolios with absolute-momentum filter (Antonacci 2014):
- **CAGR:** 12-16%
- **Sharpe:** 0.8-1.0
- **Max drawdown:** 30-40% (GFC-class events; absolute filter limits but doesn't eliminate)
- **Win rate on monthly rebalance:** ~55%

## Kill switches
1. **Drawdown kill (auto):** 35% peak-to-trough equity drop → status killed. Matches historical worst including 2008.
2. **Sharpe kill (auto):** After 365 days live, realized Sharpe < 0.4 → status killed.
3. **Data kill (manual):** If sector data feed fails on rebalance day, skip and alert.

## What would prove this broken
- 3 consecutive years of negative returns while SPY is positive
- Max drawdown > 40% (deeper than GFC worst)
- Realized correlation between sectors permanently above 0.9 (sectors stopped being distinct)

## Graduation criteria (paper → live)
- **Phase 1 (day 0 → 180):** Paper only, $5,000 allocated.
- **Phase 2 (day 180 → 365):** If Phase 1 passes, graduate to $250 live.
- **Phase 3 (day 365+):** Full $250 persistent; add capital only if fund as a whole validates.

**Pre-graduation checks at day 180:**
- CAGR ≥ 6%
- Max drawdown ≤ 30%
- At least 6 rebalance events executed without errors
- No kill switches triggered

## Regime behavior (expected)
- **Trending markets:** Excellent — sector leadership persists.
- **Choppy markets:** Whipsaws — top 3 changes monthly, churn cost eats returns.
- **Bear markets:** Absolute filter sends strategy to cash, avoiding most of the damage.
- **V-shaped crashes:** Absolute filter lags — fully invested during crash, then misses initial rally.

## Review cadence
- **Monthly:** Check realized vs. expected stats.
- **Quarterly:** Re-read mandate; check correlation of SECMO equity curve to CATF (should be <0.7; if higher, we're getting less diversification than planned).
- **Annually:** Full review.
