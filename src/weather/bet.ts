/**
 * Weather bet executor.
 *
 * Takes BetSignals from ev.ts and places orders on Polymarket via the CLOB client.
 * Defaults to PREVIEW mode — prints what it would do without touching the chain.
 *
 * Usage:
 *   npx tsx src/weather/bet.ts --city london --days 2 [--live] [--bankroll 500] [--bias 0]
 *
 * Set PREVIEW_MODE=false in .env AND pass --live flag to actually place orders.
 * Both gates must be open — belt and braces.
 *
 * --- Strategy ---
 * For each forecast date:
 *   1. Fetch ECMWF ensemble → model probability per bracket
 *   2. Fetch Polymarket live odds + tokenIds
 *   3. Run EV + Kelly to find actionable signals
 *   4. Check for neg-risk arbitrage (buy/sell all brackets)
 *   5. Place a limit order at current ask price for the top Kelly BUY signal
 *
 * --- Neg-risk arbitrage execution ---
 * If arb detected (sum of YES prices < 1 after fees):
 *   → Buy YES for every bracket at current prices
 *   → One must resolve YES, netting guaranteed profit
 *
 * --- Order type ---
 * Uses limit orders at the current YES price. Orders fill immediately if there's
 * liquidity at that price, otherwise sit in the book. GTC (good-till-cancelled).
 */

import { Side } from '@polymarket/clob-client';
import { ENV } from '../config';
import { createTradingClient } from '../polymarket';
import { CityConfig, parseCityArg, CITIES } from './cities';
import { fetchEcmwfEnsemble } from './ensemble';
import { fetchMarketOdds, cityWithMarketBrackets, BracketMarket, MarketOdds } from './polymarket_odds';
import { computeBracketProbabilities } from './brackets';
import { applySingleMarketKellyRecommendation, computeBetSignals, detectArbOpportunity, BetSignal, KELLY_SCALE, MIN_KELLY } from './ev';
import { applyLiveMetarTemperatureFloor, applyTafRiskToSignals, fetchStationNowcast, fetchTafRiskOverlay, StationNowcast, TafRiskOverlay } from './aviation';
import {
  applyObservedFloorToProbabilities,
  applyStationPostProcessorToTemps,
  computePostProcessedBracketProbabilities,
  loadStationPostProcessor,
} from './postprocess';
import { buildCurrentForecastFeatureRows } from './train_postprocess';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let forecastDays   = 2;
let biasCorrection = 0;
let bankrollUsd    = 500;
let liveModeFlag   = args.includes('--live');

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--days'     && args[i+1]) forecastDays    = parseInt(args[++i], 10);
  if (args[i] === '--bias'     && args[i+1]) biasCorrection  = parseFloat(args[++i]);
  if (args[i] === '--bankroll' && args[i+1]) bankrollUsd     = parseFloat(args[++i]);
}

