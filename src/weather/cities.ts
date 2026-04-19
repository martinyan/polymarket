/**
 * City configurations for Polymarket temperature markets.
 *
 * IMPORTANT: coordinates are the RESOLUTION STATION (airport), not city centre.
 * Polymarket resolves on Weather Underground station data, not forecast-point data.
 *
 * Bracket structure: {min}° or below | {min+1}° … {max-1}° | {max}° or higher
 * US cities (NYC, Chicago) use Fahrenheit brackets; all others Celsius.
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
  unit:            'C' | 'F'; // bracket unit on Polymarket; ECMWF temps always Celsius, converted before bucketing
  minBracket:      number;    // lower edge in city's native unit
  maxBracket:      number;    // upper edge in city's native unit
  /** Best short-range secondary model for this city (used in ensemble) */
  secondaryModel:  'kma' | 'jma' | 'icon_eu' | 'metoffice' | 'none';
  /** Rollout bucket used by the portal and forward-test expansion plan. */
  launchPhase:     'core' | 'wave_1' | 'wave_2';
  /**
   * Station microclimate bias correction — always in Celsius regardless of market unit.
   * Positive = ECMWF grid runs warm vs. resolution station.
   */
  stationBiasC:    number;
  /** Short operator note for why this city is in the universe. */
  note:            string;
};

