/**
 * Polymarket temperature bracket logic.
 *
 * Brackets are generated dynamically per city config:
 *   "{min}° or below" | "{min+1}°" … "{max-1}°" | "{max}° or higher"
 *
 * ECMWF ensemble member temps are always in Celsius; cities with unit='F'
 * are converted to Fahrenheit before bucket assignment.
 */

import { CityConfig } from './cities';

export type Bracket = string; // e.g. "6_or_below", "12", "16_or_above"

export type BracketProbabilities = Record<Bracket, number>;

export type TemperatureMarketTitle =
  | { kind: 'below'; value: number }
  | { kind: 'exact'; value: number }
  | { kind: 'above'; value: number };

/** Build the ordered list of bracket keys for a city */
export function buildBrackets(city: CityConfig): Bracket[] {
  return buildBracketsFromBounds(city.minBracket, city.maxBracket);
}

/** Build the ordered list of bracket keys for explicit market bounds. */
export function buildBracketsFromBounds(minBracket: number, maxBracket: number): Bracket[] {
  const brackets: Bracket[] = [`${minBracket}_or_below`];
  for (let t = minBracket + 1; t < maxBracket; t++) {
    brackets.push(String(t));
  }
  brackets.push(`${maxBracket}_or_above`);
  return brackets;
}

/** Human-readable label for a bracket key */
export function bracketLabel(bracket: Bracket, city: CityConfig): string {
  const u = city.unit === 'F' ? 'F' : 'C';
  if (bracket === `${city.minBracket}_or_below`) return `≤${city.minBracket}°${u}`;
  if (bracket === `${city.maxBracket}_or_above`) return `≥${city.maxBracket}°${u}`;
  return `${bracket}°${u}`;
}

/**
 * Map a continuous temperature (always Celsius from ECMWF) to its bracket key.
 * Cities with unit='F' are converted before bucketing.
 */
export function tempToBracket(tempC: number, city: CityConfig): Bracket {
  const temp = city.unit === 'F' ? tempC * 9 / 5 + 32 : tempC;
  const rounded = Math.round(temp);
  if (rounded <= city.minBracket) return `${city.minBracket}_or_below`;
  if (rounded >= city.maxBracket) return `${city.maxBracket}_or_above`;
  return String(rounded);
}

/**
 * Parse a Gamma API groupItemTitle like "13°C", "60°F", "8°C or below", "84°F or higher".
 * Handles both Celsius (all existing markets) and Fahrenheit (US cities).
 * Polymarket shifts the 11-bracket range by city+date — don't rely on city-level bounds.
 */
export function parseTemperatureMarketTitle(title: string): TemperatureMarketTitle | null {
  const t = title.trim();
  const below = t.match(/^(-?\d+)°[CF] or below$/);
  if (below) return { kind: 'below', value: Number(below[1]) };
  const above = t.match(/^(-?\d+)°[CF] or higher$/);
  if (above) return { kind: 'above', value: Number(above[1]) };
  const exact = t.match(/^(-?\d+)°[CF]$/);
  if (exact) return { kind: 'exact', value: Number(exact[1]) };
  return null;
}

/**
 * Parse a Gamma API groupItemTitle into a bracket key.
 * Works for any city/date market range.
 */
export function titleToBracket(title: string, _city: CityConfig): Bracket | null {
  const parsed = parseTemperatureMarketTitle(title);
  if (!parsed) return null;
  if (parsed.kind === 'below') return `${parsed.value}_or_below`;
  if (parsed.kind === 'above') return `${parsed.value}_or_above`;
  return String(parsed.value);
}

/**
 * Compute probability per bracket from ensemble member temperatures.
 * Each member casts one vote. Returns fractions summing to 1.0.
 *
 * @param temps           Array of daily max temps from ensemble members
 * @param city            City config (determines bracket range)
 * @param biasCorrectionC Subtract this from each temp before mapping
 *                        (positive = models run too warm vs. WUnderground actuals)
 */
export function computeBracketProbabilities(
  temps: number[],
  city: CityConfig,
  biasCorrectionC = 0,
): BracketProbabilities {
  const brackets = buildBrackets(city);
  const counts: BracketProbabilities = Object.fromEntries(brackets.map(b => [b, 0]));

  for (const raw of temps) {
    const b = tempToBracket(raw - biasCorrectionC, city);
    counts[b] = (counts[b] ?? 0) + 1;
  }

  const total = temps.length;
  return Object.fromEntries(
    brackets.map(b => [b, total > 0 ? counts[b] / total : 0])
  );
}

/** Standard deviation of ensemble member temperatures — measures forecast uncertainty. */
export function computeEnsembleSpread(temps: number[]): number {
  if (temps.length < 2) return 0;
  let sum = 0, sumSq = 0;
  for (const t of temps) { sum += t; sumSq += t * t; }
  const mean = sum / temps.length;
  return Math.sqrt(Math.max(0, sumSq / temps.length - mean * mean));
}

export type EdgeRow = {
  bracket: Bracket;
  label: string;
  modelProb: number;
  marketProb: number;
  edge: number;
};

/** Compute edge table sorted by absolute edge descending */
export function computeEdgeTable(
  modelProbs: BracketProbabilities,
  marketProbs: Partial<BracketProbabilities>,
  city: CityConfig,
): EdgeRow[] {
  return buildBrackets(city)
    .map(bracket => ({
      bracket,
      label:      bracketLabel(bracket, city),
      modelProb:  modelProbs[bracket]  ?? 0,
      marketProb: marketProbs[bracket] ?? 0,
      edge:       (modelProbs[bracket] ?? 0) - (marketProbs[bracket] ?? 0),
    }))
    .sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
}
