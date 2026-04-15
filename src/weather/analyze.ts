/**
 * Weather edge analysis runner.
 *
 * Usage:
 *   npx tsx src/weather/analyze.ts [--city <id>] [--days N] [--bias B]
 *
 * Examples:
 *   npx tsx src/weather/analyze.ts --city london --days 3
 *   npx tsx src/weather/analyze.ts --city seoul --bias -0.5
 */

import { fetchEcmwfEnsemble, fetchKmaForecast, fetchMetOfficeEnsemble, EnsembleMember } from './ensemble';
import { fetchMarketOdds, MarketOdds, cityWithMarketBrackets } from './polymarket_odds';
import { computeBracketProbabilities, computeEdgeTable, BracketProbabilities } from './brackets';
import { fetchMonthlyAnomaly } from './gistemp';
import { parseCityArg, CITIES } from './cities';
import { applyLiveMetarTemperatureFloor, fetchStationNowcast, fetchTafRiskOverlay, StationNowcast, TafRiskOverlay } from './aviation';
import {
  applyObservedFloorToProbabilities,
  applyStationPostProcessorToTemps,
  computePostProcessedBracketProbabilities,
  loadStationPostProcessor,
  validatePostProcessedBracketProbabilities,
} from './postprocess';
import { buildCurrentForecastFeatureRows } from './train_postprocess';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let forecastDays  = 7;
let biasCorrection = 0;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--days' && args[i + 1]) forecastDays   = parseInt(args[++i], 10);
  if (args[i] === '--bias' && args[i + 1]) biasCorrection = parseFloat(args[++i]);
}

