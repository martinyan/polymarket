import test from 'node:test';
import assert from 'node:assert/strict';
import { CITIES } from './cities';
import { applyLiveMetarTemperatureFloor, applyTafRiskToSignals, cityLocalDate, LatestMetar, parseTafRiskOverlay, StationNowcast } from './aviation';

test('cityLocalDate renders YYYY-MM-DD in the requested timezone', () => {
  const date = new Date('2026-04-10T23:30:00.000Z');
  assert.equal(cityLocalDate(date, 'Asia/Seoul'), '2026-04-11');
  assert.equal(cityLocalDate(date, 'Europe/London'), '2026-04-11');
});

test('applyLiveMetarTemperatureFloor removes impossible members for today only', () => {
  const city = CITIES.seoul;
  const metar: LatestMetar = {
    stationCode: 'RKSI',
    reportTime: '2026-04-10T03:00:00.000Z',
    tempC: 13.2,
    rawOb: 'METAR RKSI 100300Z ... 13/08 ...',
    flightCategory: 'VFR',
    stationName: 'Incheon Intl',
  };

  const result = applyLiveMetarTemperatureFloor(
    [10, 12.5, 13.2, 13.8, 15],
    city,
    '2026-04-10',
    metar,
    new Date('2026-04-10T03:30:00.000Z')
  );

  assert.deepEqual(result.temps, [13.2, 13.8, 15]);
  assert.equal(result.adjustment?.method, 'filter');
  assert.equal(result.adjustment?.discardedMemberCount, 2);
});

test('applyLiveMetarTemperatureFloor ignores stale or non-current-day reports', () => {
  const city = CITIES.london;
  const staleMetar: LatestMetar = {
    stationCode: 'EGLC',
    reportTime: '2026-04-10T00:00:00.000Z',
    tempC: 12,
    rawOb: '',
    flightCategory: 'VFR',
    stationName: 'London City',
  };

  const stale = applyLiveMetarTemperatureFloor(
    [11, 12, 13],
    city,
    '2026-04-10',
    staleMetar,
    new Date('2026-04-10T04:30:00.000Z')
  );
  assert.deepEqual(stale.temps, [11, 12, 13]);
  assert.equal(stale.adjustment, null);

  const tomorrow = applyLiveMetarTemperatureFloor(
    [11, 12, 13],
    city,
    '2026-04-11',
    {
      ...staleMetar,
      reportTime: '2026-04-10T10:00:00.000Z',
    },
    new Date('2026-04-10T10:15:00.000Z')
  );
  assert.deepEqual(tomorrow.temps, [11, 12, 13]);
  assert.equal(tomorrow.adjustment, null);
});

test('applyLiveMetarTemperatureFloor uses the observed max-so-far across same-day METARs', () => {
  const city = CITIES.london;
  const nowcast: StationNowcast = {
    latest: {
      stationCode: 'EGLC',
      reportTime: '2026-04-10T10:00:00.000Z',
      tempC: 14,
      rawOb: '',
      flightCategory: 'VFR',
      stationName: 'London City',
    },
    observations: [
      {
        stationCode: 'EGLC',
        reportTime: '2026-04-10T07:00:00.000Z',
        tempC: 15.4,
        rawOb: '',
        flightCategory: 'VFR',
        stationName: 'London City',
      },
      {
        stationCode: 'EGLC',
        reportTime: '2026-04-10T10:00:00.000Z',
        tempC: 14,
        rawOb: '',
        flightCategory: 'VFR',
        stationName: 'London City',
      },
    ],
  };

  const result = applyLiveMetarTemperatureFloor(
    [13, 14.5, 15.5, 16],
    city,
    '2026-04-10',
    nowcast,
    new Date('2026-04-10T10:15:00.000Z')
  );

  assert.deepEqual(result.temps, [15.5, 16]);
  assert.equal(result.adjustment?.observedMaxSoFarC, 15.4);
  assert.equal(result.adjustment?.observationCount, 2);
});

test('parseTafRiskOverlay detects uncertainty features from raw taf text', () => {
  const taf = parseTafRiskOverlay(
    'TAF EGLC 101100Z 1012/1112 09012G24KT P6SM BKN020 TEMPO 1012/1016 3SM SHRA BKN012 PROB30 1016/1020 TSRA',
    'EGLC'
  );

  assert.equal(taf.stationCode, 'EGLC');
  assert.equal(taf.multiplier, 0.52);
  assert.ok(taf.reasons.some(r => r.includes('temporary/probabilistic')));
  assert.ok(taf.reasons.some(r => r.includes('precipitation')));
  assert.ok(taf.reasons.some(r => r.includes('gusty wind')));
  assert.ok(taf.reasons.some(r => r.includes('low cloud')));
});

test('applyTafRiskToSignals reduces sizing and can skip small bets', () => {
  const adjusted = applyTafRiskToSignals([
    {
      bracket: '17',
      label: '17°C',
      modelProb: 0.4,
      marketPrice: 0.2,
      edge: 0.2,
      evPerDollar: 1,
      kellyFraction: 0.1,
      scaledKelly: 0.025,
      suggestedUsd: 8,
      action: 'BUY',
    },
  ], {
    stationCode: 'EGLC',
    rawText: 'TAF...',
    multiplier: 0.5,
    reasons: ['test'],
    summary: 'TAF uncertainty overlay 0.50x: test',
  });

  assert.equal(adjusted[0].action, 'SKIP');
  assert.equal(adjusted[0].suggestedUsd, 4);
  assert.match(adjusted[0].reason ?? '', /TAF risk overlay/);
});
