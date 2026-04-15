# Polymarket Copy Bot Plan

Last updated: 2026-04-05 UTC (weather strategy research added)

## Goal

Build a preview-first, production-usable Polymarket copy-trading bot that:

- follows one or more trader wallets
- detects fresh trade activity quickly and only once
- decides whether each trade is safe to copy
- sizes the copied trade conservatively
- places the order through the official CLOB flow when live mode is enabled
- stays easy to audit, test, and roll back

## What We Already Have

The current repo is not a blank slate. It already includes:

- config parsing and env validation
- polling of public trader activity from the Polymarket Data API
- market enrichment from the Gamma API
- preview-mode logging
- live order submission through `@polymarket/clob-client`
- local state persistence for processed activity ids
- a first pass of tests around activity, bot flow, and strategy

That means our fastest path is to harden and verify this scaffold, not rebuild it.

## Public API Grounding

This plan is based on Polymarket's public docs and hosted endpoints:

- Quickstart: https://docs.polymarket.com/quickstart
- API intro: https://docs.polymarket.com/api-reference/introduction
- Data API activity: https://docs.polymarket.com/developers/misc-endpoints/data-api-activity
- Gamma markets overview: https://docs.polymarket.com/developers/gamma-markets-api/overview
- CLOB auth overview: https://docs.polymarket.com/developers/CLOB/authentication
- CLOB client methods: https://docs.polymarket.com/developers/CLOB/clients/methods-l1

Useful split to keep in mind:

- `data-api.polymarket.com`: public user/activity style data
- `gamma-api.polymarket.com`: public market metadata and discovery
- `clob.polymarket.com`: trading and order-book actions, with authenticated client flow for live orders

## Build Strategy

We will ship this in phases, with each phase ending in a concrete verification point.

### Phase 1: Lock Down Preview Mode

Objective:
- make the bot trustworthy in preview before risking any live order

Tasks:
- verify the current activity polling returns the right trades for a real followed wallet
- confirm duplicate suppression works across repeated polls and restarts
- verify market lookup by `conditionId` is stable for copied trades
- confirm skip reasons are explicit and actionable
- ensure preview logs include all values needed for manual review

Done when:
- repeated runs do not replay already-seen activity unless state is intentionally reset
- every copied candidate has `slug`, `conditionId`, `tokenId`, `price`, `orderUsd`, and `orderSize`
- skipped trades clearly explain why they were blocked

### Phase 2: Harden Copy Decision Logic

Objective:
- make copying safer and more predictable than a naive mirror bot

Tasks:
- review how we infer side, price, and size from source activity
- decide how to handle sells from followed wallets
- cap copied exposure with `COPY_RATIO`, `MIN_ORDER_USD`, and `MAX_ORDER_USD`
- reject markets with missing token metadata or disabled trading
- add stricter checks around stale prices, bad token mappings, and invalid market shape
- document exactly what classes of source trades we will ignore

Done when:
- the strategy is deterministic for the same activity input
- risky or ambiguous source trades are skipped instead of guessed
- tests cover the main allow/deny paths

### Phase 3: Verify Live Trading Plumbing

Objective:
- ensure the wallet and CLOB auth flow work cleanly before real money is involved

Tasks:
- validate `PRIVATE_KEY`, `FUNDER_ADDRESS`, and chain settings
- confirm the client can derive or create API credentials successfully
- verify order creation uses the right token id, price, size, tick size, and risk flags
- confirm live submission errors are logged with enough detail to diagnose quickly
- decide whether we want limit orders only or any market-order helper path

Done when:
- `npm run check` validates the wallet and connectivity path
- a tiny live order can be submitted intentionally with conservative settings
- any failure leaves enough logs to understand what happened

### Phase 4: Add Operational Safety

Objective:
- make the bot safe to run continuously

Tasks:
- improve structured logging for poll cycles, decisions, and submissions
- add backoff and retry rules for transient API issues
- ensure state saves even after partial failures
- protect against noisy replay after crashes or container restarts
- make the preview/live switch impossible to miss in logs
- add a simple kill-switch procedure in the docs

Done when:
- the bot can run unattended in preview for a meaningful soak period
- logs are enough to reconstruct what it saw and why it acted
- restart behavior is predictable

