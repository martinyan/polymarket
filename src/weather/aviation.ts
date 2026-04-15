import { fetchJson, fetchText } from '../http';
import { CityConfig } from './cities';
import { BetSignal, MIN_POSITION_USD } from './ev';

type AviationMetarApiRow = {
  icaoId?: string;
  reportTime?: string;
  temp?: number;
  rawOb?: string;
  fltCat?: string;
  name?: string;
};

export type LatestMetar = {
  stationCode: string;
  reportTime: string | null;
  tempC: number | null;
  rawOb: string;
  flightCategory: string;
  stationName: string;
};

export type MetarObservation = {
  stationCode: string;
  reportTime: string;
  tempC: number;
  rawOb: string;
  flightCategory: string;
  stationName: string;
};

export type StationNowcast = {
  latest: LatestMetar | null;
  observations: MetarObservation[];
};

export type LiveTemperatureFloorAdjustment = {
  stationCode: string;
  marketDate: string;
  reportTime: string;
  reportAgeMinutes: number;
  currentTempC: number;
  observedMaxSoFarC: number;
  observationCount: number;
  originalMemberCount: number;
  adjustedMemberCount: number;
  discardedMemberCount: number;
  method: 'filter' | 'clamp';
  summary: string;
  rawOb: string;
};

export type TemperatureFloorResult = {
  temps: number[];
  adjustment: LiveTemperatureFloorAdjustment | null;
};

export type TafRiskOverlay = {
  stationCode: string;
  rawText: string;
  multiplier: number;
  reasons: string[];
  summary: string;
};

const AVIATION_WEATHER_BASE = 'https://aviationweather.gov/api/data';
const MAX_METAR_AGE_MINUTES = 180;
const RECENT_METAR_LOOKBACK_HOURS = 36;

export function buildMetarUrl(stationCode: string, hours?: number): string {
  const params = new URLSearchParams({
    ids: stationCode,
    format: 'json',
  });
  if (hours && Number.isFinite(hours) && hours > 0) {
    params.set('hours', String(hours));
  }
  return `${AVIATION_WEATHER_BASE}/metar?${params.toString()}`;
}

export function buildTafUrl(stationCode: string): string {
  const params = new URLSearchParams({
    ids: stationCode,
    format: 'raw',
  });
  return `${AVIATION_WEATHER_BASE}/taf?${params.toString()}`;
}

export async function fetchLatestMetar(stationCode: string): Promise<LatestMetar | null> {
  const nowcast = await fetchStationNowcast(stationCode, 1);
  return nowcast.latest;
}

export async function fetchRecentMetars(stationCode: string, hours = RECENT_METAR_LOOKBACK_HOURS): Promise<MetarObservation[]> {
  const rows = await fetchJson<AviationMetarApiRow[]>(buildMetarUrl(stationCode, hours));
  return (rows ?? [])
    .filter((row): row is AviationMetarApiRow & { reportTime: string; temp: number } =>
      typeof row.reportTime === 'string' &&
      typeof row.temp === 'number' &&
      Number.isFinite(row.temp)
    )
    .map(row => ({
      stationCode: row.icaoId ?? stationCode,
      reportTime: row.reportTime,
      tempC: row.temp,
      rawOb: row.rawOb ?? '',
      flightCategory: row.fltCat ?? '',
      stationName: row.name ?? '',
    }));
}

export async function fetchStationNowcast(stationCode: string, hours = RECENT_METAR_LOOKBACK_HOURS): Promise<StationNowcast> {
  const observations = await fetchRecentMetars(stationCode, hours);
  const latestObs = observations[0];
  const latest = latestObs ? {
    stationCode: latestObs.stationCode,
    reportTime: latestObs.reportTime,
    tempC: latestObs.tempC,
    rawOb: latestObs.rawOb,
    flightCategory: latestObs.flightCategory,
    stationName: latestObs.stationName,
  } satisfies LatestMetar : null;

  return { latest, observations };
}

export async function fetchTafRiskOverlay(stationCode: string): Promise<TafRiskOverlay | null> {
  const raw = (await fetchText(buildTafUrl(stationCode))).trim();
  if (!raw) return null;
  return parseTafRiskOverlay(raw, stationCode);
}

export function normalizeLatestMetar(observation: MetarObservation | null, stationCode: string): LatestMetar | null {
  if (!observation) return null;
  return {
    stationCode: observation.stationCode ?? stationCode,
    reportTime: observation.reportTime,
    tempC: observation.tempC,
    rawOb: observation.rawOb,
    flightCategory: observation.flightCategory,
    stationName: observation.stationName,
  };
}

