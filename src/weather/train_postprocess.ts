import { fetchJson, fetchText } from '../http';
import { fetchEcmwfAifs, fetchEcmwfEnsemble, fetchGfsEnsemble, fetchSecondaryForecast } from './ensemble';
import { CITIES, CityConfig } from './cities';
import {
  ForecastFeatureRow,
  postProcessorPath,
  saveStationPostProcessor,
  trainStationPostProcessor,
  TrainingSample,
} from './postprocess';

type DailyResponse = {
  daily: Record<string, Array<number | string | null>>;
};

type WeatherCompanyDailySummaryResponse = {
  validTimeLocal?: Array<string | null>;
  temperatureMax?: Array<number | null>;
};

const args = process.argv.slice(2);
const cityArgIdx = args.indexOf('--city');
const cityArg = cityArgIdx !== -1 ? args[cityArgIdx + 1] : 'all';
const trainDaysIdx = args.indexOf('--days');
const trainDays = trainDaysIdx !== -1 ? parseInt(args[trainDaysIdx + 1] ?? '120', 10) : 120;

async function main() {
  const cities = cityArg === 'all' ? Object.values(CITIES) : [resolveCity(cityArg)];
  for (const city of cities) await trainCity(city, trainDays);
}

async function trainCity(city: CityConfig, days: number): Promise<void> {
  const endDate = isoDate(offsetUtcDays(new Date(), -1));
  const startDate = isoDate(offsetUtcDays(new Date(), -days));
  console.log(`\n[${city.name}] training station post-processor ${startDate} → ${endDate}`);

  const samples = await buildTrainingSamples(city, startDate, endDate);
  const exactLabelCount = samples.filter(sample => sample.actualSource === 'twc_daily_summary').length;
  const model = trainStationPostProcessor(city, samples, {
    exactLabelCount,
    exactLabelSource: exactLabelCount > 0 ? 'Weather Company daily summary via Weather Underground station page key' : undefined,
  });
  const path = postProcessorPath(city);
  saveStationPostProcessor(model, path);

  console.log(`  samples=${model.sampleCount} rmse=${model.rmseC.toFixed(2)}°C mae=${model.maeC.toFixed(2)}°C bias=${model.meanBiasC.toFixed(2)}°C`);
  if (exactLabelCount > 0) {
    console.log(`  exact recent labels=${exactLabelCount}/${samples.length} (${((exactLabelCount / samples.length) * 100).toFixed(0)}%)`);
  }
  console.log(`  saved=${path}`);
}

