import { ClobClient, Side } from '@polymarket/clob-client';
import { Wallet } from 'ethers';
import { ENV } from './config';
import { fetchJson } from './http';
import { GammaMarket, TraderActivity } from './types';

export async function fetchTraderActivity(address: string, page: number): Promise<TraderActivity[]> {
  const offset = page * 100;
  const url = `${ENV.POLYMARKET_DATA_URL}/activity?user=${address}&type=TRADE&limit=100&offset=${offset}`;
  return fetchJson<TraderActivity[]>(url);
}

export async function fetchMarketByCondition(conditionId: string): Promise<GammaMarket | null> {
  const url = `${ENV.POLYMARKET_GAMMA_URL}/markets?condition_ids=${encodeURIComponent(conditionId)}`;
  const markets = await fetchJson<GammaMarket[]>(url);
  return markets[0] || null;
}

export async function createTradingClient(): Promise<ClobClient> {
  const signer = new Wallet(ENV.PRIVATE_KEY);
  const tempClient = new ClobClient(ENV.POLYMARKET_HOST, ENV.CHAIN_ID, signer);
  const creds = await tempClient.createOrDeriveApiKey();

  return new ClobClient(
    ENV.POLYMARKET_HOST,
    ENV.CHAIN_ID,
    signer,
    creds,
    0,
    ENV.FUNDER_ADDRESS || signer.address
  );
}

export function mapSide(input?: string): Side {
  return (input || '').toUpperCase() === 'SELL' ? Side.SELL : Side.BUY;
}

export async function postCopyOrder(
  client: ClobClient,
  params: {
    tokenId: string;
    conditionId: string;
    side: Side;
    price: number;
    size: number;
  }
): Promise<unknown> {
  const market = await client.getMarket(params.conditionId);
  return client.createAndPostOrder(
    {
      tokenID: params.tokenId,
      price: params.price,
      size: params.size,
      side: params.side
    },
    {
      tickSize: market.minimum_tick_size as any,
      negRisk: !!market.neg_risk
    }
  );
}
