# Trading Strategy Improvement Roadmap

Based on analysis of the current codebase and research into successful Polymarket weather traders ColdMath and Maskache2. Date: 2026-04-18.

---

## Priority 1 — Station Bias Verification (NEXT PROJECT)

**What:** Verify and fix systematic temperature bias caused by resolution station microclimate vs. NWP model gridpoint.

**Why:** Polymarket resolves each city market on a specific airport METAR station (e.g. RKSI = Incheon International for Seoul), not the city center. NWP models output for the city centroid. Airport stations have coastal exposure, no urban heat island, different elevation — creating a consistent offset of 1–3°C that market prices do not reflect. Maskache2's $36k+ profit is largely attributed to exploiting this gap in Seoul.

**Known station mismatches to investigate:**
| City | Resolution Station | Known Bias |
|------|--------------------|------------|
| Seoul | RKSI (Incheon Airport) | Coastal, cooler than city center |
| Shanghai | ZSPD (Pudong Airport) | Near Yangtze estuary, sea-breeze cooling |
| NYC | KLGA (LaGuardia) | Differs from KJFK and city center |
| Tokyo | RJTT (Haneda) | Coastal, different from JMA city station |

**Steps:**
1. Pull historical METAR records for each resolution station from Iowa State IEM (`mesonet.agron.iastate.edu`)
2. Pull historical NWP ensemble output at city-center gridpoint for the same dates
3. Compute monthly offset: `bias[city][month] = mean(METAR_obs - ensemble_forecast)`
4. Bake bias term into `src/weather/postprocess.ts` as a fixed per-city per-month correction before probability calculation
5. Verify: check that `src/weather/cities.ts` `stationCode` field matches the actual Polymarket resolution oracle for each city

**Files to change:** `src/weather/postprocess.ts`, `src/weather/cities.ts`

---

## Priority 2 — Ensemble Spread Gate (NEXT PROJECT)

**What:** Add ensemble member spread (stddev) as a signal quality filter before sizing Kelly bets.

**Why:** Current code in `src/weather/ev.ts` uses only ensemble mean probability. A bimodal ensemble (25 members @ 12°C, 26 members @ 22°C) appears as a confident 17°C forecast but is actually high-uncertainty. This causes the bot to size bets normally on what are effectively coin-flip forecasts.

**Logic:**
```
ensembleSpread = stddev(memberTemps)

if spread > 6°C  → SKIP (do not bet)
if spread > 4°C  → reduce KELLY_SCALE: 0.25 → 0.10
if spread ≤ 4°C  → normal sizing
```

**Steps:**
1. Compute `ensembleSpread` in `src/weather/brackets.ts` alongside existing probability calculation
2. Pass spread into `src/weather/ev.ts` `calcKelly()` function
3. Add spread-based Kelly multiplier lookup
4. Add `ensemble_spread` column to forward test CSV (`LogEntry` type) for tracking
5. Add unit test: bimodal ensemble should produce reduced or zero sizing

**Files to change:** `src/weather/brackets.ts`, `src/weather/ev.ts`, `src/weather/forwardtest.ts`

---

## Priority 3 — Post Model Run Timing Trigger

**What:** Trigger market scans within 5 minutes of ECMWF/GFS model run publication rather than on a fixed 30-minute cycle.

**Why:** Market prices lag model updates. ECMWF publishes at 00Z and 12Z; GFS at 00Z, 06Z, 12Z, 18Z. The window to extract edge before the crowd reprices is 30–60 minutes for liquid markets, longer for niche cities (Seoul, Buenos Aires). The current 30-min docker-compose cycle may miss the post-publication window entirely.

**Steps:**
1. Add a model publication schedule to `src/weather/forward_policy.ts`
2. In `docker-compose.yml` weather-updater, switch from fixed 30-min sleep to a scheduler that aligns with 00Z/06Z/12Z/18Z + 10 min buffer
3. Log which model run triggered each snapshot for audit trail

**Files to change:** `docker-compose.yml`, `src/weather/forward_policy.ts`

---

