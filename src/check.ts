import { ENV, validateLiveMode } from './config';
import { fetchJson } from './http';
import { logInfo } from './logger';
import { createTradingClient, fetchMarketByCondition, fetchTraderActivity } from './polymarket';
import { getActivityKeys, normalizeActivity } from './activity';
import { decideCopy } from './strategy';

async function main(): Promise<void> {
  validateLiveMode();

  const gamma = await fetchJson<unknown>(`${ENV.POLYMARKET_GAMMA_URL}/markets?active=true&closed=false&limit=1`);
  const data = await fetchJson<unknown>(`${ENV.POLYMARKET_DATA_URL}/activity?user=${ENV.USER_ADDRESSES[0]}&type=TRADE&limit=3`);
  const clobOk = await fetchJson<unknown>(`${ENV.POLYMARKET_HOST}/ok`);
  const activities = await fetchTraderActivity(ENV.USER_ADDRESSES[0], 0);
  const sampleActivity = activities[0] ? normalizeActivity(activities[0], ENV.USER_ADDRESSES[0]) : null;
  const sampleMarket = sampleActivity?.conditionId ? await fetchMarketByCondition(sampleActivity.conditionId) : null;
  const sampleDecision = sampleActivity ? decideCopy(sampleActivity, sampleMarket) : null;

  logInfo('Gamma API reachable', gamma);
  logInfo('Data API reachable', data);
  logInfo('CLOB API reachable', clobOk);
  logInfo('Followed wallet activity check', {
    event: 'followed_wallet_activity_check',
    userAddress: ENV.USER_ADDRESSES[0],
    activityCount: activities.length,
    sampleActivityId: sampleActivity ? getActivityKeys(sampleActivity)[0] : null,
    sampleSide: sampleActivity?.side || null,
    sampleSlug: sampleActivity?.marketSlug || sampleActivity?.eventSlug || sampleActivity?.slug || sampleMarket?.slug || null,
    sampleTokenId: sampleActivity?.asset || null,
    sampleConditionId: sampleActivity?.conditionId || sampleMarket?.conditionId || sampleMarket?.questionID || null,
    sampleDecision
  });

  if (ENV.PREVIEW_MODE) {
    logInfo('Live trading client validation skipped', {
      event: 'live_client_validation_skipped',
      reason: 'preview mode enabled'
    });
    return;
  }

  const client = await createTradingClient();
  logInfo('Live trading client validated', {
    event: 'live_client_validated',
    chainId: ENV.CHAIN_ID,
    funderAddress: ENV.FUNDER_ADDRESS,
    hasClient: !!client
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