const city = parseCityArg(args);
const isLive = liveModeFlag && !ENV.PREVIEW_MODE;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n=== Weather Bet Executor — ${city.name} ===`);
  console.log(`Mode:     ${isLive ? '🔴 LIVE — REAL ORDERS WILL BE PLACED' : '🟡 PREVIEW — no orders placed'}`);
  console.log(`Bankroll: $${bankrollUsd}  |  Kelly scale: ${KELLY_SCALE}x  |  Min Kelly: ${(MIN_KELLY*100).toFixed(0)}%`);
  console.log(`Bias correction: ${biasCorrection >= 0 ? '+' : ''}${biasCorrection}°C\n`);

  if (isLive && !ENV.PRIVATE_KEY) {
    console.error('PRIVATE_KEY not set — cannot place live orders');
    process.exit(1);
  }

  // CLOB client (only created for live mode)
  const client = isLive ? await createTradingClient() : null;

  // Fetch ensemble
  console.log('Fetching ECMWF ensemble…');
  const ensembleMembers = await fetchEcmwfEnsemble(city, forecastDays);
  const dates = [...new Set(ensembleMembers.map(m => m.date))].sort();
  console.log(`  → ${dates.length} forecast dates\n`);

  let stationNowcast: StationNowcast | null = null;
  try { stationNowcast = await fetchStationNowcast(city.stationCode); } catch {}
  let tafOverlay: TafRiskOverlay | null = null;
  try { tafOverlay = await fetchTafRiskOverlay(city.stationCode); } catch {}
  const postProcessor = loadStationPostProcessor(city);
  const featureRows = postProcessor ? await buildCurrentForecastFeatureRows(city, forecastDays) : new Map();

  const results: Array<{ date: string; signals: BetSignal[]; arb: ReturnType<typeof detectArbOpportunity> }> = [];

  for (const date of dates) {
    console.log(`── ${date} ──────────────────────────────────`);

    // Fetch market
    const odds = await fetchMarketOdds(city, date);
    if (!odds) { console.log('  No market found — skipping\n'); continue; }

    console.log(`  Volume: $${Math.round(odds.volume).toLocaleString()}  Liquidity: $${Math.round(odds.liquidity).toLocaleString()}`);

    // Model probabilities
    const marketCity = cityWithMarketBrackets(city, odds);
    const baseTemps  = ensembleMembers.filter(m => m.date === date).map(m => m.tempMaxC);
    const calibration = applyStationPostProcessorToTemps(city, baseTemps, featureRows.get(date) ?? {
      date,
      ecmwfMeanC: baseTemps.reduce((a, b) => a + b, 0) / Math.max(baseTemps.length, 1),
      gfsMeanC: null,
      aifsMeanC: null,
      secondaryMeanC: null,
      leadDays: 0,
    }, postProcessor);
    const metarFloor = applyLiveMetarTemperatureFloor(calibration.temps, marketCity, date, stationNowcast);
    const temps      = metarFloor.temps;
    const probRow = featureRows.get(date) ?? {
      date,
      ecmwfMeanC: baseTemps.reduce((a, b) => a + b, 0) / Math.max(baseTemps.length, 1),
      gfsMeanC: null,
      aifsMeanC: null,
      secondaryMeanC: null,
      leadDays: 0,
    };
    const probabilistic = computePostProcessedBracketProbabilities(marketCity, probRow, postProcessor);
    const modelProbs = probabilistic.probs
      ? (metarFloor.adjustment
          ? applyObservedFloorToProbabilities(probabilistic.probs, marketCity, metarFloor.adjustment.observedMaxSoFarC)
          : probabilistic.probs)
      : computeBracketProbabilities(temps, marketCity, biasCorrection);
    if (calibration.adjustment) {
      console.log(`  Station post-process: shift ${calibration.adjustment.shiftC >= 0 ? '+' : ''}${calibration.adjustment.shiftC.toFixed(2)}°C (rmse ${calibration.adjustment.rmseC.toFixed(2)}°C)`);
      if (calibration.adjustment.p10C !== undefined && calibration.adjustment.p90C !== undefined) {
        console.log(`  Calibrated quantiles: p10=${calibration.adjustment.p10C.toFixed(1)}°C p50=${(calibration.adjustment.p50C ?? calibration.adjustment.calibratedMeanC).toFixed(1)}°C p90=${calibration.adjustment.p90C.toFixed(1)}°C lead=${calibration.adjustment.leadDays}d`);
      }
    }
    if (metarFloor.adjustment) {
      console.log(`  Observed max-so-far floor: ${metarFloor.adjustment.observedMaxSoFarC.toFixed(1)}°C from ${metarFloor.adjustment.observationCount} METAR(s) (${metarFloor.adjustment.method}, removed ${metarFloor.adjustment.discardedMemberCount})`);
    }

    // Neg-risk arbitrage check: use executable ask-side prices, not Gamma
    // outcomePrices/midpoints. Midpoints can show fake buy-all arb.
    const yesAskPrices = Object.fromEntries(odds.bracketMarkets.map(b => [b.bracket, b.yesAsk]));
    const noAskPrices  = Object.fromEntries(odds.bracketMarkets.map(b => [b.bracket, b.noAsk]));
    const arb          = detectArbOpportunity(yesAskPrices, marketCity, 0.01, 0.02, noAskPrices);

    // EV + Kelly signals. Use executable YES asks for recommendations; the
    // Gamma outcome price can be a stale midpoint on thin markets.
    const signalPrices = Object.keys(yesAskPrices).length ? yesAskPrices : odds.probs;
    const signals = applyTafRiskToSignals(applySingleMarketKellyRecommendation(
      computeBetSignals(modelProbs, signalPrices, marketCity, bankrollUsd)
    ), tafOverlay);
    if (tafOverlay && tafOverlay.multiplier < 1) {
      console.log(`  TAF risk overlay: ${tafOverlay.multiplier.toFixed(2)}x sizing (${tafOverlay.reasons.join('; ')})`);
    }

    results.push({ date, signals, arb });

    // Print signals
    printSignals(signals, odds);

    // Print arb
    if (arb) {
      console.log(`\n  🔺 ARB DETECTED (${arb.type})`);
      console.log(`     Sum of YES prices: ${arb.sumOfYesPrices.toFixed(4)}`);
      console.log(`     Gross profit: ${(arb.theoreticalProfit*100).toFixed(2)}¢ per dollar`);
      console.log(`     After 1% fees: ${(arb.profitAfterFees*100).toFixed(2)}¢ per dollar`);
    }

    // Execute
    const buySignals = signals.filter(s => s.action === 'BUY');

    if (arb && arb.type === 'buy_all') {
      // Arb takes priority — buy all brackets
      await executeBuyAll(client, odds, city, bankrollUsd, isLive);
    } else if (buySignals.length > 0) {
      for (const signal of buySignals) {
        const bm = odds.bracketMarkets.find(b => b.bracket === signal.bracket);
        if (!bm) continue;
        await executeBet(client, signal, bm, city, date, isLive);
      }
    } else {
      console.log('\n  No actionable signals for this date.\n');
    }
  }

  printSummary(results);
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------
async function executeBet(
  client: Awaited<ReturnType<typeof createTradingClient>> | null,
  signal: BetSignal,
  bm: BracketMarket,
  city: CityConfig,
  date: string,
  live: boolean,
): Promise<void> {
  const orderPrice = bm.yesAsk > 0 ? bm.yesAsk : signal.marketPrice;
  const size = signal.suggestedUsd / orderPrice; // shares = dollars / price

  console.log(`\n  → ${live ? 'PLACING' : 'WOULD PLACE'} BUY`);
  console.log(`     Bracket:  ${signal.label}  (${date}  ${city.name})`);
  console.log(`     Price:    ${orderPrice.toFixed(3)} (${(orderPrice*100).toFixed(1)}¢ ask)`);
  console.log(`     Size:     ${size.toFixed(2)} shares  ($${signal.suggestedUsd.toFixed(2)})`);
  console.log(`     Model:    ${(signal.modelProb*100).toFixed(1)}%`);
  console.log(`     EV:       ${(signal.evPerDollar*100).toFixed(1)}¢ per dollar`);
  console.log(`     Kelly:    ${(signal.kellyFraction*100).toFixed(1)}%  (scaled: ${(signal.scaledKelly*100).toFixed(1)}%)`);
  console.log(`     conditionId: ${bm.conditionId}`);
  console.log(`     tokenId:     ${bm.yesTokenId}`);

  if (!live || !client) {
    console.log(`     [PREVIEW — not submitted]\n`);
    return;
  }

  if (!bm.acceptingOrders) {
    console.log(`     ⚠ Market not accepting orders — skipping\n`);
    return;
  }

  try {
    const resp = await client.createAndPostOrder(
      {
        tokenID: bm.yesTokenId,
        price:   parseFloat(orderPrice.toFixed(3)),
        size:    parseFloat(size.toFixed(2)),
        side:    Side.BUY,
      },
      {
        tickSize: bm.tickSize as any,
        negRisk:  bm.negRisk,
      }
    );
    console.log(`     ✓ Order placed:`, JSON.stringify(resp, null, 2));
  } catch (err) {
    console.error(`     ✗ Order failed:`, (err as Error).message);
  }
  console.log('');
}

async function executeBuyAll(
  client: Awaited<ReturnType<typeof createTradingClient>> | null,
  odds: MarketOdds,
  city: CityConfig,
  bankrollUsd: number,
  live: boolean,
): Promise<void> {
  // For buy-all arb: buy equal shares in every bracket. Equal-dollar sizing
  // does not guarantee the same payout across outcomes.
  const totalBudget  = bankrollUsd * 0.1;
  const totalAskCost = odds.bracketMarkets.reduce((s, bm) => s + bm.yesAsk, 0);
  const shares = totalAskCost > 0 ? totalBudget / totalAskCost : 0;

  console.log(`\n  → ${live ? 'EXECUTING' : 'WOULD EXECUTE'} BUY-ALL ARB`);
  console.log(`     Total budget: $${totalBudget.toFixed(2)} (${shares.toFixed(2)} shares per bracket)`);

  for (const bm of odds.bracketMarkets) {
    const size = shares;
    const cost = size * bm.yesAsk;
    console.log(`     ${bm.bracket.padEnd(15)} price=${bm.yesAsk.toFixed(3)}  size=${size.toFixed(2)} shares  cost=$${cost.toFixed(2)}`);

    if (!live || !client || !bm.acceptingOrders) continue;

    try {
      await client.createAndPostOrder(
        { tokenID: bm.yesTokenId, price: parseFloat(bm.yesAsk.toFixed(3)), size: parseFloat(size.toFixed(2)), side: Side.BUY },
        { tickSize: bm.tickSize as any, negRisk: bm.negRisk }
      );
    } catch (err) {
      console.error(`     ✗ ${bm.bracket}:`, (err as Error).message);
    }
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------
function printSignals(signals: BetSignal[], odds: MarketOdds): void {
  const active = signals.filter(s => s.modelProb > 0 || s.marketPrice > 0);
  if (!active.length) return;

  console.log(`\n  ${'Bracket'.padEnd(12)} ${'Model%'.padStart(7)} ${'Mkt%'.padStart(6)} ${'EV/¢$'.padStart(7)} ${'Kelly%'.padStart(7)} ${'$Size'.padStart(6)}  Action`);
  console.log(`  ${'─'.repeat(65)}`);

  for (const s of active) {
    const mkt  = s.marketPrice > 0 ? (s.marketPrice*100).toFixed(1) : '  n/a';
    const ev   = s.marketPrice > 0 ? (s.evPerDollar*100 >= 0 ? '+' : '') + (s.evPerDollar*100).toFixed(1) : '   n/a';
    const kel  = s.kellyFraction > 0 ? (s.kellyFraction*100).toFixed(1) : '  n/a';
    const sz   = s.suggestedUsd > 0 ? '$' + s.suggestedUsd.toFixed(0) : '    —';
    const act  = s.action === 'BUY' ? '✅ BUY' : `— ${s.reason ?? 'skip'}`;
    console.log(`  ${s.label.padEnd(12)} ${(s.modelProb*100).toFixed(1).padStart(6)}% ${mkt.padStart(6)}% ${ev.padStart(7)}¢ ${kel.padStart(6)}% ${sz.padStart(6)}  ${act}`);
  }
  console.log('');
}

function printSummary(results: typeof main extends () => any ? any : any[]): void {
  const allSignals = results.flatMap((r: any) => r.signals.filter((s: BetSignal) => s.action === 'BUY'));
  const arbDates   = results.filter((r: any) => r.arb).map((r: any) => r.date);
  const totalSize  = allSignals.reduce((s: number, sig: BetSignal) => s + sig.suggestedUsd, 0);

  console.log('\n════════════════════════════════════════');
  console.log('SUMMARY');
  console.log(`BUY signals:  ${allSignals.length}`);
  console.log(`Total size:   $${totalSize.toFixed(2)}`);
  if (arbDates.length) console.log(`Arb dates:    ${arbDates.join(', ')}`);
  console.log('════════════════════════════════════════\n');
}

main().catch(e => { console.error(e); process.exit(1); });
