import test from 'node:test';
import assert from 'node:assert/strict';
import { CITIES } from './cities';
import {
  applyObservedFloorToProbabilities,
  applyStationPostProcessorToTemps,
  computePostProcessedBracketProbabilities,
  predictCalibratedMeanC,
  trainStationPostProcessor,
  TrainingSample,
  validatePostProcessedBracketProbabilities,
} from './postprocess';
import { extractWeatherCompanyApiKey, mergePreferredActualSeries } from './train_postprocess';

test('station post-processor learns a simple affine correction', () => {
  const city = CITIES.london;
  const samples: TrainingSample[] = [];
  for (let i = 0; i < 40; i++) {
    const ecmwf = 10 + i * 0.2;
    samples.push({
      date: `2025-03-${String((i % 28) + 1).padStart(2, '0')}`,
      ecmwfMeanC: ecmwf,
      gfsMeanC: ecmwf + 0.5,
      aifsMeanC: ecmwf - 0.2,
      secondaryMeanC: ecmwf + 0.1,
      actualMaxC: ecmwf + 1.5,
    });
  }

  const model = trainStationPostProcessor(city, samples);
  const pred = predictCalibratedMeanC(model, {
    date: '2025-04-15',
    ecmwfMeanC: 18,
    gfsMeanC: 18.5,
    aifsMeanC: 17.8,
      secondaryMeanC: 18.1,
      leadDays: 0,
    });

  assert.ok(Math.abs(pred - 19.5) < 0.35);
});

test('applyStationPostProcessorToTemps shifts ensemble to calibrated mean', () => {
  const city = CITIES.seoul;
  const model = {
    version: 1 as const,
    cityId: city.id,
    stationCode: city.stationCode,
    trainedAt: '2026-04-10T00:00:00.000Z',
    trainingStartDate: '2025-01-01',
    trainingEndDate: '2025-03-31',
    sampleCount: 90,
    coefficients: {
      intercept: 2,
      ecmwfMeanC: 1,
      gfsMeanC: 0,
      aifsMeanC: 0,
      secondaryMeanC: 0,
      dayOfYearSin: 0,
      dayOfYearCos: 0,
      leadDays: 0,
      leadDaysSq: 0,
    },
    rmseC: 1.1,
    maeC: 0.9,
    meanBiasC: 0,
  };

  const result = applyStationPostProcessorToTemps(
    city,
    [10, 11, 12],
    {
      date: '2026-04-10',
      ecmwfMeanC: 11,
      gfsMeanC: null,
      aifsMeanC: null,
      secondaryMeanC: null,
      leadDays: 0,
    },
    model
  );

  assert.deepEqual(result.temps, [12, 13, 14]);
  assert.equal(result.adjustment?.shiftC, 2);
});

test('probabilistic post-process returns normalized bracket probabilities', () => {
  const city = CITIES.london;
  const samples: TrainingSample[] = [];
  for (let i = 0; i < 60; i++) {
    const mean = 10 + i * 0.15;
    samples.push({
      date: `2025-02-${String((i % 28) + 1).padStart(2, '0')}`,
      ecmwfMeanC: mean,
      gfsMeanC: mean + 0.3,
      aifsMeanC: mean,
      secondaryMeanC: mean + 0.1,
      leadDays: 0,
      actualMaxC: mean + 1.2,
    });
  }

  const model = trainStationPostProcessor(city, samples);
  const result = computePostProcessedBracketProbabilities(city, {
    date: '2026-04-10',
    ecmwfMeanC: 16,
    gfsMeanC: 16.2,
    aifsMeanC: 15.9,
    secondaryMeanC: 16.1,
    leadDays: 2,
  }, model);

  assert.ok(result.probs);
  const total = Object.values(result.probs ?? {}).reduce((sum, value) => sum + value, 0);
  assert.ok(Math.abs(total - 1) < 1e-6);
});

test('observed floor zeroes out impossible colder brackets', () => {
  const city = CITIES.seoul;
  const floored = applyObservedFloorToProbabilities({
    '6_or_below': 0.1,
    '7': 0.1,
    '8': 0.1,
    '9': 0.2,
    '10': 0.2,
    '11': 0.1,
    '12': 0.1,
    '13': 0.05,
    '14': 0.03,
    '15': 0.01,
    '16_or_above': 0.01,
  }, city, 10.2);

  assert.equal(floored['6_or_below'], 0);
  assert.equal(floored['7'], 0);
  assert.equal(floored['8'], 0);
  assert.ok(floored['10'] > 0);
});

test('validatePostProcessedBracketProbabilities rejects incoherent tail-heavy distributions', () => {
  const city = CITIES.seoul;
  const valid = validatePostProcessedBracketProbabilities({
    '6_or_below': 0.5603,
    '7': 0,
    '8': 0,
    '9': 0,
    '10': 0,
    '11': 0.1394,
    '12': 0.0511,
    '13': 0.0178,
    '14': 0,
    '15': 0,
    '16_or_above': 0.2314,
  }, city, [12.5, 13.0, 13.4, 13.8, 14.3]);

  assert.equal(valid, false);
});

test('validatePostProcessedBracketProbabilities accepts distributions aligned with calibrated ensemble', () => {
  const city = CITIES.seoul;
  const valid = validatePostProcessedBracketProbabilities({
    '6_or_below': 0,
    '7': 0,
    '8': 0,
    '9': 0,
    '10': 0,
    '11': 0.1,
    '12': 0.25,
    '13': 0.35,
    '14': 0.2,
    '15': 0.1,
    '16_or_above': 0,
  }, city, [12.5, 13.0, 13.4, 13.8, 14.3]);

  assert.equal(valid, true);
});

test('extractWeatherCompanyApiKey finds the embedded Weather Company key', () => {
  const html = '<script>const x="https://api.weather.com/v3/location/point?apiKey=e1f10a1e78da46f5b10a1e78da96f525&icaoCode=EGLC";</script>';
  assert.equal(extractWeatherCompanyApiKey(html), 'e1f10a1e78da46f5b10a1e78da96f525');
});

test('mergePreferredActualSeries prefers exact station labels over archive fallback', () => {
  const merged = mergePreferredActualSeries(
    [
      { date: '2026-04-08', value: 21, source: 'twc_daily_summary' },
      { date: '2026-04-09', value: 23, source: 'twc_daily_summary' },
    ],
    [
      { date: '2026-04-07', value: 18, source: 'open_meteo_archive' },
      { date: '2026-04-08', value: 20, source: 'open_meteo_archive' },
    ],
  );

  assert.deepEqual(merged, [
    { date: '2026-04-07', value: 18, source: 'open_meteo_archive' },
    { date: '2026-04-08', value: 21, source: 'twc_daily_summary' },
    { date: '2026-04-09', value: 23, source: 'twc_daily_summary' },
  ]);
});