### Phase 5: Expand Testing

Objective:
- make future changes fast and safe

Tasks:
- expand unit tests around strategy edge cases
- add integration-style tests for API response normalization
- add regression tests for duplicate suppression and state recovery
- test malformed or partial API payload handling

Done when:
- the critical execution path has regression coverage
- we can change sizing or filtering logic without blind risk

### Phase 6: Controlled Live Rollout

Objective:
- move from preview to real orders with the least possible blast radius

Tasks:
- follow only one wallet initially
- keep `BUY_ONLY=true`
- use a very low `COPY_RATIO`
- keep `MAX_ORDER_USD` tiny
- watch the first live submissions in real time
- compare live fills against preview expectations

Done when:
- first live trades behave exactly like the preview logic predicted
- no unexpected replay or oversizing occurs
- we are comfortable increasing scope gradually

## Priority Order

If the goal is "asap, but safely", our order should be:

1. prove preview mode correctness
2. tighten strategy behavior
3. verify live auth and order submission
4. add operational hardening
5. expand tests where the risk is highest
6. do the smallest possible live rollout

## Immediate Work Queue

This is the exact order I recommend we follow next:

1. Inspect the current strategy logic and write down the exact copy rules the bot uses today.
2. Run the existing test suite and fix any failures.
3. Run the bot in preview against one real followed wallet and inspect the output.
4. Confirm the Data API payload shape we actually receive matches the assumptions in the code.
5. Tighten any unsafe gaps before we touch live mode.

## Likely Gaps To Check First

These are the places I expect the most real-world issues:

- activity payload fields may not always be present or named exactly as expected
- source trade price may not be the same price we can actually post at
- market lookup by `conditionId` may return edge-case market shapes
- copied order sizing may need rounding or minimum-size handling
- live order placement may need clearer handling for tick size, neg-risk, and auth failures
- some trader activity may not represent a copyable trade event

## Definition Of "Ready For First Real Trade"

We are ready for the first live test only when all of this is true:

- preview output has been reviewed against real source-wallet activity
- duplicate suppression works across restart
- tests are green
- the wallet check passes
- max order size is intentionally tiny
- the followed wallet list has only one address
- we have a clear stop procedure

## Working Rules

- preview mode stays on until we explicitly decide otherwise
- we prefer skipping uncertain trades over making risky guesses
- every live behavior should be reproducible in preview first
- every change should improve observability, not reduce it

## First Step For Our Next Session

Start with the strategy and execution path:

- read `src/strategy.ts`
- read `src/types.ts`
- run the tests
- then run a preview poll against one target wallet

That will tell us very quickly whether we are one tightening pass away from usable preview mode, or whether we need to correct deeper assumptions first.

---

## Weather Strategy

Research completed 2026-04-05. The weather strategy is independent of the copy-bot and lives in `src/weather/`.

### How It Works

We compare ensemble NWP model probability distributions against Polymarket implied odds for daily temperature markets. Markets resolve on a specific airport weather station (not city centre) via Weather Underground — most casual traders don't know this, creating systematic mispricing near bracket boundaries.

Core pipeline: `ensemble.ts` → `brackets.ts` → `ev.ts` → `bet.ts`
Visualisation: `npm run weather:viz -- --city all` → `data/weather_analysis.html` (auto-refreshes hourly via `weather-updater` Docker service at `:9000`)

### Market Liquidity Research — Last 2 Weeks (Mar 20 – Apr 5 2026)

Sourced from Gamma API volume data across all temperature events:

| Rank | City | Station (resolution oracle) | Typical daily vol | Notes |
|------|------|-----------------------------|-------------------|-------|
| 1 | **Seoul** | Incheon Airport RKSI | $400–650K | Highest recurring volume; $641K on Mar 27 |
| 2 | **Tel Aviv** | TBD — needs research | $1.37M peak | One very high vol event Mar 16; likely event-driven spike |
| 3 | **London** | London City Airport EGLC | $200–230K | Highest liquidity ($730K); most stable bid-ask |
| 4 | **Shanghai** | TBD — needs research | $40–430K | High vol Apr 1 ($432K); drops off 2+ days out |
| 5 | **Tokyo** | TBD — needs research | ~$100K | Active; station not yet confirmed |

