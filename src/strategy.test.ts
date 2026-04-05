import test from 'node:test';
import assert from 'node:assert/strict';
import { ENV } from './config';
import { decideCopy } from './strategy';
import { GammaMarket, TraderActivity } from './types';

function withEnv<T>(overrides: Partial<typeof ENV>, fn: () => T): T {
  const previous = {
    BUY_ONLY: ENV.BUY_ONLY,
    MAX_ORDER_USD: ENV.MAX_ORDER_USD,
    MIN_ORDER_USD: ENV.MIN_ORDER_USD,
    COPY_RATIO: ENV.COPY_RATIO,
    ALLOWED_TAGS: [...ENV.ALLOWED_TAGS],
    ALLOWED_EVENT_KEYWORDS: [...ENV.ALLOWED_EVENT_KEYWORDS],
    BLOCKED_SLUGS: [...ENV.BLOCKED_SLUGS]
  };

  Object.assign(ENV, overrides);

  try {
    return fn();
  } finally {
    Object.assign(ENV, previous);
  }
}

function buildActivity(overrides: Partial<TraderActivity> = {}): TraderActivity {
  return {
    id: 'activity-1',
    user: '0xtrader',
    side: 'BUY',
    asset: 'token-yes',
    price: '0.42',
    usdcSize: '100',
    conditionId: 'condition-1',
    marketSlug: 'will-it-rain',
    ...overrides
  };
}

function buildMarket(overrides: Partial<GammaMarket> = {}): GammaMarket {
  return {
    conditionId: 'condition-1',
    slug: 'will-it-rain',
    enableOrderBook: true,
    clobTokenIds: ['token-yes', 'token-no'],
    tags: [{ slug: 'weather' }],
    ...overrides
  };
}

test('allows a valid buy trade', () => {
  const decision = withEnv(
    {
      BUY_ONLY: true,
      COPY_RATIO: 0.02,
      MAX_ORDER_USD: 5,
      MIN_ORDER_USD: 1,
      ALLOWED_TAGS: [],
      ALLOWED_EVENT_KEYWORDS: [],
      BLOCKED_SLUGS: []
    },
    () => decideCopy(buildActivity(), buildMarket())
  );

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'eligible');
  assert.equal(decision.orderUsd, 2);
  assert.equal(decision.tokenId, 'token-yes');
  assert.equal(decision.conditionId, 'condition-1');
});

test('rejects sell activity when buy-only mode is enabled', () => {
  const decision = withEnv({ BUY_ONLY: true }, () => decideCopy(buildActivity({ side: 'SELL' }), buildMarket()));
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'buy-only mode enabled');
});

test('rejects blocked slugs', () => {
  const decision = withEnv({ BLOCKED_SLUGS: ['will-it-rain'] }, () => decideCopy(buildActivity(), buildMarket()));
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'market slug blocked by config');
});

test('rejects invalid prices', () => {
  const decision = withEnv({}, () => decideCopy(buildActivity({ price: '1' }), buildMarket()));
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'activity price outside expected range');
});

test('rejects orders below the minimum configured usd', () => {
  const decision = withEnv(
    { COPY_RATIO: 0.01, MIN_ORDER_USD: 2, MAX_ORDER_USD: 5 },
    () => decideCopy(buildActivity({ usdcSize: '50' }), buildMarket())
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'order below minimum configured usd');
});

test('rejects disallowed tags', () => {
  const decision = withEnv({ ALLOWED_TAGS: ['politics'] }, () => decideCopy(buildActivity(), buildMarket()));
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'market tags not allowed');
});

test('allows matching event keywords', () => {
  const decision = withEnv(
    { ALLOWED_EVENT_KEYWORDS: ['temperature'] },
    () =>
      decideCopy(
        buildActivity({
          title: 'Will the global temperature anomaly exceed 1.5C this month?'
        }),
        buildMarket({ slug: 'temperature-anomaly-april' })
      )
  );

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'eligible');
});

test('rejects non-matching event keywords', () => {
  const decision = withEnv(
    { ALLOWED_EVENT_KEYWORDS: ['temperature'] },
    () => decideCopy(buildActivity({ title: 'Will BTC break 100k?' }), buildMarket({ slug: 'btc-100k' }))
  );

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'event keyword not allowed');
});

test('rejects market token mismatches', () => {
  const decision = withEnv({}, () => decideCopy(buildActivity({ asset: 'unknown-token' }), buildMarket()));
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'market token id mismatch');
});
