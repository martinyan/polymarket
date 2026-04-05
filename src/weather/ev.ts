/**
 * Expected Value (EV) and Kelly Criterion calculations for Polymarket weather bets.
 *
 * --- Terminology ---
 * price (P)      : the YES token price on Polymarket (0–1). This is what you pay per share.
 *                  If you buy 1 share at 0.60¢, you pay $0.60 and receive $1 if it resolves YES.
 * model prob (Q) : your estimated true probability of YES, from ECMWF ensemble.
 * edge           : Q - P  (positive = model thinks more likely than market)
 * EV per dollar  : Q/P - 1  (how many cents profit per dollar risked, if model is correct)
 * Kelly fraction : (Q - P) / (1 - P)  (fraction of bankroll to bet for max log growth)
 *
 * --- Neg-risk markets ---
 * Polymarket temperature markets use neg-risk: exactly one bracket resolves YES.
 * Each sub-market is a standard YES/NO binary. The sum of all YES prices ≈ 1.
 * Treat each bracket independently for EV/Kelly purposes.
 *
 * --- Practical limits ---
 * - Never bet more than MAX_KELLY_FRACTION of bankroll on one position
 * - Only bet when Kelly fraction > MIN_KELLY to avoid noise trades
 * - Size in USD is: bankroll × kellyFraction × kellyScale
 *   kellyScale < 1 is "fractional Kelly" — standard practice is 0.25 (quarter Kelly)
 */

import { BracketProbabilities, Bracket, buildBrackets, bracketLabel } from './brackets';
import { CityConfig } from './cities';

// Conservative defaults — override per session risk tolerance
export const KELLY_SCALE       = 0.25;  // quarter-Kelly reduces variance
export const MIN_KELLY         = 0.03;  // skip bets with < 3% Kelly fraction
export const MIN_EV_PER_DOLLAR = 0.04;  // skip bets with < 4¢ EV per dollar
export const MAX_POSITION_USD  = 100;   // hard cap per bracket per day
export const MIN_POSITION_USD  = 5;     // Polymarket minimum order size

export type BetSignal = {
  bracket: Bracket;
  label: string;
  modelProb: number;      // Q
  marketPrice: number;    // P  (same as implied prob for binary)
  edge: number;           // Q - P
  evPerDollar: number;    // Q/P - 1
  kellyFraction: number;  // (Q-P)/(1-P)
  scaledKelly: number;    // kellyFraction * KELLY_SCALE
  suggestedUsd: number;   // bankroll * scaledKelly, capped
  action: 'BUY' | 'SKIP';
  reason?: string;
};

export type ArbSignal = {
  type: 'buy_all' | 'sell_all';
  sumOfYesPrices: number;
  theoreticalProfit: number;   // per $1 notional
  profitAfterFees: number;     // assuming 1% taker fee per leg
  brackets: Array<{ bracket: Bracket; label: string; price: number }>;
};

/**
 * Compute EV and Kelly for every bracket in a market.
 *
 * @param modelProbs   Ensemble-derived probability per bracket
 * @param marketProbs  Polymarket implied probability per bracket (unnormalised raw prices)
 * @param city         City config
 * @param bankrollUsd  Your total trading bankroll for sizing
 */
export function computeBetSignals(
  modelProbs: BracketProbabilities,
  marketProbs: Partial<BracketProbabilities>,
  city: CityConfig,
  bankrollUsd = 1000,
): BetSignal[] {
  const brackets = buildBrackets(city);
  const signals: BetSignal[] = [];

  for (const bracket of brackets) {
    const Q = modelProbs[bracket] ?? 0;
    const P = marketProbs[bracket] ?? 0;

    if (P <= 0 || P >= 1) {
      // No liquid market or already resolved
      signals.push({
        bracket, label: bracketLabel(bracket, city),
        modelProb: Q, marketPrice: P,
        edge: Q - P, evPerDollar: 0, kellyFraction: 0,
        scaledKelly: 0, suggestedUsd: 0,
        action: 'SKIP', reason: P <= 0 ? 'no market price' : 'price at ceiling',
      });
      continue;
    }

    const edge          = Q - P;
    const evPerDollar   = Q / P - 1;                          // profit per $1 if model is right
    const kellyFraction = edge > 0 ? edge / (1 - P) : 0;     // Kelly formula for binary bets
    const scaledKelly   = kellyFraction * KELLY_SCALE;
    const rawUsd        = bankrollUsd * scaledKelly;
    const suggestedUsd  = Math.min(Math.max(rawUsd, 0), MAX_POSITION_USD);

    let action: 'BUY' | 'SKIP' = 'SKIP';
    let reason: string | undefined;

    if (edge <= 0) {
      reason = `model prob (${(Q*100).toFixed(1)}%) ≤ market price (${(P*100).toFixed(1)}%)`;
    } else if (kellyFraction < MIN_KELLY) {
      reason = `Kelly ${(kellyFraction*100).toFixed(1)}% < min ${(MIN_KELLY*100).toFixed(0)}%`;
    } else if (evPerDollar < MIN_EV_PER_DOLLAR) {
      reason = `EV ${(evPerDollar*100).toFixed(1)}¢/$ < min ${(MIN_EV_PER_DOLLAR*100).toFixed(0)}¢`;
    } else if (suggestedUsd < MIN_POSITION_USD) {
      reason = `size $${suggestedUsd.toFixed(2)} < min $${MIN_POSITION_USD}`;
    } else {
      action = 'BUY';
    }

    signals.push({
      bracket, label: bracketLabel(bracket, city),
      modelProb: Q, marketPrice: P,
      edge, evPerDollar, kellyFraction, scaledKelly, suggestedUsd,
      action, reason,
    });
  }

  // Sort: BUY signals first by EV, then SKIP by edge descending
  return signals.sort((a, b) => {
    if (a.action === 'BUY' && b.action !== 'BUY') return -1;
    if (b.action === 'BUY' && a.action !== 'BUY') return 1;
    return b.evPerDollar - a.evPerDollar;
  });
}

