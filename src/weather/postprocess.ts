import { existsSync, readFileSync, writeFileSync } from 'fs';
import { CityConfig } from './cities';
import { BracketProbabilities, buildBrackets, tempToBracket } from './brackets';

export type ForecastFeatureRow = {
  date: string;
  ecmwfMeanC: number;
  gfsMeanC: number | null;
  aifsMeanC: number | null;
  secondaryMeanC: number | null;
  leadDays?: number;
};

export type TrainingSample = ForecastFeatureRow & {
  actualMaxC: number;
  actualSource?: 'twc_daily_summary' | 'open_meteo_archive';
};

export type StationPostProcessorModel = {
  version: 1;
  cityId: string;
  stationCode: string;
  trainedAt: string;
  trainingStartDate: string;
  trainingEndDate: string;
  sampleCount: number;
  coefficients: {
    intercept: number;
    ecmwfMeanC: number;
    gfsMeanC: number;
    aifsMeanC: number;
    secondaryMeanC: number;
    dayOfYearSin: number;
    dayOfYearCos: number;
    leadDays: number;
    leadDaysSq: number;
  };
  rmseC: number;
  maeC: number;
  meanBiasC: number;
  exactLabelCount?: number;
  exactLabelSource?: string;
  quantileModels?: Record<'p10' | 'p50' | 'p90', number[]>;
  thresholdModels?: Record<string, number[]>;
  thresholdRange?: { min: number; max: number };
};

export type PostProcessAdjustment = {
  rawMeanC: number;
  calibratedMeanC: number;
  shiftC: number;
  modelPath: string;
  sampleCount: number;
  rmseC: number;
  leadDays: number;
  leadScale: number;
  p10C?: number;
  p50C?: number;
  p90C?: number;
  probabilisticModel?: 'threshold';
};

export function postProcessorPath(city: CityConfig): string {
  return `data/weather_postprocess_${city.id}.json`;
}

export function trainStationPostProcessor(
  city: CityConfig,
  samples: TrainingSample[],
  options?: { exactLabelCount?: number; exactLabelSource?: string },
): StationPostProcessorModel {
  if (samples.length < 20) {
    throw new Error(`Need at least 20 samples to train ${city.id}; got ${samples.length}`);
  }

  const x = samples.map(sample => featureVector(sample));
  const y = samples.map(sample => sample.actualMaxC);
  const beta = solveRidgeNormalEquation(x, y, 0.01);
  const predictions = x.map(row => dot(beta, row));
  const residuals = predictions.map((pred, i) => pred - y[i]);
  const rmseC = Math.sqrt(mean(residuals.map(v => v * v)));
  const maeC = mean(residuals.map(v => Math.abs(v)));
  const meanBiasC = mean(residuals);
  const quantileModels = {
    p10: fitQuantileRegression(x, y, 0.1),
    p50: fitQuantileRegression(x, y, 0.5),
    p90: fitQuantileRegression(x, y, 0.9),
  };
  const rounded = y.map(value => Math.round(value));
  const thresholdMin = Math.min(city.minBracket - 4, ...rounded) - 1;
  const thresholdMax = Math.max(city.maxBracket + 4, ...rounded) + 1;
  const thresholdModels: Record<string, number[]> = {};
  for (let threshold = thresholdMin; threshold <= thresholdMax; threshold++) {
    const labels = y.map(value => (Math.round(value) <= threshold ? 1 : 0));
    thresholdModels[String(threshold)] = solveRidgeNormalEquation(x, labels, 0.2);
  }

  return {
    version: 1,
    cityId: city.id,
    stationCode: city.stationCode,
    trainedAt: new Date().toISOString(),
    trainingStartDate: samples[0].date,
    trainingEndDate: samples[samples.length - 1].date,
    sampleCount: samples.length,
    coefficients: {
      intercept: beta[0],
      ecmwfMeanC: beta[1],
      gfsMeanC: beta[2],
      aifsMeanC: beta[3],
      secondaryMeanC: beta[4],
      dayOfYearSin: beta[5],
      dayOfYearCos: beta[6],
      leadDays: beta[7],
      leadDaysSq: beta[8],
    },
    rmseC,
    maeC,
    meanBiasC,
    exactLabelCount: options?.exactLabelCount,
    exactLabelSource: options?.exactLabelSource,
    quantileModels,
    thresholdModels,
    thresholdRange: { min: thresholdMin, max: thresholdMax },
  };
}

