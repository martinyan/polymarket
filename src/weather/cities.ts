/**
 * City configurations for Polymarket temperature markets.
 *
 * IMPORTANT: coordinates are the RESOLUTION STATION (airport), not city centre.
 * Polymarket resolves on Weather Underground station data, not forecast-point data.
 *
 * Bracket structure: {min}°C or below | {min+1}°C … {max-1}°C | {max}°C or higher
 * = 11 outcome buckets total (consistent across all cities)
 */

export type CityConfig = {
  id:              string;
  name:            string;
  lat:             number;    // resolution station lat
  lon:             number;    // resolution station lon
  timezone:        string;
  slugPrefix:      string;    // Gamma API event slug prefix
  wundergroundUrl: string;    // resolution oracle URL
  stationCode:     string;    // ICAO code of resolution station
  minBracket:      number;    // lower edge (°C): values ≤ this → "{min}°C or below"
  maxBracket:      number;    // upper edge (°C): values ≥ this → "{max}°C or higher"
  /** Best short-range secondary model for this city (used in ensemble) */
  secondaryModel:  'kma' | 'jma' | 'icon_eu' | 'metoffice' | 'none';
};

export const CITIES: Record<string, CityConfig> = {
  seoul: {
    id:              'seoul',
    name:            'Seoul',
    // Incheon Int'l Airport (RKSI) — ~25km west of Seoul, coastal.
    // Runs 1–3°C cooler than Seoul city centre in spring/summer.
    lat:             37.4602,
    lon:             126.4407,
    timezone:        'Asia/Seoul',
    slugPrefix:      'highest-temperature-in-seoul-on',
    wundergroundUrl: 'https://www.wunderground.com/history/daily/kr/incheon/RKSI',
    stationCode:     'RKSI',
    minBracket:      6,
    maxBracket:      16,
    secondaryModel:  'kma',
  },

  london: {
    id:              'london',
    name:            'London',
    // London City Airport (EGLC) — East London / Docklands.
    // Different microclimate from Heathrow (EGLL) and city centre.
    lat:             51.5048,
    lon:             0.0495,
    timezone:        'Europe/London',
    slugPrefix:      'highest-temperature-in-london-on',
    wundergroundUrl: 'https://www.wunderground.com/history/daily/gb/london/EGLC',
    stationCode:     'EGLC',
    minBracket:      8,
    maxBracket:      18,
    secondaryModel:  'icon_eu',
  },

  tel_aviv: {
    id:              'tel_aviv',
    name:            'Tel Aviv',
    // Ben Gurion International Airport (LLBG) — ~15km SE of Tel Aviv.
    // Resolution source: WUnderground LLBG (confirmed from Gamma market description).
    lat:             32.0055,
    lon:             34.8854,
    timezone:        'Asia/Jerusalem',
    slugPrefix:      'highest-temperature-in-tel-aviv-on',
    wundergroundUrl: 'https://www.wunderground.com/history/daily/il/tel-aviv/LLBG',
    stationCode:     'LLBG',
    minBracket:      16,
    maxBracket:      26,
    secondaryModel:  'none',   // no dedicated regional model; ECMWF IFS is primary
  },

  shanghai: {
    id:              'shanghai',
    name:            'Shanghai',
    // Shanghai Pudong International Airport (ZSPD).
    lat:             31.1434,
    lon:             121.8052,
    timezone:        'Asia/Shanghai',
    slugPrefix:      'highest-temperature-in-shanghai-on',
    wundergroundUrl: 'https://www.wunderground.com/history/daily/cn/shanghai/ZSPD',
    stationCode:     'ZSPD',
    minBracket:      18,
    maxBracket:      28,
    secondaryModel:  'none',   // JMA covers China marginally; ECMWF IFS primary
  },

  tokyo: {
    id:              'tokyo',
    name:            'Tokyo',
    // Tokyo Haneda Airport (RJTT) — in Tokyo Bay, slightly coastal.
    lat:             35.5494,
    lon:             139.7798,
    timezone:        'Asia/Tokyo',
    slugPrefix:      'highest-temperature-in-tokyo-on',
    wundergroundUrl: 'https://www.wunderground.com/history/daily/jp/tokyo/RJTT',
    stationCode:     'RJTT',
    minBracket:      13,
    maxBracket:      23,
    secondaryModel:  'jma',
  },
};

export const DEFAULT_CITY = 'seoul';

export function parseCityArg(args: string[]): CityConfig {
  const idx = args.indexOf('--city');
  const id  = idx !== -1 ? args[idx + 1] : DEFAULT_CITY;
  const city = CITIES[id?.toLowerCase().replace('-', '_')];
  if (!city) {
    const valid = Object.keys(CITIES).join(', ');
    throw new Error(`Unknown city "${id}". Valid: ${valid}`);
  }
  return city;
}
