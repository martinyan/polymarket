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
 * Parse a Gamma API groupItemTitle like "13°C" or "8°C or below".
 * Polymarket shifts the 11-bracket range by city+date, so this must not rely
 * on the city-level default bounds.
 */
export function parseTemperatureMarketTitle(title: string): TemperatureMarketTitle | null {
  const t = title.trim();
  const below = t.match(/^(-?\d+)°C or below$/);
  if (below) return { kind: 'below', value: Number(below[1]) };
  const above = t.match(/^(-?\d+)°C or higher$/);
  if (above) return { kind: 'above', value: Number(above[1]) };
  const exact = t.match(/^(-?\d+)°C$/);
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
