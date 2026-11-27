---
name: quant-backtest-discipline
description: "Factor-benchmarking, fee/slippage/missing-data accounting, and paper-trading-first validation checklist distilled from HKUDS/Vibe-Trading for quantitative research and trading strategy tasks."
---

# Quantitative Backtest & Paper-Trading Discipline

Apply this checklist on any trading, alpha-factor, or financial strategy task:

1. **Research & Paper First**: Default to read-only market research and paper-trading validation. Never connect live withdrawal-capable keys or bypass explicit human approval for live orders.
2. **No Look-Ahead / Survivorship Bias**: Verify timestamps strictly (bar close vs next-bar open fill), include delisted/failed symbols when available, and separate in-sample discovery from out-of-sample holdout windows.
3. **Full Friction Accounting**: Every backtest MUST deduct maker/taker fees, funding rates (for perpetuals), realistic slippage/spread, and minimum order notional constraints (e.g., $100 floor). Report missing/stale data gaps explicitly rather than forward-filling silently.
4. **Counter-Evidence & Stress Stop**: Explicitly report maximum drawdown (MDD), worst losing streak, tail-event stress stop cost, and turnover alongside gross/net return and Sharpe/Sortino.
5. **Promotion Ladder**: Promote strategies only after: (a) clean out-of-sample walk-forward pass → (b) deterministic paper-trading log matching backtest assumptions → (c) explicit human approval with hard daily loss limits.
