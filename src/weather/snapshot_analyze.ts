import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';

type SnapshotSingle = {
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

type SnapshotBasket = {
  brackets: [string, string];
  labels: [string, string];
  marketPrices: [number, number];
  modelProbabilities: [number, number];
  stakeUsd: [number, number];
  expectedLogGrowth: number;
  profitProbability: number;
  expectedProfitUsd: number;
};

type SnapshotDay = {
  date: string;
  tradeWindowOpenUtc: string;
  tradeWindowCloseUtc: string;
  inTradeWindow: boolean;
  volume: number;
  liquidity: number;
  modelSource: 'postprocessed' | 'ensemble';
  single: SnapshotSingle | null;
  basket: SnapshotBasket | null;
  recommendation: 'single' | 'basket' | 'none';
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

type LogEntry = {
  city: string;
  market_date: string;
  bracket: string;
  order_status: string;
  resolved: boolean;
  actual_bracket: string;
};

type Observation = {
  generatedAt: string;
  city: string;
  cityId: string;
  marketDate: string;
  leadDays: number;
  volume: number;
  liquidity: number;
  modelSource: string;
  recommendation: 'single' | 'basket' | 'none';
  single: SnapshotSingle | null;
  basket: SnapshotBasket | null;
  actualBracket: string | null;
  singlePnlUsd: number | null;
  basketPnlUsd: number | null;
};

const SNAPSHOT_HISTORY_PATH = 'data/weather_snapshot_history.jsonl';
const FORWARD_LOG_PATH = 'data/forward_test_log.csv';
const OUT_PATH = 'data/weather_snapshot_analysis.json';

function parseSnapshotHistory(): SnapshotRun[] {
  if (!existsSync(SNAPSHOT_HISTORY_PATH)) return [];
  return readFileSync(SNAPSHOT_HISTORY_PATH, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as SnapshotRun);
}

function parseForwardLog(): LogEntry[] {
  if (!existsSync(FORWARD_LOG_PATH)) return [];
  const lines = readFileSync(FORWARD_LOG_PATH, 'utf8').trim().split('\n');
  if (lines.length <= 1) return [];
  return lines.slice(1).map(line => {
    const cols = line.split(',');
    const hasOrderCols = cols.length >= 17;
    const base = hasOrderCols ? 2 : 0;
    return {
      city: cols[1] ?? '',
      market_date: cols[2] ?? '',
      bracket: cols[3] ?? '',
      order_status: hasOrderCols ? (cols[11] ?? 'preview') : 'preview',
      resolved: cols[11 + base] === 'true',
      actual_bracket: cols[12 + base] ?? '',
    };
  });
}

function payoutForSingle(single: SnapshotSingle, actualBracket: string): number {
  return single.bracket === actualBracket
    ? single.suggestedUsd * (1 / single.marketPrice - 1)
    : -single.suggestedUsd;
}

function payoutForBasket(basket: SnapshotBasket, actualBracket: string): number {
  if (actualBracket === basket.brackets[0]) {
    return basket.stakeUsd[0] * (1 / basket.marketPrices[0] - 1) - basket.stakeUsd[1];
  }
  if (actualBracket === basket.brackets[1]) {
    return basket.stakeUsd[1] * (1 / basket.marketPrices[1] - 1) - basket.stakeUsd[0];
  }
  return -(basket.stakeUsd[0] + basket.stakeUsd[1]);
}

function diffDays(fromIso: string, marketDate: string): number {
  const from = new Date(fromIso).getTime();
  const to = new Date(`${marketDate}T00:00:00Z`).getTime();
  return Math.round((to - from) / 86_400_000);
}

function liquidityBucket(liquidity: number): string {
  if (liquidity >= 100_000) return '100k+';
  if (liquidity >= 25_000) return '25k-100k';
  return '<25k';
}

function summarizeByKey(observations: Observation[], keyFn: (observation: Observation) => string) {
  const buckets = new Map<string, Observation[]>();
  for (const observation of observations) {
    const key = keyFn(observation);
    const rows = buckets.get(key) ?? [];
    rows.push(observation);
    buckets.set(key, rows);
  }

  return [...buckets.entries()]
    .map(([key, rows]) => {
      const basketBetter = rows.filter(row =>
        row.single && row.basket && row.basket.expectedLogGrowth > row.single.expectedLogGrowth
      );
      const realizedComparable = rows.filter(row => row.singlePnlUsd !== null && row.basketPnlUsd !== null);
      return {
        key,
        observations: rows.length,
        basketRecommendations: rows.filter(row => row.recommendation === 'basket').length,
        basketBetterExAnte: basketBetter.length,
        basketBetterExAntePct: rows.length ? basketBetter.length / rows.length : 0,
        realizedComparable: realizedComparable.length,
        basketBeatSingleRealized: realizedComparable.filter(row => (row.basketPnlUsd ?? Number.NEGATIVE_INFINITY) > (row.singlePnlUsd ?? Number.NEGATIVE_INFINITY)).length,
        singleBeatBasketRealized: realizedComparable.filter(row => (row.singlePnlUsd ?? Number.NEGATIVE_INFINITY) > (row.basketPnlUsd ?? Number.NEGATIVE_INFINITY)).length,
        ties: realizedComparable.filter(row => row.singlePnlUsd === row.basketPnlUsd).length,
      };
    })
    .sort((a, b) => b.observations - a.observations);
}

function main(): void {
  const runs = parseSnapshotHistory();
  const forwardLog = parseForwardLog();
  const actualByCityDate = new Map<string, string>();
  for (const entry of forwardLog) {
    if (!entry.resolved || !entry.actual_bracket) continue;
    actualByCityDate.set(`${entry.city}|${entry.market_date}`, entry.actual_bracket);
  }

  const observations: Observation[] = [];
  for (const run of runs) {
    for (const city of run.cities) {
      for (const day of city.days) {
        const actualBracket = actualByCityDate.get(`${city.cityName}|${day.date}`) ?? null;
        observations.push({
          generatedAt: run.generatedAt,
          city: city.cityName,
          cityId: city.cityId,
          marketDate: day.date,
          leadDays: diffDays(run.generatedAt, day.date),
          volume: day.volume,
          liquidity: day.liquidity,
          modelSource: day.modelSource,
          recommendation: day.recommendation,
          single: day.single,
          basket: day.basket,
          actualBracket,
          singlePnlUsd: actualBracket && day.single ? payoutForSingle(day.single, actualBracket) : null,
          basketPnlUsd: actualBracket && day.basket ? payoutForBasket(day.basket, actualBracket) : null,
        });
      }
    }
  }

  const withSingle = observations.filter(observation => observation.single);
  const withBasket = observations.filter(observation => observation.basket);
  const withBoth = observations.filter(observation => observation.single && observation.basket);
  const basketBetterExAnte = withBoth.filter(observation =>
    (observation.basket?.expectedLogGrowth ?? Number.NEGATIVE_INFINITY) >
    (observation.single?.expectedLogGrowth ?? Number.NEGATIVE_INFINITY)
  );
  const realizedComparable = withBoth.filter(observation => observation.singlePnlUsd !== null && observation.basketPnlUsd !== null);

  const report = {
    generatedAt: new Date().toISOString(),
    snapshotRuns: runs.length,
    observations: observations.length,
    withSingle: withSingle.length,
    withBasket: withBasket.length,
    withBoth: withBoth.length,
    recommendations: {
      single: observations.filter(observation => observation.recommendation === 'single').length,
      basket: observations.filter(observation => observation.recommendation === 'basket').length,
      none: observations.filter(observation => observation.recommendation === 'none').length,
    },
    basketBetterExAnte: {
      count: basketBetterExAnte.length,
      pctOfBoth: withBoth.length ? basketBetterExAnte.length / withBoth.length : 0,
    },
    realizedComparison: {
      comparable: realizedComparable.length,
      basketBeatSingle: realizedComparable.filter(observation => (observation.basketPnlUsd ?? Number.NEGATIVE_INFINITY) > (observation.singlePnlUsd ?? Number.NEGATIVE_INFINITY)).length,
      singleBeatBasket: realizedComparable.filter(observation => (observation.singlePnlUsd ?? Number.NEGATIVE_INFINITY) > (observation.basketPnlUsd ?? Number.NEGATIVE_INFINITY)).length,
      ties: realizedComparable.filter(observation => observation.singlePnlUsd === observation.basketPnlUsd).length,
      singlePnlUsd: realizedComparable.reduce((sum, observation) => sum + (observation.singlePnlUsd ?? 0), 0),
      basketPnlUsd: realizedComparable.reduce((sum, observation) => sum + (observation.basketPnlUsd ?? 0), 0),
    },
    byCity: summarizeByKey(observations, observation => observation.city),
    byLeadDays: summarizeByKey(observations, observation => `lead_${observation.leadDays}`),
    byLiquidityBucket: summarizeByKey(observations, observation => liquidityBucket(observation.liquidity)),
    basketExamples: basketBetterExAnte
      .slice(0, 20)
      .map(observation => ({
        generatedAt: observation.generatedAt,
        city: observation.city,
        marketDate: observation.marketDate,
        leadDays: observation.leadDays,
        liquidity: observation.liquidity,
        actualBracket: observation.actualBracket,
        single: observation.single,
        basket: observation.basket,
        singlePnlUsd: observation.singlePnlUsd,
        basketPnlUsd: observation.basketPnlUsd,
      })),
  };

  mkdirSync('data', { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(report, null, 2), 'utf8');

  console.log(`Snapshot runs: ${report.snapshotRuns}`);
  console.log(`Observations: ${report.observations} | single: ${report.withSingle} | basket: ${report.withBasket} | both: ${report.withBoth}`);
  console.log(`Recommendations — single: ${report.recommendations.single}, basket: ${report.recommendations.basket}, none: ${report.recommendations.none}`);
  console.log(`Basket better ex-ante: ${report.basketBetterExAnte.count}`);
  console.log(`Realized comparable: ${report.realizedComparison.comparable} | basket P&L: $${report.realizedComparison.basketPnlUsd.toFixed(2)} | single P&L: $${report.realizedComparison.singlePnlUsd.toFixed(2)}`);
  console.log(`Report → ${OUT_PATH}`);
}

if (require.main === module) {
  main();
}
