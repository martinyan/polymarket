import { ENV, validateLiveMode } from './config';
import { logInfo, logWarn } from './logger';
import { runPollCycle } from './bot';
import { loadState } from './state';

async function main(): Promise<void> {
  validateLiveMode();

  if (!ENV.PREVIEW_MODE) {
    throw new Error('preview:once requires PREVIEW_MODE=true');
  }

  const state = loadState(ENV.STATE_PATH);
  const seen = new Set(state.seenActivityIds);

  logWarn('Running single preview poll cycle', {
    event: 'preview_once_start',
    previewMode: ENV.PREVIEW_MODE,
    userAddresses: ENV.USER_ADDRESSES,
    pollIntervalMs: ENV.POLL_INTERVAL_MS,
    priorSeenCount: seen.size
  });

  const summary = await runPollCycle({
    state,
    seen,
    tradingClient: null
  });

  logInfo('Single preview poll cycle complete', {
    event: 'preview_once_complete',
    ...summary,
    seenCount: seen.size,
    statePath: ENV.STATE_PATH
  });
}

main().catch((error) => {
  logWarn('Single preview poll cycle failed', {
    event: 'preview_once_failed',
    message: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