**Priority cities to add to `src/weather/cities.ts`:** Tel Aviv, Shanghai, Tokyo.
Each requires: confirming the exact WUnderground station slug, bracket structure (min/max °C), and slug prefix from Gamma API.

### Available Weather Data Sources

#### Ensemble NWP Models (via Open-Meteo — free, no key)

| Model | Members | Resolution | Range | Best for |
|-------|---------|-----------|-------|----------|
| ECMWF IFS 0.25° | 51 | 25 km | 15 days | Global baseline — primary model |
| ECMWF AIFS 0.25° | 51 | 25 km | 15 days | AI-based, comparable to IFS |
| NOAA GFS 0.25° | 31 | 25 km | 10 days | Global backup |
| NOAA GFS 0.5° (extended) | 31 | 50 km | 35 days | Long-range prior |
| DWD ICON-EU-EPS | 40 | 13 km | 5 days | Europe (London) |
| DWD ICON-D2-EPS | 20 | 2 km | 2 days | Central Europe ultra-high-res |
| UK Met Office MOGREPS-G | 18 | 20 km | 8 days | Good for London |
| UK Met Office MOGREPS-UK | 3 | 2 km | 5 days | UK only, ultra-high-res |
| Canadian GEM | 21 | 25 km | 16 days | Global |
| Australian BOM ACCESS-GE | 18 | 40 km | 10 days | Global |
| KMA LDPS (via Open-Meteo) | 1 (det.) | 1.5 km | 2 days | Korea — best near-term for Seoul |
| JMA MSM | 1 (det.) | 5 km | 4 days | Japan/Korea |

**Current implementation uses:** ECMWF IFS (primary) + KMA LDPS for Seoul, Met Office for London.
**Next step:** add DWD ICON-EU for London (40-member, 13km — better than MOGREPS for medium range).

#### Historical / Calibration Sources

| Source | What it gives | Access |
|--------|--------------|--------|
| Open-Meteo ERA5 archive | Daily max temps 1940–present at any coords | Free, used for anomaly calc |
| NOAA GHCN-D | 100K+ global stations, daily max/min, up to 175 years | Free via AWS or CDO |
| NASA GISTEMP v4 | Monthly anomaly vs 1951–1980 baseline, 2°×2° grid | Free CSV download |
| WUnderground RKSI/EGLC history | Ground truth — exact values Polymarket resolves on | Web scrape |

**Critical use:** Scrape 2+ years of WUnderground actuals for each resolution station, compare against ERA5/ECMWF hindcasts at the same coordinates → measure systematic model bias → apply as `--bias` correction.

#### AI / ML Weather Models

| Model | Developer | Resolution | Notes |
|-------|-----------|-----------|-------|
| GraphCast | Google DeepMind | 0.25° | Open source; outperforms ECMWF on 90% of targets; 10-day global |
| FourCastNet v2 | NVIDIA | 0.25° | Open source; available via ECMWF public charts |
| Pangu-Weather | Huawei | 0.25° | Open source; 3D transformer, 39-year training set |
| Aurora | Microsoft | 0.1° | Highest resolution AI model; not yet fully public |

ECMWF now publishes daily GraphCast and FourCastNet forecasts publicly. These can be a second opinion alongside IFS ensemble — if GraphCast and IFS agree on a bracket, confidence is higher.

### Edge Framework

Three compounding edges identified:

1. **Station mismatch** — Market resolves on airport station, not city centre. Incheon (RKSI) runs 1–3°C cooler than Seoul in spring/summer. London City (EGLC) differs from Heathrow and city centre. Most traders use city weather apps.
2. **Distribution vs point forecast** — We use 51+ ensemble members to build a probability distribution per bracket. Market makers likely use a single model point forecast.
3. **Seasonal anomaly prior** — ERA5 anomaly vs 1991–2020 normal tells us if the season is running warm or cold. Current reading: +4.53°C for Seoul March 2026, +2.10°C for London.

### Arbitrage

