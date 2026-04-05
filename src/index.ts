import { ENV, validateLiveMode } from './config';
import { logError, logInfo } from './logger';
import { runPollCycle } from './bot';
import { createTradingClient } from './polymarket';
import { loadState } from './state';

async function main(): Promise<void> {
  validateLiveMode();

  const state = loadState(ENV.STATE_PATH);
  const seen = new Set(state.seenActivityIds);
  const tradingClient = ENV.PREVIEW_MODE ? null : await createTradingClient();

  logInfo('Bot starting', {
    previewMode: ENV.PREVIEW_MODE,
    userAddresses: ENV.USER_ADDRESSES,
    pollIntervalMs: ENV.POLL_INTERVAL_MS
  });

  while (true) {
    await runPollCycle({ state, seen, tradingClient });

    await new Promise((resolve) => setTimeout(resolve, ENV.POLL_INTERVAL_MS));
  }
}

main().catch((error) => {
  logError('Fatal startup error', {
    message: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
