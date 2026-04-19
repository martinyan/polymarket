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
import { BRIER_SKIP_THRESHOLD } from './calibration';

// Conservative defaults — override per session risk tolerance
export const KELLY_SCALE            = 0.25;  // quarter-Kelly reduces variance
export const KELLY_SCALE_HIGH_SPREAD = 0.10; // reduced scale when ensemble is uncertain
export const MIN_KELLY              = 0.03;  // skip bets with < 3% Kelly fraction
export const MIN_EV_PER_DOLLAR      = 0.04;  // skip bets with < 4¢ EV per dollar
export const MAX_POSITION_USD       = 100;   // hard cap per bracket per day
export const MIN_POSITION_USD       = 5;     // Polymarket minimum order size
export const MIN_MARKET_PRICE       = 0.05;  // skip brackets priced below 5¢ — stale/illiquid
export const MAX_YES_PRICE_FOR_NO   = 0.95;  // skip NO when YES price ≥ 95¢ (NO price ≤ 5¢ — illiquid)
export const SPREAD_GATE_SKIP_C     = 6;     // skip entirely when ensemble spread exceeds this
export const SPREAD_GATE_REDUCE_C   = 4;     // reduce Kelly scale when spread exceeds this

export type BetSignal = {
  bracket: Bracket;
  label: string;
  tradeDirection: 'YES' | 'NO'; // which token to buy
  modelProb: number;       // Q  — model prob that this bracket resolves YES
  marketPrice: number;     // P  — YES token price on Polymarket
  edge: number;            // Q - P for YES; P - Q for NO (always positive when BUY)
  evPerDollar: number;     // Q/P - 1 for YES; (1-Q)/(1-P) - 1 for NO
  kellyFraction: number;   // (Q-P)/(1-P) for YES; (P-Q)/P for NO
  scaledKelly: number;     // kellyFraction * effective kelly scale (spread-adjusted)
  suggestedUsd: number;    // bankroll * scaledKelly, capped
  ensembleSpreadC: number; // stddev of ensemble member temps (0 = not provided)
  action: 'BUY' | 'SKIP';
  reason?: string;
};

export type ArbSignal = {
  type: 'buy_all' | 'sell_all';
  sumOfYesPrices: number;
  theoreticalProfit: number;   // per $1 notional
  profitAfterFees: number;     // after taker fee on dollars traded
  brackets: Array<{ bracket: Bracket; label: string; price: number }>; // YES ask for buy_all, NO ask for sell_all
};