export async function buildTrainingSamples(city: CityConfig, startDate: string, endDate: string): Promise<TrainingSample[]> {
  const [ecmwf, gfs, aifs, secondary, actual] = await Promise.all([
    fetchHistoricalDailySeries(city, startDate, endDate, 'ecmwf_ifs025'),
    fetchHistoricalDailySeries(city, startDate, endDate, 'gfs025').catch(() => []),
    fetchHistoricalDailySeries(city, startDate, endDate, 'ecmwf_aifs025').catch(() => []),
    city.secondaryModel === 'none'
      ? Promise.resolve([])
      : fetchHistoricalDailySeries(city, startDate, endDate, historicalSecondaryModelName(city)).catch(() => []),
    fetchHistoricalActualDailyMax(city, startDate, endDate),
  ]);

  const byDate = new Map<string, Partial<TrainingSample>>();
  mergeSeries(byDate, ecmwf, 'ecmwfMeanC');
  mergeSeries(byDate, gfs, 'gfsMeanC');
  mergeSeries(byDate, aifs, 'aifsMeanC');
  mergeSeries(byDate, secondary, 'secondaryMeanC');
  for (const row of actual) {
    const prev = byDate.get(row.date) ?? { date: row.date };
    byDate.set(row.date, { ...prev, actualMaxC: row.value, actualSource: row.source });
  }

  return [...byDate.values()]
    .filter((row): row is TrainingSample =>
      typeof row.date === 'string' &&
      typeof row.ecmwfMeanC === 'number' &&
      typeof row.actualMaxC === 'number'
    )
    .map(row => ({ ...row, leadDays: 0 }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export async function buildCurrentForecastFeatureRows(city: CityConfig, forecastDays: number): Promise<Map<string, ForecastFeatureRow>> {
  const [ecmwfMembers, gfsMembers, aifsMembers, secondaryMembers] = await Promise.all([
    fetchEcmwfEnsemble(city, forecastDays),
    fetchGfsEnsemble(city, forecastDays).catch(() => []),
    fetchEcmwfAifs(city, forecastDays).catch(() => []),
    fetchSecondaryForecast(city, forecastDays).catch(() => []),
  ]);

  const dates = [...new Set(ecmwfMembers.map(m => m.date))].sort();
  const rows = new Map<string, ForecastFeatureRow>();
  const today = new Date().toISOString().slice(0, 10);
  for (const date of dates) {
    rows.set(date, {
      date,
      ecmwfMeanC: mean(ecmwfMembers.filter(m => m.date === date).map(m => m.tempMaxC)),
      gfsMeanC: maybeMean(gfsMembers.filter(m => m.date === date).map(m => m.tempMaxC)),
      aifsMeanC: maybeMean(aifsMembers.filter(m => m.date === date).map(m => m.tempMaxC)),
      secondaryMeanC: maybeMean(secondaryMembers.filter(m => m.date === date).map(m => m.tempMaxC)),
      leadDays: diffDays(today, date),
    });
  }
  return rows;
}

type SeriesRow = { date: string; value: number };
type ActualSeriesRow = SeriesRow & { source: 'twc_daily_summary' | 'open_meteo_archive' };

async function fetchHistoricalDailySeries(city: CityConfig, startDate: string, endDate: string, model: string): Promise<SeriesRow[]> {
  const url = [
    `https://historical-forecast-api.open-meteo.com/v1/forecast`,
    `?latitude=${city.lat}&longitude=${city.lon}`,
    `&start_date=${startDate}&end_date=${endDate}`,
    `&daily=temperature_2m_max`,
    `&models=${model}`,
    `&timezone=${encodeURIComponent(city.timezone)}`,
  ].join('');
  const data = await fetchJson<DailyResponse>(url);
  return dailySeries(data, 'temperature_2m_max');
}

async function fetchHistoricalActualDailyMax(city: CityConfig, startDate: string, endDate: string): Promise<ActualSeriesRow[]> {
  const [archiveRows, twcRows] = await Promise.all([
    fetchOpenMeteoActualDailyMax(city, startDate, endDate),
    fetchWeatherCompanyActualDailyMax(city, startDate, endDate).catch(() => []),
  ]);
  return mergePreferredActualSeries(twcRows, archiveRows);
}

async function fetchOpenMeteoActualDailyMax(city: CityConfig, startDate: string, endDate: string): Promise<ActualSeriesRow[]> {
  const url = [
    `https://archive-api.open-meteo.com/v1/archive`,
    `?latitude=${city.lat}&longitude=${city.lon}`,
    `&start_date=${startDate}&end_date=${endDate}`,
    `&daily=temperature_2m_max`,
    `&timezone=${encodeURIComponent(city.timezone)}`,
  ].join('');
  const data = await fetchJson<DailyResponse>(url);
  return dailySeries(data, 'temperature_2m_max', 'open_meteo_archive') as ActualSeriesRow[];
}

async function fetchWeatherCompanyActualDailyMax(city: CityConfig, startDate: string, endDate: string): Promise<ActualSeriesRow[]> {
  const apiKey = await fetchWeatherCompanyApiKey(city, endDate);
  if (!apiKey) return [];

  const url = [
    'https://api.weather.com/v3/wx/conditions/historical/dailysummary/30day',
    `?icaoCode=${encodeURIComponent(city.stationCode)}`,
    '&units=m',
    '&language=en-US',
    '&format=json',
    `&apiKey=${encodeURIComponent(apiKey)}`,
  ].join('');
  const data = await fetchJson<WeatherCompanyDailySummaryResponse>(url);
  return weatherCompanyDailySeries(data, startDate, endDate);
}

function dailySeries(
  data: DailyResponse,
  key: string,
  source?: ActualSeriesRow['source'],
): Array<SeriesRow | ActualSeriesRow> {
  const time = (data.daily.time ?? []) as string[];
  const values = data.daily[key] ?? [];
  const rows: Array<SeriesRow | ActualSeriesRow> = [];
  for (let i = 0; i < time.length; i++) {
    const value = values[i];
    if (typeof value === 'number' && Number.isFinite(value)) {
      rows.push(source ? { date: time[i], value, source } : { date: time[i], value });
    }
  }
  return rows;
}

function weatherCompanyDailySeries(
  data: WeatherCompanyDailySummaryResponse,
  startDate: string,
  endDate: string,
): ActualSeriesRow[] {
  const rows: ActualSeriesRow[] = [];
  const times = data.validTimeLocal ?? [];
  const values = data.temperatureMax ?? [];
  for (let i = 0; i < times.length; i++) {
    const time = times[i];
    const value = values[i];
    if (typeof time !== 'string' || typeof value !== 'number' || !Number.isFinite(value)) continue;
    const date = time.slice(0, 10);
    if (date < startDate || date > endDate) continue;
    rows.push({ date, value, source: 'twc_daily_summary' });
  }
  return rows;
}

export function mergePreferredActualSeries(primary: ActualSeriesRow[], fallback: ActualSeriesRow[]): ActualSeriesRow[] {
  const merged = new Map<string, ActualSeriesRow>();
  for (const row of fallback) merged.set(row.date, row);
  for (const row of primary) merged.set(row.date, row);
  return [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function extractWeatherCompanyApiKey(html: string): string | null {
  const match = html.match(/apiKey=([A-Za-z0-9]{32})/);
  return match?.[1] ?? null;
}

async function fetchWeatherCompanyApiKey(city: CityConfig, date: string): Promise<string | null> {
  const html = await fetchText(`${city.wundergroundUrl}/date/${date}`);
  return extractWeatherCompanyApiKey(html);
}

function mergeSeries(map: Map<string, Partial<TrainingSample>>, rows: SeriesRow[], key: keyof ForecastFeatureRow): void {
  for (const row of rows) {
    const prev = map.get(row.date) ?? { date: row.date };
    map.set(row.date, { ...prev, [key]: row.value });
  }
}

function historicalSecondaryModelName(city: CityConfig): string {
  switch (city.secondaryModel) {
    case 'kma': return 'kma_seamless';
    case 'jma': return 'jma_seamless';
    case 'icon_eu': return 'icon_eu';
    case 'metoffice': return 'ukmo_seamless';
    default: return 'ecmwf_ifs025';
  }
}

function resolveCity(input: string): CityConfig {
  const city = CITIES[input.toLowerCase().replace('-', '_')];
  if (!city) throw new Error(`Unknown city "${input}". Valid: ${Object.keys(CITIES).join(', ')}`);
  return city;
}

function offsetUtcDays(date: Date, offsetDays: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + offsetDays);
  return copy;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function diffDays(fromDate: string, toDate: string): number {
  const from = new Date(`${fromDate}T00:00:00Z`).getTime();
  const to = new Date(`${toDate}T00:00:00Z`).getTime();
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function maybeMean(values: number[]): number | null {
  return values.length ? mean(values) : null;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
