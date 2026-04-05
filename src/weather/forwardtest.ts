/**
 * Forward Test — automated signal logger + resolver + P&L tracker.
 *
 * Runs in two modes:
 *   log     — fetch live signals, append new BUY entries to the CSV
 *   resolve — check all unresolved entries against Gamma, fill in actual outcome + P&L
 *   report  — print a summary table of all logged trades
 *   all     — log + resolve + report in sequence (default, used by cron)
 *
 * Usage:
 *   npx tsx src/weather/forwardtest.ts [log|resolve|report|all] [--city all|london|seoul]
 *
 * CSV: data/forward_test_log.csv
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fetchEcmwfEnsemble, fetchSecondaryForecast, EnsembleMember } from './ensemble';
import { fetchMarketOdds } from './polymarket_odds';
import { computeBracketProbabilities, buildBrackets, bracketLabel } from './brackets';
import { computeBetSignals, BetSignal } from './ev';
import { CITIES, CityConfig, parseCityArg } from './cities';
import { fetchJson } from '../http';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type LogEntry = {
  logged_at:       string;   // ISO timestamp when signal was captured
  city:            string;
  market_date:     string;   // YYYY-MM-DD the market resolves on
  bracket:         string;   // e.g. "14"
  bracket_label:   string;   // e.g. "14°C"
  model_prob:      number;   // Q — ensemble probability
  market_price:    number;   // P — Polymarket price at time of logging
  edge:            number;   // Q - P
  ev_per_dollar:   number;   // Q/P - 1
  kelly_pct:       number;   // full Kelly fraction
  suggested_usd:   number;   // quarter-Kelly capped size
  // Filled in by resolver:
  resolved:        boolean;
  actual_bracket:  string;   // bracket that resolved YES
  pnl:             number;   // $ profit/loss on suggested_usd
  notes:           string;
};

const CSV_PATH    = 'data/forward_test_log.csv';
const GAMMA_BASE  = 'https://gamma-api.polymarket.com';

const CSV_HEADERS: (keyof LogEntry)[] = [
  'logged_at', 'city', 'market_date', 'bracket', 'bracket_label',
  'model_prob', 'market_price', 'edge', 'ev_per_dollar', 'kelly_pct',
  'suggested_usd', 'resolved', 'actual_bracket', 'pnl', 'notes',
];

// ---------------------------------------------------------------------------
// CSV I/O
// ---------------------------------------------------------------------------
function readLog(): LogEntry[] {
  if (!existsSync(CSV_PATH)) return [];
  const lines = readFileSync(CSV_PATH, 'utf8').trim().split('\n');
  if (lines.length <= 1) return [];
  return lines.slice(1).map(line => {
    const cols = line.split(',');
    return {
      logged_at:      cols[0]  ?? '',
      city:           cols[1]  ?? '',
      market_date:    cols[2]  ?? '',
      bracket:        cols[3]  ?? '',
      bracket_label:  cols[4]  ?? '',
      model_prob:     parseFloat(cols[5]  ?? '0'),
      market_price:   parseFloat(cols[6]  ?? '0'),
      edge:           parseFloat(cols[7]  ?? '0'),
      ev_per_dollar:  parseFloat(cols[8]  ?? '0'),
      kelly_pct:      parseFloat(cols[9]  ?? '0'),
      suggested_usd:  parseFloat(cols[10] ?? '0'),
      resolved:       cols[11] === 'true',
      actual_bracket: cols[12] ?? '',
      pnl:            parseFloat(cols[13] ?? '0'),
      notes:          (cols[14] ?? '').replace(/^"|"$/g, ''),
    };
  });
}

function writeLog(entries: LogEntry[]): void {
  const header = CSV_HEADERS.join(',');
  const rows   = entries.map(e => CSV_HEADERS.map(k => {
    const v = e[k];
    // Quote strings that may contain commas
    if (typeof v === 'string' && (v.includes(',') || v.includes('"'))) return `"${v.replace(/"/g, '""')}"`;
    if (typeof v === 'number') return v.toFixed(4);
    return String(v);
  }).join(','));
  writeFileSync(CSV_PATH, [header, ...rows].join('\n') + '\n', 'utf8');
}

function isDuplicate(entries: LogEntry[], city: string, date: string, bracket: string): boolean {
  // Same city+date+bracket already logged today (within same calendar day UTC)
  const today = new Date().toISOString().slice(0, 10);
  return entries.some(e =>
    e.city === city &&
    e.market_date === date &&
    e.bracket === bracket &&
    e.logged_at.slice(0, 10) === today
  );
}

// ---------------------------------------------------------------------------
// Logger — fetches live signals and appends new BUY entries
// ---------------------------------------------------------------------------
async function runLogger(cityIds: string[]): Promise<number> {
  const entries = readLog();
  let added = 0;

  for (const cityId of cityIds) {
    const city = CITIES[cityId];
    if (!city) continue;

    process.stdout.write(`  [${city.name}] fetching ensemble… `);
    let members: EnsembleMember[] = [];
    try {
      members = await fetchEcmwfEnsemble(city, 7);
      process.stdout.write(`${members.length} member-days`);
    } catch (e) {
      process.stdout.write(`error: ${(e as Error).message}\n`);
      continue;
    }

    // Blend in secondary model members (deterministic; lower weight via repeat)
    try {
      const sec = await fetchSecondaryForecast(city, 4);
      if (sec.length > 0) {
        // Add each secondary reading 3× to give it ~6% weight vs 51-member ECMWF
        for (const m of sec) members.push(m, m, m);
        process.stdout.write(` + ${city.secondaryModel.toUpperCase()} blend`);
      }
    } catch {}
    process.stdout.write('\n');

    const dates: string[] = [...new Set(members.map(m => m.date))].sort();

    // Only trade within 24h of event close: today's market or tomorrow's market
    const today    = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

    for (const date of dates) {
      // Skip dates already passed or further than 24h away
      if (date < today || date > tomorrow) continue;

      const temps      = members.filter(m => m.date === date).map(m => m.tempMaxC);
      const modelProbs = computeBracketProbabilities(temps, city, 0);

      let odds: Awaited<ReturnType<typeof fetchMarketOdds>> | null = null;
      try { odds = await fetchMarketOdds(city, date); } catch { continue; }
      if (!odds || Object.keys(odds.probs).length === 0) continue;

      const signals = computeBetSignals(modelProbs, odds.probs, city, 1000);
      const buySignals = signals.filter(s => s.action === 'BUY');

      for (const sig of buySignals) {
        if (isDuplicate(entries, city.name, date, String(sig.bracket))) continue;

        entries.push({
          logged_at:      new Date().toISOString(),
          city:           city.name,
          market_date:    date,
          bracket:        String(sig.bracket),
          bracket_label:  sig.label,
          model_prob:     sig.modelProb,
          market_price:   sig.marketPrice,
          edge:           sig.edge,
          ev_per_dollar:  sig.evPerDollar,
          kelly_pct:      sig.kellyFraction,
          suggested_usd:  sig.suggestedUsd,
          resolved:       false,
          actual_bracket: '',
          pnl:            0,
          notes:          '',
        });

        console.log(`    + ${city.name} ${date} ${sig.label}  edge=${(sig.edge*100).toFixed(1)}%  EV=${(sig.evPerDollar*100).toFixed(1)}¢  size=$${sig.suggestedUsd.toFixed(0)}`);
        added++;
      }
    }
  }

  writeLog(entries);
  return added;
}

// ---------------------------------------------------------------------------
// Resolver — checks Gamma for resolved markets, fills actual_bracket + P&L
// ---------------------------------------------------------------------------
async function runResolver(): Promise<number> {
  const entries = readLog();
  let resolved  = 0;

  // Group unresolved entries by city+date for efficient API calls
  const pending = entries.filter(e => !e.resolved && e.market_date < new Date().toISOString().slice(0, 10));
  const keys    = [...new Set(pending.map(e => `${e.city}|${e.market_date}`))];

  for (const key of keys) {
    const parts    = key.split('|');
    const cityName = parts[0] as string;
    const date     = parts[1] as string;
    const city     = Object.values(CITIES).find(c => c.name === cityName);
    if (!city) continue;

    process.stdout.write(`  Resolving ${cityName} ${date}… `);

    // Build slug and fetch from Gamma
    const d     = new Date(date + 'T12:00:00Z');
    const month = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }).toLowerCase();
    const slug  = `${city.slugPrefix}-${month}-${d.getUTCDate()}-${d.getUTCFullYear()}`;
    const url   = `${GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}`;

    let actualBracket = '';
    try {
      const events = await fetchJson<any[]>(url);
      const markets = events?.[0]?.markets ?? [];
      for (const m of markets) {
        const prices = JSON.parse(m.outcomePrices ?? '["0","1"]');
        if (parseFloat(prices[0]) === 1 && m.umaResolutionStatus === 'resolved') {
          // This is the winning bracket — map groupItemTitle back to bracket key
          const title = (m.groupItemTitle ?? '').trim();
          // Normalise: "16°C" → "16", "6°C or below" → "6_or_below", "18°C or higher" → "18_or_above"
          if (title.endsWith('°C or below'))  actualBracket = `${city.minBracket}_or_below`;
          else if (title.endsWith('°C or higher')) actualBracket = `${city.maxBracket}_or_above`;
          else actualBracket = title.replace('°C', '').trim();
          break;
        }
      }
    } catch (e) {
      process.stdout.write(`error: ${(e as Error).message}\n`);
      continue;
    }

    if (!actualBracket) {
      process.stdout.write(`not resolved yet\n`);
      continue;
    }

    process.stdout.write(`resolved → ${actualBracket}°C\n`);

    // Update all matching entries
    for (const entry of entries) {
      if (entry.city !== cityName || entry.market_date !== date || entry.resolved) continue;

      entry.resolved       = true;
      entry.actual_bracket = actualBracket;

      const won = entry.bracket === actualBracket;
      if (won) {
        // Profit: shares × ($1 − price). Shares = suggested_usd / market_price.
        const shares = entry.suggested_usd / entry.market_price;
        entry.pnl    = shares * (1 - entry.market_price);
        entry.notes  = 'WIN';
      } else {
        entry.pnl   = -entry.suggested_usd;
        entry.notes = 'LOSS';
      }
      resolved++;
    }
  }

  writeLog(entries);
  return resolved;
}

// ---------------------------------------------------------------------------
// Reporter — prints running P&L summary
// ---------------------------------------------------------------------------
function runReport(): void {
  const entries  = readLog();
  const closed   = entries.filter(e => e.resolved);
  const open     = entries.filter(e => !e.resolved);
  const wins     = closed.filter(e => e.pnl > 0);
  const losses   = closed.filter(e => e.pnl <= 0);
  const totalPnl = closed.reduce((s, e) => s + e.pnl, 0);
  const totalRisked = closed.reduce((s, e) => s + e.suggested_usd, 0);

  console.log('\n══════════════════════════════════════════════════════');
  console.log(' FORWARD TEST REPORT');
  console.log(`══════════════════════════════════════════════════════`);
  console.log(` Period:     ${entries[0]?.logged_at.slice(0,10) ?? '—'} → ${new Date().toISOString().slice(0,10)}`);
  console.log(` Open:       ${open.length} signals pending resolution`);
  console.log(` Closed:     ${closed.length} (${wins.length} wins, ${losses.length} losses)`);
  console.log(` Win rate:   ${closed.length ? (wins.length/closed.length*100).toFixed(1)+'%' : '—'}`);
  console.log(` Total risked: $${totalRisked.toFixed(2)}`);
  console.log(` Total P&L:    ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);
  console.log(` ROI:          ${totalRisked > 0 ? (totalPnl/totalRisked*100).toFixed(1)+'%' : '—'}`);
  console.log('──────────────────────────────────────────────────────');

  if (closed.length === 0) {
    console.log(' No closed trades yet.\n');
  } else {
    console.log(` ${'City'.padEnd(8)} ${'Date'.padEnd(12)} ${'Bet'.padEnd(10)} ${'Model%'.padStart(7)} ${'Mkt%'.padStart(6)} ${'Actual'.padEnd(10)} ${'Size'.padStart(6)} ${'P&L'.padStart(8)}  Result`);
    console.log(` ${'─'.repeat(80)}`);
    for (const e of closed.sort((a,b) => a.market_date.localeCompare(b.market_date))) {
      const won  = e.pnl > 0;
      const pnl  = (e.pnl >= 0 ? '+' : '') + '$' + Math.abs(e.pnl).toFixed(2);
      console.log(` ${e.city.padEnd(8)} ${e.market_date.padEnd(12)} ${e.bracket_label.padEnd(10)} ${(e.model_prob*100).toFixed(1).padStart(6)}% ${(e.market_price*100).toFixed(1).padStart(5)}% ${(e.actual_bracket+'°C').padEnd(10)} $${e.suggested_usd.toFixed(0).padStart(5)} ${pnl.padStart(8)}  ${won ? '✅ WIN' : '❌ LOSS'}`);
    }
  }

  if (open.length > 0) {
    console.log('\n Open signals (awaiting resolution):');
    console.log(` ${'City'.padEnd(8)} ${'Date'.padEnd(12)} ${'Bracket'.padEnd(10)} ${'Model%'.padStart(7)} ${'Mkt%'.padStart(6)} ${'EV'.padStart(7)} ${'Size'.padStart(6)}`);
    console.log(` ${'─'.repeat(65)}`);
    for (const e of open.sort((a,b) => a.market_date.localeCompare(b.market_date))) {
      console.log(` ${e.city.padEnd(8)} ${e.market_date.padEnd(12)} ${e.bracket_label.padEnd(10)} ${(e.model_prob*100).toFixed(1).padStart(6)}% ${(e.market_price*100).toFixed(1).padStart(5)}% ${('+'+( e.ev_per_dollar*100).toFixed(1)+'¢').padStart(7)} $${e.suggested_usd.toFixed(0).padStart(5)}`);
    }
  }

  // Calibration by model probability bucket
  if (closed.length >= 5) {
    console.log('\n Calibration (model prob bucket vs actual win rate):');
    const buckets: Record<string, {predicted: number[]; wins: number}> = {};
    for (const e of closed) {
      const bucket = Math.floor(e.model_prob * 10) * 10; // 10% wide buckets
      const key    = `${bucket}-${bucket+10}%`;
      if (!buckets[key]) buckets[key] = { predicted: [], wins: 0 };
      buckets[key].predicted.push(e.model_prob);
      if (e.pnl > 0) buckets[key].wins++;
    }
    for (const [bucket, data] of Object.entries(buckets).sort()) {
      const n         = data.predicted.length;
      const avgPred   = data.predicted.reduce((a,b)=>a+b,0)/n;
      const actualWR  = data.wins / n;
      const diff      = actualWR - avgPred;
      const flag      = Math.abs(diff) > 0.1 ? ' ◄ bias' : '';
      console.log(`   ${bucket.padEnd(10)} n=${String(n).padStart(3)}  predicted=${(avgPred*100).toFixed(1)}%  actual=${(actualWR*100).toFixed(1)}%  diff=${diff>=0?'+':''}${(diff*100).toFixed(1)}%${flag}`);
    }
  }

  console.log('══════════════════════════════════════════════════════\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
const args   = process.argv.slice(2);
const mode   = ['log','resolve','report','all'].find(m => args.includes(m)) ?? 'all';

const cityIdx = args.indexOf('--city');
const cityArg = cityIdx !== -1 ? args[cityIdx + 1] : 'all';
const cityIds = cityArg === 'all' ? Object.keys(CITIES) : [cityArg];

async function main() {
  console.log(`\n=== Forward Test [${mode.toUpperCase()}] — ${new Date().toISOString()} ===\n`);

  if (mode === 'log' || mode === 'all') {
    console.log('── Logging signals ──');
    const added = await runLogger(cityIds);
    console.log(`   ${added} new signal(s) added\n`);
  }

  if (mode === 'resolve' || mode === 'all') {
    console.log('── Resolving past trades ──');
    const n = await runResolver();
    console.log(`   ${n} trade(s) resolved\n`);
  }

  if (mode === 'report' || mode === 'all') {
    runReport();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
