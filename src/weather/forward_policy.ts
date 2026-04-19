import { cityDayEndUtcMs, tradeWindowOpenUtcMs } from './time';

export const NORMAL_TRADE_WINDOW_HOURS = 18;
export const FORCED_FALLBACK_WINDOW_HOURS = 8;

export function normalTradeWindowOpenUtcMs(date: string, timezone: string): number {
  return tradeWindowOpenUtcMs(date, timezone, NORMAL_TRADE_WINDOW_HOURS);
}

export function forcedFallbackWindowOpenUtcMs(date: string, timezone: string): number {
  return tradeWindowOpenUtcMs(date, timezone, FORCED_FALLBACK_WINDOW_HOURS);
}

export function marketCloseUtcMs(date: string, timezone: string): number {
  return cityDayEndUtcMs(date, timezone);
}

export function tradeWindowPhase(date: string, timezone: string, nowMs = Date.now()): 'before_normal' | 'normal_only' | 'forced_fallback' | 'closed' {
  const closeMs = marketCloseUtcMs(date, timezone);
  if (nowMs >= closeMs) return 'closed';
  if (nowMs >= forcedFallbackWindowOpenUtcMs(date, timezone)) return 'forced_fallback';
  if (nowMs >= normalTradeWindowOpenUtcMs(date, timezone)) return 'normal_only';
  return 'before_normal';
}