export type TwoBracketBasketSignal = {
  brackets: [Bracket, Bracket];
  labels: [string, string];
  modelProbabilities: [number, number];
  marketPrices: [number, number];
  stakeUsd: [number, number];
  stakeFractions: [number, number];
  totalStakeUsd: number;
  totalStakeFraction: number;
  expectedProfitUsd: number;
  evPerDollar: number;
  profitProbability: number;
  expectedLogGrowth: number;
  outcomeProfitUsd: [number, number];
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
  ensembleSpreadC = 0,
  kellyScaleMultiplier = 1,
): BetSignal[] {
  const brackets = buildBrackets(city);
  const signals: BetSignal[] = [];
  const baseKellyScale = KELLY_SCALE * Math.max(0, kellyScaleMultiplier);
  const effectiveKellyScale =
    baseKellyScale <= 0                     ? 0 :
    ensembleSpreadC >= SPREAD_GATE_SKIP_C   ? 0 :
    ensembleSpreadC >= SPREAD_GATE_REDUCE_C ? Math.min(KELLY_SCALE_HIGH_SPREAD, baseKellyScale) :
    baseKellyScale;

  for (const bracket of brackets) {
    const Q = modelProbs[bracket] ?? 0;
    const P = marketProbs[bracket] ?? 0;

    if (P <= 0 || P >= 1) {
      signals.push({
        bracket, label: bracketLabel(bracket, city), tradeDirection: 'YES',
        modelProb: Q, marketPrice: P,
        edge: Q - P, evPerDollar: 0, kellyFraction: 0,
        scaledKelly: 0, suggestedUsd: 0, ensembleSpreadC,
        action: 'SKIP', reason: P <= 0 ? 'no market price' : 'price at ceiling',
      });
      continue;
    }

    if (P < MIN_MARKET_PRICE) {
      signals.push({
        bracket, label: bracketLabel(bracket, city), tradeDirection: 'YES',
        modelProb: Q, marketPrice: P,
        edge: Q - P, evPerDollar: Q / P - 1, kellyFraction: 0,
        scaledKelly: 0, suggestedUsd: 0, ensembleSpreadC,
        action: 'SKIP', reason: `price ${(P*100).toFixed(1)}¢ < min ${(MIN_MARKET_PRICE*100).toFixed(0)}¢ liquidity floor`,
      });
      continue;
    }

    // ── YES signal ──────────────────────────────────────────────────────────
    {
      const edge          = Q - P;
      const evPerDollar   = Q / P - 1;
      const kellyFraction = edge > 0 ? edge / (1 - P) : 0;
      const scaledKelly   = kellyFraction * effectiveKellyScale;
      const suggestedUsd  = Math.min(Math.max(bankrollUsd * scaledKelly, 0), MAX_POSITION_USD);

      let action: 'BUY' | 'SKIP' = 'SKIP';
      let reason: string | undefined;

      if (kellyScaleMultiplier <= 0) {
        reason = `calibration skip: Brier score exceeds ${BRIER_SKIP_THRESHOLD} threshold`;
      } else if (ensembleSpreadC >= SPREAD_GATE_SKIP_C) {
        reason = `spread ${ensembleSpreadC.toFixed(1)}°C ≥ ${SPREAD_GATE_SKIP_C}°C skip threshold`;
      } else if (edge <= 0) {
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
        bracket, label: bracketLabel(bracket, city), tradeDirection: 'YES',
        modelProb: Q, marketPrice: P,
        edge, evPerDollar, kellyFraction, scaledKelly, suggestedUsd, ensembleSpreadC,
        action, reason,
      });
    }

    // ── NO signal — bracket is overpriced; buy NO token ────────────────────
    // NO Kelly = (P-Q)/P;  NO EV = (1-Q)/(1-P) - 1
    // Only compute when YES price is below the liquidity ceiling (NO price ≥ MIN_MARKET_PRICE)
    if (P <= MAX_YES_PRICE_FOR_NO) {
      const noEdge          = P - Q;                         // positive when market overprices
      const noEvPerDollar   = (1 - Q) / (1 - P) - 1;
      const noKellyFraction = noEdge > 0 ? noEdge / P : 0;
      const noScaledKelly   = noKellyFraction * effectiveKellyScale;
      const noSuggestedUsd  = Math.min(Math.max(bankrollUsd * noScaledKelly, 0), MAX_POSITION_USD);

      let noAction: 'BUY' | 'SKIP' = 'SKIP';
      let noReason: string | undefined;

      if (kellyScaleMultiplier <= 0) {
        noReason = `calibration skip: Brier score exceeds ${BRIER_SKIP_THRESHOLD} threshold`;
      } else if (ensembleSpreadC >= SPREAD_GATE_SKIP_C) {
        noReason = `spread ${ensembleSpreadC.toFixed(1)}°C ≥ ${SPREAD_GATE_SKIP_C}°C skip threshold`;
      } else if (noEdge <= 0) {
        noReason = `market price (${(P*100).toFixed(1)}%) ≤ model prob (${(Q*100).toFixed(1)}%) — no NO edge`;
      } else if (noKellyFraction < MIN_KELLY) {
        noReason = `NO Kelly ${(noKellyFraction*100).toFixed(1)}% < min ${(MIN_KELLY*100).toFixed(0)}%`;
      } else if (noEvPerDollar < MIN_EV_PER_DOLLAR) {
        noReason = `NO EV ${(noEvPerDollar*100).toFixed(1)}¢/$ < min ${(MIN_EV_PER_DOLLAR*100).toFixed(0)}¢`;
      } else if (noSuggestedUsd < MIN_POSITION_USD) {
        noReason = `NO size $${noSuggestedUsd.toFixed(2)} < min $${MIN_POSITION_USD}`;
      } else {
        noAction = 'BUY';
      }

      signals.push({
        bracket, label: `${bracketLabel(bracket, city)} NO`, tradeDirection: 'NO',
        modelProb: Q, marketPrice: P,
        edge: noEdge, evPerDollar: noEvPerDollar, kellyFraction: noKellyFraction,
        scaledKelly: noScaledKelly, suggestedUsd: noSuggestedUsd, ensembleSpreadC,
        action: noAction, reason: noReason,
      });
    }
  }

  // Sort: BUY signals first by EV, then SKIP by edge descending
  return signals.sort((a, b) => {
    if (a.action === 'BUY' && b.action !== 'BUY') return -1;
    if (b.action === 'BUY' && a.action !== 'BUY') return 1;
    return b.evPerDollar - a.evPerDollar;
  });
}

