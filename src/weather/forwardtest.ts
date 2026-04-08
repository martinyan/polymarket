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
import { Side } from '@polymarket/clob-client';
import { ENV } from '../config';
import { createTradingClient } from '../polymarket';
import { fetchEcmwfEnsemble, fetchSecondaryForecast, EnsembleMember } from './ensemble';
import { fetchMarketOdds, cityWithMarketBrackets, BracketMarket } from './polymarket_odds';
import { computeBracketProbabilities, titleToBracket } from './brackets';
import { applySingleMarketKellyRecommendation, computeBetSignals, BetSignal } from './ev';
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
  // Order execution:
  order_status:    string;   // 'placed' | 'preview' | 'failed' | 'skipped'
  order_id:        string;   // CLOB order ID if placed, empty otherwise
  // Filled in by resolver:
  resolved:        boolean;
  actual_bracket:  string;   // bracket that resolved YES
  pnl:             number;   // $ profit/loss on suggested_usd
  notes:           string;
};

const CSV_PATH    = 'data/forward_test_log.csv';
const GAMMA_BASE  = 'https://gamma-api.polymarket.com';
const STARTING_BANKROLL_USD = 1000;

// How many hours before a day ends (in local city time) we are allowed to enter a bet.
const TRADE_WINDOW_HOURS = 8;

// UTC offsets (hours) for each city timezone, accurate for April (DST already applied).
// Seoul/Tokyo/Shanghai have no DST. London = BST (UTC+1). Tel Aviv = IDT (UTC+3).
const TZ_OFFSET_HOURS: Record<string, number> = {
  'Asia/Seoul':     9,
  'Asia/Tokyo':     9,
  'Asia/Shanghai':  8,
  'Asia/Jerusalem': 3,   // Israel Daylight Time, April
  'Europe/London':  1,   // British Summer Time, April
};

/**
 * Returns the UTC millisecond timestamp when `marketDate` ends (local midnight)
 * in the city's timezone — i.e. when the daily high is fully determined.
 *
 * Example: Seoul Apr 6  → midnight Apr 7 KST = Apr 6 15:00 UTC
 *          London Apr 6 → midnight Apr 7 BST = Apr 6 23:00 UTC
 */
function cityDayEndUtcMs(marketDate: string, timezone: string): number {
  const [y, m, d]  = marketDate.split('-').map(Number);
  const offsetHours = TZ_OFFSET_HOURS[timezone] ?? 0;
  // Midnight start of next day in local time = UTC midnight of next day minus offset
  return Date.UTC(y, m - 1, d + 1, 0, 0, 0) - offsetHours * 3_600_000;
}

/** Return ISO string showing when the trade window opens for a city+date. */
function windowOpenStr(marketDate: string, timezone: string): string {
  const openMs = cityDayEndUtcMs(marketDate, timezone) - TRADE_WINDOW_HOURS * 3_600_000;
  return new Date(openMs).toISOString();
}

const CSV_HEADERS: (keyof LogEntry)[] = [
  'logged_at', 'city', 'market_date', 'bracket', 'bracket_label',
  'model_prob', 'market_price', 'edge', 'ev_per_dollar', 'kelly_pct',
  'suggested_usd', 'order_status', 'order_id',
  'resolved', 'actual_bracket', 'pnl', 'notes',
];

const IS_LIVE = !ENV.PREVIEW_MODE && !!ENV.PRIVATE_KEY;