Neg-risk markets allow true arb when sum of YES prices deviates meaningfully from 1.0:
- **Sum < 1**: Buy YES every bracket → guaranteed $1 payout at < $1 cost
- **Sum > 1**: Buy NO every bracket → guaranteed payout exceeds cost

The detector in `ev.ts` requires >2¢ net profit after 1% taker fees with all brackets present. The Gamma API returns stale midpoint prices — always verify on the live CLOB before executing. Real arb opportunities will be rare and short-lived on liquid markets.

### Forward Test Plan — Apr 5 to Apr 19 2026 (2 weeks)

**Objective:** Determine if the ECMWF ensemble + quarter-Kelly sizing generates positive expected returns in real market conditions before committing live capital.

**Method:** Preview mode only. Record every BUY signal the bot would have placed, then compare against actual resolution outcomes.

**Cities in scope:** 20-city Celsius universe shared across `visualize.ts`, `forwardtest.ts`, and `cities.ts`.

Core 5:
- Seoul
- London
- Tel Aviv
- Shanghai
- Tokyo

Wave 1 additions:
- Hong Kong
- Paris
- Milan
- Buenos Aires
- Toronto
- Wellington
- Shenzhen
- Beijing

Wave 2 additions:
- Singapore
- Mexico City
- Madrid
- Munich
- Jakarta
- Kuala Lumpur
- Busan

**Parameters (frozen for the test period):**
```
KELLY_SCALE       = 0.25   (quarter-Kelly)
MIN_KELLY         = 0.03   (3% minimum)
MIN_EV_PER_DOLLAR = 0.04   (4¢/$ minimum)
MAX_POSITION_USD  = 100    (hard cap)
Bankroll assumed  = $1,000
Bias correction   = 0 (will measure actual bias during the test)
```

**What to track per trade:**
- Date, city, bracket
- Model probability (Q), market price (P)
- Edge (Q−P), EV, Kelly fraction, suggested size
- Actual resolution outcome (did it resolve YES or NO?)
- Hypothetical P&L: if YES → profit = size × (1/P − 1); if NO → loss = −size

**Daily routine:**
1. `npm run weather:viz -- --city all --days 7` (auto via hourly updater)
2. Manually record all BUY signals from the dashboard into `data/forward_test_log.csv`
3. Check previous day's resolutions on WUnderground, update P&L column

**Success criteria for going live:**
- At least 20 closed BUY signals
- Cumulative hypothetical P&L > 0
- Model calibration: among all brackets where Q = 60–70%, actual resolution rate = 55–75%
- No systematic over/under-estimation in a specific temperature range

**Failure criteria — pause and reassess:**
- Cumulative P&L < −$300 hypothetical (30% drawdown on $1K bankroll)
- Model consistently wrong on a specific city or season direction
- Fewer than 5 BUY signals generated (model agrees with market too often — no edge)

**After the test:**
- Compute actual vs predicted win rates per bracket
- Compute implied bias correction per city (mean error of ECMWF vs WUnderground actuals)
- Decide whether to go live, adjust parameters, or add more data sources

### Next Engineering Tasks

Priority order:

1. **Finish calibration for the 15 new cities** — scrape and align WUnderground history so post-processors can move beyond the original core set
2. **Add a market discovery / refresh script** — automatically detect new Celsius weather cities and keep the portal universe current
3. **Deepen Europe overlays** — continue improving ICON-EU / regional weighting for Paris, Milan, Madrid, and Munich
4. **Add NOAA GHCN-D station lookup** — cross-reference resolution station IDs to get the exact long-run climatology
5. **Explore GraphCast forecasts** — ECMWF publishes daily; if accessible via API, use as a third model vote alongside IFS ensemble and KMA/ICON
6. **Evaluate Fahrenheit support separately** — current code is Celsius-only, so US weather cities remain out of scope for this rollout

### Working Rules (Weather Strategy)

- Never trade a bracket where the market has < $1K liquidity — fill price will be far from midpoint
- Never size above `MAX_POSITION_USD` regardless of Kelly — model errors compound at full Kelly
- Always use the resolution station coordinates (airport), never city centre
- Arb signals from Gamma API require live CLOB verification before execution
- Forward test runs from Apr 5–19 2026; do not go live until success criteria are met
