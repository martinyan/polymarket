Research (2): How Top Polymarket Traders Make Money Consistently
From the ChainCatcher analysis of 86M on-chain transactions and Polyburg/Webopedia profiles:

Strategy	Who uses it	How
Domain specialisation	#1 strategy by far	One trader: 96% win rate on "specific word mentioned" markets via exhaustive historical research. Erasmus: $1.3M on election markets via custom polling. Be the expert, not a generalist.
Information arbitrage	French trader: $85M on 2024 election	Commission original research (polls, satellite data, local sources) before the market prices it in. First mover wins.
Cross-platform arb	Dedicated bots	Same event trades at different prices on Polymarket vs Kalshi. ~$40M extracted Apr 2024–2025. Our ECMWF vs market gap is a version of this.
High-probability "bond" strategy	Conservative traders	Buy near-certain outcomes (>95¢) resolving in 1–3 days. 5% gain in 72 hrs = 1800%+ annualised. Low risk, scales with capital.
Market making	Automated bots	Post both sides, capture spread. $700–800/day on $10K capital. Requires API and tight risk management.
Speed trading	HFT-style operators	2–5 second lag between oracle data and Polymarket price. Used for BTC/ETH short-duration markets primarily.
The leaderboard reality: 80% of participants lose money. The winners are almost universally specialists, not generalists. The top wallets profit from information advantages in narrow domains — they don't bet everything with edge, they bet big on their highest-conviction domain.

What this means for our strategy:

Weather temperature markets are a narrow domain with a clear information edge (ensemble model vs. market maker's point forecast). That's genuinely good. The risk is over-diversifying across too many brackets on too many cities instead of going deep on the highest-conviction individual signals.

What We Should Change in the Bot
Two concrete fixes:

One bracket per city per date — after computing all signals, take only the single bracket with the highest Kelly fraction. No more logging 4 Shanghai brackets from the same event.

Minimum market price gate of 5¢ — if market_price < 0.05, skip regardless of EV. Prices below 5¢ are stale and not fillable at size.

Want me to implement both of these in forwardtest.ts and ev.ts now?

Sources:

Application of the Kelly Criterion to Prediction Markets — arXiv
Hey Kelly, Optimize My Portfolio — Medium
Polymarket 2025 Six Major Profit Models — ChainCatcher
polymarket-kalshi-weather-bot — GitHub
Best Polymarket Traders: Leaderboard 2026 — Polycopy
Polymarket Top Traders 2026 — Polyburg