// ---------------------------------------------------------------------------
// CSV I/O
// ---------------------------------------------------------------------------
function readLog(): LogEntry[] {
  if (!existsSync(CSV_PATH)) return [];
  const lines = readFileSync(CSV_PATH, 'utf8').trim().split('\n');
  if (lines.length <= 1) return [];
  return lines.slice(1).map(line => {
    const cols = line.split(',');
    // Support both old (15-col) and new (17-col) formats
    const hasOrderCols = cols.length >= 17;
    const base = hasOrderCols ? 2 : 0;  // shift for order_status + order_id cols
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
      order_status:   hasOrderCols ? (cols[11] ?? 'preview') : 'preview',
      order_id:       hasOrderCols ? (cols[12] ?? '')         : '',
      resolved:       cols[11 + base] === 'true',
      actual_bracket: cols[12 + base] ?? '',
      pnl:            parseFloat(cols[13 + base] ?? '0'),
      notes:          (cols[14 + base] ?? '').replace(/^"|"$/g, ''),
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

function isDuplicate(entries: LogEntry[], city: string, date: string): boolean {
  // One position per city+date. Once logged (unresolved), skip all brackets for that event.
  // Prevents both same-bracket re-logging and adding correlated brackets on later runs.
  // Resolved entries are excluded — they no longer occupy the slot.
  return entries.some(e =>
    e.city === city &&
    e.market_date === date &&
    !e.resolved
  );
}

function currentForwardTestBankroll(entries: LogEntry[]): number {
  const closedPnl = entries
    .filter(e => e.resolved)
    .reduce((sum, e) => sum + e.pnl, 0);
  const openRisk = entries
    .filter(e => !e.resolved)
    .reduce((sum, e) => sum + e.suggested_usd, 0);
  return Math.max(0, STARTING_BANKROLL_USD + closedPnl - openRisk);
}

// ---------------------------------------------------------------------------
// Order execution — places a single BUY limit order on Polymarket CLOB
// Returns { status, orderId }
// ---------------------------------------------------------------------------
async function placeOrder(
  sig: BetSignal,
  bm: BracketMarket,
  city: CityConfig,
  date: string,
): Promise<{ status: string; orderId: string }> {
  if (!IS_LIVE) {
    console.log(`    [PREVIEW] would BUY ${sig.label} ${city.name} ${date} @ ${(sig.marketPrice*100).toFixed(1)}¢  $${sig.suggestedUsd.toFixed(0)}`);
    return { status: 'preview', orderId: '' };
  }

  if (!bm.acceptingOrders) {
    console.log(`    [SKIP] ${sig.label} ${city.name} ${date} — market not accepting orders`);
    return { status: 'skipped-not-accepting', orderId: '' };
  }

  try {
    const client = await createTradingClient();
    const shares = sig.suggestedUsd / sig.marketPrice;
    const resp: any = await client.createAndPostOrder(
      {
        tokenID: bm.yesTokenId,
        price:   parseFloat(sig.marketPrice.toFixed(3)),
        size:    parseFloat(shares.toFixed(2)),
        side:    Side.BUY,
      },
      { tickSize: bm.tickSize as any, negRisk: bm.negRisk }
    );
    const orderId = resp?.orderID ?? resp?.id ?? JSON.stringify(resp).slice(0, 40);
    console.log(`    [LIVE] ORDER PLACED ${sig.label} ${city.name} ${date}  id=${orderId}`);
    return { status: 'placed', orderId };
  } catch (err) {
    const msg = (err as Error).message.slice(0, 80);
    console.error(`    [FAILED] ${sig.label} ${city.name} ${date}  error=${msg}`);
    return { status: `failed: ${msg}`, orderId: '' };
  }
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
    const nowMs = Date.now();

    for (const date of dates) {
      const dayEndMs      = cityDayEndUtcMs(date, city.timezone);
      const windowStartMs = dayEndMs - TRADE_WINDOW_HOURS * 3_600_000;

      if (nowMs < windowStartMs) {
        // Too early — window not open yet; log when it opens
        process.stdout.write(`  [${city.name}] ${date} window opens ${windowOpenStr(date, city.timezone)} (in ${((windowStartMs - nowMs) / 3_600_000).toFixed(1)}h)\n`);
        continue;
      }
      if (nowMs >= dayEndMs) {
        // Day already over in this city's timezone — market closed
        continue;
      }

      const captureTime = new Date();
      const availableBankroll = currentForwardTestBankroll(entries);
      if (availableBankroll < 5) {
        console.log(`    - ${city.name} ${date} SKIP  available bankroll $${availableBankroll.toFixed(2)} below minimum order`);
        continue;
      }

      let odds: Awaited<ReturnType<typeof fetchMarketOdds>> | null = null;
      try { odds = await fetchMarketOdds(city, date); } catch (e) {
        console.log(`    - ${city.name} ${date} NO ODDS  error: ${(e as Error).message}`);
        continue;
      }
      if (!odds || Object.keys(odds.probs).length === 0) {
        console.log(`    - ${city.name} ${date} NO MARKET`);
        continue;
      }

      const marketCity = cityWithMarketBrackets(city, odds);
      const temps      = members.filter(m => m.date === date).map(m => m.tempMaxC);
      const modelProbs = computeBracketProbabilities(temps, marketCity, 0);
      const yesAskPrices = Object.fromEntries(odds.bracketMarkets.map(b => [b.bracket, b.yesAsk]));
      const signalPrices = Object.keys(yesAskPrices).length ? yesAskPrices : odds.probs;
      const rawSignals = computeBetSignals(modelProbs, signalPrices, marketCity, availableBankroll);
      const totalAboveThreshold = rawSignals.filter(s => s.action === 'BUY').length;
      const signals    = applySingleMarketKellyRecommendation(
        rawSignals
      );
      const buySignals = signals.filter(s => s.action === 'BUY');

      // --- Correlated-bet guard ---
      // All brackets on the same city+date share the same temperature draw.
      // Portfolio Kelly collapses to: bet only the single highest-conviction bracket.
      // Betting multiple brackets on the same event re-exposes to the same risk multiple times.
      const best = buySignals.sort((a, b) => b.kellyFraction - a.kellyFraction)[0];

      if (!best) {
        // No qualifying BUY signal — show the best candidate so we know why it was skipped
        const topSkip = signals.filter(s => s.edge > 0).sort((a, b) => b.kellyFraction - a.kellyFraction)[0];
        if (topSkip) {
          console.log(`    - ${city.name} ${date} NO SIGNAL  best=${topSkip.label}  edge=${(topSkip.edge*100).toFixed(1)}%  Kelly=${(topSkip.kellyFraction*100).toFixed(1)}%  reason: ${topSkip.reason}`);
        } else {
          console.log(`    - ${city.name} ${date} NO SIGNAL  model agrees with market (no positive edge)`);
        }
        continue;
      }

      if (isDuplicate(entries, city.name, date)) {
        console.log(`    - ${city.name} ${date} SKIP (already logged)`);
        continue;
      }

      const note = totalAboveThreshold > 1
        ? `best of ${totalAboveThreshold} qualifying brackets (highest Kelly)`
        : '';

      // Place the order (live or preview)
      const bm = odds.bracketMarkets.find(b => b.bracket === best.bracket);
      const { status: orderStatus, orderId } = bm
        ? await placeOrder(best, bm, city, date)
        : { status: 'skipped-no-token', orderId: '' };

      entries.push({
        logged_at:      captureTime.toISOString(),
        city:           city.name,
        market_date:    date,
        bracket:        String(best.bracket),
        bracket_label:  best.label,
        model_prob:     best.modelProb,
        market_price:   best.marketPrice,
        edge:           best.edge,
        ev_per_dollar:  best.evPerDollar,
        kelly_pct:      best.kellyFraction,
        suggested_usd:  best.suggestedUsd,
        order_status:   orderStatus,
        order_id:       orderId,
        resolved:       false,
        actual_bracket: '',
        pnl:            0,
        notes:          [
          note,
          `window_open=${new Date(windowStartMs).toISOString()}`,
          `captured_in_8h_window`,
          `bankroll=${availableBankroll.toFixed(2)}`,
        ].filter(Boolean).join('; '),
      });

      console.log(`    + ${city.name} ${date} ${best.label}  edge=${(best.edge*100).toFixed(1)}%  EV=${(best.evPerDollar*100).toFixed(1)}¢  bankroll=$${availableBankroll.toFixed(2)}  size=$${best.suggestedUsd.toFixed(0)}  [${orderStatus}]${totalAboveThreshold > 1 ? `  (best of ${totalAboveThreshold})` : ''}`);
      added++;
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

  // Group unresolved entries by city+date for efficient API calls.
  // An entry is eligible once the city's local day has fully ended (not just when UTC date rolls over).
  const nowMs   = Date.now();
  const pending = entries.filter(e => {
    if (e.resolved) return false;
    const city = Object.values(CITIES).find(c => c.name === e.city);
    if (!city) return false;
    return nowMs >= cityDayEndUtcMs(e.market_date, city.timezone);
  });
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
          // This is the winning bracket — map the resolved market title back to
          // the same key format used when paper trades are logged.
          actualBracket = titleToBracket(m.groupItemTitle ?? '', city) ?? '';
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
        if (entry.market_price <= 0) {
          entry.pnl   = 0;
          entry.notes = 'WIN - invalid entry price for P&L';
          resolved++;
          continue;
        }
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
