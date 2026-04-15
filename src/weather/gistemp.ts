/**
 * Fetches NASA GISTEMP v4 monthly temperature anomaly for the Korea grid cell.
 *
 * GISTEMP v4 uses a 2°×2° grid. The Korea/Seoul cell covers roughly:
 *   36–38°N, 126–128°E  (Incheon / Seoul area)
 *
 * Anomaly is relative to the 1951–1980 baseline mean.
 * A positive anomaly (e.g. +1.2°C) means the current period is warmer than baseline.
 *
 * Use: Shift the ensemble probability distribution by the anomaly as a seasonal prior.
 * Rule of thumb: if the month is running +1°C anomaly, the expected RKSI high
 * for any given day is ~1°C warmer than pure climatology.
 *
 * Data source: https://data.giss.nasa.gov/gistemp/
 * Plain-text LOTI file: https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv
 *
 * For regional/station anomaly we use the Open-Meteo climate API which exposes
 * ERA5 reanalysis monthly normals — a practical substitute since GISTEMP's
 * gridded netCDF files are large and require scientific libraries to parse.
 */

import { fetchJson, fetchText } from '../http';
import { CityConfig } from './cities';

export type MonthlyAnomaly = {
  year: number;
  month: number;         // 1–12
  anomalyC: number;      // °C above/below 1991-2020 normal
  source: 'open-meteo-era5' | 'gistemp-global';
};

type OpenMeteoClimateResponse = {
  monthly: {
    time: string[];
    temperature_2m_mean: number[];
  };
};

/**
 * Fetch recent monthly mean temperature for the RKSI grid cell via Open-Meteo
 * ERA5 reanalysis (1940–present). Then compute anomaly vs. the 1991–2020 climatological
 * normal for the same month.
 *
 * This is a practical, code-friendly substitute for parsing GISTEMP netCDF files.
 * It gives you the same signal: is this month running warm or cold vs. climatology?
 *
 * @param targetYear  Year to check (defaults to current year)
 * @param targetMonth Month to check, 1-based (defaults to current month)
 */
export async function fetchMonthlyAnomaly(
  city: CityConfig,
  targetYear?: number,
  targetMonth?: number,
): Promise<MonthlyAnomaly> {
  const now = new Date();

  // ERA5 archive lags by ~5 days; if the current month isn't fully available yet,
  // fall back to the previous completed month.
  let year  = targetYear  ?? now.getUTCFullYear();
  let month = targetMonth ?? (now.getUTCMonth() + 1);

  if (!targetYear && !targetMonth) {
    try {
      const recentMean = await fetchMonthlyMean(city, year, month);
      const normalMean = await fetchClimatologicalNormal(city, month);
      return { year, month, anomalyC: recentMean - normalMean, source: 'open-meteo-era5' };
    } catch {
      month -= 1;
      if (month === 0) { month = 12; year -= 1; }
    }
  }

  const recentMean = await fetchMonthlyMean(city, year, month);
  const normalMean = await fetchClimatologicalNormal(city, month);

  return {
    year,
    month,
    anomalyC: recentMean - normalMean,
    source: 'open-meteo-era5',
  };
}

/**
 * Fetch the GISTEMP v4 global LOTI time series as a fallback / cross-check.
 * This is the global mean anomaly (not Korea-specific) but useful as context.
 *
 * Returns the most recent annual anomaly available in the CSV.
 */
export async function fetchGistempGlobalAnomaly(): Promise<{ year: number; anomalyC: number }> {
  // GISTEMP v4 global LOTI CSV (plain text, updated ~monthly)
  const url = 'https://data.giss.nasa.gov/gistemp/tabledata_v4/GLB.Ts+dSST.csv';
  const text = await fetchText(url);
  return parseGistempCsv(text);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function fetchMonthlyMean(city: CityConfig, year: number, month: number): Promise<number> {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate   = lastDayOfMonth(year, month);

  const url = [
    `https://archive-api.open-meteo.com/v1/archive`,
    `?latitude=${city.lat}&longitude=${city.lon}`,
    `&start_date=${startDate}`,
    `&end_date=${endDate}`,
    `&daily=temperature_2m_max`,
    `&timezone=${encodeURIComponent(city.timezone)}`,
  ].join('');

  const data = await fetchJson<{ daily: { temperature_2m_max: (number | null)[] } }>(url);
  const temps = data.daily.temperature_2m_max.filter((v): v is number => v !== null);
  if (temps.length === 0) throw new Error(`No ERA5 data for ${year}-${month}`);
  return temps.reduce((a, b) => a + b, 0) / temps.length;
}

async function fetchClimatologicalNormal(city: CityConfig, month: number): Promise<number> {
  const normals: number[] = [];
  for (let y = 1991; y <= 2020; y++) {
    const m = await fetchMonthlyMean(city, y, month);
    normals.push(m);
  }
  return normals.reduce((a, b) => a + b, 0) / normals.length;
}

function parseGistempCsv(csv: string): { year: number; anomalyC: number } {
  // GISTEMP CSV has header rows then lines like: 1880,-.16,-.08,...
  // We want the last complete annual entry (last column before "J-D" annual mean).
  const lines = csv.split('\n').filter(l => /^\d{4},/.test(l.trim()));
  if (lines.length === 0) throw new Error('Could not parse GISTEMP CSV');

  // Walk backwards to find the last year with a valid annual mean (column index 13 = "J-D")
  for (let i = lines.length - 1; i >= 0; i--) {
    const cols = lines[i].split(',');
    const year = parseInt(cols[0], 10);
    const annualMean = parseFloat(cols[13] ?? '');
    if (!isNaN(year) && !isNaN(annualMean)) {
      return { year, anomalyC: annualMean / 100 }; // GISTEMP stores in 0.01°C units
    }
  }

  throw new Error('No valid annual entry found in GISTEMP CSV');
}

function lastDayOfMonth(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month, 0)); // day 0 of next month = last day of this month
  return d.toISOString().slice(0, 10);
}
