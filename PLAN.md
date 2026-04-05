# Polymarket Copy Bot Plan

Last updated: 2026-04-05 UTC

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
