/**
 * Live weather snapshot recorder.
 *
 * Persists the exact model probabilities, market prices, and recommendation
 * context we see during each run so future strategy analysis can use our own
 * time-stamped dataset instead of depending on incomplete public history.
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
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
import { tradeWindowOpenUtcMs, cityDayEndUtcMs } from './time';

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
  tradeWindowCloseUtc: string;
  inTradeWindow: boolean;
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
  days: SnapshotDay[];
};

type SnapshotRun = {
  generatedAt: string;
  cityCount: number;
  forecastDays: number;
  cities: SnapshotCity[];
};

const args = process.argv.slice(2);
const daysIdx = args.indexOf('--days');
const forecastDays = daysIdx !== -1 ? parseInt(args[daysIdx + 1] ?? '3', 10) : 3;
const HISTORY_PATH = 'data/weather_snapshot_history.jsonl';
const LATEST_PATH = 'data/weather_snapshot_latest.json';
const TRADE_WINDOW_HOURS = 8;
const BANKROLL_USD = 1000;

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

    const windowOpenMs = tradeWindowOpenUtcMs(date, city.timezone, TRADE_WINDOW_HOURS);
    const windowCloseMs = cityDayEndUtcMs(date, city.timezone);

    days.push({
      date,
      tradeWindowOpenUtc: new Date(windowOpenMs).toISOString(),
      tradeWindowCloseUtc: new Date(windowCloseMs).toISOString(),
      inTradeWindow: Date.now() >= windowOpenMs && Date.now() < windowCloseMs,
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
    days,
  };
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

async function main(): Promise<void> {
  const cities: SnapshotCity[] = [];
  for (const cityId of FORWARD_TEST_CITY_IDS) {
    const city = CITIES[cityId];
    if (!city) continue;
    process.stdout.write(`  [${city.name}] snapshot… `);
    const snapshot = await snapshotCity(city);
    cities.push(snapshot);
    process.stdout.write(`${snapshot.days.length} day(s)\n`);
  }

  const run: SnapshotRun = {
    generatedAt: new Date().toISOString(),
    cityCount: cities.length,
    forecastDays,
    cities,
  };

  mkdirSync('data', { recursive: true });
  writeFileSync(LATEST_PATH, JSON.stringify(run, null, 2), 'utf8');
  appendFileSync(HISTORY_PATH, JSON.stringify(run) + '\n', 'utf8');

  console.log(`Snapshot latest → ${LATEST_PATH}`);
  console.log(`Snapshot history append → ${HISTORY_PATH}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