## Priority 4 — Calibration Feedback Loop (Brier Score Tracking)

**What:** After each market resolves, compare `model_prob` vs actual binary outcome and track Brier score per city.

**Why:** Currently there is no feedback loop — if ECMWF runs systematically warm in Tokyo in spring, Kelly bets will be wrong-sized indefinitely. A Brier score monitor detects degrading calibration and can automatically reduce Kelly multiplier for that city.

**Logic:**
```
brier[city] = mean((model_prob - outcome)²) over last 30 resolved markets
if brier[city] > 0.30  → reduce Kelly multiplier to 0.10 for that city
if brier[city] > 0.40  → SKIP that city until manual review
```

**Steps:**
1. Add `outcome` field to resolved `LogEntry` rows (already partially tracked via `resolved_at`)
2. Build `src/weather/calibration.ts` module to compute rolling Brier score per city
3. Load calibration adjustments in `src/weather/ev.ts` before Kelly calculation
4. Expose per-city Brier scores in the `weather_analysis.html` visualization

**Files to change:** `src/weather/ev.ts`, `src/weather/forwardtest.ts`, new `src/weather/calibration.ts`

---

## Priority 5 — "No" Trade Path

**What:** Evaluate and log "No" trades when the market overprices a bracket (i.e. `market_price_yes` is too high relative to model probability).

**Why:** Gopfan2 made $2M+ almost entirely buying "No" on overpriced brackets. The current bot only bets YES. The EV calculation is symmetric — a mispriced NO is an identical edge opportunity.

**Logic:**
```
no_edge = (1 - P) - (1 - Q) = Q - P  (same as yes_edge, opposite direction)
no_ev_per_dollar = (1 - Q) / (1 - P) - 1
```
If `no_ev_per_dollar > MIN_EV_PER_DOLLAR`, log a NO trade.

**Steps:**
1. Add `tradeDirection: 'YES' | 'NO'` to `LogEntry` type in `src/weather/forwardtest.ts`
2. Extend `calcKelly()` in `src/weather/ev.ts` to evaluate both sides and return the better direction
3. Update CSV parser for backward compatibility with old rows (default to 'YES')
4. Confirm Polymarket CLOB client supports limit NO orders (it does via `side: 'NO'` in `@polymarket/clob-client`)

**Files to change:** `src/weather/ev.ts`, `src/weather/forwardtest.ts`

---

## Priority 6 — Near-Certainty Grind Mode (ColdMath Leg 1)

**What:** Add a separate high-probability, low-edge trading path for brackets priced 94–99¢ where the bot acts as a passive market maker.

**Why:** ColdMath's primary income source is parking capital in near-certain outcomes and collecting 1–2% yield per resolved market. The current `MIN_EV_PER_DOLLAR = 0.04` gate filters these out. A separate grind path with different sizing rules (larger position, no Kelly, flat $ per market) would extract this yield.

**Logic:**
```
if model_prob > 0.96 AND market_price > 0.94:
    grind_bet_usd = min(500, 0.05 * bankroll)  // flat sizing, not Kelly
    log with type: 'GRIND'
```

**Steps:**
1. Add `tradeType: 'KELLY' | 'GRIND'` to `LogEntry`
2. Add grind path in `src/weather/ev.ts` alongside existing Kelly path
3. Separate P&L tracking for grind vs Kelly trades in visualization

**Files to change:** `src/weather/ev.ts`, `src/weather/forwardtest.ts`, `src/weather/visualize.ts`

---

## Reference: Key Trader Profiles

| Trader | Profit | Win Rate | Core Edge |
|--------|--------|----------|-----------|
| ColdMath | ~$110k | High (grind) + low (snipes) | Market microstructure barbell, not forecasting |
| Maskache2 | ~$36k | 30% | Seoul RKSI station microclimate gap, asymmetric sizing |
| gopfan2 | $2M+ | Very high | Buying "No" on overpriced near-certainties |
| BeefSlayer | $49k | 67% | US city specialist, concentrated sizing |
| neobrother | $20k+ | N/A | Temperature laddering — dense limit orders across adjacent brackets |
