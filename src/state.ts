import fs from 'fs';
import path from 'path';
import { BotState } from './types';

const defaultState = (): BotState => ({
  seenActivityIds: [],
  updatedAt: new Date().toISOString()
});

export function loadState(statePath: string): BotState {
  if (!fs.existsSync(statePath)) {
    return defaultState();
  }

  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    const parsed = JSON.parse(raw) as BotState;
    return {
      seenActivityIds: parsed.seenActivityIds || [],
      updatedAt: parsed.updatedAt || new Date().toISOString()
    };
  } catch {
    return defaultState();
  }
}

export function saveState(statePath: string, state: BotState): void {
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify(
      {
        ...state,
        updatedAt: new Date().toISOString()
      },
      null,
      2
    )
  );
}