export function predictCalibratedMeanC(model: StationPostProcessorModel, row: ForecastFeatureRow): number {
  const features = featureVector(row);
  const beta = [
    model.coefficients.intercept,
    model.coefficients.ecmwfMeanC,
    model.coefficients.gfsMeanC,
    model.coefficients.aifsMeanC,
    model.coefficients.secondaryMeanC,
    model.coefficients.dayOfYearSin,
    model.coefficients.dayOfYearCos,
    model.coefficients.leadDays,
    model.coefficients.leadDaysSq,
  ];
  return dot(beta, features);
}

export function applyStationPostProcessorToTemps(
  city: CityConfig,
  temps: number[],
  row: ForecastFeatureRow,
  model: StationPostProcessorModel | null,
): { temps: number[]; adjustment: PostProcessAdjustment | null } {
  if (!model || temps.length === 0) {
    return { temps, adjustment: null };
  }

  const rawMeanC = mean(temps);
  const leadDays = Math.max(0, Math.round(row.leadDays ?? 0));
  const leadScale = leadTimeMeanScale(leadDays);
  const fullCalibratedMeanC = predictCalibratedMeanC(model, row);
  const calibratedMeanC = rawMeanC + (fullCalibratedMeanC - rawMeanC) * leadScale;
  const shiftC = calibratedMeanC - rawMeanC;
  if (!Number.isFinite(shiftC) || Math.abs(shiftC) < 0.01) {
    return { temps, adjustment: null };
  }

  const quantiles = predictQuantiles(model, row, rawMeanC);
  const spreadScale = leadTimeSpreadScale(leadDays);

  return {
    temps: temps.map(temp => temp + shiftC),
    adjustment: {
      rawMeanC,
      calibratedMeanC,
      shiftC,
      modelPath: postProcessorPath(city),
      sampleCount: model.sampleCount,
      rmseC: model.rmseC,
      leadDays,
      leadScale,
      p10C: quantiles ? calibratedMeanC + (quantiles.p10 - fullCalibratedMeanC) * spreadScale : undefined,
      p50C: quantiles ? calibratedMeanC + (quantiles.p50 - fullCalibratedMeanC) : undefined,
      p90C: quantiles ? calibratedMeanC + (quantiles.p90 - fullCalibratedMeanC) * spreadScale : undefined,
    },
  };
}