const city = parseCityArg(args);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n=== Polymarket Weather Edge Analyzer — ${city.name} ===`);
  console.log(`Resolution station: ${city.wundergroundUrl}`);
  console.log(`Coordinates: ${city.lat}°N, ${city.lon}°E`);
  console.log(`Bias correction: ${biasCorrection >= 0 ? '+' : ''}${biasCorrection}°C\n`);

  // Seasonal anomaly
  console.log('Fetching seasonal anomaly…');
  let anomaly: { anomalyC: number; year: number; month: number } | null = null;
  try {
    anomaly = await fetchMonthlyAnomaly(city);
    const sign = anomaly.anomalyC >= 0 ? '+' : '';
    console.log(`  → ${anomaly.year}-${String(anomaly.month).padStart(2,'0')}: ${sign}${anomaly.anomalyC.toFixed(2)}°C vs 1991-2020 normal\n`);
  } catch (e) {
    console.warn(`  ⚠ ${(e as Error).message}\n`);
  }

  // ECMWF ensemble
  console.log('Fetching ECMWF IFS ensemble (51 members)…');
  let ecmwfMembers: EnsembleMember[] = [];
  try {
    ecmwfMembers = await fetchEcmwfEnsemble(city, forecastDays);
    const dates = [...new Set(ecmwfMembers.map(m => m.date))];
    console.log(`  → ${ecmwfMembers.length} member-days across ${dates.length} dates\n`);
  } catch (e) {
    console.error(`  ✗ ${(e as Error).message}`); process.exit(1);
  }

  // Secondary model: KMA for Seoul, Met Office for London
  let secondaryMembers: EnsembleMember[] = [];
  if (city.id === 'seoul') {
    console.log('Fetching KMA LDPS (1.5km, 2-day)…');
    try {
      secondaryMembers = await fetchKmaForecast(city, 2);
      for (const f of secondaryMembers) console.log(`  → ${f.date}: ${f.tempMaxC.toFixed(1)}°C`);
      console.log('');
    } catch (e) { console.warn(`  ⚠ ${(e as Error).message}\n`); }
  } else if (city.id === 'london') {
    console.log('Fetching UK Met Office ensemble…');
    try {
      secondaryMembers = await fetchMetOfficeEnsemble(city, forecastDays);
      const dates = [...new Set(secondaryMembers.map(m => m.date))];
      console.log(`  → ${secondaryMembers.length} member-days across ${dates.length} dates\n`);
    } catch (e) { console.warn(`  ⚠ ${(e as Error).message}\n`); }
  }

  let stationNowcast: StationNowcast | null = null;
  let tafOverlay: TafRiskOverlay | null = null;
  console.log('Fetching station METAR history…');
  try {
    stationNowcast = await fetchStationNowcast(city.stationCode);
    if (stationNowcast.latest?.reportTime && stationNowcast.latest.tempC !== null) {
      console.log(`  → ${stationNowcast.latest.stationCode} latest ${stationNowcast.latest.tempC.toFixed(1)}°C @ ${stationNowcast.latest.reportTime}; ${stationNowcast.observations.length} recent METAR(s)\n`);
    } else {
      console.log('  → no fresh METAR available\n');
    }
  } catch (e) {
    console.warn(`  ⚠ ${(e as Error).message}\n`);
  }
  console.log('Fetching station TAF…');
  try {
    tafOverlay = await fetchTafRiskOverlay(city.stationCode);
    if (tafOverlay) console.log(`  → ${tafOverlay.summary}\n`);
  } catch (e) {
    console.warn(`  ⚠ ${(e as Error).message}\n`);
  }

  // Polymarket odds
  console.log('Fetching Polymarket live odds…');
  const dates = [...new Set(ecmwfMembers.map(m => m.date))].sort();
  const postProcessor = loadStationPostProcessor(city);
  const featureRows = postProcessor ? await buildCurrentForecastFeatureRows(city, forecastDays) : new Map();
  const oddsMap: Record<string, Partial<BracketProbabilities>> = {};
  const marketOddsMap: Record<string, MarketOdds> = {};
  const volumeMap: Record<string, number> = {};

  for (const date of dates) {
    try {
      const odds = await fetchMarketOdds(city, date);
      if (odds) {
        oddsMap[date]       = odds.probs;
        marketOddsMap[date] = odds;
        volumeMap[date]     = odds.volume;
        console.log(`  → ${date}: $${Math.round(odds.volume).toLocaleString()} vol, $${Math.round(odds.liquidity).toLocaleString()} liq`);
      } else {
        console.log(`  → ${date}: no market found`);
      }
    } catch (e) { console.warn(`  ⚠ ${date}: ${(e as Error).message}`); }
  }
  console.log('');

  // Per-date output
  for (const date of dates) {
    const members  = ecmwfMembers.filter(m => m.date === date);
    const baseTemps = members.map(m => m.tempMaxC);
    const secondary = secondaryMembers.filter(m => m.date === date);

    const marketCity  = marketOddsMap[date] ? cityWithMarketBrackets(city, marketOddsMap[date]) : city;
    const calibration = applyStationPostProcessorToTemps(city, baseTemps, featureRows.get(date) ?? {
      date,
      ecmwfMeanC: mean(baseTemps),
      gfsMeanC: null,
      aifsMeanC: null,
      secondaryMeanC: null,
      leadDays: 0,
    }, postProcessor);
    const metarFloor  = applyLiveMetarTemperatureFloor(calibration.temps, marketCity, date, stationNowcast);
    const temps       = metarFloor.temps;
    const probRow = featureRows.get(date) ?? {
      date,
      ecmwfMeanC: mean(baseTemps),
      gfsMeanC: null,
      aifsMeanC: null,
      secondaryMeanC: null,
      leadDays: 0,
    };
    const probabilistic = computePostProcessedBracketProbabilities(marketCity, probRow, postProcessor);
    const useProbabilistic = probabilistic.probs && validatePostProcessedBracketProbabilities(probabilistic.probs, marketCity, temps);
    const modelProbs  = useProbabilistic
      ? (metarFloor.adjustment
          ? applyObservedFloorToProbabilities(probabilistic.probs, marketCity, metarFloor.adjustment.observedMaxSoFarC)
          : probabilistic.probs)
      : computeBracketProbabilities(temps, marketCity, biasCorrection);
    const marketProbs = oddsMap[date] ?? {};
    const edgeTable   = computeEdgeTable(modelProbs, marketProbs, marketCity);

    const eMean = mean(temps);
    const eStd  = stdDev(temps);
    const p10   = pct(temps, 10);
    const p90   = pct(temps, 90);

    console.log(`─────────────────────────────────────────────`);
    console.log(`${date}  |  ${city.name}`);
    console.log(`ECMWF: mean=${eMean.toFixed(1)}°C  std=±${eStd.toFixed(1)}°C  p10=${p10.toFixed(1)}  p90=${p90.toFixed(1)}`);
    if (calibration.adjustment) {
      console.log(`Station post-process: shift ${calibration.adjustment.shiftC >= 0 ? '+' : ''}${calibration.adjustment.shiftC.toFixed(2)}°C  (rmse ${calibration.adjustment.rmseC.toFixed(2)}°C, n=${calibration.adjustment.sampleCount})`);
      if (calibration.adjustment.p10C !== undefined && calibration.adjustment.p90C !== undefined) {
        console.log(`Calibrated quantiles: p10=${calibration.adjustment.p10C.toFixed(1)}°C  p50=${(calibration.adjustment.p50C ?? calibration.adjustment.calibratedMeanC).toFixed(1)}°C  p90=${calibration.adjustment.p90C.toFixed(1)}°C  lead=${calibration.adjustment.leadDays}d`);
      }
    }
    if (metarFloor.adjustment) {
      console.log(`Observed max-so-far floor: ${metarFloor.adjustment.observedMaxSoFarC.toFixed(1)}°C from ${metarFloor.adjustment.observationCount} METAR(s)  (${metarFloor.adjustment.method}, removed ${metarFloor.adjustment.discardedMemberCount})`);
    }
    if (tafOverlay && tafOverlay.multiplier < 1) {
      console.log(`TAF risk overlay: ${tafOverlay.multiplier.toFixed(2)}x sizing  (${tafOverlay.reasons.join('; ')})`);
    }

    if (secondary.length === 1) {
      console.log(`${city.id === 'seoul' ? 'KMA LDPS' : 'Met Office'}: ${secondary[0].tempMaxC.toFixed(1)}°C`);
    } else if (secondary.length > 1) {
      const sTemps = secondary.map(m => m.tempMaxC);
      console.log(`Met Office ensemble: mean=${mean(sTemps).toFixed(1)}°C  std=±${stdDev(sTemps).toFixed(1)}°C  (${sTemps.length} members)`);
    }

    if (anomaly) {
      const sign = anomaly.anomalyC >= 0 ? '+' : '';
      console.log(`Seasonal anomaly: ${sign}${anomaly.anomalyC.toFixed(2)}°C`);
    }
    if (volumeMap[date]) console.log(`Market volume: $${Math.round(volumeMap[date]).toLocaleString()}`);
    console.log('');

    const hasMarket = Object.keys(marketProbs).length > 0;
    console.log(`  Bracket    Model%  Market%    Edge`);
    console.log(`  ─────────────────────────────────`);
    for (const row of edgeTable.filter(r => r.modelProb > 0 || r.marketProb > 0)) {
      const mp  = (row.modelProb * 100).toFixed(1).padStart(6);
      const mkp = hasMarket && row.marketProb > 0 ? (row.marketProb * 100).toFixed(1).padStart(6) : '   n/a';
      const ep  = hasMarket && row.marketProb > 0 ? `${row.edge >= 0 ? '+' : ''}${(row.edge * 100).toFixed(1)}%`.padStart(7) : '      —';
      const flag = hasMarket && Math.abs(row.edge) >= 0.05 ? ' ◄' : '';
      console.log(`  ${row.label.padEnd(10)} ${mp}%  ${mkp}%  ${ep}${flag}`);
    }
    console.log('');
  }

  console.log(`Available cities: ${Object.keys(CITIES).join(', ')}`);
}

function mean(v: number[]) { return v.length ? v.reduce((a,b) => a+b,0)/v.length : 0; }
function stdDev(v: number[]) {
  if (!v.length) return 0;
  const m = mean(v);
  return Math.sqrt(v.reduce((a,b) => a+(b-m)**2,0)/v.length);
}
function pct(v: number[], p: number) {
  if (!v.length) return 0;
  const s = [...v].sort((a,b) => a-b);
  return s[Math.min(Math.floor(p/100*s.length), s.length-1)];
}

main().catch(e => { console.error(e); process.exit(1); });
