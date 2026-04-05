import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv();

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(8080),
  USER_ADDRESSES: z.string().min(1),
  PREVIEW_MODE: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),
  PRIVATE_KEY: z.string().optional().default(''),
  FUNDER_ADDRESS: z.string().optional().default(''),
  POLYMARKET_HOST: z.string().url().default('https://clob.polymarket.com'),
  POLYMARKET_GAMMA_URL: z.string().url().default('https://gamma-api.polymarket.com'),
  POLYMARKET_DATA_URL: z.string().url().default('https://data-api.polymarket.com'),
  CHAIN_ID: z.coerce.number().default(137),
  POLL_INTERVAL_MS: z.coerce.number().default(5000),
  MAX_ACTIVITY_PAGES: z.coerce.number().default(2),
  MAX_ORDER_USD: z.coerce.number().default(25),
  MIN_ORDER_USD: z.coerce.number().default(1),
  COPY_RATIO: z.coerce.number().default(0.1),
  MAX_SLIPPAGE: z.coerce.number().default(0.03),
  BUY_ONLY: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() === 'true'),
  ALLOWED_TAGS: z.string().optional().default(''),
  ALLOWED_EVENT_KEYWORDS: z.string().optional().default(''),
  BLOCKED_SLUGS: z.string().optional().default(''),
  STATE_PATH: z.string().default('./data/state.json')
});

const parsed = schema.parse(process.env);

const splitCsv = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

export const ENV = {
  ...parsed,
  USER_ADDRESSES: splitCsv(parsed.USER_ADDRESSES).map((addr) => addr.toLowerCase()),
  ALLOWED_TAGS: splitCsv(parsed.ALLOWED_TAGS).map((tag) => tag.toLowerCase()),
  ALLOWED_EVENT_KEYWORDS: splitCsv(parsed.ALLOWED_EVENT_KEYWORDS).map((keyword) => keyword.toLowerCase()),
  BLOCKED_SLUGS: splitCsv(parsed.BLOCKED_SLUGS).map((slug) => slug.toLowerCase())
};

export function validateLiveMode(): void {
  if (!ENV.PREVIEW_MODE) {
    if (!ENV.PRIVATE_KEY) {
      throw new Error('PRIVATE_KEY is required when PREVIEW_MODE=false');
    }
    if (!ENV.FUNDER_ADDRESS) {
      throw new Error('FUNDER_ADDRESS is required when PREVIEW_MODE=false');
    }
  }
}
