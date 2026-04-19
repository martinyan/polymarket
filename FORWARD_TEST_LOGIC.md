# Forward Test Logic

This document describes the current behavior of the weather forward-test system implemented in `src/weather/forwardtest.ts`.

## Summary

The forward test logs at most one unresolved trade per `city + market_date`.

Normal threshold-passing trades may open inside the final `18` hours before the market closes in that city's local timezone.

The forced continuity fallback is held back until the final `8` hours before close.

It prefers the normal filtered trade logic, but it now has continuity fallbacks:

1. normal best-Kelly trade
2. snapshot-backed fallback trade if live forecast fetch fails
3. forced highest-model-probability trade if no normal trade survives the gates

## Bankroll

Forward-test bankroll is derived from `data/forward_test_log.csv`.

Formula:

- start from `$1000`
- add realized `pnl` from resolved trades
- subtract `suggested_usd` from unresolved trades as open risk

If the log is cleared back to its header row, the derived bankroll resets to `$1000`.

## Trade Window

For each city/date market:

- `tradeWindowOpenUtc = cityDayEndUtcMs(date, timezone) - 18h`
- `forcedFallbackWindowOpenUtc = cityDayEndUtcMs(date, timezone) - 8h`
- `tradeWindowCloseUtc = cityDayEndUtcMs(date, timezone)`

The logger:

- skips the market if current time is before the `T-18` normal window
- skips the market if current time is after the local day end
- logs normal threshold-passing trades inside the `T-18` to close window
- only allows forced continuity trades inside the final `T-8` window

## Normal Trade Logic

Within an open window, the logger builds signals from:

- ECMWF ensemble forecast
- optional secondary model blend for some cities
- station post-processing
- live METAR temperature floor
- optional TAF risk overlay
- live Polymarket weather odds

Then it applies the standard weather EV/Kelly filters from `src/weather/ev.ts`:

- market price must exist
- market price must be above `0`
- market price must be at least `5¢`
- edge must be positive
- Kelly must meet the minimum threshold
- EV per dollar must meet the minimum threshold
- only the highest-Kelly bracket in a market remains actionable after single-market correlation filtering

If at least one normal `BUY` survives:

- the highest-Kelly bracket is chosen
- a 2-bracket basket may replace it only if it improves expected log growth

## Forced Trade Policy

If a market is already inside the final `T-8` fallback window and no bracket survives the normal gates, the forward test still logs one trade for that market.

Last-resort selection rule:

- choose the bracket with the highest `modelProb`
- require an executable `marketPrice > 0`
- break ties by higher edge, then lower price

This forced path intentionally ignores the normal Kelly / EV / minimum-size gating.

### Forced Trade Size

Forced trade size is:

- the normal `suggestedUsd` if it is already positive
- otherwise `$1`
- always capped by available forward-test bankroll

## Snapshot Fallback

If live forecast fetch fails, the logger can fall back to `data/weather_snapshot_latest.json`.

Fallback order:

1. use the best normal `BUY` from the fresh snapshot if one exists
2. otherwise use the same forced highest-model-probability rule on snapshot signals, but only once the market has reached `T-8`

Snapshot-fallback trades are marked in `notes` and `order_status`.

## Duplicate Protection

Only one unresolved trade may exist for a given `city + market_date`.

If one is already open, no additional trade is logged for that event.

## Audit Markers In The CSV

The forward-test log stores both execution state and selection rationale.

Important fields:

- `suggested_usd`: capital treated as at risk while unresolved
- `order_status`: preview / placed / skipped / forced / fallback state
- `resolved`: whether the trade has been closed
- `pnl`: realized profit/loss after resolution
- `notes`: audit trail for why the trade was taken

Common markers in `notes`:

- `forced_market_trade=highest_model_prob`
- `snapshot_fallback=latest`
- `snapshot_generated_at=...`
- `live_fetch_error=...`
- `normal_window_open=...`
- `forced_window_open=...`
- `captured_in_normal_18h_window`
- `captured_in_forced_8h_window`
- `bankroll=...`

## Current Intent

The current system favors continuity first, but keeps the trade source legible in the log:

- normal trade if available
- snapshot fallback if live fetch breaks
- forced trade as last resort

That means future analysis can separate:

- normal threshold-passing trades
- forced continuity trades
- snapshot-driven fallback trades
