/**
 * Multi-city weather edge visualizer with EV, Kelly, and arbitrage signals.
 *
 * Usage:
 *   npx tsx src/weather/visualize.ts [--city <id|all>] [--days N] [--bias B] [--bankroll N] [--out path]
 */

import { writeFileSync, readFileSync, existsSync } from 'fs';
import { fetchEcmwfEnsemble, fetchSecondaryForecast, EnsembleMember } from './ensemble';
import { fetchMarketOdds, MarketOdds } from './polymarket_odds';
import { computeBracketProbabilities, computeEdgeTable, buildBrackets, bracketLabel, BracketProbabilities } from './brackets';
import { fetchMonthlyAnomaly } from './gistemp';
import { CITIES, CityConfig } from './cities';
import { computeBetSignals, detectArbOpportunity, BetSignal, ArbSignal } from './ev';
import { ENV as _ENV } from '../config';
const IS_LIVE_NOTE = _ENV.PREVIEW_MODE ? '🟡 PREVIEW MODE — no real orders placed' : '🔴 LIVE MODE — real orders placed';

// ---------------------------------------------------------------------------
// 12-hour trade window helpers (mirrors forwardtest.ts logic)
// ---------------------------------------------------------------------------
const TZ_OFFSET_HOURS: Record<string, number> = {
  'Asia/Seoul': 9, 'Asia/Tokyo': 9, 'Asia/Shanghai': 8,
  'Asia/Jerusalem': 3, 'Europe/London': 1,
};
function cityDayEndUtcMs(date: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d + 1, 0, 0, 0) - (TZ_OFFSET_HOURS[tz] ?? 0) * 3_600_000;
}
function tradeWindowStatus(date: string, tz: string): { open: boolean; opensAt: string; closesAt: string } {
  const dayEndMs   = cityDayEndUtcMs(date, tz);
  const openMs     = dayEndMs - 12 * 3_600_000;
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
const cityIds = cityArg === 'all' ? Object.keys(CITIES) : [cityArg];

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
  modelProbs: BracketProbabilities;
  marketProbs: Partial<BracketProbabilities>;
  rawPrices: Partial<BracketProbabilities>;   // un-normalised for arb detection
  members: number[];
  volume: number; liquidity: number;
  signals: BetSignal[];
  arb: ArbSignal | null;
};

