/**
 * Polymarket temperature bracket logic.
 *
 * Brackets are generated dynamically per city config:
 *   "{min}°C or below" | "{min+1}°C" … "{max-1}°C" | "{max}°C or higher"
 *
 * Resolution is whole-degree Celsius only (Polymarket rounds to nearest integer).
 */

import { CityConfig } from './cities';

export type Bracket = string; // e.g. "6_or_below", "12", "16_or_above"

export type BracketProbabilities = Record<Bracket, number>;

/** Build the ordered list of bracket keys for a city */
export function buildBrackets(city: CityConfig): Bracket[] {
  const brackets: Bracket[] = [`${city.minBracket}_or_below`];
  for (let t = city.minBracket + 1; t < city.maxBracket; t++) {
    brackets.push(String(t));
  }
  brackets.push(`${city.maxBracket}_or_above`);
  return brackets;
}

/** Human-readable label for a bracket key */
export function bracketLabel(bracket: Bracket, city: CityConfig): string {
  if (bracket === `${city.minBracket}_or_below`) return `≤${city.minBracket}°C`;
  if (bracket === `${city.maxBracket}_or_above`) return `≥${city.maxBracket}°C`;
  return `${bracket}°C`;
}

/**
 * Map a continuous temperature to its bracket key for a given city.
 * Polymarket rounds to the nearest whole degree.
 */
export function tempToBracket(tempC: number, city: CityConfig): Bracket {
  const rounded = Math.round(tempC);
  if (rounded <= city.minBracket) return `${city.minBracket}_or_below`;
  if (rounded >= city.maxBracket) return `${city.maxBracket}_or_above`;
  return String(rounded);
}

/**
 * Parse a Gamma API groupItemTitle like "13°C" or "8°C or below" into a bracket key.
 * Works for any city.
 */
export function titleToBracket(title: string, city: CityConfig): Bracket | null {
  const t = title.trim();
  if (t === `${city.minBracket}°C or below`) return `${city.minBracket}_or_below`;
  if (t === `${city.maxBracket}°C or higher`) return `${city.maxBracket}_or_above`;
  const m = t.match(/^(\d+)°C$/);
  if (m) return m[1];
  return null;
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
