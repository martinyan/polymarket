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
  /** Rollout bucket used by the portal and forward-test expansion plan. */
  launchPhase:     'core' | 'wave_1' | 'wave_2';
  /** Short operator note for why this city is in the universe. */
  note:            string;
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
    launchPhase:     'core',
    note:            'Highest recurring Polymarket weather liquidity; Korea-specific KMA overlay available.',
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
    launchPhase:     'core',
    note:            'Stable liquidity and tight spreads; European regional model coverage is strong.',
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
    launchPhase:     'core',
    note:            'One of the stronger Asia volumes and already aligned with the current Celsius pipeline.',
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
    launchPhase:     'core',
    note:            'Airport resolution and JMA support make it a natural core market.',
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
    minBracket:      25,
    maxBracket:      35,
    secondaryModel:  'none',
    launchPhase:     'wave_1',
    note:            'High-volume East Asia Celsius market; ECMWF-only to start.',
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
    minBracket:      13,
    maxBracket:      23,
    secondaryModel:  'icon_eu',
    launchPhase:     'wave_1',
    note:            'European airport market that can benefit from the existing ICON-EU path.',
  },

  milan: {
    id:              'milan',
    name:            'Milan',
    // Milan Malpensa Airport (LIMC).
    lat:             45.6301,
    lon:             8.7281,
    timezone:        'Europe/Rome',
    slugPrefix:      'highest-temperature-in-milan-on',
    wundergroundUrl: 'https://www.wunderground.com/history/daily/it/milan/LIMC',
    stationCode:     'LIMC',
    minBracket:      17,
    maxBracket:      27,
    secondaryModel:  'icon_eu',
    launchPhase:     'wave_1',
    note:            'Celsius market with strong Europe-model overlap and diversified climate regime vs London.',
  },

  buenos_aires: {
    id:              'buenos_aires',
    name:            'Buenos Aires',
    // Ministro Pistarini International Airport / Ezeiza (SAEZ).
    lat:             -34.8222,
    lon:             -58.5358,
    timezone:        'America/Argentina/Buenos_Aires',
    slugPrefix:      'highest-temperature-in-buenos-aires-on',
    wundergroundUrl: 'https://www.wunderground.com/history/daily/ar/ezeiza/SAEZ',
    stationCode:     'SAEZ',
    minBracket:      27,
    maxBracket:      35,
    secondaryModel:  'none',
    launchPhase:     'wave_1',
    note:            'Southern-hemisphere diversification with verified airport resolution on Polymarket.',
  },

  toronto: {
    id:              'toronto',
    name:            'Toronto',
    // Toronto Pearson International Airport (CYYZ).
    lat:             43.6777,
    lon:             -79.6248,
    timezone:        'America/Toronto',
    slugPrefix:      'highest-temperature-in-toronto-on',
    wundergroundUrl: 'https://www.wunderground.com/history/daily/ca/mississauga/CYYZ',
    stationCode:     'CYYZ',
    minBracket:      6,
    maxBracket:      16,
    secondaryModel:  'none',
    launchPhase:     'wave_1',
    note:            'Large North American Celsius market that avoids the repo’s current Fahrenheit limitation.',
  },

  wellington: {
    id:              'wellington',
    name:            'Wellington',
    // Wellington International Airport (NZWN).
    lat:             -41.3272,
    lon:             174.8050,
    timezone:        'Pacific/Auckland',
    slugPrefix:      'highest-temperature-in-wellington-on',
    wundergroundUrl: 'https://www.wunderground.com/history/daily/nz/wellington/NZWN',
    stationCode:     'NZWN',
    minBracket:      14,
    maxBracket:      24,
    secondaryModel:  'none',
    launchPhase:     'wave_1',
    note:            'Oceania coverage with airport-based resolution and limited overlap to current exposures.',
  },

  shenzhen: {
    id:              'shenzhen',
    name:            'Shenzhen',
    // Shenzhen Bao'an International Airport (ZGSZ).
    lat:             22.6393,
    lon:             113.8107,
    timezone:        'Asia/Shanghai',
    slugPrefix:      'highest-temperature-in-shenzhen-on',
    wundergroundUrl: 'https://www.wunderground.com/history/daily/cn/shenzhen/ZGSZ',
    stationCode:     'ZGSZ',
    minBracket:      24,
    maxBracket:      34,
    secondaryModel:  'none',
    launchPhase:     'wave_1',
    note:            'High-humidity South China market that broadens China exposure beyond Shanghai.',
  },

  beijing: {
    id:              'beijing',
    name:            'Beijing',
    // Beijing Capital International Airport (ZBAA).
    lat:             40.0801,
    lon:             116.5846,
    timezone:        'Asia/Shanghai',
    slugPrefix:      'highest-temperature-in-beijing-on',
    wundergroundUrl: 'https://www.wunderground.com/history/daily/cn/beijing/ZBAA',
    stationCode:     'ZBAA',
    minBracket:      23,
    maxBracket:      33,
    secondaryModel:  'none',
    launchPhase:     'wave_1',
    note:            'Large-liquid China market with a distinct inland regime vs coastal cities.',
  },

  singapore: {
    id:              'singapore',
    name:            'Singapore',
    // Singapore Changi Airport (WSSS).
    lat:             1.3644,
    lon:             103.9915,
    timezone:        'Asia/Singapore',
    slugPrefix:      'highest-temperature-in-singapore-on',
    wundergroundUrl: 'https://www.wunderground.com/history/daily/sg/singapore/WSSS',
    stationCode:     'WSSS',
    minBracket:      29,
    maxBracket:      39,
    secondaryModel:  'none',
    launchPhase:     'wave_2',
    note:            'Dense tropical Celsius market; useful for broadening seasonality coverage.',
  },

  mexico_city: {
    id:              'mexico_city',
    name:            'Mexico City',
    // Benito Juarez International Airport (MMMX).
    lat:             19.4361,
    lon:             -99.0719,
    timezone:        'America/Mexico_City',
    slugPrefix:      'highest-temperature-in-mexico-city-on',
    wundergroundUrl: 'https://www.wunderground.com/history/daily/mx/mexico-city/MMMX',
    stationCode:     'MMMX',
    minBracket:      13,
    maxBracket:      23,
    secondaryModel:  'none',
    launchPhase:     'wave_2',
    note:            'Verified airport rule on Polymarket and a useful high-altitude temperature regime.',
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
    minBracket:      23,
    maxBracket:      33,
    secondaryModel:  'icon_eu',
    launchPhase:     'wave_2',
    note:            'Strong fit for the Europe stack and often more directional than maritime climates.',
  },

  munich: {
    id:              'munich',
    name:            'Munich',
    // Munich Airport (EDDM).
    lat:             48.3538,
    lon:             11.7861,
    timezone:        'Europe/Berlin',
    slugPrefix:      'highest-temperature-in-munich-on',
    wundergroundUrl: 'https://www.wunderground.com/history/daily/de/munich/EDDM',
    stationCode:     'EDDM',
    minBracket:      8,
    maxBracket:      18,
    secondaryModel:  'icon_eu',
    launchPhase:     'wave_2',
    note:            'Another verified Europe airport city with different alpine-season behavior.',
  },

  jakarta: {
    id:              'jakarta',
    name:            'Jakarta',
    // Soekarno-Hatta International Airport (WIII).
    lat:             -6.1256,
    lon:             106.6559,
    timezone:        'Asia/Jakarta',
    slugPrefix:      'highest-temperature-in-jakarta-on',
    wundergroundUrl: 'https://www.wunderground.com/history/daily/id/jakarta/WIII',
    stationCode:     'WIII',
    minBracket:      28,
    maxBracket:      38,
    secondaryModel:  'none',
    launchPhase:     'wave_2',
    note:            'Tropical Southeast Asia market that stays inside the Celsius-only stack.',
  },

  kuala_lumpur: {
    id:              'kuala_lumpur',
    name:            'Kuala Lumpur',
    // Kuala Lumpur International Airport (WMKK).
    lat:             2.7456,
    lon:             101.7072,
    timezone:        'Asia/Kuala_Lumpur',
    slugPrefix:      'highest-temperature-in-kuala-lumpur-on',
    wundergroundUrl: 'https://www.wunderground.com/history/daily/my/kuala-lumpur/WMKK',
    stationCode:     'WMKK',
    minBracket:      28,
    maxBracket:      38,
    secondaryModel:  'none',
    launchPhase:     'wave_2',
    note:            'Pairs well with Singapore/Jakarta while keeping a separate airport oracle.',
  },

  busan: {
    id:              'busan',
    name:            'Busan',
    // Gimhae International Airport (RKPK).
    lat:             35.1795,
    lon:             128.9382,
    timezone:        'Asia/Seoul',
    slugPrefix:      'highest-temperature-in-busan-on',
    wundergroundUrl: 'https://www.wunderground.com/history/daily/kr/busan/RKPK',
    stationCode:     'RKPK',
    minBracket:      15,
    maxBracket:      25,
    secondaryModel:  'kma',
    launchPhase:     'wave_2',
    note:            'Extends the Korea edge beyond Seoul using the same KMA overlay family.',
  },

  sao_paulo: {
    id:              'sao_paulo',
    name:            'Sao Paulo',
    // Sao Paulo-Guarulhos International Airport (SBGR).
    lat:             -23.4356,
    lon:             -46.4731,
    timezone:        'America/Sao_Paulo',
    slugPrefix:      'highest-temperature-in-sao-paulo-on',
    wundergroundUrl: 'https://www.wunderground.com/history/daily/br/guarulhos/SBGR',
    stationCode:     'SBGR',
    minBracket:      25,
    maxBracket:      35,
    secondaryModel:  'none',
    launchPhase:     'wave_2',
    note:            'Validated airport-based alternate promoted into the active universe after removing Tel Aviv.',
  },
};

export const DEFAULT_CITY = 'seoul';
export const WEATHER_CITY_ORDER = [
  'seoul', 'london', 'shanghai', 'tokyo', 'hong_kong',
  'paris', 'milan', 'buenos_aires', 'toronto', 'wellington',
  'shenzhen', 'beijing', 'singapore', 'mexico_city', 'madrid',
  'munich', 'jakarta', 'kuala_lumpur', 'busan', 'sao_paulo',
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