type CityResult = {
  city: CityConfig;
  anomaly: { year: number; month: number; anomalyC: number } | null;
  snapshots: DateSnapshot[];
};

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------
async function fetchCityData(city: CityConfig): Promise<CityResult> {
  process.stdout.write(`  [${city.name}] ECMWF ensemble… `);
  const ecmwfMembers = await fetchEcmwfEnsemble(city, forecastDays);
  process.stdout.write(`${ecmwfMembers.length} member-days\n`);

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
    const temps    = dayEcmwf.map(m => m.tempMaxC);
    const secTemps = daySec.map(m => m.tempMaxC);
    const modelProbs = computeBracketProbabilities(temps, city, biasCorrection);

    let odds: MarketOdds | null = null;
    try { odds = await fetchMarketOdds(city, date); } catch {}

    const marketProbs = odds?.probs ?? {};
    const rawPrices   = Object.fromEntries((odds?.bracketMarkets ?? []).map(b => [b.bracket, b.yesPrice]));
    const volume      = odds?.volume ?? 0;
    const liquidity   = odds?.liquidity ?? 0;

    const signals = computeBetSignals(modelProbs, marketProbs, city, bankrollUsd);
    const arb     = detectArbOpportunity(rawPrices, city);

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
      modelProbs, marketProbs, rawPrices,
      members: temps, volume, liquidity, signals, arb,
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
  for (const city of cities) results.push(await fetchCityData(city));

  writeFileSync(outPath, buildHtml(results), 'utf8');
  console.log(`\nReport → ${outPath}`);
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------
function buildHtml(results: CityResult[]): string {
  const generatedAt = new Date().toUTCString();
  const totalBuys   = results.flatMap(r => r.snapshots.flatMap(s => s.signals.filter(x => x.action === 'BUY'))).length;
  const totalArbs   = results.flatMap(r => r.snapshots.filter(s => s.arb)).length;

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
/* city header */
.city-hdr{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-start;margin-bottom:18px}
.city-title{font-size:1.1rem;font-weight:700;color:#f8fafc}
.city-meta{font-size:.78rem;color:#64748b}
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
  <span>⚖️ Bias: <strong>${biasCorrection>=0?'+':''}${biasCorrection}°C</strong></span>
  <span>💰 Bankroll: <strong>$${bankrollUsd.toLocaleString()}</strong></span>
  <span class="badge-sum">✅ ${totalBuys} BUY signal${totalBuys!==1?'s':''}</span>
  ${totalArbs > 0 ? `<span class="badge-arb">🔺 ${totalArbs} ARB opportunity${totalArbs!==1?'s':''}</span>` : ''}
  <span style="color:#475569;font-size:.75rem">🔵 Model = ECMWF IFS 51-member &nbsp;|&nbsp; 🟠 Market = Polymarket &nbsp;|&nbsp; Kelly scale = 25%</span>
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
function fmtDuration(ms){
  if(ms<=0) return '0m';
  const h=Math.floor(ms/3600000), m=Math.floor((ms%3600000)/60000), s=Math.floor((ms%60000)/1000);
  if(h>0) return h+'h '+String(m).padStart(2,'0')+'m '+String(s).padStart(2,'0')+'s';
  if(m>0) return m+'m '+String(s).padStart(2,'0')+'s';
  return s+'s';
}
function updateWindows(){
  const now=Date.now();
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

function buildCityPanel(r: CityResult): string {
  const { city, anomaly, snapshots } = r;
  const aSign = anomaly && anomaly.anomalyC >= 0 ? '+' : '';
  const anomHtml = anomaly
    ? `<span class="anom ${anomaly.anomalyC>=0?'anom-warm':'anom-cool'}">
         ${anomaly.anomalyC>=0?'🌡':'❄️'} ${anomaly.year}-${String(anomaly.month).padStart(2,'0')} anomaly: ${aSign}${anomaly.anomalyC.toFixed(2)}°C vs 1991–2020
       </span>` : '';

  return `<div class="city-hdr">
    <div>
      <div class="city-title">${city.name}</div>
      <div class="city-meta">
        Resolution: <a class="stn" href="${city.wundergroundUrl}" target="_blank">${city.wundergroundUrl.split('/').pop()}</a>
        &nbsp;·&nbsp; ${city.lat}°N ${city.lon}°E
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
  const hasMkt    = Object.keys(s.marketProbs).length > 0;
  const edgeRows  = computeEdgeTable(s.modelProbs, s.marketProbs, city)
    .filter(r => r.modelProb > 0 || r.marketProb > 0);
  const volStr    = s.volume ? `$${Math.round(s.volume/1000)}K vol · $${Math.round(s.liquidity/1000)}K liq` : 'no market';
  const win       = tradeWindowStatus(s.date, city.timezone);
  const dayEndMs  = cityDayEndUtcMs(s.date, city.timezone);
  const openMs    = dayEndMs - 12 * 3_600_000;
  // Embed UTC epoch timestamps as data attrs — client JS updates every second
  const winBadge  = `<span class="win-badge" data-open="${openMs}" data-close="${dayEndMs}" style="border-radius:5px;padding:2px 9px;font-size:.7rem">loading…</span>`;

  const secChip = s.secondaryMean !== null
    ? `<div class="chip">${s.secondaryLabel} <strong>${s.secondaryMean.toFixed(1)}°C${s.secondaryStd!==null?` ±${s.secondaryStd.toFixed(1)}`:''}</strong></div>`
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
    const noCost   = arb.brackets.reduce((a, b) => a + (1 - b.price), 0);
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
    const mktPct   = row.marketProb > 0 ? (row.marketProb*100).toFixed(1)+'%' : '<span class="neu">—</span>';
    const edgePct  = row.marketProb > 0 ? `<span class="${row.edge>0.02?'pos':row.edge<-0.02?'neg':'neu'}">${row.edge>=0?'+':''}${(row.edge*100).toFixed(1)}%</span>` : '<span class="neu">—</span>';
    const ev       = sig?.marketPrice > 0 ? `<span class="${sig.evPerDollar>=0?'pos':'neg'}">${sig.evPerDollar>=0?'+':''}${(sig.evPerDollar*100).toFixed(1)}¢</span>` : '<span class="neu">—</span>';
    const kelly    = sig && sig.kellyFraction > 0 ? `${(sig.kellyFraction*100).toFixed(1)}%` : '<span class="neu">—</span>';
    const sizing   = sig?.action === 'BUY' ? `$${sig.suggestedUsd.toFixed(0)}` : '<span class="neu">—</span>';
    const action   = s.arb
      ? `<span class="b-arb">ARB</span>`
      : isBest
        ? `<span class="b-buy">BUY ★</span>`
        : sig?.action === 'BUY'
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
  <div class="chips">
    <div class="chip">ECMWF <strong>${s.ensembleMean.toFixed(1)}°C</strong></div>
    <div class="chip">σ <strong>±${s.ensembleStd.toFixed(1)}°C</strong></div>
    <div class="chip">p10 <strong>${s.p10.toFixed(1)}°C</strong></div>
    <div class="chip">p90 <strong>${s.p90.toFixed(1)}°C</strong></div>
    <div class="chip">n <strong>${s.members.length} members</strong></div>
    ${secChip}
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
  ${buySignals.length > 1 ? `<div style="font-size:.71rem;color:#64748b;margin-top:7px">★ = best bracket logged. Other qualifying brackets skipped — all share the same temperature draw (correlated risk). Min market price: 5¢.</div>` : ''}
</div>`;
}

function buildChartJs(s: DateSnapshot, city: CityConfig): string {
  const brackets  = buildBrackets(city);
  const labels    = brackets.map(b => bracketLabel(b, city));
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
    <div class="city-meta">All BUY signals since ${rows[0]?.logged_at.slice(0,10) ?? '—'} · updated every 15 min · ${IS_LIVE_NOTE}</div>
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