export function computePostProcessedBracketProbabilities(
  city: CityConfig,
  row: ForecastFeatureRow,
  model: StationPostProcessorModel | null,
): { probs: BracketProbabilities | null; adjustment: Partial<PostProcessAdjustment> | null } {
  if (!model?.thresholdModels || !model.thresholdRange) {
    return { probs: null, adjustment: null };
  }

  const leadDays = Math.max(0, Math.round(row.leadDays ?? 0));
  const leadScale = leadTimeMeanScale(leadDays);
  const rawMeanC = row.ecmwfMeanC;
  const fullCalibratedMeanC = predictCalibratedMeanC(model, row);
  const calibratedMeanC = rawMeanC + (fullCalibratedMeanC - rawMeanC) * leadScale;
  const cdfByThreshold = new Map<number, number>();

  for (let threshold = model.thresholdRange.min; threshold <= model.thresholdRange.max; threshold++) {
    const beta = model.thresholdModels[String(threshold)];
    if (!beta) continue;
    const raw = sigmoid(dot(beta, featureVector(row)));
    const adjusted = clampProbability(0.5 + (raw - 0.5) * leadProbabilityConfidenceScale(leadDays));
    cdfByThreshold.set(threshold, adjusted);
  }

  let running = 0;
  for (let threshold = model.thresholdRange.min; threshold <= model.thresholdRange.max; threshold++) {
    const value = Math.max(running, cdfByThreshold.get(threshold) ?? running);
    running = Math.min(1, value);
    cdfByThreshold.set(threshold, running);
  }

  const probs: BracketProbabilities = {};
  const brackets = buildBrackets(city);
  for (const bracket of brackets) {
    if (bracket.endsWith('_or_below')) {
      const threshold = parseInt(bracket, 10);
      probs[bracket] = cdfByThreshold.get(threshold) ?? 0;
      continue;
    }
    if (bracket.endsWith('_or_above')) {
      const threshold = parseInt(bracket, 10) - 1;
      probs[bracket] = 1 - (cdfByThreshold.get(threshold) ?? 0);
      continue;
    }
    const exact = parseInt(bracket, 10);
    const upper = cdfByThreshold.get(exact) ?? 0;
    const lower = cdfByThreshold.get(exact - 1) ?? 0;
    probs[bracket] = Math.max(0, upper - lower);
  }

  normalizeProbabilities(probs);
  const quantiles = predictQuantiles(model, row, rawMeanC);

  return {
    probs,
    adjustment: {
      rawMeanC,
      calibratedMeanC,
      shiftC: calibratedMeanC - rawMeanC,
      sampleCount: model.sampleCount,
      rmseC: model.rmseC,
      leadDays,
      leadScale,
      p10C: quantiles?.p10,
      p50C: quantiles?.p50,
      p90C: quantiles?.p90,
      probabilisticModel: 'threshold',
    },
  };
}

export function validatePostProcessedBracketProbabilities(
  probs: BracketProbabilities,
  city: CityConfig,
  referenceTemps: number[],
): boolean {
  if (!referenceTemps.length) return false;

  const referenceMean = mean(referenceTemps);
  const referenceMin = Math.min(...referenceTemps);
  const referenceMax = Math.max(...referenceTemps);
  const impliedMean = impliedBracketMeanC(probs, city);
  const tailMass = impliedTailMassOutsideRange(probs, city, referenceMin - 2, referenceMax + 2);
  const meanTolerance = Math.max(1.5, spread(referenceTemps) * 2 + 0.5);

  if (!Number.isFinite(impliedMean)) return false;
  if (Math.abs(impliedMean - referenceMean) > meanTolerance) return false;
  if (tailMass > 0.2) return false;
  return true;
}

export function applyObservedFloorToProbabilities(
  probs: BracketProbabilities,
  city: CityConfig,
  observedFloorC: number,
): BracketProbabilities {
  const floored: BracketProbabilities = {};
  const minAllowed = tempToBracket(observedFloorC, city);
  const brackets = buildBrackets(city);
  let allow = false;
  for (const bracket of brackets) {
    if (bracket === minAllowed) allow = true;
    floored[bracket] = allow ? (probs[bracket] ?? 0) : 0;
  }
  normalizeProbabilities(floored);
  return floored;
}

export function saveStationPostProcessor(model: StationPostProcessorModel, path: string): void {
  writeFileSync(path, JSON.stringify(model, null, 2) + '\n', 'utf8');
}

