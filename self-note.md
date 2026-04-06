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


Here’s the architecture I’d use for a `mid-copyability` Polymarket copier built around public-info, mechanical traders.

**Goal**
Copy the `process`, not blindly mirror fills:
- detect target-wallet trades quickly
- decide whether the trade is still good at `current` odds
- place only when the edge survives latency and slippage
- keep strict risk controls

**Core Pipeline**
1. `Wallet Watcher`
- Subscribe to public Polymarket activity for a shortlist of target wallets.
- Also subscribe to CLOB market/trade data for markets those wallets touch.
- Purpose: don’t rely on delayed polling alone.

2. `Event Normalizer`
- Convert raw wallet activity into a standard record:
  - wallet
  - timestamp
  - market/event slug
  - token id
  - side
  - observed fill price
  - observed size
  - category
- De-duplicate partial fills and repeated notifications.

3. `Trader Profile Layer`
- Maintain per-trader heuristics:
  - favored sports/leagues
  - usual clip size
  - normal entry price bands
  - whether they scale in
  - whether they ever sell early
- This is what turns “someone bought” into “this matches their copyable pattern.”

4. `Market Snapshot Engine`
- At signal time, fetch:
  - best bid/ask
  - depth near top of book
  - recent price movement
  - market liquidity/volume
  - time to resolution
- Purpose: determine whether the trader’s edge still exists now.

5. `Copyability Scorer`
Score each observed trade before acting:
- `Pattern match`: does this trade look like the trader’s normal mechanical behavior?
- `Latency decay`: how long since the original fill?
- `Price drift`: how much worse is the current ask than their fill?
- `Liquidity`: can we enter without moving price badly?
- `Category fit`: is this one of their known strong market types?
- `Crowding`: are many copy bots already chasing it?

6. `Independent Edge Filter`
This is the key protection.
Only copy if:
- current implied probability is still close to or better than trader fill
- slippage-adjusted price is within tolerance
- market still passes your own value rules
- expected edge after fees is positive
Without this layer, you’re just buying stale alerts.

7. `Execution Engine`
- Use passive or aggressive limit orders depending on urgency.
- Default to clipped entries, not one big order.
- Optionally ladder:
  - 40% now
  - 30% on pullback
  - 30% only if price stays inside bounds
- Cancel stale orders automatically.

8. `Risk Manager`
Hard constraints:
- max per market
- max per event/day
- max per trader
- max concurrent exposure by league/category
- no doubling down after drift beyond threshold
- cooldown after losses or model mismatch

9. `Position Manager`
- Track copied positions separately from observed whale positions.
- Decide exits by your rules, not theirs:
  - hold to resolution
  - partial take-profit
  - stop copying if price fully rerates
- For mechanical sports traders, hold-to-resolution is often simplest.

10. `Research and Replay Layer`
- Store every observed signal and what happened after:
  - trader fill
  - your possible fill
  - later market movement
  - final outcome
- This lets you answer:
  - which traders are actually copyable?
  - how much edge survives 10s / 30s / 2m latency?
  - which leagues and odds bands work best?

**Data Sources**
- `Polymarket public activity/data API`
- `Polymarket CLOB public market data / websocket if available in your setup`
- Optional third-party tracker for faster alerting and wallet labeling

**Recommended Decision Rules**
For the trader types we discussed, I’d start with:
- Copy only sports markets.
- Copy only traders with repeatable clip-size behavior.
- Ignore first fill if market already moved more than `2-3 cents`.
- Prefer markets with strong liquidity and short time to resolution.
- Only copy if current price is still within a configured band of trader price.
- Skip giant whale bursts where their own impact likely created the move.

**Best System Shape**
I’d split it into 5 services/modules:
- `ingest`: wallet activity + market stream listeners
- `normalize`: event cleaning, fill aggregation, trader tagging
- `score`: copyability + independent edge checks
- `execute`: order placement and order management
- `research`: database, replay, dashboards, performance attribution

**Tech Notes**
A simple stack is enough:
- listener workers
- Postgres for signals/trades/replay
- Redis for fast dedupe and queues
- one execution service
- one dashboard/reporting service

**What Makes This Work**
The winning version is not “copy every whale buy.”
It’s:
- watch good traders
- understand which of their trades are systematic
- only enter when the price is still good enough by your own rules

If you want, I can turn this into a concrete folder plan for `./research`, including:
- service layout
- database tables
- event schemas
- scoring formula
- MVP build order.