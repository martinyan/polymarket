import { ENV } from './config';
import { decideCopy } from './strategy';

type Activity = {
  side?: string;
  price?: number | string;
  size?: number | string;
  usdcSize?: number | string;
  title?: string;
  slug?: string;
  eventSlug?: string;
  asset?: string;
  outcome?: string;
  conditionId?: string;
  timestamp?: number | string;
};

type GammaMarketLike = {
  question?: string;
  slug?: string;
  clobTokenIds?: string | string[];
  outcomePrices?: string | string[];
};

type MarketBacktestStats = {
  question: string;
  slug: string;
  copiedTrades: number;
  skippedTrades: number;
  totalBuyCost: number;
  realizedCash: number;
  currentValue: number;
  endingShares: number;
};

const DEFAULT_ACTIVITY_PAGE_SIZE = 100;
const DEFAULT_BACKTEST_MAX_PAGES = 20;

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function parseJsonList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'clean-polymarket-copy-bot/0.1'
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed ${response.status} for ${url}`);
  }

  return (await response.json()) as T;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function currentPriceForAsset(market: GammaMarketLike | null, asset: string): number | null {
  if (!market) {
    return null;
  }

  const tokenIds = parseJsonList(market.clobTokenIds);
  const prices = parseJsonList(market.outcomePrices).map(Number);
  const index = tokenIds.indexOf(String(asset));

  if (index >= 0 && Number.isFinite(prices[index])) {
    return prices[index];
  }

  return null;
}

async function main(): Promise<void> {
  const wallet = ENV.USER_ADDRESSES[0];
  const keywords = ENV.ALLOWED_EVENT_KEYWORDS;
  const pageSize = envNumber('BACKTEST_ACTIVITY_PAGE_SIZE', DEFAULT_ACTIVITY_PAGE_SIZE);
  const maxPages = envNumber('BACKTEST_MAX_PAGES', Math.max(ENV.MAX_ACTIVITY_PAGES, DEFAULT_BACKTEST_MAX_PAGES));
  const targetViableTrades = envNumber('BACKTEST_TARGET_VIABLE_TRADES', 0);
  const isKeywordMatch = (value?: string): boolean =>
    keywords.length === 0 || keywords.some((keyword) => String(value || '').toLowerCase().includes(keyword));

  const activities: Activity[] = [];
  const viableMatchedActivities: Activity[] = [];

  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * pageSize;
    const batch = await fetchJson<Activity[]>(
      `${ENV.POLYMARKET_DATA_URL}/activity?user=${wallet}&type=TRADE&limit=${pageSize}&offset=${offset}`
    );

    if (batch.length === 0) {
      break;
    }

    activities.push(...batch);

    for (const activity of batch) {
      if (!(isKeywordMatch(activity.title) || isKeywordMatch(activity.slug) || isKeywordMatch(activity.eventSlug))) {
        continue;
      }

      const copyDecision = decideCopy(activity, null);
      if (copyDecision.allowed) {
        viableMatchedActivities.push(activity);
      }
    }

    if (targetViableTrades > 0 && viableMatchedActivities.length >= targetViableTrades) {
      break;
    }

    if (batch.length < pageSize) {
      break;
    }
  }

  const matchedPool = activities
    .filter(
      (activity) => isKeywordMatch(activity.title) || isKeywordMatch(activity.slug) || isKeywordMatch(activity.eventSlug)
    )
    .sort((a, b) => toNumber(a.timestamp) - toNumber(b.timestamp));

  const matched =
    targetViableTrades > 0
      ? matchedPool.filter((activity) => decideCopy(activity, null).allowed).slice(-targetViableTrades)
      : matchedPool;

  const conditionIds = Array.from(new Set(matched.map((activity) => activity.conditionId).filter(Boolean))) as string[];
  const markets = new Map<string, GammaMarketLike | null>();

  for (const conditionId of conditionIds) {
    const results = await fetchJson<GammaMarketLike[]>(
      `${ENV.POLYMARKET_GAMMA_URL}/markets?condition_ids=${encodeURIComponent(conditionId)}`
    );
    markets.set(conditionId, results[0] || null);
  }

  const byMarket = new Map<string, MarketBacktestStats>();

  let copiedTrades = 0;
  let skippedTrades = 0;
  let totalBuyCost = 0;
  let realizedCash = 0;
  const inventory = new Map<string, number>();

  for (const activity of matched) {
    const side = String(activity.side || '').toUpperCase();
    const price = toNumber(activity.price);
    const traderUsd = toNumber(activity.usdcSize) || toNumber(activity.size);
    const orderUsd = Math.min(ENV.MAX_ORDER_USD, traderUsd * ENV.COPY_RATIO);
    const market = activity.conditionId ? markets.get(activity.conditionId) || null : null;
    const label = market?.question || activity.title || activity.conditionId || 'unknown-market';
    const existing: MarketBacktestStats = byMarket.get(label) || {
      question: label,
      slug: market?.slug || activity.slug || '',
      copiedTrades: 0,
      skippedTrades: 0,
      totalBuyCost: 0,
      realizedCash: 0,
      currentValue: 0,
      endingShares: 0
    };

    let allowed = true;

    if (!activity.asset || !activity.conditionId) {
      allowed = false;
    } else if (ENV.BUY_ONLY && side !== 'BUY') {
      allowed = false;
    } else if (!(price > 0 && price < 1)) {
      allowed = false;
    } else if (orderUsd < ENV.MIN_ORDER_USD) {
      allowed = false;
    }

    const markPrice = activity.asset ? currentPriceForAsset(market, activity.asset) : null;
    if (allowed && !(markPrice !== null && markPrice >= 0 && markPrice <= 1)) {
      allowed = false;
    }

    if (!allowed || markPrice === null) {
      existing.skippedTrades += 1;
      skippedTrades += 1;
      byMarket.set(label, existing);
      continue;
    }

    const key = `${activity.conditionId}:${activity.asset}`;
    const heldShares = inventory.get(key) || 0;
    const requestedShares = orderUsd / price;

    if (side === 'SELL') {
      const sellShares = Math.min(heldShares, requestedShares);

      if (!(sellShares > 0)) {
        existing.skippedTrades += 1;
        skippedTrades += 1;
        byMarket.set(label, existing);
        continue;
      }

      inventory.set(key, heldShares - sellShares);
      const proceeds = sellShares * price;
      realizedCash += proceeds;
      existing.realizedCash += proceeds;
      existing.copiedTrades += 1;
      copiedTrades += 1;
      byMarket.set(label, existing);
      continue;
    }

    const buyShares = requestedShares;
    inventory.set(key, heldShares + buyShares);
    totalBuyCost += orderUsd;
    existing.totalBuyCost += orderUsd;
    existing.copiedTrades += 1;
    copiedTrades += 1;
    byMarket.set(label, existing);
  }

  let currentValue = 0;
  for (const [conditionId, market] of markets.entries()) {
    if (!market) {
      continue;
    }
    const tokenIds = parseJsonList(market.clobTokenIds);
    for (const tokenId of tokenIds) {
      const key = `${conditionId}:${tokenId}`;
      const heldShares = inventory.get(key) || 0;
      if (!(heldShares > 0)) {
        continue;
      }
      const markPrice = currentPriceForAsset(market, tokenId);
      if (!(markPrice !== null && markPrice >= 0 && markPrice <= 1)) {
        continue;
      }
      const positionValue = heldShares * markPrice;
      currentValue += positionValue;

      for (const marketStats of byMarket.values()) {
        if (marketStats.slug === market.slug || marketStats.question === market.question) {
          marketStats.currentValue += positionValue;
          marketStats.endingShares += heldShares;
        }
      }
    }
  }

  const endingEquity = realizedCash + currentValue;
  const pnl = endingEquity - totalBuyCost;

  console.log(
    JSON.stringify(
      {
        wallet,
        asOf: new Date().toISOString(),
        keywords,
        activityPageSize: pageSize,
        activityPagesFetched: Math.ceil(activities.length / pageSize),
        targetViableTrades: targetViableTrades || null,
        totalRecentTrades: activities.length,
        matchedTrades: matched.length,
        copiedTrades,
        skippedTrades,
        totalBuyCost: Number(totalBuyCost.toFixed(4)),
        realizedCash: Number(realizedCash.toFixed(4)),
        currentValue: Number(currentValue.toFixed(4)),
        endingEquity: Number(endingEquity.toFixed(4)),
        pnl: Number(pnl.toFixed(4)),
        roiPct: totalBuyCost ? Number(((pnl / totalBuyCost) * 100).toFixed(2)) : null,
        byMarket: Array.from(byMarket.values()).map((market) => ({
          ...market,
          totalBuyCost: Number(market.totalBuyCost.toFixed(4)),
          realizedCash: Number(market.realizedCash.toFixed(4)),
          currentValue: Number(market.currentValue.toFixed(4)),
          endingShares: Number(market.endingShares.toFixed(6)),
          endingEquity: Number((market.realizedCash + market.currentValue).toFixed(4)),
          pnl: Number((market.realizedCash + market.currentValue - market.totalBuyCost).toFixed(4)),
          roiPct: market.totalBuyCost
            ? Number((((market.realizedCash + market.currentValue - market.totalBuyCost) / market.totalBuyCost) * 100).toFixed(2))
            : null
        }))
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
