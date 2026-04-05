import { ENV } from './config';
import { getPrimaryActivityId, hasSeenActivity, markActivitySeen, normalizeActivity } from './activity';
import { logError, logInfo, logWarn } from './logger';
import { fetchMarketByCondition, fetchTraderActivity, postCopyOrder } from './polymarket';
import { saveState } from './state';
import { decideCopy } from './strategy';
import { BotState, TraderActivity } from './types';

interface BotEnv {
  USER_ADDRESSES: string[];
  MAX_ACTIVITY_PAGES: number;
  PREVIEW_MODE: boolean;
  STATE_PATH: string;
}

const defaultEnv: BotEnv = {
  USER_ADDRESSES: ENV.USER_ADDRESSES,
  MAX_ACTIVITY_PAGES: ENV.MAX_ACTIVITY_PAGES,
  PREVIEW_MODE: ENV.PREVIEW_MODE,
  STATE_PATH: ENV.STATE_PATH
};

interface BotDeps {
  fetchTraderActivity: (address: string, page: number) => Promise<TraderActivity[]>;
  fetchMarketByCondition: (conditionId: string) => Promise<any>;
  postCopyOrder: (client: any, params: { tokenId: string; conditionId: string; side: any; price: number; size: number }) => Promise<unknown>;
  saveState: (statePath: string, state: BotState) => void;
  logInfo: (message: string, meta?: unknown) => void;
  logWarn: (message: string, meta?: unknown) => void;
  logError: (message: string, meta?: unknown) => void;
}

const defaultDeps: BotDeps = {
  fetchTraderActivity,
  fetchMarketByCondition,
  postCopyOrder,
  saveState,
  logInfo,
  logWarn,
  logError
};

export async function collectFreshActivity(
  seen: Set<string>,
  env: BotEnv = defaultEnv,
  deps: Pick<BotDeps, 'fetchTraderActivity'> = defaultDeps
): Promise<TraderActivity[]> {
  const fresh: TraderActivity[] = [];
  const cycleSeen = new Set<string>();

  for (const address of env.USER_ADDRESSES) {
    for (let page = 0; page < env.MAX_ACTIVITY_PAGES; page += 1) {
      const activities = await deps.fetchTraderActivity(address, page);
      if (!activities.length) {
        break;
      }

      for (const activity of activities) {
        const normalizedActivity = normalizeActivity(activity, address);
        if (hasSeenActivity(seen, normalizedActivity) || hasSeenActivity(cycleSeen, normalizedActivity)) {
          continue;
        }
        fresh.push(normalizedActivity);
        markActivitySeen(cycleSeen, normalizedActivity);
      }
    }
  }

  fresh.sort((a, b) => String(a.createdAt || a.timestamp).localeCompare(String(b.createdAt || b.timestamp)));
  return fresh;
}

export async function runPollCycle(params: {
  state: BotState;
  seen: Set<string>;
  tradingClient: unknown | null;
  env?: BotEnv;
  deps?: Partial<BotDeps>;
}): Promise<{
  freshCount: number;
  previewCount: number;
  liveCount: number;
  skippedCount: number;
  failedCount: number;
}> {
  const env = params.env || defaultEnv;
  const deps: BotDeps = { ...defaultDeps, ...params.deps };
  let freshCount = 0;
  let previewCount = 0;
  let liveCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  try {
    const fresh = await collectFreshActivity(params.seen, env, deps);
    freshCount = fresh.length;

    for (const activity of fresh) {
      const id = getPrimaryActivityId(activity);

      try {
        const market = activity.conditionId ? await deps.fetchMarketByCondition(activity.conditionId) : null;
        const decision = decideCopy(activity, market);

        if (!decision.allowed) {
          deps.logInfo('Skipping activity', {
            event: 'activity_skipped',
            id,
            trader: activity.user,
            reason: decision.reason,
            side: activity.side,
            slug: decision.slug || activity.slug
          });
          markActivitySeen(params.seen, activity);
          skippedCount += 1;
          continue;
        }

        const payload = {
          event: env.PREVIEW_MODE ? 'preview_order' : 'live_order_submission',
          id,
          trader: activity.user,
          side: activity.side,
          slug: decision.slug,
          orderUsd: decision.orderUsd,
          orderSize: decision.orderSize,
          price: decision.price,
          tokenId: decision.tokenId,
          conditionId: decision.conditionId
        };

        if (env.PREVIEW_MODE) {
          deps.logWarn('Preview mode: would place copy order', payload);
          previewCount += 1;
        } else if (params.tradingClient) {
          const response = await deps.postCopyOrder(params.tradingClient, {
            tokenId: decision.tokenId as string,
            conditionId: decision.conditionId as string,
            side: decision.side!,
            price: decision.price as number,
            size: decision.orderSize as number
          });
          deps.logInfo('Live order submitted', { ...payload, response });
          liveCount += 1;
        }

        markActivitySeen(params.seen, activity);
      } catch (error) {
        failedCount += 1;
        deps.logError('Activity processing failed', {
          event: 'activity_processing_failed',
          id,
          trader: activity.user,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
  } catch (error) {
    failedCount += 1;
    deps.logError('Polling loop failed', {
      event: 'poll_cycle_failed',
      message: error instanceof Error ? error.message : String(error)
    });
  } finally {
    params.state.seenActivityIds = Array.from(params.seen).slice(-5000);
    deps.saveState(env.STATE_PATH, params.state);
  }

  return {
    freshCount,
    previewCount,
    liveCount,
    skippedCount,
    failedCount
  };
}
