import { Side, OrderType } from '@polymarket/clob-client';
import type { ClobClient } from '@polymarket/clob-client';

export type OrderSide = 'BUY' | 'SELL';

export type PostOrderInput = {
  client: ClobClient;
  tokenId: string;            // asset ID — the specific YES or NO token for order construction
  conditionId: string;        // ADDED: market condition ID — used to look up tickSize/negRisk
  side: OrderSide;
  sizeUsd: number;            // desired USD notional (e.g. 50.00 = $50)
  price: number;              // signal price used to convert USD → shares
  maxAcceptablePrice?: number;
};

type TickSize = '0.1' | '0.01' | '0.001' | '0.0001';

function snapToTick(price: number, tick: TickSize): number {
  const increment = parseFloat(tick);
  return Math.round(price / increment) * increment;
}

/**
 * Fetches tickSize and negRisk for a market using its conditionId.
 * The CLOB client's getMarket() endpoint expects a conditionId — NOT a tokenId.
 * Passing tokenId here caused the "market not found" 404 error.
 */
async function fetchMarketOptions(
  client: ClobClient,
  conditionId: string,
): Promise<{ tickSize: TickSize; negRisk: boolean }> {
  try {
    const market = await (client as any).getMarket(conditionId);
    const tickSize = (market?.minimum_tick_size ?? market?.minTickSize ?? '0.01') as TickSize;
    const negRisk = market?.neg_risk ?? market?.negRisk ?? false;
    return { tickSize, negRisk };
  } catch {
    return { tickSize: '0.01', negRisk: false };
  }
}

export async function postOrder(input: PostOrderInput): Promise<void> {
  const { client, tokenId, conditionId, side, sizeUsd, price, maxAcceptablePrice } = input;

  // FIXED: pass conditionId, not tokenId, so getMarket() resolves correctly
  const { tickSize, negRisk } = await fetchMarketOptions(client, conditionId);

  const rawPrice = maxAcceptablePrice ?? price;
  const limitPrice = snapToTick(rawPrice, tickSize);

  if (limitPrice <= 0 || limitPrice >= 1) {
    throw new Error(
      `Computed limit price ${limitPrice} is out of valid range (0, 1) for token ${tokenId}`,
    );
  }

  const size = sizeUsd / limitPrice;

  if (size < 1) {
    throw new Error(
      `Order size ${size.toFixed(4)} shares ($${sizeUsd} / $${limitPrice}) is below the ` +
      `CLOB minimum of 1 share. Increase sizeUsd or reduce multiplier.`,
    );
  }

  const response = await client.createAndPostOrder(
    {
      tokenID: tokenId,
      price: limitPrice,
      size,
      side: side === 'BUY' ? Side.BUY : Side.SELL,
    },
    { tickSize, negRisk },
    OrderType.GTC,
  );

  if (!response.success) {
    throw new Error(
      `CLOB rejected order for token ${tokenId}: ${response.errorMsg} (status: ${response.status})`,
    );
  }
}

