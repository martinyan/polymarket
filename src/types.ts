export interface TraderActivity {
  id?: string;
  proxyWallet?: string;
  transactionHash?: string;
  user?: string;
  side?: string;
  type?: string;
  asset?: string;
  price?: number | string;
  size?: number | string;
  usdcSize?: number | string;
  title?: string;
  slug?: string;
  marketSlug?: string;
  eventSlug?: string;
  timestamp?: number | string;
  createdAt?: string;
  conditionId?: string;
}

export interface GammaMarket {
  questionID?: string;
  conditionId?: string;
  slug?: string;
  minimum_tick_size?: number | string;
  neg_risk?: boolean;
  enableOrderBook?: boolean;
  tags?: Array<{ label?: string; slug?: string }>;
  clobTokenIds?: string | string[];
  outcomeTokenIds?: string | string[];
  tokens?: Array<{ token_id?: string; tokenId?: string; id?: string }>;
}

export interface BotState {
  seenActivityIds: string[];
  updatedAt: string;
}
