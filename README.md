# Clean Polymarket Weather Bot

This repository is now a weather-market research and execution stack on a smart contract platform.

The codebase focuses on daily high-temperature markets across multiple cities, using ensemble forecasts, market odds, forward-test logging, and a live portal to monitor trade eligibility, audit past signals, and track bankroll behavior.

## What The Bot Does

- fetches ECMWF ensemble weather forecasts for tracked cities
- optionally blends in a secondary forecast model for some markets
- applies station-level post-processing and live aviation overlays
- reads live Polymarket weather odds
- computes bracket probabilities, edge, EV, Kelly sizing, and basket alternatives
- logs forward-test trades into `data/forward_test_log.csv`
- rebuilds a portal at `data/weather_analysis.html`
- stores fresh market/model snapshots in `data/weather_snapshot_latest.json`

## Current Strategy

The active strategy is a weather-only forward-test system built around one unresolved position per `city + market_date`.

It is designed to:

- prefer normal threshold-passing trades
- enter earlier than before, but not too early
- preserve continuity when upstream weather APIs fail
- force at least one logged trade per market only as a last resort

The detailed forward-test audit logic is documented in [FORWARD_TEST_LOGIC.md](FORWARD_TEST_LOGIC.md).

## Forecast Inputs

Normal trade evaluation is built from:

- ECMWF ensemble forecast
- optional secondary model blend
- station post-processing / MOS-style calibration
- live METAR observed temperature floor
- optional TAF risk overlay
- live Polymarket market odds

## Bet Timeframe

The strategy uses two time windows per market:

- `T-18` to market close:
  normal threshold-passing trades are allowed
- `T-8` to market close:
  forced continuity fallback becomes allowed if no normal trade survives

Definitions:

- `T-18` means 18 hours before the local market close for that city/date
- `T-8` means 8 hours before the local market close for that city/date
- market close is the end of that calendar day in the city’s local timezone

## Bet Selection Logic

Inside an eligible window, the bot:

1. converts forecast temperatures into bracket probabilities
2. compares model probability against live Polymarket ask prices
3. computes edge, EV per dollar, and Kelly fraction
4. applies single-market correlation filtering so only the best bracket remains actionable
5. optionally replaces the best single with a 2-bracket basket if basket log-growth is better

## Normal Bet Gates

For a normal trade to qualify, the relevant bracket must pass all of these gates:

- live executable market price must exist
- market price must be greater than `0`
- market price must be at least `5¢`
- model edge must be positive
- Kelly fraction must exceed the configured minimum
- EV per dollar must exceed the configured minimum
- after correlation filtering, only the highest-Kelly bracket remains actionable

Sizing rules:

- quarter-Kelly sizing is used
- current bankroll is the sizing base
- basket trades are only used if they improve expected log growth over the best single

## Forced Continuity Fallback

If a market is inside `T-8` and no normal trade survives the gates, the bot still logs one trade for that market.

Last-resort bracket selection:

- choose the bracket with the highest `modelProb`
- require executable `marketPrice > 0`
- break ties by higher edge, then lower price

Forced sizing:

- use the normal `suggestedUsd` if positive
- otherwise use `$1`
- always cap by available forward-test bankroll

This path intentionally ignores the normal Kelly / EV / minimum-size gates and exists to avoid forward-test interruptions.

## Snapshot Fallback

If live ensemble fetches fail, the forward-test logger can fall back to `data/weather_snapshot_latest.json`.

Fallback order:

1. use the best normal `BUY` from the latest fresh snapshot if one exists
2. otherwise use the same forced highest-model-probability rule, but only once the market has reached `T-8`

Snapshot-driven trades are marked in the CSV audit notes.

## Bankroll Model

Forward-test bankroll is derived from `data/forward_test_log.csv`.

Formula:

- start at `$1000`
- add realized `pnl` from resolved trades
- subtract `suggested_usd` from unresolved trades as open risk

Only one unresolved trade may exist per `city + market_date`.

## Portal And Data Artifacts

Main generated artifacts:

- `data/weather_analysis.html`
  multi-city portal with model vs market, EV/Kelly table, trade eligibility, and audit log
- `data/weather_snapshot_latest.json`
  latest model/market snapshot cache
- `data/weather_snapshot_history.jsonl`
  append-only snapshot history
- `data/forward_test_log.csv`
  forward-test trade log, bankroll source, and audit trail

The portal currently defaults to a lighter `2`-day forecast view to reduce upstream load and rate-limit pressure.

## Automation Loop

The `weather-updater` container runs a recurring cycle:

1. `weather:snapshot --days 2`
2. `weather:fwdtest all --city all`
3. `weather:viz --city all --days 2`
4. `weather:health`

The cycle currently sleeps for `30` minutes between runs.

## Setup

1. Copy `.env.example` to `.env`.
2. Fill in the required wallet and Polymarket configuration.
3. Keep `PREVIEW_MODE=true` for dry runs unless you explicitly want live orders.
4. Build the containers:

```bash
docker compose build
```

## Common Commands

Run tests:

```bash
npm test
```

Build TypeScript:

```bash
npm run build
```

Generate latest snapshot cache:

```bash
npm run weather:snapshot -- --days 2
```

Run forward test manually:

```bash
npm run weather:fwdtest -- all --city all
```

Rebuild the portal:

```bash
npm run weather:viz -- --city all --days 2
```

Start the full stack:

```bash
docker compose up -d
```

## Verification Checklist

When validating a strategy or deployment, confirm:

- snapshot files refresh successfully
- the portal rebuilds without stale dates
- forward-test log rows include the expected notes and order status
- market cards show the correct eligibility state for the current time window
- duplicate protection prevents more than one unresolved trade per `city + market_date`
- bankroll changes match resolved P&L and open risk

## Important Strategy References

- [FORWARD_TEST_LOGIC.md](FORWARD_TEST_LOGIC.md)
- [src/weather/forwardtest.ts](/docker/polymarket/src/weather/forwardtest.ts:1)
- [src/weather/visualize.ts](/docker/polymarket/src/weather/visualize.ts:1)
- [src/weather/snapshot.ts](/docker/polymarket/src/weather/snapshot.ts:1)
- [src/weather/ev.ts](/docker/polymarket/src/weather/ev.ts:1)