/**
 * Temperature brackets in the same city+date market are mutually exclusive.
 * Multiple positive-Kelly brackets are not independent bets; for the trade
 * recommendation path, keep only the single highest-Kelly bracket actionable.
 */
export function applySingleMarketKellyRecommendation(signals: BetSignal[]): BetSignal[] {
  const buySignals = signals.filter(s => s.action === 'BUY');
  if (buySignals.length <= 1) return signals;

  const [best] = [...buySignals].sort((a, b) =>
    b.kellyFraction - a.kellyFraction ||
    b.evPerDollar - a.evPerDollar ||
    b.edge - a.edge
  );

  return signals.map(signal => {
    if (signal.action !== 'BUY' || signal.bracket === best.bracket) return signal;
    return {
      ...signal,
      action: 'SKIP' as const,
      reason: `correlated with ${best.label}; single-market Kelly selects highest Kelly`,
    };
  }).sort((a, b) => {
    if (a.action === 'BUY' && b.action !== 'BUY') return -1;
    if (b.action === 'BUY' && a.action !== 'BUY') return 1;
    return b.evPerDollar - a.evPerDollar;
  });
}

/**
 * Expected log growth for a single YES position sized using `suggestedUsd`.
 * This is the right comparison metric when deciding whether a structured basket
 * is actually better than the single highest-Kelly bracket.
 */
export function expectedLogGrowthForSingle(signal: Pick<BetSignal, 'modelProb' | 'marketPrice' | 'suggestedUsd'>, bankrollUsd: number): number {
  if (bankrollUsd <= 0 || signal.suggestedUsd <= 0) return Number.NEGATIVE_INFINITY;
  const f = signal.suggestedUsd / bankrollUsd;
  if (f <= 0 || f >= 1 || signal.marketPrice <= 0 || signal.marketPrice >= 1) return Number.NEGATIVE_INFINITY;
  const winMultiplier = 1 - f + f / signal.marketPrice;
  const loseMultiplier = 1 - f;
  if (winMultiplier <= 0 || loseMultiplier <= 0) return Number.NEGATIVE_INFINITY;
  return signal.modelProb * Math.log(winMultiplier) + (1 - signal.modelProb) * Math.log(loseMultiplier);
}

/**
 * Two-bracket basket on the same city/date market.
 *
 * Let bankroll fractions be f1 and f2 on brackets 1 and 2 priced at p1 and p2.
 * Because exactly one bracket resolves YES:
 *   W1 = 1 - f1 - f2 + f1/p1
 *   W2 = 1 - f1 - f2 + f2/p2
 *   W0 = 1 - f1 - f2              (all other brackets win)
 *
 * Expected log growth is:
 *   G = q1 ln(W1) + q2 ln(W2) + (1-q1-q2) ln(W0)
 *
 * We compare this basket against the best single-bracket trade using the same
 * total risk budget, and only use the basket when it improves expected log growth.
 */
