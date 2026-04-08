import test from 'node:test';
import assert from 'node:assert/strict';
import { runPollCycle } from './bot';
import { ENV } from './config';
import { BotState, TraderActivity } from './types';

function buildActivity(overrides: Partial<TraderActivity> = {}): TraderActivity {
  return {
    id: 'activity-1',
    transactionHash: '0xtx-1',
    user: '0xtrader',
    side: 'BUY',
    asset: 'token-yes',
    price: '0.50',
    usdcSize: '100',
    conditionId: 'condition-1',
    marketSlug: 'test-market',
    timestamp: 1000,
    ...overrides
  };
}

test('runPollCycle persists only fresh activities across repeated polls', async () => {
  const previous = {
    ALLOWED_TAGS: [...ENV.ALLOWED_TAGS],
    ALLOWED_EVENT_KEYWORDS: [...ENV.ALLOWED_EVENT_KEYWORDS],
    BLOCKED_SLUGS: [...ENV.BLOCKED_SLUGS],
    BUY_ONLY: ENV.BUY_ONLY,
    COPY_RATIO: ENV.COPY_RATIO,
    MAX_ORDER_USD: ENV.MAX_ORDER_USD,
    MIN_ORDER_USD: ENV.MIN_ORDER_USD
  };
  Object.assign(ENV, {
    ALLOWED_TAGS: [],
    ALLOWED_EVENT_KEYWORDS: [],
    BLOCKED_SLUGS: [],
    BUY_ONLY: true,
    COPY_RATIO: 0.1,
    MAX_ORDER_USD: 25,
    MIN_ORDER_USD: 1
  });

  const savedStates: BotState[] = [];
  const infoLogs: unknown[] = [];
  const warnLogs: unknown[] = [];

  const env = {
    USER_ADDRESSES: ['0xtrader'],
    MAX_ACTIVITY_PAGES: 2,
    PREVIEW_MODE: true,
    STATE_PATH: './data/test-state.json'
  };

  const activity = buildActivity();
  const state: BotState = {
    seenActivityIds: [],
    updatedAt: new Date().toISOString()
  };
  const seen = new Set<string>();

  const deps = {
    fetchTraderActivity: async (_address: string, page: number): Promise<TraderActivity[]> => {
      if (page === 0) {
        return [activity, activity];
      }
      return [];
    },
    fetchMarketByCondition: async () => ({
      conditionId: 'condition-1',
      slug: 'test-market',
      enableOrderBook: true,
      clobTokenIds: ['token-yes', 'token-no']
    }),
    postCopyOrder: async () => ({ ok: true }),
    saveState: (_path: string, nextState: BotState) => {
      savedStates.push(JSON.parse(JSON.stringify(nextState)) as BotState);
    },
    logInfo: (_message: string, meta?: unknown) => {
      infoLogs.push(meta);
    },
    logWarn: (_message: string, meta?: unknown) => {
      warnLogs.push(meta);
    },
    logError: (_message: string, meta?: unknown) => {
      infoLogs.push(meta);
    }
  };

  try {
    const first = await runPollCycle({ state, seen, tradingClient: null, env, deps });
    const second = await runPollCycle({ state, seen, tradingClient: null, env, deps });

    assert.equal(first.freshCount, 1);
    assert.equal(first.previewCount, 1);
    assert.equal(first.failedCount, 0);
    assert.equal(second.freshCount, 0);
    assert.equal(second.previewCount, 0);
    assert.equal(warnLogs.length, 1);
    assert.equal(savedStates.length, 2);
    assert.ok(savedStates[0].seenActivityIds.length >= 2);
  } finally {
    Object.assign(ENV, previous);
  }
});
