/**
 * Multi-model ensemble fetcher.
 * Primary: ECMWF IFS 51-member (global, all cities)
 * Secondary per city:
 *   Seoul  → KMA LDPS 1.5km deterministic (Korea)
 *   Tokyo  → JMA MSM 5km deterministic (Japan/Korea)
 *   London → DWD ICON-EU-EPS 40-member 13km (Europe)
 *   others → ECMWF only
 */

import { fetchJson } from '../http';
import { CityConfig } from './cities';

export type EnsembleMember = {
  date:        string;   // YYYY-MM-DD
  memberIndex: number;   // 0-based; 0 = deterministic secondary model
  tempMaxC:    number;
  model:       string;   // 'ecmwf_ifs' | 'kma' | 'jma' | 'icon_eu' | etc.
};

type OpenMeteoEnsembleResponse = {
  daily: Record<string, string[] | number[]>;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Primary: ECMWF IFS 51-member ensemble */
export async function fetchEcmwfEnsemble(city: CityConfig, days = 7): Promise<EnsembleMember[]> {
  const url = buildEnsembleUrl(city, days, 'ecmwf_ifs025');
  const data = await fetchJson<OpenMeteoEnsembleResponse>(url);
  return parseEnsembleResponse(data, 'ecmwf_ifs');
}

/** ECMWF AIFS 51-member (AI-based, independent from IFS) */
export async function fetchEcmwfAifs(city: CityConfig, days = 7): Promise<EnsembleMember[]> {
  const url = buildEnsembleUrl(city, days, 'ecmwf_aifs025');
  try {
    const data = await fetchJson<OpenMeteoEnsembleResponse>(url);
    return parseEnsembleResponse(data, 'ecmwf_aifs');
  } catch { return []; }
}

/** GFS 31-member (NOAA, independent global model) */
export async function fetchGfsEnsemble(city: CityConfig, days = 7): Promise<EnsembleMember[]> {
  const url = buildEnsembleUrl(city, Math.min(days, 10), 'gfs025');
  try {
    const data = await fetchJson<OpenMeteoEnsembleResponse>(url);
    return parseEnsembleResponse(data, 'gfs');
  } catch { return []; }
}

/** KMA LDPS deterministic — 1.5km, 2-day (Korea only, best for Seoul) */
export async function fetchKmaForecast(city: CityConfig, days = 2): Promise<EnsembleMember[]> {
  const url = [
    `https://api.open-meteo.com/v1/forecast`,
    `?latitude=${city.lat}&longitude=${city.lon}`,
    `&daily=temperature_2m_max`,
    `&models=kma_seamless`,
    `&forecast_days=${Math.min(days, 2)}`,
    `&timezone=${encodeURIComponent(city.timezone)}`,
  ].join('');
  try {
    const data = await fetchJson<{ daily: { time: string[]; temperature_2m_max: number[] } }>(url);
    return data.daily.time.map((date, i) => ({
      date, memberIndex: 0, tempMaxC: data.daily.temperature_2m_max[i], model: 'kma_ldps',
    }));
  } catch { return []; }
}

/** JMA MSM deterministic — 5km, 4-day (Japan/Korea, best for Tokyo) */
export async function fetchJmaForecast(city: CityConfig, days = 4): Promise<EnsembleMember[]> {
  const url = [
    `https://api.open-meteo.com/v1/forecast`,
    `?latitude=${city.lat}&longitude=${city.lon}`,
    `&daily=temperature_2m_max`,
    `&models=jma_seamless`,
    `&forecast_days=${Math.min(days, 4)}`,
    `&timezone=${encodeURIComponent(city.timezone)}`,
  ].join('');
  try {
    const data = await fetchJson<{ daily: { time: string[]; temperature_2m_max: number[] } }>(url);
    return data.daily.time.map((date, i) => ({
      date, memberIndex: 0, tempMaxC: data.daily.temperature_2m_max[i], model: 'jma_msm',
    }));
  } catch { return []; }
}

/** DWD ICON-EU-EPS 40-member, 13km, 5-day (Europe, best for London) */
export async function fetchIconEuEnsemble(city: CityConfig, days = 5): Promise<EnsembleMember[]> {
  const url = buildEnsembleUrl(city, Math.min(days, 5), 'icon_eu_eps');
  try {
    const data = await fetchJson<OpenMeteoEnsembleResponse>(url);
    return parseEnsembleResponse(data, 'icon_eu');
  } catch { return []; }
}

/** Met Office MOGREPS-G 18-member (global, good for London) */
export async function fetchMetOfficeEnsemble(city: CityConfig, days = 7): Promise<EnsembleMember[]> {
  const url = buildEnsembleUrl(city, days, 'ukmo_seamless_ensemble');
  try {
    const data = await fetchJson<OpenMeteoEnsembleResponse>(url);
    return parseEnsembleResponse(data, 'metoffice');
  } catch { return []; }
}

/**
 * Fetch the best secondary model for a city (based on city.secondaryModel).
 * Returns empty array if no secondary model is configured.
 */
export async function fetchSecondaryForecast(city: CityConfig, days = 3): Promise<EnsembleMember[]> {
  switch (city.secondaryModel) {
    case 'kma':        return fetchKmaForecast(city, days);
    case 'jma':        return fetchJmaForecast(city, days);
    case 'icon_eu':    return fetchIconEuEnsemble(city, days);
    case 'metoffice':  return fetchMetOfficeEnsemble(city, days);
    default:           return [];
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------
function buildEnsembleUrl(city: CityConfig, days: number, model: string): string {
  return [
    `https://ensemble-api.open-meteo.com/v1/ensemble`,
    `?latitude=${city.lat}&longitude=${city.lon}`,
    `&daily=temperature_2m_max`,
    `&models=${model}`,
    `&forecast_days=${days}`,
    `&timezone=${encodeURIComponent(city.timezone)}`,
  ].join('');
}

function parseEnsembleResponse(data: OpenMeteoEnsembleResponse, modelName: string): EnsembleMember[] {
  const daily   = data.daily;
  const dates   = daily['time'] as string[];
  const members = Object.keys(daily)
    .filter(k => k.startsWith('temperature_2m_max_member'))
    .sort();

  const results: EnsembleMember[] = [];
  for (const [mi, key] of members.entries()) {
    const values = daily[key] as number[];
    for (const [di, date] of dates.entries()) {
      const t = values[di];
      if (t !== null && t !== undefined) {
        results.push({ date, memberIndex: mi, tempMaxC: t, model: modelName });
      }
    }
  }
  return results;
}
