# Roadmap

## Phase 1 — Governance + initial strategies (current)
- [x] Portfolio governance layer (mandates, risk manager, attribution, kill switches)
- [x] Backtest harness (Yahoo Finance data loader, pre-commit criteria check)
- [x] Strategy 1 (CATF) — backtest passed, ready for paper deployment
- [ ] Strategy 1 — first paper rebalance + 6-month validation
- [ ] Strategy 2 mandate + implementation + paper trading
- [ ] Strategy 3 mandate + implementation + paper trading
- [ ] Strategy 4 mandate + implementation + paper trading
- [ ] Dashboard cleanup (remove V5/insider remnants, surface governance state)

### Retired
- **mr-rsi2** (killed 2026-04-14) — failed pre-commit: PF 1.12 vs 1.3 required, regime-dependent (worked 2023-24, failed 2019-22).
- **secmo** (killed 2026-04-14) — two-strikes retirement. v1 (top-3, 3-month): Sharpe 0.59, DD 40.7%. v2 (top-1, 6-month, canonical Antonacci): Sharpe 0.51, DD 35.4%. Both cleared PF/CAGR/Z/N but consistently undershot Sharpe + DD. Sector momentum at retail scale needs vol-targeting to be viable — not pursuing without structural redesign.
- **btcmo** (killed 2026-04-14) — failed pre-commit: DD 69.5% vs 50% kill. Strategy is real (Sharpe 1.08 full, PF 3.74, CAGR 46.9%) but BTC volatility overwhelms the 200-day SMA filter — holds through initial crash before signal flips. Shorter SMA would be post-hoc tuning.

## Phase 1.5 — Activist / insider event replication (candidate)
Add as strategy #5 after the core 4 validate. Not strategy #1.

**Thesis:** Activist 13D filings and multi-insider open-market buying contain real alpha, especially in small/mid-cap names where institutional attention is rarer and more informative.

**Universe:** US small/mid-cap equities (not S&P 500 — lesson learned from V5).

**Signals:**
- Activist fund files new 13D with >5% stake → buy within days
- 3+ company insiders make open-market purchases (Form 4 code P only, NOT grants code A) within 30 days

**Exit:** 3-6 month holding period, -15% stop, or activist exit disclosure.

**Why deferred:** Event-driven data pipelines are harder to build correctly than price-based strategies. V5 failed specifically because of data contamination (counted grants as buys) and wrong universe. Revisit after the simpler strategies prove the governance layer works.

**Required for revisit:**
- Clean SEC EDGAR or vetted paid data source
- Event detection pipeline with tested filtering rules
- Small/mid-cap universe (explicitly NOT mega-caps)
- Backtest against pre-commit criteria with proper holdout

## Phase 2 — Meta-allocation (deferred)
Dynamic capital allocation between strategies based on realized performance. Flagged for later because:
- Needs real attribution data to validate the allocator itself
- Risk of whipsawing on short-window noise
- Fixed weights + quarterly rebalance beats most "smart" schemes anyway

When revisiting:
- Start with **read-only mode** — compute target weights, log them, don't change anything. Run 3 months. Compare to fixed weights.
- Prefer **vol-targeting** (normalize risk contribution) over **performance-chasing** (chase winners).
- Cap weight changes at ±5% per quarter.
- Floor weights at ~10% per strategy (never fully abandon a diversifier).
- Implementation sketch: `portfolio/meta-allocator.js` reads attribution, writes allocationPct into each mandate, runs monthly/quarterly.

## Phase 3 — Live deployment (after validation)
- Graduate first strategy to $500 live after 6 months paper
- Full $1k live after 12 months paper tracking