export function findBestTwoBracketBasket(
  signals: BetSignal[],
  bankrollUsd: number,
  totalRiskUsd: number,
): TwoBracketBasketSignal | null {
  if (bankrollUsd <= 0 || totalRiskUsd < MIN_POSITION_USD * 2) return null;
  const candidates = signals
    .filter(signal => signal.action === 'BUY' && signal.suggestedUsd >= MIN_POSITION_USD && signal.marketPrice >= MIN_MARKET_PRICE)
    .sort((a, b) => b.kellyFraction - a.kellyFraction || b.evPerDollar - a.evPerDollar);
  if (candidates.length < 2) return null;

  let best: TwoBracketBasketSignal | null = null;
  const step = Math.max(1, Math.round(totalRiskUsd / 40));

  for (let i = 0; i < candidates.length - 1; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      const totalStakeUsd = Math.min(totalRiskUsd, a.suggestedUsd + b.suggestedUsd);
      if (totalStakeUsd < MIN_POSITION_USD * 2) continue;

      const minStakeA = Math.max(MIN_POSITION_USD, totalStakeUsd - b.suggestedUsd);
      const maxStakeA = Math.min(a.suggestedUsd, totalStakeUsd - MIN_POSITION_USD);
      if (minStakeA > maxStakeA) continue;

      for (let stakeA = minStakeA; stakeA <= maxStakeA + 1e-9; stakeA += step) {
        const stakeB = totalStakeUsd - stakeA;
        if (stakeB < MIN_POSITION_USD || stakeB > b.suggestedUsd) continue;

        const f1 = stakeA / bankrollUsd;
        const f2 = stakeB / bankrollUsd;
        const totalFraction = f1 + f2;
        if (f1 <= 0 || f2 <= 0 || totalFraction >= 1) continue;

        const w1 = 1 - totalFraction + f1 / a.marketPrice;
        const w2 = 1 - totalFraction + f2 / b.marketPrice;
        const w0 = 1 - totalFraction;
        if (w1 <= 0 || w2 <= 0 || w0 <= 0) continue;

        const q1 = a.modelProb;
        const q2 = b.modelProb;
        const q0 = Math.max(0, 1 - q1 - q2);

        const pnlIfA = stakeA * (1 / a.marketPrice - 1) - stakeB;
        const pnlIfB = stakeB * (1 / b.marketPrice - 1) - stakeA;
        const expectedProfitUsd =
          q1 * pnlIfA +
          q2 * pnlIfB +
          q0 * (-totalStakeUsd);
        const expectedLogGrowth =
          q1 * Math.log(w1) +
          q2 * Math.log(w2) +
          q0 * Math.log(w0);
        const profitProbability =
          (pnlIfA > 0 ? q1 : 0) +
          (pnlIfB > 0 ? q2 : 0);
        const evPerDollar = totalStakeUsd > 0 ? expectedProfitUsd / totalStakeUsd : Number.NEGATIVE_INFINITY;
        if (evPerDollar < MIN_EV_PER_DOLLAR) continue;

        const basket: TwoBracketBasketSignal = {
          brackets: [a.bracket, b.bracket],
          labels: [a.label, b.label],
          modelProbabilities: [q1, q2],
          marketPrices: [a.marketPrice, b.marketPrice],
          stakeUsd: [stakeA, stakeB],
          stakeFractions: [f1, f2],
          totalStakeUsd,
          totalStakeFraction: totalFraction,
          expectedProfitUsd,
          evPerDollar,
          profitProbability,
          expectedLogGrowth,
          outcomeProfitUsd: [pnlIfA, pnlIfB],
        };

        if (!best ||
            basket.expectedLogGrowth > best.expectedLogGrowth + 1e-9 ||
            (Math.abs(basket.expectedLogGrowth - best.expectedLogGrowth) <= 1e-9 && basket.expectedProfitUsd > best.expectedProfitUsd) ||
            (Math.abs(basket.expectedLogGrowth - best.expectedLogGrowth) <= 1e-9 && Math.abs(basket.expectedProfitUsd - best.expectedProfitUsd) <= 1e-9 && basket.profitProbability > best.profitProbability)) {
          best = basket;
        }
      }
    }
  }

  return best;
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
 * @param yesBuyPrices Executable YES buy prices per bracket (ask side)
 * @param city
 * @param takerFeePct  Fee as decimal (default 0.01 = 1%)
 * @param noBuyPrices  Executable NO buy prices per bracket (ask side), for sell-all detection
 */