/**
 * Scan for neg-risk arbitrage.
 *
 * In a neg-risk market, exactly one bracket resolves YES.
 * Sum of YES prices should equal 1.0.
 *
 * If sum < 1:  buy all brackets → guaranteed $1 payout on < $1 cost.
 * If sum > 1:  sell all brackets → collect > $1 now, pay out exactly $1.
 *
 * Polymarket charges a ~1% taker fee per leg, which eats into arb profit.
 * Only flag if profit after fees is positive.
 *
 * @param marketProbs  Raw (un-normalised) YES prices per bracket
 * @param city
 * @param takerFeePct  Fee as decimal (default 0.01 = 1%)
 */
export function detectArbOpportunity(
  marketProbs: Partial<BracketProbabilities>,
  city: CityConfig,
  takerFeePct = 0.01,
  // Minimum gap after fees before flagging as actionable.
  // 0.1% threshold avoids false positives from stale midpoint prices on
  // thinly-traded future markets — the Gamma API returns last-trade midpoints,
  // not live CLOB bids. Only flag when the gap is large enough to survive
  // realistic bid-ask slippage AND fees.
  minProfitAfterFees = 0.02,   // 2¢ per dollar minimum
): ArbSignal | null {
  const brackets    = buildBrackets(city);
  const activePairs = brackets
    .map(b => ({ bracket: b, label: bracketLabel(b, city), price: marketProbs[b] ?? 0 }))
    .filter(x => x.price > 0);

  // Need all brackets active — a missing bracket breaks the guarantee
  const expectedCount = brackets.length;
  if (activePairs.length < expectedCount) return null;

  const sumPrices = activePairs.reduce((s, x) => s + x.price, 0);

  // Buy-all arb: sum of YES prices < $1
  // Action: buy YES for every bracket for guaranteed $1 payout.
  // Fee = 1% taker on total spend (not per-leg — it's a % of dollars traded).
  if (sumPrices < 1) {
    const grossProfit = 1 - sumPrices;
    const totalFees   = sumPrices * takerFeePct;
    const profitAfter = grossProfit - totalFees;
    if (profitAfter >= minProfitAfterFees) {
      return { type: 'buy_all', sumOfYesPrices: sumPrices, theoreticalProfit: grossProfit, profitAfterFees: profitAfter, brackets: activePairs };
    }
  }

  // Sell-all arb: sum of YES prices > $1
  // Action: buy NO for every bracket (economically = short YES on all brackets).
  // NO portfolio cost = sum(1 - yesPrice) = N - sumYes.
  // NO portfolio payout = N - 1 (all NOs pay $1 except the one that resolves YES).
  // Gross profit = (N-1) - (N - sumYes) = sumYes - 1.
  if (sumPrices > 1) {
    const grossProfit = sumPrices - 1;
    const noCost      = activePairs.reduce((s, x) => s + (1 - x.price), 0);
    const totalFees   = noCost * takerFeePct;
    const profitAfter = grossProfit - totalFees;
    if (profitAfter >= minProfitAfterFees) {
      return { type: 'sell_all', sumOfYesPrices: sumPrices, theoreticalProfit: grossProfit, profitAfterFees: profitAfter, brackets: activePairs };
    }
  }

  return null;
}

/** Format EV as a coloured string for terminal output */
export function formatEv(evPerDollar: number): string {
  const pct = (evPerDollar * 100).toFixed(1);
  return evPerDollar >= 0 ? `+${pct}¢/$` : `${pct}¢/$`;
}
