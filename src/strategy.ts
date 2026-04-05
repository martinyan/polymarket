import { Side } from '@polymarket/clob-client';
import { ENV } from './config';
import { GammaMarket, TraderActivity } from './types';

export interface CopyDecision {
  allowed: boolean;
  reason: string;
  orderUsd?: number;
  orderSize?: number;
  side?: Side;
  tokenId?: string;
  price?: number;
  conditionId?: string;
  slug?: string;
}

const toNumber = (value: unknown): number => {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

function normalizeTokenId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseTokenIdList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeTokenId(item)).filter(Boolean);
  }

  if (typeof value !== 'string') {
    return [];
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed.map((item) => normalizeTokenId(item)).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  return trimmed
    .split(',')
    .map((item) => normalizeTokenId(item))
    .filter(Boolean);
}

function marketTokenIds(market: GammaMarket | null): string[] {
  if (!market) {
    return [];
  }

  return Array.from(
    new Set(
      [
        ...parseTokenIdList(market.clobTokenIds),
        ...parseTokenIdList(market.outcomeTokenIds),
        ...(market.tokens || []).flatMap((token) =>
          [normalizeTokenId(token.token_id), normalizeTokenId(token.tokenId), normalizeTokenId(token.id)].filter(Boolean)
        )
      ].filter(Boolean)
    )
  );
}

function tagAllowed(market: GammaMarket | null): boolean {
  if (!market || ENV.ALLOWED_TAGS.length === 0) {
    return true;
  }
  const marketTags = (market.tags || [])
    .map((tag) => tag.slug || tag.label || '')
    .map((tag) => tag.toLowerCase());
  return marketTags.some((tag) => ENV.ALLOWED_TAGS.includes(tag));
}

function eventKeywordAllowed(activity: TraderActivity, market: GammaMarket | null): boolean {
  if (ENV.ALLOWED_EVENT_KEYWORDS.length === 0) {
    return true;
  }

  const haystacks = [
    activity.title,
    activity.slug,
    activity.marketSlug,
    activity.eventSlug,
    market?.slug
  ]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((value) => value.toLowerCase());

  return ENV.ALLOWED_EVENT_KEYWORDS.some((keyword) => haystacks.some((value) => value.includes(keyword)));
}

export function decideCopy(activity: TraderActivity, market: GammaMarket | null): CopyDecision {
  const side = (activity.side || '').toUpperCase();
  const price = toNumber(activity.price);
  const traderUsd = toNumber(activity.usdcSize) || toNumber(activity.size);
  const slug = (activity.marketSlug || activity.eventSlug || activity.slug || market?.slug || '').toLowerCase();
  const conditionId = activity.conditionId || market?.conditionId || market?.questionID;
  const knownMarketConditionId = market?.conditionId || market?.questionID;
  const tokens = marketTokenIds(market);

  if (!activity.asset) {
    return { allowed: false, reason: 'missing asset token id' };
  }

  if (!conditionId) {
    return { allowed: false, reason: 'missing condition id' };
  }

  if (ENV.BUY_ONLY && side !== 'BUY') {
    return { allowed: false, reason: 'buy-only mode enabled' };
  }

  if (activity.conditionId && knownMarketConditionId && activity.conditionId !== knownMarketConditionId) {
    return { allowed: false, reason: 'market condition mismatch' };
  }

  if (tokens.length > 0 && !tokens.includes(activity.asset)) {
    return { allowed: false, reason: 'market token id mismatch' };
  }

  if (ENV.BLOCKED_SLUGS.includes(slug)) {
    return { allowed: false, reason: 'market slug blocked by config' };
  }

  if (!tagAllowed(market)) {
    return { allowed: false, reason: 'market tags not allowed' };
  }

  if (!eventKeywordAllowed(activity, market)) {
    return { allowed: false, reason: 'event keyword not allowed' };
  }

  if (market && market.enableOrderBook === false) {
    return { allowed: false, reason: 'market order book disabled' };
  }

  if (!price || price <= 0 || price >= 1) {
    return { allowed: false, reason: 'activity price outside expected range' };
  }

  const orderUsd = Math.min(ENV.MAX_ORDER_USD, traderUsd * ENV.COPY_RATIO);

  if (orderUsd < ENV.MIN_ORDER_USD) {
    return { allowed: false, reason: 'order below minimum configured usd' };
  }

  const orderSize = orderUsd / price;

  if (!Number.isFinite(orderSize) || orderSize <= 0) {
    return { allowed: false, reason: 'order size invalid' };
  }

  return {
    allowed: true,
    reason: 'eligible',
    orderUsd,
    orderSize,
    side: Side.BUY,
    tokenId: activity.asset,
    price,
    conditionId,
    slug
  };
}