export function cityLocalDate(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = parts.find(part => part.type === 'year')?.value ?? '0000';
  const month = parts.find(part => part.type === 'month')?.value ?? '01';
  const day = parts.find(part => part.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

/**
 * Tighten today's station-level daily-high distribution using the latest METAR.
 *
 * The final daily high cannot end below the latest observed station temperature.
 * We therefore discard ensemble members that are already impossible, but only for
 * the current local market day and only when the observation is fresh.
 */
export function applyLiveMetarTemperatureFloor(
  temps: number[],
  city: CityConfig,
  marketDate: string,
  metarOrNowcast: LatestMetar | StationNowcast | null,
  now = new Date(),
): TemperatureFloorResult {
  const nowcast = toStationNowcast(metarOrNowcast, city.stationCode);
  const metar = nowcast.latest;
  if (!metar?.reportTime || metar.tempC === null || !Number.isFinite(metar.tempC)) {
    return { temps, adjustment: null };
  }

  const reportTime = new Date(metar.reportTime);
  const reportAgeMinutes = (now.getTime() - reportTime.getTime()) / 60_000;
  if (reportAgeMinutes < -5 || reportAgeMinutes > MAX_METAR_AGE_MINUTES) {
    return { temps, adjustment: null };
  }

  if (cityLocalDate(now, city.timezone) !== marketDate) {
    return { temps, adjustment: null };
  }
  if (cityLocalDate(reportTime, city.timezone) !== marketDate) {
    return { temps, adjustment: null };
  }

  const sameLocalDayObservations = nowcast.observations.filter(obs =>
    cityLocalDate(new Date(obs.reportTime), city.timezone) === marketDate
  );
  const observedFloorC = sameLocalDayObservations.length
    ? Math.max(...sameLocalDayObservations.map(obs => obs.tempC))
    : metar.tempC;
  const filteredTemps = temps.filter(temp => temp >= observedFloorC);
  if (filteredTemps.length === temps.length) {
    return { temps, adjustment: null };
  }

  const adjustedTemps = filteredTemps.length > 0
    ? filteredTemps
    : temps.map(temp => Math.max(temp, observedFloorC));
  const method = filteredTemps.length > 0 ? 'filter' : 'clamp';
  const discardedMemberCount = temps.length - filteredTemps.length;

  return {
    temps: adjustedTemps,
    adjustment: {
      stationCode: metar.stationCode,
      marketDate,
      reportTime: reportTime.toISOString(),
      reportAgeMinutes,
      currentTempC: observedFloorC,
      observedMaxSoFarC: observedFloorC,
      observationCount: sameLocalDayObservations.length || 1,
      originalMemberCount: temps.length,
      adjustedMemberCount: adjustedTemps.length,
      discardedMemberCount: Math.max(0, discardedMemberCount),
      method,
      summary: `${metar.stationCode} observed max-so-far ${observedFloorC.toFixed(1)}°C from ${sameLocalDayObservations.length || 1} METAR(s) makes ${discardedMemberCount} member(s) impossible`,
      rawOb: metar.rawOb,
    },
  };
}

function toStationNowcast(
  value: LatestMetar | StationNowcast | null,
  stationCode: string,
): StationNowcast {
  if (!value) return { latest: null, observations: [] };
  if ('observations' in value) return value;

  const latest = value;
  const observations: MetarObservation[] = latest.reportTime && latest.tempC !== null
    ? [{
        stationCode: latest.stationCode ?? stationCode,
        reportTime: latest.reportTime,
        tempC: latest.tempC,
        rawOb: latest.rawOb,
        flightCategory: latest.flightCategory,
        stationName: latest.stationName,
      }]
    : [];
  return { latest, observations };
}

export function parseTafRiskOverlay(rawText: string, stationCode: string): TafRiskOverlay {
  const text = rawText.replace(/\s+/g, ' ').trim().toUpperCase();
  let multiplier = 1;
  const reasons: string[] = [];

  if (/\bTEMPO\b/.test(text) || /\bPROB30\b/.test(text)) {
    multiplier *= 0.75;
    reasons.push('temporary/probabilistic regime change in TAF');
  }
  if (/\b(TS|VCTS|SHRA|RA|SN|FG|BR)\b/.test(text)) {
    multiplier *= 0.85;
    reasons.push('precipitation, convection, or visibility restrictions');
  }
  if (/\b\d{3}\d{2,3}G(\d{2,3})KT\b/.test(text) || /\bVRB\d{2,3}G(\d{2,3})KT\b/.test(text)) {
    multiplier *= 0.9;
    reasons.push('gusty wind regime');
  }
  if (/\b(BKN|OVC|VV)0(0\d|1\d|2\d)\b/.test(text)) {
    multiplier *= 0.9;
    reasons.push('low cloud ceiling/obscuration');
  }

  multiplier = Math.max(0.5, Number(multiplier.toFixed(2)));
  const summary = reasons.length
    ? `TAF uncertainty overlay ${multiplier.toFixed(2)}x: ${reasons.join('; ')}`
    : 'TAF overlay neutral';

  return {
    stationCode,
    rawText: rawText.trim(),
    multiplier,
    reasons,
    summary,
  };
}

export function applyTafRiskToSignals(signals: BetSignal[], overlay: TafRiskOverlay | null): BetSignal[] {
  if (!overlay || overlay.multiplier >= 0.999) return signals;

  return signals.map(signal => {
    if (signal.action !== 'BUY') return signal;
    const adjustedUsd = Number((signal.suggestedUsd * overlay.multiplier).toFixed(2));
    if (adjustedUsd < MIN_POSITION_USD) {
      return {
        ...signal,
        suggestedUsd: adjustedUsd,
        action: 'SKIP' as const,
        reason: `TAF risk overlay reduced size below $${MIN_POSITION_USD}: ${overlay.summary}`,
      };
    }
    return {
      ...signal,
      suggestedUsd: adjustedUsd,
      reason: overlay.summary,
    };
  }).sort((a, b) => {
    if (a.action === 'BUY' && b.action !== 'BUY') return -1;
    if (b.action === 'BUY' && a.action !== 'BUY') return 1;
    return b.evPerDollar - a.evPerDollar;
  });
}
