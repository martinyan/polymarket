import test from 'node:test';
import assert from 'node:assert/strict';
import { CITIES } from './cities';
import { applySingleMarketKellyRecommendation, computeBetSignals, detectArbOpportunity, expectedLogGrowthForSingle, findBestTwoBracketBasket } from './ev';

const londonApr10Market = {
  ...CITIES.london,
  minBracket: 16,
  maxBracket: 26,
};

test('buy-all arb detection uses executable asks, not midpoint outcome prices', () => {
  const outcomePrices = {
    '16_or_below': 0.855,
    '17': 0.029,
    '18': 0.017,
    '19': 0.0125,
    '20': 0.0085,
    '21': 0.0025,
    '22': 0.0045,
    '23': 0.0015,
    '24': 0.0015,
    '25': 0.0055,
    '26_or_above': 0.0035,
  };

  const yesAsks = {
    '16_or_below': 0.88,
    '17': 0.04,
    '18': 0.018,
    '19': 0.015,
    '20': 0.011,
    '21': 0.003,
    '22': 0.006,
    '23': 0.002,
    '24': 0.002,
    '25': 0.008,
    '26_or_above': 0.005,
  };

  const noAsks = {
    '16_or_below': 0.17,
    '17': 0.982,
    '18': 0.984,
    '19': 0.99,
    '20': 0.994,
    '21': 0.998,
    '22': 0.997,
    '23': 0.999,
    '24': 0.999,
    '25': 0.997,
    '26_or_above': 0.998,
  };

  assert.equal(detectArbOpportunity(outcomePrices, londonApr10Market)?.type, 'buy_all');
  assert.equal(detectArbOpportunity(yesAsks, londonApr10Market, 0.01, 0.02, noAsks), null);
});

test('single-market Kelly recommendation keeps only the highest Kelly BUY', () => {
  const city = {
    ...CITIES.london,
    minBracket: 16,
    maxBracket: 18,
  };

  const rawSignals = computeBetSignals(
    {
      '16_or_below': 0.20,
      '17': 0.45,
      '18_or_above': 0.35,
    },
    {
      '16_or_below': 0.10,
      '17': 0.25,
      '18_or_above': 0.20,
    },
    city,
    1000
  );

  assert.equal(rawSignals.filter(s => s.action === 'BUY').length, 3);

  const recommended = applySingleMarketKellyRecommendation(rawSignals);
  const buys = recommended.filter(s => s.action === 'BUY');

  assert.equal(buys.length, 1);
  assert.equal(buys[0].bracket, '17');
  assert.ok(recommended.some(s => s.bracket === '18_or_above' && s.reason?.includes('single-market Kelly')));
});

test('two-bracket basket can beat the best single bracket on expected log growth', () => {
  const city = {
    ...CITIES.london,
    minBracket: 18,
    maxBracket: 20,
  };

  const signals = computeBetSignals(
    {
      '18_or_below': 0.05,
      '19': 0.34,
      '20_or_above': 0.33,
    },
    {
      '18_or_below': 0.08,
      '19': 0.18,
      '20_or_above': 0.17,
    },
    city,
    1000
  );

  const singles = signals.filter(signal => signal.action === 'BUY').sort((a, b) => b.kellyFraction - a.kellyFraction);
  assert.ok(singles.length >= 2);

  const bestSingle = singles[0];
  const basket = findBestTwoBracketBasket(signals, 1000, bestSingle.suggestedUsd);
  assert.ok(basket);
  assert.ok(basket!.expectedLogGrowth > expectedLogGrowthForSingle(bestSingle, 1000));
  assert.ok(basket!.profitProbability > bestSingle.modelProb);
});