export function detectArbOpportunity(
  yesBuyPrices: Partial<BracketProbabilities>,
  city: CityConfig,
  takerFeePct = 0.01,
  // Minimum gap after fees before flagging as actionable.
  // Use executable bid/ask-side prices here. Midpoints and last-trade prices
  // produce false positives on thinly traded future markets.
  minProfitAfterFees = 0.02,   // 2¢ per dollar minimum
  noBuyPrices?: Partial<BracketProbabilities>,
): ArbSignal | null {
  const brackets    = buildBrackets(city);
  const yesPairs = brackets
    .map(b => ({ bracket: b, label: bracketLabel(b, city), price: yesBuyPrices[b] ?? 0 }))
    .filter(x => x.price > 0);

  // Need all brackets active — a missing bracket breaks the guarantee
  const expectedCount = brackets.length;
  if (yesPairs.length < expectedCount) return null;

  const sumYesBuyPrices = yesPairs.reduce((s, x) => s + x.price, 0);

  // Buy-all arb: sum of YES prices < $1
  // Action: buy YES for every bracket for guaranteed $1 payout.
  // Fee = 1% taker on total spend (not per-leg — it's a % of dollars traded).
  if (sumYesBuyPrices < 1) {
    const grossProfit = 1 - sumYesBuyPrices;
    const totalFees   = sumYesBuyPrices * takerFeePct;
    const profitAfter = grossProfit - totalFees;
    if (profitAfter >= minProfitAfterFees) {
      return { type: 'buy_all', sumOfYesPrices: sumYesBuyPrices, theoreticalProfit: grossProfit, profitAfterFees: profitAfter, brackets: yesPairs };
    }
  }

  // Sell-all arb: buy NO for every bracket (economically = short YES on all brackets).
  // Use executable NO asks when available; as a backward-compatible fallback,
  // derive NO cost from YES prices. The fallback is only suitable for tests or
  // callers that intentionally pass executable YES sell-side prices.
  // NO portfolio payout = N - 1 (all NOs pay $1 except the one that resolves YES).
  const noPairs = (noBuyPrices
    ? brackets.map(b => ({ bracket: b, label: bracketLabel(b, city), price: noBuyPrices[b] ?? 0 }))
    : yesPairs.map(x => ({ ...x, price: 1 - x.price }))
  ).filter(x => x.price > 0);
  if (noPairs.length < expectedCount) return null;

  const noCost = noPairs.reduce((s, x) => s + x.price, 0);
  const noPayout = expectedCount - 1;
  if (noCost < noPayout) {
    const grossProfit = noPayout - noCost;
    const totalFees   = noCost * takerFeePct;
    const profitAfter = grossProfit - totalFees;
    if (profitAfter >= minProfitAfterFees) {
      return { type: 'sell_all', sumOfYesPrices: expectedCount - noCost, theoreticalProfit: grossProfit, profitAfterFees: profitAfter, brackets: noPairs };
    }
  }

  return null;
}

/** Format EV as a coloured string for terminal output */
export function formatEv(evPerDollar: number): string {
  const pct = (evPerDollar * 100).toFixed(1);
  return evPerDollar >= 0 ? `+${pct}¢/$` : `${pct}¢/$`;
}
