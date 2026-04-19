/**
 * Rolling Brier score calibration tracker.
 *
 * After each market resolves, we score the model: Brier = mean((p - o)^2)
 * where p = model_prob at trade time and o = 1 if we bet the winning bracket.
 *
 * A well-calibrated model that picks ~40–60% probability bets and wins at that
 * rate should score ~0.20–0.24. Scores above 0.30 indicate systematic drift
 * (seasonal model bias, station change, oracle change) and warrant reduced sizing.
 */

export const BRIER_WINDOW             = 30;   // rolling window of resolved trades
export const BRIER_MIN_SAMPLES        = 10;   // need at least this many to apply penalty
export const BRIER_DEGRADED_THRESHOLD = 0.25; // mild reduction
export const BRIER_POOR_THRESHOLD     = 0.30; // heavy reduction
export const BRIER_SKIP_THRESHOLD     = 0.40; // skip entirely

export type CalibrationStatus = 'good' | 'degraded' | 'poor' | 'skip' | 'insufficient';

export type CityCalibration = {
  cityName:        string;
  brierScore:      number;
  sampleCount:     number;
  winRate:         number;
  kellyMultiplier: number; // multiply against base KELLY_SCALE; 0 = skip market
  status:          CalibrationStatus;
};

type ResolvedEntry = {
  city:           string;
  logged_at:      string;
  bracket:        string;
  actual_bracket: string;
  model_prob:     number;
  resolved:       boolean;
};

export function computeCityCalibrations(entries: ResolvedEntry[]): Map<string, CityCalibration> {
  const byCityName = new Map<string, ResolvedEntry[]>();
  for (const e of entries) {
    if (!e.resolved || !e.actual_bracket) continue;
    const bucket = byCityName.get(e.city);
    if (bucket) bucket.push(e);
    else byCityName.set(e.city, [e]);
  }

  const result = new Map<string, CityCalibration>();

  for (const [cityName, resolved] of byCityName) {
    const window = resolved
      .slice()
      .sort((a, b) => a.logged_at.localeCompare(b.logged_at))
      .slice(-BRIER_WINDOW);

    if (window.length < BRIER_MIN_SAMPLES) {
      result.set(cityName, {
        cityName, brierScore: 0, sampleCount: window.length,
        winRate: 0, kellyMultiplier: 1, status: 'insufficient',
      });
      continue;
    }

    let brierSum = 0;
    let wins = 0;
    for (const e of window) {
      const outcome = e.bracket === e.actual_bracket ? 1 : 0;
      brierSum += (e.model_prob - outcome) ** 2;
      if (outcome === 1) wins++;
    }
    const brierScore = brierSum / window.length;
    const winRate    = wins / window.length;

    let status: CalibrationStatus;
    let kellyMultiplier: number;

    if (brierScore > BRIER_SKIP_THRESHOLD) {
      status = 'skip';       kellyMultiplier = 0;
    } else if (brierScore > BRIER_POOR_THRESHOLD) {
      status = 'poor';       kellyMultiplier = 0.4;  // 0.25 → 0.10
    } else if (brierScore > BRIER_DEGRADED_THRESHOLD) {
      status = 'degraded';   kellyMultiplier = 0.6;  // 0.25 → 0.15
    } else {
      status = 'good';       kellyMultiplier = 1.0;
    }

    result.set(cityName, { cityName, brierScore, sampleCount: window.length, winRate, kellyMultiplier, status });
  }

  return result;
}
