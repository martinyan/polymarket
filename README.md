# Clean Polymarket Copy Bot

This is a preview-first Polymarket copy-trading bot scaffolded from scratch with a narrow dependency set and conservative live-trading defaults.

## Safety model

- Uses only Polymarket-hosted endpoints plus the official TypeScript CLOB client
- Defaults to `PREVIEW_MODE=true`
- Persists only a small local state file with processed activity IDs
- Retries transient poll failures without losing already-processed state
- Starts with conservative copy sizing for first live rollout

## Current behavior

- Polls selected trader activity from the public Data API
- Enriches markets from the public Gamma API
- Filters trades by strategy and safety rules
- Reuses the same `.env` keyword filter for live trading and backtesting
- Emits structured JSON logs for preview, skip, error, and live-order events
- In preview mode: logs the exact copy order it would place
- In live mode: places BUY-side limit orders using the official CLOB client

## Supported safety checks

- Missing asset token id
- Missing condition id
- SELL activity when `BUY_ONLY=true`
- Gamma market condition mismatch
- Gamma market token mismatch when token ids are available
- Disabled order book
- Invalid price
- Disallowed tags
- Blocked market slugs
- Order below configured minimum

## Setup

1. Copy `.env.example` to `.env`.
2. Fill in:
   - `USER_ADDRESSES`
   - `PRIVATE_KEY`
   - `FUNDER_ADDRESS`
3. Keep `PREVIEW_MODE=true` for the first run.
4. If you want to follow multiple traders, set `USER_ADDRESSES` as a comma-separated list.
5. If you want to copy only selected events, set `ALLOWED_EVENT_KEYWORDS` to comma-separated keywords such as `temperature`.
4. Build the image:

```bash
docker compose build
```

## Verification checklist

Run the connectivity and wallet validation check:

```bash
docker compose run --rm bot npm run check
```

Then start the bot in preview:

```bash
docker compose up
```

Review logs and confirm:

- the followed wallet returns real trade activity
- each fresh trade appears once
- repeated polls do not re-log already-seen activity
- skipped trades include a clear `reason`
- preview orders include `slug`, `tokenId`, `conditionId`, `price`, `orderUsd`, and `orderSize`

## Live rollout checklist

Before changing `PREVIEW_MODE=false`:

- keep `BUY_ONLY=true`
- keep `COPY_RATIO` small
- keep `MAX_ORDER_USD` low for first live orders
- validate the wallet config with `npm run check`
- start with one followed wallet only

For the first live rollout:

1. Set `PREVIEW_MODE=false`.
2. Restart the bot.
3. Watch logs for `live_order_submission` and `Live order submitted`.
4. Confirm the response payload is present.
5. If behavior is not what you expect, stop the bot and switch back to preview mode.

## State and rollback

- State is stored at `STATE_PATH` and contains processed activity ids.
- Preserve the state file when restarting normally so old activity is not replayed.
- Remove the state file only when you intentionally want to replay historical activity for testing.
- If the bot misbehaves in live mode, stop the container and set `PREVIEW_MODE=true` before restarting.

## Development

Run tests:

```bash
docker compose run --rm bot npm test
```

## Notes

- Official docs used for this build:
  - Quickstart: https://docs.polymarket.com/quickstart
  - API overview: https://docs.polymarket.com/api-reference/introduction
  - Market data overview: https://docs.polymarket.com/market-data/overview

## Filtering examples

- Follow multiple wallets:
  - `USER_ADDRESSES=0xabc...,0xdef...,0x123...`
- Only copy events whose title or slug contains "temperature":
  - `ALLOWED_EVENT_KEYWORDS=temperature`
- Only copy events matching either of several keywords:
  - `ALLOWED_EVENT_KEYWORDS=temperature,climate,weather`
- Leave `ALLOWED_EVENT_KEYWORDS` blank to disable keyword filtering:
  - `ALLOWED_EVENT_KEYWORDS=`