export function loadStationPostProcessor(city: CityConfig): StationPostProcessorModel | null {
  const path = postProcessorPath(city);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<StationPostProcessorModel>;
  if (raw.cityId !== city.id || raw.stationCode !== city.stationCode) return null;
  const coefficients = raw.coefficients ?? {
    intercept: 0, ecmwfMeanC: 1, gfsMeanC: 0, aifsMeanC: 0, secondaryMeanC: 0,
    dayOfYearSin: 0, dayOfYearCos: 0, leadDays: 0, leadDaysSq: 0,
  };
  return {
    version: 1,
    cityId: raw.cityId,
    stationCode: raw.stationCode,
    trainedAt: raw.trainedAt ?? new Date().toISOString(),
    trainingStartDate: raw.trainingStartDate ?? '',
    trainingEndDate: raw.trainingEndDate ?? '',
    sampleCount: raw.sampleCount ?? 0,
    coefficients: {
      intercept: coefficients.intercept ?? 0,
      ecmwfMeanC: coefficients.ecmwfMeanC ?? 1,
      gfsMeanC: coefficients.gfsMeanC ?? 0,
      aifsMeanC: coefficients.aifsMeanC ?? 0,
      secondaryMeanC: coefficients.secondaryMeanC ?? 0,
      dayOfYearSin: coefficients.dayOfYearSin ?? 0,
      dayOfYearCos: coefficients.dayOfYearCos ?? 0,
      leadDays: coefficients.leadDays ?? 0,
      leadDaysSq: coefficients.leadDaysSq ?? 0,
    },
    rmseC: raw.rmseC ?? 0,
    maeC: raw.maeC ?? 0,
    meanBiasC: raw.meanBiasC ?? 0,
    exactLabelCount: raw.exactLabelCount,
    exactLabelSource: raw.exactLabelSource,
    quantileModels: raw.quantileModels as StationPostProcessorModel['quantileModels'],
    thresholdModels: raw.thresholdModels as StationPostProcessorModel['thresholdModels'],
    thresholdRange: raw.thresholdRange as StationPostProcessorModel['thresholdRange'],
  };
}

function featureVector(row: ForecastFeatureRow): number[] {
  const angle = dayOfYearAngle(row.date);
  return [
    1,
    row.ecmwfMeanC,
    row.gfsMeanC ?? row.ecmwfMeanC,
    row.aifsMeanC ?? row.ecmwfMeanC,
    row.secondaryMeanC ?? row.ecmwfMeanC,
    Math.sin(angle),
    Math.cos(angle),
    row.leadDays ?? 0,
    Math.min(9, row.leadDays ?? 0) ** 2,
  ];
}

function dayOfYearAngle(date: string): number {
  const d = new Date(`${date}T00:00:00Z`);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const doy = Math.floor((d.getTime() - start) / 86_400_000) + 1;
  return 2 * Math.PI * (doy / 365.25);
}

function solveRidgeNormalEquation(x: number[][], y: number[], lambda: number): number[] {
  const cols = x[0]?.length ?? 0;
  const xtx = Array.from({ length: cols }, () => Array(cols).fill(0));
  const xty = Array(cols).fill(0);

  for (let r = 0; r < x.length; r++) {
    for (let i = 0; i < cols; i++) {
      xty[i] += x[r][i] * y[r];
      for (let j = 0; j < cols; j++) {
        xtx[i][j] += x[r][i] * x[r][j];
      }
    }
  }
  for (let i = 1; i < cols; i++) xtx[i][i] += lambda;
  return gaussianElimination(xtx, xty);
}

function fitQuantileRegression(x: number[][], y: number[], tau: number): number[] {
  const cols = x[0]?.length ?? 0;
  const beta = Array(cols).fill(0);
  const lr = 0.003;
  const lambda = 0.001;

  for (let iter = 0; iter < 1800; iter++) {
    const grad = Array(cols).fill(0);
    for (let r = 0; r < x.length; r++) {
      const pred = dot(beta, x[r]);
      const coeff = y[r] >= pred ? -tau : (1 - tau);
      for (let c = 0; c < cols; c++) grad[c] += coeff * x[r][c];
    }
    for (let c = 0; c < cols; c++) {
      grad[c] = grad[c] / Math.max(1, x.length) + (c === 0 ? 0 : lambda * beta[c]);
      beta[c] -= lr * grad[c];
    }
  }
  return beta;
}

