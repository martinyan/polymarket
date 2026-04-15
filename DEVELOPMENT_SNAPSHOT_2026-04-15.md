# Development Snapshot

Saved: 2026-04-15 UTC

## Repo Status

- Test suite is green: `6/6` passing via `npm test`.
- The repo contains two parallel tracks:
  - a preview-first Polymarket copy-trading bot in `src/`
  - a much larger weather-market research/execution system in `src/weather/`
- The working tree is dirty right now, mostly from active weather-strategy work and a few supporting config/docs edits.

## What Exists Today

### 1. Base copy-trading bot

Core files:
- `src/index.ts`
- `src/bot.ts`
- `src/strategy.ts`
- `src/polymarket.ts`
- `src/activity.ts`
- `src/check.ts`
- `src/config.ts`
- `src/state.ts`

Implemented behavior:
- Loads env config with validation through `zod`
- Defaults to preview mode and blocks live mode unless `PRIVATE_KEY` and `FUNDER_ADDRESS` are set
- Polls one or more followed wallets from Polymarket Data API
- Normalizes and de-duplicates activity
- Fetches market metadata from Gamma by `conditionId`
- Applies copy filters:
  - must have asset token id
  - must have condition id
  - buy-only mode support
  - market condition consistency check
  - market token id consistency check
  - blocked slug filter
  - allowed tags filter
  - allowed event keyword filter
  - order-book enabled check
  - price must be between `0` and `1`
  - copy order must be above configured minimum USD
- Sizes copied trades using:
  - `COPY_RATIO`
  - `MIN_ORDER_USD`
  - `MAX_ORDER_USD`
- In preview mode, logs the order it would place
- In live mode, submits BUY limit orders through the Polymarket CLOB client
- Persists seen activity ids to local state so repeated polls do not replay the same trade

Operational helpers:
- `npm run check` verifies reachability of Gamma, Data API, and CLOB, and inspects a sample activity/decision path
- `npm run preview:once` exists for a single preview-style run path

Current maturity:
- This part looks like a functioning scaffold with tests and guardrails
- It is still simpler and smaller than the weather side of the repo

### 2. Weather strategy system

Core weather modules:
- `src/weather/analyze.ts`
- `src/weather/bet.ts`
- `src/weather/forwardtest.ts`
- `src/weather/retro_backtest.ts`
- `src/weather/snapshot.ts`
- `src/weather/snapshot_analyze.ts`
- `src/weather/ensemble.ts`
- `src/weather/brackets.ts`
- `src/weather/ev.ts`
- `src/weather/polymarket_odds.ts`
- `src/weather/aviation.ts`
- `src/weather/postprocess.ts`
- `src/weather/train_postprocess.ts`
- `src/weather/time.ts`
- `src/weather/cities.ts`

Implemented behavior:
- Fetches weather forecast inputs from ensemble sources
- Converts forecast distributions into temperature-bracket probabilities
- Pulls live Polymarket weather market odds and bracket token metadata
- Computes edge, EV, and Kelly-style position sizing
- Applies station-aware calibration and post-processing
- Uses METAR data to impose observed-temperature floors
- Uses TAF data as a risk overlay that can reduce sizing
- Supports city-specific configs and station mapping
- Can generate live analysis output, preview bets, forward tests, retrospective backtests, and recurring snapshots
- Stores snapshot history so strategy research can rely on the repo's own captured dataset later

Execution flow that now exists:
- `analyze.ts` is the research/diagnostic CLI
- `bet.ts` is the execution-oriented runner with preview/live gating
- `forwardtest.ts` logs signals, resolves them later, and tracks P&L in CSV
- `retro_backtest.ts` compares single-bracket vs two-bracket basket decisions on resolved markets
- `snapshot.ts` records time-stamped model probabilities, market prices, and recommendations into local files

Current maturity:
- The weather track is now the most developed part of the repository
- It has its own tests, data capture, calibration, and multiple evaluation modes
- Recent commit history strongly suggests this has been the main active development focus

## Scripts Available

- `npm run check`
- `npm run preview:once`
- `npm run backtest`
- `npm run weather`
- `npm run weather:train`
- `npm run weather:viz`
- `npm run weather:bet`
- `npm run weather:fwdtest`
- `npm run weather:retro`
- `npm run weather:snapshot`
- `npm run weather:snapshot:analyze`

## Recent Development Direction

Recent commits show the project has shifted from a generic copy bot toward an operational weather-trading workflow:

- `6f4c7a0` weather trade for 5 cities logged; forward test for 2 weeks confirmed
- `c0f9780` visual portal/countdown and rolling 2-week forward testing wired in
- `23148a6` audit log fixes
- `c094bec` fixes for trade amount problems

Uncommitted files also point the same way:
- new `aviation`, `postprocess`, `retro_backtest`, `snapshot`, `snapshot_analyze`, `time`, and `train_postprocess` modules
- edits in weather analysis, betting, city config, EV, visualization, and forward-testing files

## What Feels Stable

- Environment/config validation
- Preview-first safety model
- Activity de-duplication and persisted state
- Core copy-decision rules
- Weather EV and calibration test coverage
- Forward-test and snapshot machinery for weather research

## What Is Still In Motion

- The weather subsystem is actively changing right now
- `PLAN.md` is behind the real repo state; it still describes the weather strategy as research-added, but the codebase now includes execution, forward testing, retro backtesting, and snapshot capture
- The copy-bot README is directionally accurate for the base bot, but it does not capture how much development has moved into the weather system

## Best Resume Point For A Future Session

If resuming development later, start here:

1. Read this file first.
2. Re-check working tree changes with `git status --short`.
3. Run `npm test`.
4. Decide which track is the priority:
   - copy bot hardening
   - weather strategy research
   - weather strategy live execution/risk controls
5. If weather is the focus, read in this order:
   - `src/weather/cities.ts`
   - `src/weather/ev.ts`
   - `src/weather/analyze.ts`
   - `src/weather/bet.ts`
   - `src/weather/forwardtest.ts`
   - `src/weather/postprocess.ts`
6. If copy-bot work resumes, read in this order:
   - `src/config.ts`
   - `src/activity.ts`
   - `src/strategy.ts`
   - `src/bot.ts`
   - `src/polymarket.ts`
   - `src/check.ts`

## Suggested Next Decisions

- Decide whether the repo's primary goal is now:
  - a general copy-trading bot
  - a dedicated weather trading system
  - or both, but with clearer separation
- If weather is primary, update `README.md` and `PLAN.md` so they match current reality
- If both tracks remain active, consider separating them into clearer top-level docs and data directories
