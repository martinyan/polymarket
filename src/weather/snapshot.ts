/**
 * Live weather snapshot recorder.
 *
 * Persists the exact model probabilities, market prices, and recommendation
 * context we see during each run so future strategy analysis can use our own
 * time-stamped dataset instead of depending on incomplete public history.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { fetchEcmwfEnsemble, fetchSecondaryForecast } from './ensemble';
import { fetchMarketOdds, cityWithMarketBrackets } from './polymarket_odds';
import { computeBracketProbabilities } from './brackets';
import { FORWARD_TEST_CITY_IDS, CITIES, CityConfig } from './cities';
import {
  applySingleMarketKellyRecommendation,
  computeBetSignals,
  expectedLogGrowthForSingle,
  findBestTwoBracketBasket,
} from './ev';
import {
  applyObservedFloorToProbabilities,
  applyStationPostProcessorToTemps,
  computePostProcessedBracketProbabilities,
  loadStationPostProcessor,
  validatePostProcessedBracketProbabilities,
} from './postprocess';
import { buildCurrentForecastFeatureRows } from './train_postprocess';
import { applyLiveMetarTemperatureFloor, applyTafRiskToSignals, fetchStationNowcast, fetchTafRiskOverlay } from './aviation';
import { cityDayEndUtcMs } from './time';
import {
  forcedFallbackWindowOpenUtcMs,
  normalTradeWindowOpenUtcMs,
} from './forward_policy';

type SnapshotLeg = {
  bracket: string;
  label: string;
  modelProb: number;
  marketPrice: number;
  edge: number;
  evPerDollar: number;
  kellyFraction: number;
  suggestedUsd: number;
  action: string;
  reason?: string;
};

type SnapshotDay = {
  date: string;
  tradeWindowOpenUtc: string;
  forcedFallbackWindowOpenUtc: string;
  tradeWindowCloseUtc: string;
  inTradeWindow: boolean;
  inForcedFallbackWindow: boolean;
  volume: number;
  liquidity: number;
  modelSource: 'postprocessed' | 'ensemble';
  modelProbs: Record<string, number>;
  marketProbs: Record<string, number>;
  single: null | {
    bracket: string;
    label: string;
    marketPrice: number;
    modelProb: number;
    edge: number;
    evPerDollar: number;
    kellyFraction: number;
    suggestedUsd: number;
    expectedLogGrowth: number;
  };
  basket: null | {
    brackets: [string, string];
    labels: [string, string];
    marketPrices: [number, number];
    modelProbabilities: [number, number];
    stakeUsd: [number, number];
    expectedLogGrowth: number;
    profitProbability: number;
    expectedProfitUsd: number;
  };
  recommendation: 'single' | 'basket' | 'none';
  signals: SnapshotLeg[];
};

type SnapshotCity = {
  cityId: string;
  cityName: string;
  stationCode: string;
  secondaryModel: string;
  generatedAt: string;
  days: SnapshotDay[];
};

type SnapshotRun = {
  generatedAt: string;
  cityCount: number;
  forecastDays: number;
  cities: SnapshotCity[];
  refreshedCityIds?: string[];
  skippedCityIds?: string[];
};

const args = process.argv.slice(2);
const daysIdx = args.indexOf('--days');
const forecastDays = daysIdx !== -1 ? parseInt(args[daysIdx + 1] ?? '2', 10) : 2;
const HISTORY_PATH = 'data/weather_snapshot_history.jsonl';
const LATEST_PATH = 'data/weather_snapshot_latest.json';
const CITY_SNAPSHOT_DIR = 'data/weather_snapshot_latest_cities';
const BANKROLL_USD = 1000;
const CITY_REQUEST_STAGGER_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function rotateCityIds(cityIds: readonly string[], offset: number): string[] {
  if (!cityIds.length) return [];
  const normalized = ((offset % cityIds.length) + cityIds.length) % cityIds.length;
  return [...cityIds.slice(normalized), ...cityIds.slice(0, normalized)];
}

async function snapshotCity(city: CityConfig): Promise<SnapshotCity> {
  const ecmwfMembers = await fetchEcmwfEnsemble(city, forecastDays);
  let stationNowcast = null;
  try { stationNowcast = await fetchStationNowcast(city.stationCode); } catch {}
  let tafOverlay = null;
  try { tafOverlay = await fetchTafRiskOverlay(city.stationCode); } catch {}
  const postProcessor = loadStationPostProcessor(city);
  const featureRows = postProcessor ? await buildCurrentForecastFeatureRows(city, forecastDays) : new Map();

  let secondaryMembers = [];
  if (city.secondaryModel !== 'none') {
    try { secondaryMembers = await fetchSecondaryForecast(city, Math.min(forecastDays, 5)); } catch {}
  }
  void secondaryMembers;

  const dates = [...new Set(ecmwfMembers.map(member => member.date))].sort();
  const days: SnapshotDay[] = [];

  for (const date of dates) {
    const baseTemps = ecmwfMembers.filter(member => member.date === date).map(member => member.tempMaxC);
    let odds = null;
    try { odds = await fetchMarketOdds(city, date); } catch {}
    const marketCity = odds ? cityWithMarketBrackets(city, odds) : city;
    const calibration = applyStationPostProcessorToTemps(city, baseTemps, featureRows.get(date) ?? {
      date,
      ecmwfMeanC: mean(baseTemps),
      gfsMeanC: null,
      aifsMeanC: null,
      secondaryMeanC: null,
      leadDays: 0,
    }, postProcessor);
    const metarFloor = applyLiveMetarTemperatureFloor(calibration.temps, marketCity, date, stationNowcast);
    const probRow = featureRows.get(date) ?? {
      date,
      ecmwfMeanC: mean(baseTemps),
      gfsMeanC: null,
      aifsMeanC: null,
      secondaryMeanC: null,
      leadDays: 0,
    };
    const probabilistic = computePostProcessedBracketProbabilities(marketCity, probRow, postProcessor);
    const useProbabilistic = probabilistic.probs && validatePostProcessedBracketProbabilities(probabilistic.probs, marketCity, metarFloor.temps);
    const modelProbs = useProbabilistic
      ? (metarFloor.adjustment
          ? applyObservedFloorToProbabilities(probabilistic.probs, marketCity, metarFloor.adjustment.observedMaxSoFarC)
          : probabilistic.probs)
      : computeBracketProbabilities(metarFloor.temps, marketCity, 0);
    const marketProbs = Object.fromEntries((odds?.bracketMarkets ?? []).map(market => [market.bracket, market.yesAsk]));
    const rawSignals = computeBetSignals(modelProbs, marketProbs, marketCity, BANKROLL_USD);
    const tafAdjusted = applyTafRiskToSignals(rawSignals, tafOverlay);
    const singleSignals = applySingleMarketKellyRecommendation(tafAdjusted);
    const bestSingle = singleSignals.find(signal => signal.action === 'BUY') ?? null;
    const basket = bestSingle ? findBestTwoBracketBasket(tafAdjusted, BANKROLL_USD, bestSingle.suggestedUsd) : null;
    const singleLogGrowth = bestSingle ? expectedLogGrowthForSingle(bestSingle, BANKROLL_USD) : Number.NEGATIVE_INFINITY;
    const recommendation: SnapshotDay['recommendation'] =
      basket && bestSingle && basket.expectedLogGrowth > singleLogGrowth + 1e-9 && basket.profitProbability > bestSingle.modelProb + 1e-9
        ? 'basket'
        : bestSingle
          ? 'single'
          : 'none';

    const windowOpenMs = normalTradeWindowOpenUtcMs(date, city.timezone);
    const forcedWindowOpenMs = forcedFallbackWindowOpenUtcMs(date, city.timezone);
    const windowCloseMs = cityDayEndUtcMs(date, city.timezone);

    days.push({
      date,
      tradeWindowOpenUtc: new Date(windowOpenMs).toISOString(),
      forcedFallbackWindowOpenUtc: new Date(forcedWindowOpenMs).toISOString(),
      tradeWindowCloseUtc: new Date(windowCloseMs).toISOString(),
      inTradeWindow: Date.now() >= windowOpenMs && Date.now() < windowCloseMs,
      inForcedFallbackWindow: Date.now() >= forcedWindowOpenMs && Date.now() < windowCloseMs,
      volume: odds?.volume ?? 0,
      liquidity: odds?.liquidity ?? 0,
      modelSource: useProbabilistic ? 'postprocessed' : 'ensemble',
      modelProbs,
      marketProbs,
      single: bestSingle ? {
        bracket: bestSingle.bracket,
        label: bestSingle.label,
        marketPrice: bestSingle.marketPrice,
        modelProb: bestSingle.modelProb,
        edge: bestSingle.edge,
        evPerDollar: bestSingle.evPerDollar,
        kellyFraction: bestSingle.kellyFraction,
        suggestedUsd: bestSingle.suggestedUsd,
        expectedLogGrowth: singleLogGrowth,
      } : null,
      basket: basket ? {
        brackets: basket.brackets,
        labels: basket.labels,
        marketPrices: basket.marketPrices,
        modelProbabilities: basket.modelProbabilities,
        stakeUsd: basket.stakeUsd,
        expectedLogGrowth: basket.expectedLogGrowth,
        profitProbability: basket.profitProbability,
        expectedProfitUsd: basket.expectedProfitUsd,
      } : null,
      recommendation,
      signals: tafAdjusted.map(signal => ({
        bracket: signal.bracket,
        label: signal.label,
        modelProb: signal.modelProb,
        marketPrice: signal.marketPrice,
        edge: signal.edge,
        evPerDollar: signal.evPerDollar,
        kellyFraction: signal.kellyFraction,
        suggestedUsd: signal.suggestedUsd,
        action: signal.action,
        reason: signal.reason,
      })),
    });
  }

  return {
    cityId: city.id,
    cityName: city.name,
    stationCode: city.stationCode,
    secondaryModel: city.secondaryModel,
    generatedAt: new Date().toISOString(),
    days,
  };
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

async function main(): Promise<void> {
  const refreshedCities: SnapshotCity[] = [];
  const skippedCityIds: string[] = [];
  const rotatedCityIds = rotateCityIds(FORWARD_TEST_CITY_IDS, Math.floor(Date.now() / 1_800_000));
  for (const [index, cityId] of rotatedCityIds.entries()) {
    const city = CITIES[cityId];
    if (!city) continue;
    if (index > 0) await sleep(CITY_REQUEST_STAGGER_MS);
    process.stdout.write(`  [${city.name}] snapshot… `);
    try {
      const snapshot = await snapshotCity(city);
      refreshedCities.push(snapshot);
      process.stdout.write(`${snapshot.days.length} day(s)\n`);
    } catch (error) {
      skippedCityIds.push(city.id);
      process.stdout.write(`skipped (${error instanceof Error ? error.message : String(error)})\n`);
    }
  }

  mkdirSync('data', { recursive: true });
  mkdirSync(CITY_SNAPSHOT_DIR, { recursive: true });

  for (const city of refreshedCities) {
    writeFileSync(citySnapshotPath(city.cityId), JSON.stringify(city, null, 2), 'utf8');
  }

  const mergedCities = loadMergedLatestCities();
  if (!mergedCities.length) {
    throw new Error('No snapshot data collected; refusing to overwrite snapshot files');
  }
  if (!refreshedCities.length) {
    throw new Error('No city snapshot refreshed in this run; keeping previous latest snapshot files untouched');
  }

  const generatedAt = new Date().toISOString();
  const latestRun: SnapshotRun = {
    generatedAt,
    cityCount: mergedCities.length,
    forecastDays,
    cities: mergedCities,
    refreshedCityIds: refreshedCities.map(city => city.cityId),
    skippedCityIds,
  };
  const historyRun: SnapshotRun = {
    generatedAt,
    cityCount: refreshedCities.length,
    forecastDays,
    cities: refreshedCities,
    refreshedCityIds: refreshedCities.map(city => city.cityId),
    skippedCityIds,
  };

  writeFileSync(LATEST_PATH, JSON.stringify(latestRun, null, 2), 'utf8');
  appendFileSync(HISTORY_PATH, JSON.stringify(historyRun) + '\n', 'utf8');

  console.log(`Snapshot latest → ${LATEST_PATH}`);
  console.log(`Snapshot city cache → ${CITY_SNAPSHOT_DIR}`);
  console.log(`Snapshot history append → ${HISTORY_PATH}`);
}

function loadMergedLatestCities(): SnapshotCity[] {
  const ids = new Set<string>(FORWARD_TEST_CITY_IDS);
  const loaded = new Map<string, SnapshotCity>();
  const cityOrder = new Map(FORWARD_TEST_CITY_IDS.map((cityId, index) => [cityId, index]));

  for (const cityId of ids) {
    const path = citySnapshotPath(cityId);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as SnapshotCity;
      if (parsed?.cityId) {
        loaded.set(parsed.cityId, parsed);
      }
    } catch {
      // Ignore corrupt per-city cache and continue with other cities.
    }
  }

  if (!loaded.size && existsSync(LATEST_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(LATEST_PATH, 'utf8')) as SnapshotRun;
      for (const city of parsed.cities ?? []) {
        if (city?.cityId) loaded.set(city.cityId, city);
      }
    } catch {
      // Ignore corrupt merged cache when there are no city files to read.
    }
  }

  return [...loaded.values()].sort((a, b) =>
    (cityOrder.get(a.cityId as (typeof FORWARD_TEST_CITY_IDS)[number]) ?? Number.MAX_SAFE_INTEGER) -
    (cityOrder.get(b.cityId as (typeof FORWARD_TEST_CITY_IDS)[number]) ?? Number.MAX_SAFE_INTEGER)
  );
}

function citySnapshotPath(cityId: string): string {
  return `${CITY_SNAPSHOT_DIR}/${cityId}.json`;
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
