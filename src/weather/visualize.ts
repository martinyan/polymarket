/**
 * Multi-city weather edge visualizer with EV, Kelly, and arbitrage signals.
 *
 * Usage:
 *   npx tsx src/weather/visualize.ts [--city <id|all>] [--days N] [--bias B] [--bankroll N] [--out path]
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { fetchEcmwfEnsemble, fetchSecondaryForecast, EnsembleMember } from './ensemble';
import { fetchMarketOdds, cityWithMarketBrackets, MarketOdds } from './polymarket_odds';
import { computeBracketProbabilities, computeEdgeTable, buildBrackets, bracketLabel, BracketProbabilities } from './brackets';
import { fetchMonthlyAnomaly } from './gistemp';
import { CITIES, CityConfig, PORTAL_CITY_IDS, TARGET_WEATHER_CITY_COUNT } from './cities';
import { applySingleMarketKellyRecommendation, computeBetSignals, detectArbOpportunity, BetSignal, ArbSignal } from './ev';
import { applyLiveMetarTemperatureFloor, applyTafRiskToSignals, fetchStationNowcast, fetchTafRiskOverlay, LiveTemperatureFloorAdjustment, StationNowcast, TafRiskOverlay } from './aviation';
import {
  applyObservedFloorToProbabilities,
  applyStationPostProcessorToTemps,
  computePostProcessedBracketProbabilities,
  loadStationPostProcessor,
  PostProcessAdjustment,
  validatePostProcessedBracketProbabilities,
} from './postprocess';
import { buildCurrentForecastFeatureRows } from './train_postprocess';
import { cityDayEndUtcMs, tradeWindowOpenUtcMs } from './time';
import { ENV as _ENV } from '../config';
const IS_LIVE_NOTE = _ENV.PREVIEW_MODE ? '🟡 PREVIEW MODE — no real orders placed' : '🔴 LIVE MODE — real orders placed';

// ---------------------------------------------------------------------------
// Trade window helpers (mirrors forwardtest.ts logic)
// ---------------------------------------------------------------------------
const TRADE_WINDOW_HOURS = 8;
function tradeWindowStatus(date: string, tz: string): { open: boolean; opensAt: string; closesAt: string } {
  const dayEndMs   = cityDayEndUtcMs(date, tz);
  const openMs     = tradeWindowOpenUtcMs(date, tz, TRADE_WINDOW_HOURS);
  const now        = Date.now();
  const fmt = (ms: number) => new Date(ms).toISOString().slice(11, 16) + ' UTC';
  return { open: now >= openMs && now < dayEndMs, opensAt: fmt(openMs), closesAt: fmt(dayEndMs) };
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let forecastDays   = 7;
let biasCorrection = 0;
let bankrollUsd    = 1000;
let outPath        = 'data/weather_analysis.html';

const cityIdx = args.indexOf('--city');
const cityArg = cityIdx !== -1 ? args[cityIdx + 1] : 'all';
const cityIds = cityArg === 'all' ? PORTAL_CITY_IDS : [cityArg];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--days'     && args[i+1]) forecastDays   = parseInt(args[++i], 10);
  if (args[i] === '--bias'     && args[i+1]) biasCorrection = parseFloat(args[++i]);
  if (args[i] === '--bankroll' && args[i+1]) bankrollUsd    = parseFloat(args[++i]);
  if (args[i] === '--out'      && args[i+1]) outPath        = args[++i];
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type DateSnapshot = {
  date: string;
  ensembleMean: number; ensembleStd: number; p10: number; p90: number;
  secondaryLabel: string;
  secondaryMean: number | null; secondaryStd: number | null;
  marketCity: CityConfig;
  modelProbs: BracketProbabilities;
  marketProbs: Partial<BracketProbabilities>;
  rawPrices: Partial<BracketProbabilities>;   // un-normalised for arb detection
  members: number[];
  volume: number; liquidity: number;
  signals: BetSignal[];
  marketDataSource: 'live' | 'snapshot' | 'none';
  marketDataGeneratedAt: string | null;
  signalSource: 'live' | 'snapshot';
  signalGeneratedAt: string | null;
  arb: ArbSignal | null;
  aviation: LiveTemperatureFloorAdjustment | null;
  taf: TafRiskOverlay | null;
  postprocess: PostProcessAdjustment | null;
};

type CityResult = {
  city: CityConfig;
  anomaly: { year: number; month: number; anomalyC: number } | null;
  snapshots: DateSnapshot[];
};

type PersistedSnapshotDay = {
  date: string;
  volume: number;
  liquidity: number;
  marketProbs: Record<string, number>;
  signals: Array<{
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
  }>;
};

type PersistedSnapshotRun = {
  generatedAt: string;
  cities: Array<{
    cityId: string;
    generatedAt?: string;
    days: PersistedSnapshotDay[];
  }>;
};

type ForwardLogRow = {
  logged_at: string;
  city: string;
  market_date: string;
  suggested_usd: number;
  resolved: boolean;
  pnl: number;
};

type IndexedSnapshotDay = PersistedSnapshotDay & {
  snapshotGeneratedAt: string | null;
  latestRunGeneratedAt: string;
};

function loadLatestSnapshotIndex(): Map<string, IndexedSnapshotDay> {
  const snapshotPath = 'data/weather_snapshot_latest.json';
  if (!existsSync(snapshotPath)) return new Map();
  try {
    const raw = readFileSync(snapshotPath, 'utf8');
    const parsed = JSON.parse(raw) as PersistedSnapshotRun;
    const index = new Map<string, IndexedSnapshotDay>();
    for (const city of parsed.cities ?? []) {
      for (const day of city.days ?? []) {
        index.set(`${city.cityId}:${day.date}`, {
          ...day,
          snapshotGeneratedAt: city.generatedAt ?? parsed.generatedAt ?? null,
          latestRunGeneratedAt: parsed.generatedAt,
        });
      }
    }
    return index;
  } catch {
    return new Map();
  }
}

const latestSnapshotIndex = loadLatestSnapshotIndex();
const forwardTestState = loadForwardTestState();

function loadForwardTestState(): {
  entries: ForwardLogRow[];
  unresolvedKeys: Set<string>;
  bankrollUsd: number;
  startedAt: string | null;
} {
  const csvPath = 'data/forward_test_log.csv';
  if (!existsSync(csvPath)) {
    return { entries: [], unresolvedKeys: new Set<string>(), bankrollUsd: 1000, startedAt: null };
  }

  const raw = readFileSync(csvPath, 'utf8').trim();
  if (!raw) {
    return { entries: [], unresolvedKeys: new Set<string>(), bankrollUsd: 1000, startedAt: null };
  }

  const lines = raw.split('\n');
  if (lines.length <= 1) {
    return { entries: [], unresolvedKeys: new Set<string>(), bankrollUsd: 1000, startedAt: null };
  }

  const entries: ForwardLogRow[] = lines.slice(1).map(line => {
    const cols = line.split(',');
    const hasOrderCols = cols.length >= 17;
    const base = hasOrderCols ? 2 : 0;
    return {
      logged_at: cols[0] ?? '',
      city: cols[1] ?? '',
      market_date: cols[2] ?? '',
      suggested_usd: parseFloat(cols[10] ?? '0'),
      resolved: cols[11 + base] === 'true',
      pnl: parseFloat(cols[13 + base] ?? '0'),
    };
  });

  const unresolvedKeys = new Set(entries.filter(entry => !entry.resolved).map(entry => `${entry.city}|${entry.market_date}`));
  const closedPnl = entries.filter(entry => entry.resolved).reduce((sum, entry) => sum + entry.pnl, 0);
  const openRisk = entries.filter(entry => !entry.resolved).reduce((sum, entry) => sum + entry.suggested_usd, 0);

  return {
    entries,
    unresolvedKeys,
    bankrollUsd: Math.max(0, 1000 + closedPnl - openRisk),
    startedAt: entries[0]?.logged_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------
async function fetchCityData(city: CityConfig): Promise<CityResult> {
  process.stdout.write(`  [${city.name}] ECMWF ensemble… `);
  const ecmwfMembers = await fetchEcmwfEnsemble(city, forecastDays);
  process.stdout.write(`${ecmwfMembers.length} member-days\n`);

  let stationNowcast: StationNowcast | null = null;
  try { stationNowcast = await fetchStationNowcast(city.stationCode); } catch {}
  let tafOverlay: TafRiskOverlay | null = null;
  try { tafOverlay = await fetchTafRiskOverlay(city.stationCode); } catch {}
  const postProcessor = loadStationPostProcessor(city);
  const featureRows = postProcessor ? await buildCurrentForecastFeatureRows(city, forecastDays) : new Map();

  let secondaryMembers: EnsembleMember[] = [];
  const secondaryModelLabels: Record<string, string> = {
    kma: 'KMA LDPS', jma: 'JMA MSM', icon_eu: 'ICON-EU', metoffice: 'Met Office',
  };
  const secondaryLabel = secondaryModelLabels[city.secondaryModel] ?? '';
  if (city.secondaryModel !== 'none') {
    try { secondaryMembers = await fetchSecondaryForecast(city, Math.min(forecastDays, 5)); } catch {}
  }

  let anomaly: { year: number; month: number; anomalyC: number } | null = null;
  try { anomaly = await fetchMonthlyAnomaly(city); } catch {}

  const dates = [...new Set(ecmwfMembers.map(m => m.date))].sort();
  const snapshots: DateSnapshot[] = [];

  for (const date of dates) {
    process.stdout.write(`  [${city.name}] ${date} odds… `);
    const dayEcmwf = ecmwfMembers.filter(m => m.date === date);
    const daySec   = secondaryMembers.filter(m => m.date === date);
    const baseTemps = dayEcmwf.map(m => m.tempMaxC);
    const secTemps = daySec.map(m => m.tempMaxC);

    let odds: MarketOdds | null = null;
    try { odds = await fetchMarketOdds(city, date); } catch {}

    const marketCity  = odds ? cityWithMarketBrackets(city, odds) : city;
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
    const snapshotDay = latestSnapshotIndex.get(`${city.id}:${date}`);
    const rawPrices   = Object.fromEntries((odds?.bracketMarkets ?? []).map(b => [b.bracket, b.yesAsk]));
    const noAskPrices = Object.fromEntries((odds?.bracketMarkets ?? []).map(b => [b.bracket, b.noAsk]));
    const hasLiveBookPrices = Object.keys(rawPrices).length > 0;
    const liveMarketProbs = hasLiveBookPrices ? rawPrices : (odds?.probs ?? {});
    const hasLiveMarketProbs = Object.keys(liveMarketProbs).length > 0;
    const marketProbs = hasLiveMarketProbs
      ? liveMarketProbs
      : (snapshotDay?.marketProbs ?? {});
    const marketDataSource: DateSnapshot['marketDataSource'] = hasLiveMarketProbs
      ? 'live'
      : snapshotDay
        ? 'snapshot'
        : 'none';
    const marketDataGeneratedAt = hasLiveMarketProbs
      ? new Date().toISOString()
      : (snapshotDay?.snapshotGeneratedAt ?? snapshotDay?.latestRunGeneratedAt ?? null);
    const volume      = typeof odds?.volume === 'number' ? odds.volume : (snapshotDay?.volume ?? 0);
    const liquidity   = typeof odds?.liquidity === 'number' ? odds.liquidity : (snapshotDay?.liquidity ?? 0);

    const computedSignals = applyTafRiskToSignals(applySingleMarketKellyRecommendation(
      computeBetSignals(modelProbs, marketProbs, marketCity, bankrollUsd)
    ), tafOverlay);
    const signals: BetSignal[] = hasLiveMarketProbs
      ? computedSignals
      : (snapshotDay?.signals ?? []).length
        ? snapshotDay!.signals.map(signal => ({
            bracket: signal.bracket,
            label: signal.label,
            modelProb: signal.modelProb,
            marketPrice: signal.marketPrice,
            edge: signal.edge,
            evPerDollar: signal.evPerDollar,
            kellyFraction: signal.kellyFraction,
            scaledKelly: signal.kellyFraction * 0.25,
            suggestedUsd: signal.suggestedUsd,
            action: signal.action as BetSignal['action'],
            reason: signal.reason,
          }))
        : computedSignals;
    const signalSource: DateSnapshot['signalSource'] = hasLiveMarketProbs ? 'live' : 'snapshot';
    const signalGeneratedAt = hasLiveMarketProbs
      ? new Date().toISOString()
      : (snapshotDay?.snapshotGeneratedAt ?? snapshotDay?.latestRunGeneratedAt ?? null);
    const arb     = detectArbOpportunity(rawPrices, marketCity, 0.01, 0.02, noAskPrices);

    const hasMkt = Object.keys(marketProbs).length > 0;
    if (hasMkt) process.stdout.write(`$${Math.round(volume/1000)}K vol${arb ? ' 🔺ARB' : ''}\n`);
    else        process.stdout.write('no market\n');

    snapshots.push({
      date,
      ensembleMean: mean(temps), ensembleStd: stdDev(temps),
      p10: pct(temps, 10), p90: pct(temps, 90),
      secondaryLabel,
      secondaryMean: secTemps.length ? mean(secTemps) : null,
      secondaryStd:  secTemps.length > 1 ? stdDev(secTemps) : null,
      marketCity, modelProbs, marketProbs, rawPrices,
      members: temps, volume, liquidity, signals, marketDataSource, marketDataGeneratedAt, signalSource, signalGeneratedAt, arb, aviation: metarFloor.adjustment, taf: tafOverlay, postprocess: calibration.adjustment,
    });
  }

  return { city, anomaly, snapshots };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const cities = cityIds.map(id => {
    const c = CITIES[id];
    if (!c) throw new Error(`Unknown city "${id}". Valid: ${Object.keys(CITIES).join(', ')}`);
    return c;
  });

  console.log(`\nFetching data for: ${cities.map(c => c.name).join(', ')}\n`);
  const results: CityResult[] = [];
  for (const city of cities) {
    try {
      results.push(await fetchCityData(city));
    } catch (error) {
      console.error(`  [${city.name}] skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!results.length) {
    throw new Error('No city data available; refusing to overwrite portal with an empty report');
  }

  writeFileSync(outPath, buildHtml(results), 'utf8');
  console.log(`\nReport → ${outPath}`);
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------
function buildHtml(results: CityResult[]): string {
  const generatedDate = new Date();
  const generatedAt = generatedDate.toUTCString();
  const generatedAtIso = generatedDate.toISOString();
  const totalBuys   = results.flatMap(r => r.snapshots.flatMap(s => s.signals.filter(x => x.action === 'BUY'))).length;
  const totalArbs   = results.flatMap(r => r.snapshots.filter(s => s.arb)).length;
  const coreCount   = results.filter(r => r.city.launchPhase === 'core').length;
  const wave1Count  = results.filter(r => r.city.launchPhase === 'wave_1').length;
  const wave2Count  = results.filter(r => r.city.launchPhase === 'wave_2').length;

  const tabBtns   = results.map((r, i) => `
    <button class="tab-btn${i===0?' active':''}" onclick="switchTab('${r.city.id}')" id="tab-${r.city.id}">
      ${r.city.name} <span class="tab-sub">${cityVolLabel(r)}</span>
    </button>`).join('');

  const auditTabBtn = `
    <button class="tab-btn" onclick="switchTab('audit')" id="tab-audit">
      Audit Log <span class="tab-sub">forward test</span>
    </button>`;

  const panels      = results.map((r, i) => `
    <div class="tab-panel${i===0?' active':''}" id="panel-${r.city.id}">${buildCityPanel(r)}</div>`).join('');

  const auditPanel = `<div class="tab-panel" id="panel-audit">${buildAuditPanel()}</div>`;

  const chartInits  = results.flatMap(r => r.snapshots.map(s => buildChartJs(s, r.city))).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Weather Edge — ${new Date().toISOString().slice(0,10)}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f172a;color:#e2e8f0;padding:24px}
h1{font-size:1.4rem;font-weight:700;color:#f8fafc;margin-bottom:4px}
.sub{font-size:.83rem;color:#64748b;margin-bottom:20px}
.meta{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:12px 16px;font-size:.8rem;color:#94a3b8;margin-bottom:22px;display:flex;flex-wrap:wrap;gap:16px;align-items:center}
.meta strong{color:#e2e8f0}
.badge-sum{background:#1e3a5f;color:#93c5fd;border-radius:6px;padding:2px 10px;font-weight:700;font-size:.78rem}
.badge-arb{background:#422006;color:#fdba74;border-radius:6px;padding:2px 10px;font-weight:700;font-size:.78rem}
/* tabs */
.tabs{display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap}
.tab-btn{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:9px 16px;font-size:.85rem;color:#94a3b8;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:2px;transition:all .15s}
.tab-btn:hover{border-color:#475569;color:#e2e8f0}
.tab-btn.active{background:#1d4ed8;border-color:#3b82f6;color:#fff}
.tab-sub{font-size:.72rem;opacity:.75}
.tab-panel{display:none}.tab-panel.active{display:block}
.expansion{background:#111827;border:1px solid #1f2937;border-radius:12px;padding:16px 18px;margin-bottom:20px}
.expansion-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:12px}
.expansion-card{background:#0f172a;border:1px solid #334155;border-radius:10px;padding:12px 14px}
.expansion-label{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:#64748b;margin-bottom:6px}
.expansion-value{font-size:1.15rem;font-weight:700;color:#f8fafc}
.expansion-note{font-size:.78rem;color:#94a3b8;line-height:1.45}
/* city header */
.city-hdr{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;margin-bottom:18px}
.city-title{font-size:1.1rem;font-weight:700;color:#f8fafc}
.city-meta{font-size:.78rem;color:#64748b}
.phase{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;background:#172554;color:#bfdbfe;border:1px solid #1d4ed8}
.anom{display:inline-flex;align-items:center;gap:6px;padding:3px 11px;border-radius:20px;font-size:.78rem;font-weight:600}
.anom-warm{background:#450a0a;color:#fca5a5}.anom-cool{background:#0c2340;color:#93c5fd}
a.stn{font-size:.75rem;color:#3b82f6;text-decoration:none}
a.stn:hover{text-decoration:underline}
.legend{display:flex;gap:14px;margin-bottom:14px;flex-wrap:wrap}
.legend-item{display:flex;align-items:center;gap:5px;font-size:.76rem;color:#94a3b8}
.ldot{width:11px;height:11px;border-radius:3px;flex-shrink:0}
/* cards */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(650px,1fr));gap:18px}
.card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:18px}
.card.has-arb{border-color:#f97316}
.card.has-window{border-color:#4ade80}
.card-hdr{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin-bottom:12px}
.card-date{font-size:.98rem;font-weight:700;color:#f8fafc}
.vol{font-size:.75rem;color:#64748b}
.arb-banner{background:#422006;border:1px solid #f97316;border-radius:6px;padding:8px 12px;margin-bottom:14px;font-size:.8rem}
.arb-title{color:#fdba74;font-weight:700;margin-bottom:4px}
.arb-detail{color:#d97706;font-size:.76rem}
/* chips */
.chips{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:14px}
.chip{background:#0f172a;border:1px solid #334155;border-radius:6px;padding:3px 9px;font-size:.75rem;color:#94a3b8}
.chip strong{color:#e2e8f0}
.chip-warn{background:#3f1d1d;border-color:#7f1d1d;color:#fecaca}
.chip-warn strong{color:#fff1f2}
/* section labels */
.sl{font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#475569;margin-bottom:7px}
/* charts */
.ch-main{position:relative;height:240px;margin-bottom:16px}
.ch-dist{position:relative;height:100px;margin-bottom:16px}
hr{border:none;border-top:1px solid #1e3a5f;margin:13px 0}
/* tables */
table{width:100%;border-collapse:collapse;font-size:.79rem}
th{text-align:left;padding:5px 7px;color:#475569;font-weight:600;border-bottom:1px solid #334155;text-transform:uppercase;font-size:.68rem;letter-spacing:.05em}
td{padding:4px 7px;border-bottom:1px solid #1e293b;white-space:nowrap}
tr:last-child td{border-bottom:none}
/* colours */
.pos{color:#4ade80;font-weight:600}.neg{color:#f87171;font-weight:600}.neu{color:#475569}
.b-buy{background:#14532d;color:#4ade80;border-radius:4px;padding:1px 7px;font-size:.68rem;font-weight:700;text-transform:uppercase}
.b-skip{color:#334155;font-size:.7rem}
.b-arb{background:#422006;color:#fdba74;border-radius:4px;padding:1px 7px;font-size:.68rem;font-weight:700;text-transform:uppercase}
</style>
</head>
<body>
<h1>Polymarket Weather Edge Analyzer</h1>
<div class="sub">Daily high temperature — ensemble model vs. implied odds · EV · Kelly · Arbitrage</div>

<div class="meta">
  <span>📅 <strong>${generatedAt}</strong></span>
  <span id="portal-age" data-generated-at="${generatedAtIso}">Freshness: <strong>just generated</strong></span>
  <span>⚖️ Bias: <strong>${biasCorrection>=0?'+':''}${biasCorrection}°C</strong></span>
  <span>💰 Bankroll: <strong>$${bankrollUsd.toLocaleString()}</strong></span>
  <span class="badge-sum">✅ ${totalBuys} BUY signal${totalBuys!==1?'s':''}</span>
  ${totalArbs > 0 ? `<span class="badge-arb">🔺 ${totalArbs} ARB opportunity${totalArbs!==1?'s':''}</span>` : ''}
  <span style="color:#475569;font-size:.75rem">🔵 Model = ECMWF IFS 51-member &nbsp;|&nbsp; 🟠 Market = Polymarket &nbsp;|&nbsp; Kelly scale = 25%</span>
</div>

<div class="expansion">
  <div class="city-title" style="margin-bottom:4px">20-city expansion now live in the portal</div>
  <div class="expansion-note">The weather universe has been expanded from the original 5-city core to a tracked 20-city Celsius market set. The portal, audit tab, and forward-test logger now share the same rollout universe and ordering.</div>
  <div class="expansion-grid">
    <div class="expansion-card"><div class="expansion-label">Tracked cities</div><div class="expansion-value">${results.length} / ${TARGET_WEATHER_CITY_COUNT}</div></div>
    <div class="expansion-card"><div class="expansion-label">Core</div><div class="expansion-value">${coreCount}</div><div class="expansion-note">Original high-confidence base markets.</div></div>
    <div class="expansion-card"><div class="expansion-label">Wave 1</div><div class="expansion-value">${wave1Count}</div><div class="expansion-note">First expansion batch to widen geography quickly.</div></div>
    <div class="expansion-card"><div class="expansion-label">Wave 2</div><div class="expansion-value">${wave2Count}</div><div class="expansion-note">Additional Celsius markets now included in monitoring and testing.</div></div>
  </div>
</div>

<div class="tabs">${tabBtns}${auditTabBtn}</div>
${panels}
${auditPanel}

<script>
function switchTab(id){
  document.querySelectorAll('.tab-btn,.tab-panel').forEach(el=>el.classList.remove('active'));
  document.getElementById('tab-'+id).classList.add('active');
  document.getElementById('panel-'+id).classList.add('active');
}
${chartInits}
// ---------------------------------------------------------------------------
// Live trade-window countdown (updates every second, no server round-trip)
// ---------------------------------------------------------------------------
function fmtAge(ms){
  if(ms < 60_000) return Math.max(1, Math.floor(ms/1000))+'s old';
  if(ms < 3_600_000) return Math.floor(ms/60_000)+'m old';
  if(ms < 86_400_000) return Math.floor(ms/3_600_000)+'h '+String(Math.floor((ms%3_600_000)/60_000)).padStart(2,'0')+'m old';
  return Math.floor(ms/86_400_000)+'d '+String(Math.floor((ms%86_400_000)/3_600_000)).padStart(2,'0')+'h old';
}
function fmtDuration(ms){
  if(ms<=0) return '0m';
  const h=Math.floor(ms/3600000), m=Math.floor((ms%3600000)/60000), s=Math.floor((ms%60000)/1000);
  if(h>0) return h+'h '+String(m).padStart(2,'0')+'m '+String(s).padStart(2,'0')+'s';
  if(m>0) return m+'m '+String(s).padStart(2,'0')+'s';
  return s+'s';
}
function updateWindows(){
  const now=Date.now();
  const ageEl=document.getElementById('portal-age');
  if(ageEl){
    const generatedAt=Date.parse(ageEl.dataset.generatedAt || '');
    if(Number.isFinite(generatedAt)){
      ageEl.innerHTML='Freshness: <strong>'+fmtAge(Math.max(0, now-generatedAt))+'</strong>';
    }
  }
  document.querySelectorAll('.win-badge').forEach(el=>{
    const openMs=parseInt(el.dataset.open), closeMs=parseInt(el.dataset.close);
    if(now>=closeMs){
      el.style.background='#1e293b'; el.style.color='#475569'; el.style.fontWeight='';
      el.textContent='market closed';
      el.closest('.card')&&el.closest('.card').classList.remove('has-window');
    } else if(now>=openMs){
      el.style.background='#14532d'; el.style.color='#4ade80'; el.style.fontWeight='700';
      el.textContent='WINDOW OPEN · closes in '+fmtDuration(closeMs-now);
      el.closest('.card')&&el.closest('.card').classList.add('has-window');
    } else {
      el.style.background='#1e293b'; el.style.color='#64748b'; el.style.fontWeight='';
      el.textContent='window opens in '+fmtDuration(openMs-now)+' ('+new Date(openMs).toISOString().slice(11,16)+' UTC)';
      el.closest('.card')&&el.closest('.card').classList.remove('has-window');
    }
  });
}
updateWindows();
setInterval(updateWindows, 1000);
</script>
</body></html>`;
}

function cityVolLabel(r: CityResult): string {
  const vol  = r.snapshots.reduce((a,s) => a+s.volume, 0);
  const buys = r.snapshots.flatMap(s => s.signals.filter(x => x.action==='BUY')).length;
  const arbs = r.snapshots.filter(s => s.arb).length;
  const parts = [];
  if (vol > 0) parts.push(vol >= 1e6 ? `$${(vol/1e6).toFixed(1)}M` : `$${Math.round(vol/1000)}K`);
  if (buys > 0) parts.push(`${buys} BUY`);
  if (arbs > 0) parts.push(`${arbs} ARB`);
  return parts.join(' · ');
}

function formatAgeCompact(iso: string | null): string {
  if (!iso) return '';
  const ageMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ageMs) || ageMs < 0) return '';
  if (ageMs < 60_000) return 'just now';
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m old`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ${String(Math.floor((ageMs % 3_600_000) / 60_000)).padStart(2, '0')}m old`;
  return `${Math.floor(ageMs / 86_400_000)}d ${String(Math.floor((ageMs % 86_400_000) / 3_600_000)).padStart(2, '0')}h old`;
}

function isOlderThanMinutes(iso: string | null, minutes: number): boolean {
  if (!iso) return false;
  const ageMs = Date.now() - new Date(iso).getTime();
  return Number.isFinite(ageMs) && ageMs > minutes * 60_000;
}

function forwardEligibilityForSnapshot(s: DateSnapshot, city: CityConfig): {
  status: 'eligible_now' | 'window_not_open' | 'duplicate' | 'bankroll' | 'no_buy';
  label: string;
  detail: string;
} {
  const bestBuy = s.signals.find(signal => signal.action === 'BUY');
  if (!bestBuy) {
    return {
      status: 'no_buy',
      label: 'No Forward-Test Trade',
      detail: 'No BUY survived the forward-test thresholds after Kelly, EV, and single-market selection.',
    };
  }

  const dayEndMs = cityDayEndUtcMs(s.date, city.timezone);
  const openMs = tradeWindowOpenUtcMs(s.date, city.timezone, TRADE_WINDOW_HOURS);
  const nowMs = Date.now();
  if (nowMs < openMs) {
    return {
      status: 'window_not_open',
      label: 'Blocked: Window Not Open',
      detail: `Forward test only logs within the final ${TRADE_WINDOW_HOURS}h window. Opens ${new Date(openMs).toISOString()}.`,
    };
  }
  if (nowMs >= dayEndMs) {
    return {
      status: 'window_not_open',
      label: 'Blocked: Market Closed',
      detail: 'This event is already past the local market day close, so forward test will not open a new paper trade.',
    };
  }
  if (forwardTestState.bankrollUsd < 5) {
    return {
      status: 'bankroll',
      label: 'Blocked: Bankroll',
      detail: `Available forward-test bankroll is $${forwardTestState.bankrollUsd.toFixed(2)}, below the $5 minimum order.`,
    };
  }
  if (forwardTestState.unresolvedKeys.has(`${city.name}|${s.date}`)) {
    return {
      status: 'duplicate',
      label: 'Blocked: Already Logged',
      detail: 'Forward test allows only one unresolved position per city/date event, so this card cannot log another paper trade yet.',
    };
  }
  return {
    status: 'eligible_now',
    label: 'Forward-Test Eligible Now',
    detail: `Best bracket ${bestBuy.label} passes thresholds and can be logged now at current bankroll $${forwardTestState.bankrollUsd.toFixed(2)}.`,
  };
}

function buildCityPanel(r: CityResult): string {
  const { city, anomaly, snapshots } = r;
  const aSign = anomaly && anomaly.anomalyC >= 0 ? '+' : '';
  const phaseLabel = city.launchPhase === 'core'
    ? 'Core'
    : city.launchPhase === 'wave_1'
      ? 'Wave 1'
      : 'Wave 2';
  const anomHtml = anomaly
    ? `<span class="anom ${anomaly.anomalyC>=0?'anom-warm':'anom-cool'}">
         ${anomaly.anomalyC>=0?'🌡':'❄️'} ${anomaly.year}-${String(anomaly.month).padStart(2,'0')} anomaly: ${aSign}${anomaly.anomalyC.toFixed(2)}°C vs 1991–2020
       </span>` : '';

  return `<div class="city-hdr">
    <div>
      <div class="city-title">${city.name} <span class="phase">${phaseLabel}</span></div>
      <div class="city-meta">
        Resolution: <a class="stn" href="${city.wundergroundUrl}" target="_blank">${city.wundergroundUrl.split('/').pop()}</a>
        &nbsp;·&nbsp; ${city.lat.toFixed(4)}, ${city.lon.toFixed(4)}
        &nbsp;·&nbsp; ${city.note}
      </div>
    </div>
    ${anomHtml}
  </div>
  <div class="legend">
    <div class="legend-item"><div class="ldot" style="background:#3b82f6"></div>ECMWF ensemble</div>
    <div class="legend-item"><div class="ldot" style="background:#f97316"></div>Polymarket</div>
    <div class="legend-item"><div class="ldot" style="background:#4ade80"></div>Model &gt; Market</div>
    <div class="legend-item"><div class="ldot" style="background:#f87171"></div>Model &lt; Market</div>
  </div>
  <div class="cards">${snapshots.map(s => buildCard(s, city)).join('')}</div>`;
}

function buildCard(s: DateSnapshot, city: CityConfig): string {
  const marketCity = s.marketCity;
  const hasMkt    = Object.keys(s.marketProbs).length > 0;
  const edgeRows  = computeEdgeTable(s.modelProbs, s.marketProbs, marketCity)
    .filter(r => r.modelProb > 0 || r.marketProb > 0);
  const volStr    = s.volume ? `$${Math.round(s.volume/1000)}K vol · $${Math.round(s.liquidity/1000)}K liq` : 'no market';
  const win       = tradeWindowStatus(s.date, city.timezone);
  const dayEndMs  = cityDayEndUtcMs(s.date, city.timezone);
  const openMs    = tradeWindowOpenUtcMs(s.date, city.timezone, TRADE_WINDOW_HOURS);
  // Embed UTC epoch timestamps as data attrs — client JS updates every second
  const winBadge  = `<span class="win-badge" data-open="${openMs}" data-close="${dayEndMs}" style="border-radius:5px;padding:2px 9px;font-size:.7rem">loading…</span>`;

  const secChip = s.secondaryMean !== null
    ? `<div class="chip">${s.secondaryLabel} <strong>${s.secondaryMean.toFixed(1)}°C${s.secondaryStd!==null?` ±${s.secondaryStd.toFixed(1)}`:''}</strong></div>`
    : '';
  const postChip = s.postprocess
    ? `<div class="chip">MOS shift <strong>${s.postprocess.shiftC >= 0 ? '+' : ''}${s.postprocess.shiftC.toFixed(1)}°C</strong></div>`
    : '';
  const marketAge = formatAgeCompact(s.marketDataGeneratedAt);
  const signalAge = formatAgeCompact(s.signalGeneratedAt);
  const marketStale = isOlderThanMinutes(s.marketDataGeneratedAt, 30);
  const signalStale = isOlderThanMinutes(s.signalGeneratedAt, 30);
  const marketSourceChip = `<div class="chip${marketStale ? ' chip-warn' : ''}">Market <strong>${s.marketDataSource === 'live' ? 'live asks' : s.marketDataSource === 'snapshot' ? 'snapshot fallback' : 'missing'}</strong>${marketAge ? ` · ${marketAge}` : ''}</div>`;
  const signalSourceChip = `<div class="chip${signalStale ? ' chip-warn' : ''}">Signals <strong>${s.signalSource === 'live' ? 'fresh' : 'cached'}</strong>${signalAge ? ` · ${signalAge}` : ''}</div>`;
  const forwardEligibility = forwardEligibilityForSnapshot(s, city);
  const forwardChip = `<div class="chip${forwardEligibility.status === 'eligible_now' ? '' : ' chip-warn'}">Forward test <strong>${forwardEligibility.status === 'eligible_now' ? 'eligible now' : 'blocked'}</strong></div>`;
  const aviationChip = s.aviation
    ? `<div class="chip">Obs max-so-far <strong>${s.aviation.observedMaxSoFarC.toFixed(1)}°C · ${s.aviation.observationCount} METARs</strong></div>`
    : '';
  const tafChip = s.taf && s.taf.multiplier < 1
    ? `<div class="chip">TAF risk <strong>${s.taf.multiplier.toFixed(2)}x sizing</strong></div>`
    : '';

  // Arb banner
  const arbHtml = (() => {
    if (!s.arb) return '';
    const arb      = s.arb;
    const isBuy    = arb.type === 'buy_all';
    const bg       = isBuy ? '#0c2340' : '#2d1a00';
    const border   = isBuy ? '#3b82f6' : '#f97316';
    const icon     = isBuy ? '🟢' : '🟠';
    const label    = isBuy ? 'BUY-ALL ARB (sum &lt; 1)' : 'SELL-ALL ARB (sum &gt; 1)';
    const noCost   = arb.brackets.reduce((a, b) => a + b.price, 0);
    const action   = isBuy
      ? `Buy YES on every bracket. Total cost = <strong>${arb.sumOfYesPrices.toFixed(4)}</strong>. Guaranteed $1.00 payout. Gross profit = <strong>${(arb.theoreticalProfit*100).toFixed(2)}¢/$</strong>.`
      : `Buy NO on every bracket (= short YES). NO cost = <strong>${noCost.toFixed(4)}</strong>. Payout = <strong>${arb.brackets.length - 1}.00</strong> (all NOs except the winning bracket pay $1). Gross profit = <strong>${(arb.theoreticalProfit*100).toFixed(2)}¢/$</strong>.`;
    return `
    <div style="background:${bg};border:1px solid ${border};border-radius:6px;padding:10px 14px;margin-bottom:14px;font-size:.8rem">
      <div style="color:${border};font-weight:700;margin-bottom:5px">${icon} NEG-RISK ARB — ${label}</div>
      <div style="color:#cbd5e1;line-height:1.6">
        ${action}<br/>
        After ~1% taker fee: <strong style="color:${border}">${(arb.profitAfterFees*100).toFixed(2)}¢/$</strong>
        &nbsp;→ On $1,000 notional: <strong style="color:${border}">$${(arb.profitAfterFees*1000).toFixed(2)}</strong>
        &nbsp;&nbsp;<span style="color:#64748b;font-size:.73rem">⚠ Gamma shows midpoints — verify on live CLOB before trading</span>
      </div>
    </div>`;
  })();

  // Identify the single best bracket to trade (highest Kelly among BUYs, above price floor)
  const buySignals   = s.signals.filter(x => x.action === 'BUY');
  const bestBracket  = buySignals.sort((a, b) => b.kellyFraction - a.kellyFraction)[0]?.bracket;

  // Combined edge + EV + Kelly table
  const tableRows = edgeRows.map(row => {
    const sig      = s.signals.find(x => x.bracket === row.bracket);
    const isBest   = !s.arb && row.bracket === bestBracket;
    const isCorrSkip = sig?.reason?.startsWith('correlated with ') ?? false;
    const mktPct   = row.marketProb > 0 ? (row.marketProb*100).toFixed(1)+'%' : '<span class="neu">—</span>';
    const edgePct  = row.marketProb > 0 ? `<span class="${row.edge>0.02?'pos':row.edge<-0.02?'neg':'neu'}">${row.edge>=0?'+':''}${(row.edge*100).toFixed(1)}%</span>` : '<span class="neu">—</span>';
    const ev       = sig?.marketPrice > 0 ? `<span class="${sig.evPerDollar>=0?'pos':'neg'}">${sig.evPerDollar>=0?'+':''}${(sig.evPerDollar*100).toFixed(1)}¢</span>` : '<span class="neu">—</span>';
    const kelly    = sig && sig.kellyFraction > 0 ? `${(sig.kellyFraction*100).toFixed(1)}%` : '<span class="neu">—</span>';
    const sizing   = sig?.action === 'BUY' ? `$${sig.suggestedUsd.toFixed(0)}` : '<span class="neu">—</span>';
    const action   = s.arb
      ? `<span class="b-arb">ARB</span>`
      : isBest
        ? `<span class="b-buy">BUY ★</span>`
        : isCorrSkip
          ? `<span class="b-skip" title="Skipped: correlated with best bracket">SKIP (corr.)</span>`
          : `<span class="b-skip">${sig?.reason ?? ''}</span>`;

    const rowStyle = isBest ? ' style="background:rgba(74,222,128,.06);outline:1px solid rgba(74,222,128,.2)"' : '';

    return `<tr${rowStyle}>
      <td>${row.label}</td>
      <td>${(row.modelProb*100).toFixed(1)}%</td>
      <td>${mktPct}</td>
      <td>${edgePct}</td>
      <td>${ev}</td>
      <td>${kelly}</td>
      <td>${sizing}</td>
      <td>${action}</td>
    </tr>`;
  }).join('');

  return `<div class="card${s.arb?' has-arb':''}${win.open?' has-window':''}">
  <div class="card-hdr">
    <div>
      <div class="card-date">${s.date}</div>
      <div style="margin-top:4px">${winBadge}</div>
    </div>
    <span class="vol">${volStr}</span>
  </div>
  ${arbHtml}
  <div class="arb-banner" style="background:${forwardEligibility.status === 'eligible_now' ? '#0f2f1f' : '#3f1d1d'};border-color:${forwardEligibility.status === 'eligible_now' ? '#166534' : '#7f1d1d'}">
    <div class="arb-title" style="color:${forwardEligibility.status === 'eligible_now' ? '#86efac' : '#fecaca'}">${forwardEligibility.label}</div>
    <div class="arb-detail" style="color:${forwardEligibility.status === 'eligible_now' ? '#bbf7d0' : '#fecaca'}">${esc(forwardEligibility.detail)}</div>
  </div>
  ${s.marketDataSource !== 'live' ? `<div class="arb-banner" style="background:#3f1d1d;border-color:#7f1d1d"><div class="arb-title" style="color:#fecaca">Stale market fallback</div><div class="arb-detail" style="color:#fecaca">Live market odds were unavailable during this rebuild, so this card is using the last good cached snapshot${marketAge ? ` captured ${marketAge}` : ''}.</div></div>` : ''}
  ${s.postprocess ? `<div class="arb-banner"><div class="arb-title">Station post-processor</div><div class="arb-detail">Shift ${s.postprocess.shiftC >= 0 ? '+' : ''}${s.postprocess.shiftC.toFixed(2)}°C · rmse ${s.postprocess.rmseC.toFixed(2)}°C · n=${s.postprocess.sampleCount}</div></div>` : ''}
  ${s.aviation ? `<div class="arb-banner"><div class="arb-title">Aviation station overlay</div><div class="arb-detail">${esc(s.aviation.summary)} · report ${esc(s.aviation.reportTime)}</div></div>` : ''}
  ${s.taf && s.taf.multiplier < 1 ? `<div class="arb-banner"><div class="arb-title">TAF uncertainty overlay</div><div class="arb-detail">${esc(s.taf.summary)}</div></div>` : ''}
  <div class="chips">
    ${marketSourceChip}
    ${signalSourceChip}
    ${forwardChip}
    <div class="chip">ECMWF <strong>${s.ensembleMean.toFixed(1)}°C</strong></div>
    <div class="chip">σ <strong>±${s.ensembleStd.toFixed(1)}°C</strong></div>
    <div class="chip">p10 <strong>${s.p10.toFixed(1)}°C</strong></div>
    <div class="chip">p90 <strong>${s.p90.toFixed(1)}°C</strong></div>
    <div class="chip">n <strong>${s.members.length} members</strong></div>
    ${secChip}
    ${postChip}
    ${aviationChip}
    ${tafChip}
  </div>
  <div class="sl">Model vs Market</div>
  <div class="ch-main"><canvas id="bar-${city.id}-${s.date}"></canvas></div>
  <div class="sl">Ensemble spread</div>
  <div class="ch-dist"><canvas id="dist-${city.id}-${s.date}"></canvas></div>
  <hr/>
  <div class="sl">Edge · EV · Kelly · Sizing ($${bankrollUsd.toLocaleString()} bankroll, ¼ Kelly)</div>
  <table>
    <thead><tr><th>Bracket</th><th>Model</th><th>Market</th><th>Edge</th><th>EV/¢$</th><th>Kelly</th><th>Size</th><th>Action</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
  ${s.signals.some(x => x.reason?.startsWith('correlated with ')) ? `<div style="font-size:.71rem;color:#64748b;margin-top:7px">★ = single recommended bracket. Other qualifying brackets skipped — all share the same temperature draw (correlated risk). Min market price: 5¢.</div>` : ''}
</div>`;
}

function buildChartJs(s: DateSnapshot, city: CityConfig): string {
  const marketCity = s.marketCity;
  const brackets  = buildBrackets(marketCity);
  const labels    = brackets.map(b => bracketLabel(b, marketCity));
  const modelData = brackets.map(b => +((s.modelProbs[b] ?? 0)*100).toFixed(2));
  const mktData   = brackets.map(b => +((s.marketProbs[b] ?? 0)*100).toFixed(2));

  const hist: Record<number,number> = {};
  for (const t of s.members) { const r = Math.round(t); hist[r] = (hist[r]??0)+1; }
  const hKeys = Object.keys(hist).map(Number).sort((a,b)=>a-b);
  const histColors = hKeys.map(k => {
    const b = String(k);
    const e = (s.modelProbs[b]??0) - (s.marketProbs[b]??0);
    return Math.abs(e)<0.02 ? 'rgba(100,116,139,.6)' : e>0 ? 'rgba(74,222,128,.7)' : 'rgba(248,113,113,.7)';
  });

  return `(function(){
  new Chart(document.getElementById('bar-${city.id}-${s.date}'),{
    type:'bar',
    data:{labels:${JSON.stringify(labels)},datasets:[
      {label:'ECMWF',data:${JSON.stringify(modelData)},backgroundColor:'rgba(59,130,246,.75)',borderColor:'rgba(96,165,250,1)',borderWidth:1,borderRadius:3},
      {label:'Polymarket',data:${JSON.stringify(mktData)},backgroundColor:'rgba(249,115,22,.75)',borderColor:'rgba(253,186,116,1)',borderWidth:1,borderRadius:3}
    ]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{labels:{color:'#94a3b8',font:{size:11}}},tooltip:{callbacks:{label:c=>c.dataset.label+': '+c.parsed.y.toFixed(1)+'%'}}},
      scales:{x:{ticks:{color:'#94a3b8',font:{size:10}},grid:{color:'#1e293b'}},
              y:{ticks:{color:'#94a3b8',font:{size:10},callback:v=>v+'%'},grid:{color:'#334155'}}}}
  });
  new Chart(document.getElementById('dist-${city.id}-${s.date}'),{
    type:'bar',
    data:{labels:${JSON.stringify(hKeys.map(k=>k+'°C'))},datasets:[{label:'Members',data:${JSON.stringify(hKeys.map(k=>hist[k]))},backgroundColor:${JSON.stringify(histColors)},borderWidth:0,borderRadius:3}]},
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>'Members: '+c.parsed.y+' / ${s.members.length}'}}},
      scales:{x:{ticks:{color:'#94a3b8',font:{size:10}},grid:{color:'#1e293b'}},
              y:{ticks:{color:'#94a3b8',font:{size:10}},grid:{color:'#334155'}}}}
  });
})();`;
}

function mean(v: number[])   { return v.length ? v.reduce((a,b)=>a+b,0)/v.length : 0; }
function stdDev(v: number[]) { if(!v.length)return 0; const m=mean(v); return Math.sqrt(v.reduce((a,b)=>a+(b-m)**2,0)/v.length); }
function pct(v: number[], p: number) { if(!v.length)return 0; const s=[...v].sort((a,b)=>a-b); return s[Math.min(Math.floor(p/100*s.length),s.length-1)]; }
function esc(v: string) { return v.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)); }

// ---------------------------------------------------------------------------
// Audit Log Panel — renders data/forward_test_log.csv as HTML table
// ---------------------------------------------------------------------------
function buildAuditPanel(): string {
  const CSV_PATH = 'data/forward_test_log.csv';
  if (!existsSync(CSV_PATH)) {
    return `<div style="padding:24px;color:#64748b">No forward test log found yet. Signals will appear here after the first hourly run.</div>`;
  }

  const raw   = readFileSync(CSV_PATH, 'utf8').trim().split('\n');
  if (raw.length <= 1) return `<div style="padding:24px;color:#64748b">No signals logged yet.</div>`;

  // Parse rows — support both 15-col (old) and 17-col (new, with order_status+order_id)
  type Row = { logged_at:string; city:string; market_date:string; bracket_label:string;
               model_prob:number; market_price:number; edge:number; ev_per_dollar:number;
               kelly_pct:number; suggested_usd:number; order_status:string; order_id:string;
               resolved:boolean; actual_bracket:string; pnl:number; notes:string };
  const rows: Row[] = raw.slice(1).map(line => {
    const c = line.split(',');
    const hasOrderCols = c.length >= 17;
    const base = hasOrderCols ? 2 : 0;
    return {
      logged_at:      c[0]  ?? '',
      city:           c[1]  ?? '',
      market_date:    c[2]  ?? '',
      bracket_label:  c[4]  ?? '',
      model_prob:     parseFloat(c[5]  ?? '0'),
      market_price:   parseFloat(c[6]  ?? '0'),
      edge:           parseFloat(c[7]  ?? '0'),
      ev_per_dollar:  parseFloat(c[8]  ?? '0'),
      kelly_pct:      parseFloat(c[9]  ?? '0'),
      suggested_usd:  parseFloat(c[10] ?? '0'),
      order_status:   hasOrderCols ? (c[11] ?? 'preview') : 'preview',
      order_id:       hasOrderCols ? (c[12] ?? '')         : '',
      resolved:       c[11 + base] === 'true',
      actual_bracket: c[12 + base] ?? '',
      pnl:            parseFloat(c[13 + base] ?? '0'),
      notes:          (c[14 + base] ?? '').replace(/^"|"$/g, ''),
    };
  });

  const closed   = rows.filter(r => r.resolved);
  const open     = rows.filter(r => !r.resolved);
  const wins     = closed.filter(r => r.pnl > 0);
  const totalPnl = closed.reduce((s, r) => s + r.pnl, 0);
  const totalRisked = closed.reduce((s, r) => s + r.suggested_usd, 0);

  const livePlaced = rows.filter(r => r.order_status === 'placed').length;
  const previewCount = rows.filter(r => r.order_status === 'preview').length;
  const failedCount = rows.filter(r => r.order_status.startsWith('failed')).length;
  const orderMode = livePlaced > 0 ? '🔴 LIVE' : '🟡 PREVIEW';

  const statCards = `
  <div style="display:flex;flex-wrap:wrap;gap:12px;margin-bottom:22px">
    ${statCard('Signals', String(rows.length))}
    ${statCard('Tracked cities', String(PORTAL_CITY_IDS.length), '#93c5fd')}
    ${statCard('Bankroll', '$'+forwardTestState.bankrollUsd.toFixed(2), '#e2e8f0')}
    ${statCard('Order mode', orderMode, livePlaced > 0 ? '#f87171' : '#fbbf24')}
    ${statCard('Orders placed', String(livePlaced), livePlaced > 0 ? '#4ade80' : '#64748b')}
    ${statCard('Preview / Failed', `${previewCount} / ${failedCount}`, '#64748b')}
    ${statCard('Open', String(open.length), '#93c5fd')}
    ${statCard('Win rate', closed.length ? (wins.length/closed.length*100).toFixed(1)+'%' : '—', wins.length > 0 ? '#4ade80' : '#94a3b8')}
    ${statCard('Total P&L', (totalPnl>=0?'+':'')+'$'+totalPnl.toFixed(2), totalPnl>=0?'#4ade80':'#f87171')}
    ${statCard('ROI', totalRisked>0?(totalPnl/totalRisked*100).toFixed(1)+'%':'—', totalPnl>=0?'#4ade80':'#f87171')}
  </div>`;

  const tableRows = [...rows].sort((a,b)=>b.logged_at.localeCompare(a.logged_at)).map(r => {
    const orderBadge = r.order_status === 'placed'
      ? `<span style="background:#14532d;color:#4ade80;border-radius:4px;padding:1px 6px;font-size:.65rem;font-weight:700">PLACED</span>`
      : r.order_status === 'preview'
        ? `<span style="background:#422006;color:#fbbf24;border-radius:4px;padding:1px 6px;font-size:.65rem">PREVIEW</span>`
        : r.order_status.startsWith('failed')
          ? `<span style="background:#450a0a;color:#f87171;border-radius:4px;padding:1px 6px;font-size:.65rem" title="${r.order_status}">FAILED</span>`
          : `<span style="color:#475569;font-size:.65rem">${r.order_status}</span>`;

    const orderIdStr = r.order_id
      ? `<span style="font-size:.65rem;color:#64748b;font-family:monospace" title="${r.order_id}">${r.order_id.slice(0,10)}…</span>`
      : '';

    const outcomeBadge = !r.resolved
      ? `<span style="background:#1e3a5f;color:#93c5fd;border-radius:4px;padding:1px 7px;font-size:.68rem;font-weight:700">OPEN</span>`
      : r.pnl > 0
        ? `<span style="background:#14532d;color:#4ade80;border-radius:4px;padding:1px 7px;font-size:.68rem;font-weight:700">WIN</span>`
        : `<span style="background:#450a0a;color:#f87171;border-radius:4px;padding:1px 7px;font-size:.68rem;font-weight:700">LOSS</span>`;

    const pnlStr = r.resolved
      ? `<span class="${r.pnl>0?'pos':'neg'}">${r.pnl>=0?'+':''}$${Math.abs(r.pnl).toFixed(2)}</span>`
      : '<span class="neu">—</span>';

    const actual = r.actual_bracket ? `${r.actual_bracket}°C` : '—';

    return `<tr>
      <td style="color:#64748b;font-size:.72rem">${r.logged_at.slice(0,16).replace('T',' ')}</td>
      <td style="font-weight:600">${r.city}</td>
      <td>${r.market_date}</td>
      <td style="font-weight:600">${r.bracket_label}</td>
      <td>${(r.model_prob*100).toFixed(1)}%</td>
      <td>${(r.market_price*100).toFixed(1)}%</td>
      <td><span class="${r.edge>0?'pos':'neg'}">${r.edge>=0?'+':''}${(r.edge*100).toFixed(1)}%</span></td>
      <td><span class="${r.ev_per_dollar>=0?'pos':'neg'}">${r.ev_per_dollar>=0?'+':''}${(r.ev_per_dollar*100).toFixed(1)}¢</span></td>
      <td>${(r.kelly_pct*100).toFixed(1)}%</td>
      <td>$${r.suggested_usd.toFixed(0)}</td>
      <td>${orderBadge} ${orderIdStr}</td>
      <td>${actual}</td>
      <td>${pnlStr}</td>
      <td>${outcomeBadge}</td>
    </tr>`;
  }).join('');

  return `
  <div style="margin-bottom:18px">
    <div class="city-title" style="margin-bottom:6px">Forward Test Audit Log</div>
    <div class="city-meta">All BUY signals since ${forwardTestState.startedAt?.slice(0,16).replace('T',' ') ?? rows[0]?.logged_at.slice(0,10) ?? '—'} · updated every 15 min · ${IS_LIVE_NOTE}</div>
    <div class="city-meta" style="margin-top:6px">Expansion scope: 20-city Celsius universe shared with the portal tabs and forward-test logger.</div>
  </div>
  ${statCards}
  <div style="overflow-x:auto">
  <table>
    <thead><tr>
      <th>Logged</th><th>City</th><th>Date</th><th>Bracket</th>
      <th>Model%</th><th>Mkt%</th><th>Edge</th><th>EV/¢$</th>
      <th>Kelly</th><th>Size</th><th>Order</th><th>Actual</th><th>P&amp;L</th><th>Outcome</th>
    </tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
  </div>`;
}

function statCard(label: string, value: string, color = '#e2e8f0'): string {
  return `<div style="background:#1e293b;border:1px solid #334155;border-radius:8px;padding:12px 18px;min-width:110px">
    <div style="font-size:.7rem;color:#64748b;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">${label}</div>
    <div style="font-size:1.1rem;font-weight:700;color:${color}">${value}</div>
  </div>`;
}

main().catch(e=>{console.error(e);process.exit(1);});
