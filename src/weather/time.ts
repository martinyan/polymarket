/**
 * Timezone-aware helpers shared by the weather portal and forward-test logger.
 *
 * We avoid hard-coded UTC offsets so the 20-city expansion continues to work
 * as markets move across DST boundaries and into non-core regions.
 */

function parseUtcOffsetMinutes(offsetLabel: string): number {
  if (offsetLabel === 'GMT' || offsetLabel === 'UTC') return 0;
  const match = offsetLabel.match(/^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2] ?? '0');
  const minutes = Number(match[3] ?? '0');
  return sign * (hours * 60 + minutes);
}

function timeZoneOffsetMinutes(atUtc: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'shortOffset',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(atUtc);
  const offset = parts.find(part => part.type === 'timeZoneName')?.value ?? 'UTC';
  return parseUtcOffsetMinutes(offset);
}

/**
 * Returns the UTC millisecond timestamp when `marketDate` ends in `timeZone`,
 * i.e. local midnight at the start of the next day.
 */
export function cityDayEndUtcMs(marketDate: string, timeZone: string): number {
  const [year, month, day] = marketDate.split('-').map(Number);
  const utcGuess = new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0));
  const offsetMinutes = timeZoneOffsetMinutes(utcGuess, timeZone);
  return utcGuess.getTime() - offsetMinutes * 60_000;
}

export function tradeWindowOpenUtcMs(marketDate: string, timeZone: string, tradeWindowHours: number): number {
  return cityDayEndUtcMs(marketDate, timeZone) - tradeWindowHours * 3_600_000;
}