export const CITIES: Record<string, CityConfig> = {
  // ── Tier 1 — highest Polymarket weather liquidity ──────────────────────────

  new_york: {
    id:              'new_york',
    name:            'New York',
    // JFK International Airport (KJFK) — Polymarket resolution station.
    // Verify slug prefix against live Gamma API before going live.
    lat:             40.6413,
    lon:             -73.7781,
    timezone:        'America/New_York',
    slugPrefix:      'highest-temperature-in-new-york-on',
    wundergroundUrl: 'https://www.wunderground.com/history/daily/us/ny/new-york-city/KJFK',
    stationCode:     'KJFK',
    unit:            'F',
    minBracket:      35,   // °F — wide seasonal default; actual per-day range from Gamma API
    maxBracket:      105,
    secondaryModel:  'none', // GFS would be ideal; not yet in ensemble pipeline
    launchPhase:     'core',
    stationBiasC:    0,
    note:            'Highest Polymarket weather volume (~$399K). US market uses Fahrenheit brackets.',
  },

  hong_kong: {
    id:              'hong_kong',
    name:            'Hong Kong',
    // Hong Kong International Airport (VHHH).
    lat:             22.3080,
    lon:             113.9185,
    timezone:        'Asia/Hong_Kong',
    slugPrefix:      'highest-temperature-in-hong-kong-on',
    wundergroundUrl: 'https://www.wunderground.com/history/daily/hk/hong-kong/VHHH',
    stationCode:     'VHHH',
    unit:            'C',
    minBracket:      25,
    maxBracket:      35,
    secondaryModel:  'none',
    launchPhase:     'core',
    stationBiasC:    0,
    note:            'Second highest volume (~$397K). East Asia Celsius market.',
  },

  chicago: {
    id:              'chicago',
    name:            'Chicago',
    // O\'Hare International Airport (KORD) — standard NWS station.
    // Verify slug prefix against live Gamma API before going live.
    lat:             41.9796,
    lon:             -87.9047,
    timezone:        'America/Chicago',
    slugPrefix:      'highest-temperature-in-chicago-on',
    wundergroundUrl: 'https://www.wunderground.com/history/daily/us/il/chicago/KORD',
    stationCode:     'KORD',
    unit:            'F',
    minBracket:      25,   // °F — wide seasonal default covering Chicago winters
    maxBracket:      105,
    secondaryModel:  'none',
    launchPhase:     'core',
    stationBiasC:    0,
    note:            'Third highest volume (~$250K). US Fahrenheit market; continental climate gives more forecast spread.',
  },

  lagos: {
    id:              'lagos',
    name:            'Lagos',
    // Murtala Muhammed International Airport (DNMM).
    lat:             6.5774,
    lon:             3.3212,
    timezone:        'Africa/Lagos',
    slugPrefix:      'highest-temperature-in-lagos-on',
    wundergroundUrl: 'https://www.wunderground.com/history/daily/ng/lagos/DNMM',
    stationCode:     'DNMM',
    unit:            'C',
    minBracket:      28,
    maxBracket:      38,
    secondaryModel:  'none',
    launchPhase:     'core',
    stationBiasC:    0,
    note:            'Fourth highest volume (~$223K). Tropical African market; narrow seasonal range gives edge.',
  },

  // ── Tier 2 — strong confirmed liquidity ───────────────────────────────────

  london: {
    id:              'london',
    name:            'London',
    // London City Airport (EGLC) — East London / Docklands.
    lat:             51.5048,
    lon:             0.0495,
    timezone:        'Europe/London',
    slugPrefix:      'highest-temperature-in-london-on',
    wundergroundUrl: 'https://www.wunderground.com/history/daily/gb/london/EGLC',
    stationCode:     'EGLC',
    unit:            'C',
    minBracket:      8,
    maxBracket:      18,
    secondaryModel:  'icon_eu',
    launchPhase:     'core',
    stationBiasC:    0,
    note:            'Stable liquidity; ICON-EU secondary model available.',
  },

  paris: {
    id:              'paris',
    name:            'Paris',
    // Paris Charles de Gaulle Airport (LFPG).
    lat:             49.0097,
    lon:             2.5479,
    timezone:        'Europe/Paris',
    slugPrefix:      'highest-temperature-in-paris-on',
    wundergroundUrl: 'https://www.wunderground.com/history/daily/fr/paris/LFPG',
    stationCode:     'LFPG',
    unit:            'C',
    minBracket:      13,
    maxBracket:      23,
    secondaryModel:  'icon_eu',
    launchPhase:     'core',
    stationBiasC:    0,
    note:            'European airport market with ICON-EU secondary model.',
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
    unit:            'C',
    minBracket:      13,
    maxBracket:      23,
    secondaryModel:  'jma',
    launchPhase:     'core',
    stationBiasC:    0.5,
    note:            'JMA secondary model; coastal cooling bias at RJTT.',
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
    unit:            'C',
    minBracket:      18,
    maxBracket:      28,
    secondaryModel:  'none',
    launchPhase:     'core',
    stationBiasC:    1.0,
    note:            'Strong Asia volume; sea-breeze cooling bias at ZSPD.',
  },

  seoul: {
    id:              'seoul',
    name:            'Seoul',
    // Incheon Int\'l Airport (RKSI) — ~25km west of Seoul, coastal.
    lat:             37.4602,
    lon:             126.4407,
    timezone:        'Asia/Seoul',
    slugPrefix:      'highest-temperature-in-seoul-on',
    wundergroundUrl: 'https://www.wunderground.com/history/daily/kr/incheon/RKSI',
    stationCode:     'RKSI',
    unit:            'C',
    minBracket:      6,
    maxBracket:      16,
    secondaryModel:  'kma',
    launchPhase:     'core',
    stationBiasC:    1.5,
    note:            'KMA secondary model; ~1.5°C warm bias at RKSI coastal station.',
  },

  madrid: {
    id:              'madrid',
    name:            'Madrid',
    // Adolfo Suarez Madrid-Barajas Airport (LEMD).
    lat:             40.4983,
    lon:             -3.5676,
    timezone:        'Europe/Madrid',
    slugPrefix:      'highest-temperature-in-madrid-on',
    wundergroundUrl: 'https://www.wunderground.com/history/daily/es/madrid/LEMD',
    stationCode:     'LEMD',
    unit:            'C',
    minBracket:      23,
    maxBracket:      33,
    secondaryModel:  'icon_eu',
    launchPhase:     'core',
    stationBiasC:    0,
    note:            'Continental climate; more directional forecasts than maritime markets.',
  },
};

export const DEFAULT_CITY = 'hong_kong';
export const WEATHER_CITY_ORDER = [
  'new_york', 'hong_kong', 'chicago', 'lagos',
  'london', 'paris', 'tokyo', 'shanghai', 'seoul', 'madrid',
] as const;
export const PORTAL_CITY_IDS = [...WEATHER_CITY_ORDER];
export const FORWARD_TEST_CITY_IDS = [...WEATHER_CITY_ORDER];
export const TARGET_WEATHER_CITY_COUNT = WEATHER_CITY_ORDER.length;

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
