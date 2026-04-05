import test from 'node:test';
import assert from 'node:assert/strict';
import { getActivityKeys, hasSeenActivity, markActivitySeen, normalizeActivity } from './activity';

test('normalizeActivity prefers the observed trader address and lowercases it', () => {
  const activity = normalizeActivity(
    {
      proxyWallet: '0xAbC123',
      asset: 'token-1'
    },
    '0xFallback'
  );

  assert.equal(activity.user, '0xabc123');
});

test('markActivitySeen records all aliases so later payload variants are deduplicated', () => {
  const seen = new Set<string>();
  const original = normalizeActivity(
    {
      asset: 'token-1',
      price: '0.18',
      timestamp: 1775307201,
      user: '0xTrader'
    },
    '0xTrader'
  );

  markActivitySeen(seen, original);

  const sameTradeWithTxHash = normalizeActivity(
    {
      transactionHash: '0x0fc64363b09606f74147df1cd47c4714f38d0740458badd639bba6ff08244260',
      asset: 'token-1',
      price: '0.18',
      timestamp: 1775307201,
      user: '0xTrader'
    },
    '0xTrader'
  );

  assert.equal(hasSeenActivity(seen, sameTradeWithTxHash), true);
  assert.deepEqual(getActivityKeys(sameTradeWithTxHash), [
    '0x0fc64363b09606f74147df1cd47c4714f38d0740458badd639bba6ff08244260',
    '0xtrader-token-1-1775307201-0.18'
  ]);
});