function predictQuantiles(
  model: StationPostProcessorModel,
  row: ForecastFeatureRow,
  rawMeanC: number,
): { p10: number; p50: number; p90: number } | null {
  if (!model.quantileModels) return null;
  const fv = featureVector(row);
  const leadDays = Math.max(0, Math.round(row.leadDays ?? 0));
  const meanScale = leadTimeMeanScale(leadDays);
  const spreadScale = leadTimeSpreadScale(leadDays);
  const raw = {
    p10: dot(model.quantileModels.p10, fv),
    p50: dot(model.quantileModels.p50, fv),
    p90: dot(model.quantileModels.p90, fv),
  };
  const center = dot([
    model.coefficients.intercept,
    model.coefficients.ecmwfMeanC,
    model.coefficients.gfsMeanC,
    model.coefficients.aifsMeanC,
    model.coefficients.secondaryMeanC,
    model.coefficients.dayOfYearSin,
    model.coefficients.dayOfYearCos,
    model.coefficients.leadDays,
    model.coefficients.leadDaysSq,
  ], fv);
  const calibratedCenter = rawMeanC + (center - rawMeanC) * meanScale;
  return {
    p10: calibratedCenter + (raw.p10 - center) * spreadScale,
    p50: calibratedCenter + (raw.p50 - center),
    p90: calibratedCenter + (raw.p90 - center) * spreadScale,
  };
}

function normalizeProbabilities(probs: BracketProbabilities): void {
  const total = Object.values(probs).reduce((sum, value) => sum + value, 0);
  if (total <= 0) return;
  for (const key of Object.keys(probs)) probs[key] = Math.max(0, probs[key] / total);
}

function clampProbability(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

function leadTimeMeanScale(leadDays: number): number {
  return Math.max(0.45, 1 - leadDays * 0.12);
}

function leadTimeSpreadScale(leadDays: number): number {
  return 1 + leadDays * 0.1;
}

function leadProbabilityConfidenceScale(leadDays: number): number {
  return Math.max(0.5, 1 - leadDays * 0.1);
}

function gaussianElimination(a: number[][], b: number[]): number[] {
  const n = a.length;
  const m = a.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    }
    if (Math.abs(m[pivot][col]) < 1e-9) continue;
    if (pivot !== col) [m[col], m[pivot]] = [m[pivot], m[col]];

    const pivotVal = m[col][col];
    for (let j = col; j <= n; j++) m[col][j] /= pivotVal;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = m[row][col];
      for (let j = col; j <= n; j++) {
        m[row][j] -= factor * m[col][j];
      }
    }
  }

  return m.map(row => row[n]);
}

function dot(a: number[], b: number[]): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += (a[i] ?? 0) * (b[i] ?? 0);
  return total;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function spread(values: number[]): number {
  return values.length ? Math.max(...values) - Math.min(...values) : 0;
}

function impliedBracketMeanC(probs: BracketProbabilities, city: CityConfig): number {
  let total = 0;
  let weighted = 0;
  for (const bracket of buildBrackets(city)) {
    const prob = probs[bracket] ?? 0;
    total += prob;
    weighted += representativeTempForBracket(bracket, city) * prob;
  }
  return total > 0 ? weighted / total : Number.NaN;
}

function impliedTailMassOutsideRange(
  probs: BracketProbabilities,
  city: CityConfig,
  minAllowedC: number,
  maxAllowedC: number,
): number {
  let tailMass = 0;
  for (const bracket of buildBrackets(city)) {
    const representative = representativeTempForBracket(bracket, city);
    if (representative < minAllowedC || representative > maxAllowedC) {
      tailMass += probs[bracket] ?? 0;
    }
  }
  return tailMass;
}

function representativeTempForBracket(bracket: string, city: CityConfig): number {
  if (bracket.endsWith('_or_below')) return city.minBracket - 1;
  if (bracket.endsWith('_or_above')) return city.maxBracket + 1;
  return Number(bracket);
}
