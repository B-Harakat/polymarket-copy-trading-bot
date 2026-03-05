import { Side, OrderType } from '@polymarket/clob-client';
import type { ClobClient } from '@polymarket/clob-client';

export type OrderSide = 'BUY' | 'SELL';

export type PostOrderInput = {
  client: ClobClient;
  tokenId: string;
  conditionId: string;
  side: OrderSide;
  sizeUsd?: number;       // BUY: convert to shares via price
  sharesExact?: number;   // SELL: use directly
  price: number;          // reference price (trader's fill price)
  slippagePct?: number;   // BUY only: max % above signal price willing to pay (default 0.02)
};

export type OrderFill = {
  sharesPlaced: number;
};

type TickSize = '0.1' | '0.01' | '0.001' | '0.0001';

function snapToTick(price: number, tick: TickSize): number {
  const increment = parseFloat(tick);
  return Math.round(price / increment) * increment;
}

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

export async function postOrder(input: PostOrderInput): Promise<OrderFill> {
  const { client, tokenId, conditionId, side, price } = input;
  const slippagePct = input.slippagePct ?? 0.02;

  const { tickSize, negRisk } = await fetchMarketOptions(client, conditionId);

  let rawPrice: number;

  if (side === 'BUY') {
    // Pay up to slippagePct above the signal price to ensure fill.
    // If the market has moved more than this, the order will rest in the
    // book at the limit rather than chasing the price.
    rawPrice = price * (1 + slippagePct);
  } else {
    // SELL: use signal price as the limit exactly.
    // We fill at market price or better (higher). If the price has fallen
    // below the trader's exit we correctly don't fill rather than selling
    // cheaper than they did.
    rawPrice = price;
  }

  const limitPrice = snapToTick(rawPrice, tickSize);

  if (limitPrice <= 0 || limitPrice >= 1) {
    throw new Error(
      `Computed limit price ${limitPrice} is out of valid range (0, 1) for token ${tokenId}`,
    );
  }

  let size: number;

  if (side === 'SELL' && input.sharesExact != null) {
    size = input.sharesExact;
  } else if (input.sizeUsd != null) {
    size = input.sizeUsd / limitPrice;
  } else {
    throw new Error('postOrder: must provide sizeUsd (BUY) or sharesExact (SELL)');
  }

  if (size < 1) {
    throw new Error(
      `Order size ${size.toFixed(4)} shares is below the CLOB minimum of 1 share. ` +
      (side === 'BUY' ? 'Increase sizeUsd or reduce multiplier.' : 'Position too small to sell.'),
    );
  }

  // BUY: expire at midnight UTC tonight — stale entry orders accumulating
  // across days would cause unwanted fills on old signals.
  // SELL: GTC — exits must always fill eventually to avoid stuck positions.
  const isBuy = side === 'BUY';
  const orderType = isBuy ? OrderType.GTD : OrderType.GTC;
  const userOrder: Parameters<typeof client.createAndPostOrder>[0] = {
    tokenID: tokenId,
    price: limitPrice,
    size,
    side: isBuy ? Side.BUY : Side.SELL,
    ...(isBuy && {
      expiration: Math.floor(
        new Date(new Date().toISOString().slice(0, 10) + 'T23:59:59Z').getTime() / 1000,
      ),
    }),
  };

  const response = await client.createAndPostOrder(
    userOrder,
    { tickSize, negRisk },
    orderType,
  );

  if (!response.success) {
    throw new Error(
      `CLOB rejected order for token ${tokenId}: ${response.errorMsg} (status: ${response.status})`,
    );
  }

  // For SELL orders: makingAmount = shares given by maker in micro-units (shares * 1e6),
  // so /1e6 gives the actual share count filled. Use it when available.
  // For BUY orders: makingAmount = USDC paid by maker in micro-units — NOT shares received.
  // Using it would record the dollar cost as a share count, badly undershooting the ledger.
  // For BUYs we always use the requested size, which is correct because:
  //   - Resting GTD orders: filled async, size is the best we have at order-placement time.
  //   - Immediately matched: the CLOB fills the exact size requested at the limit price.
  const filled = (side === 'SELL' && response.makingAmount)
    ? parseFloat(response.makingAmount) / 1e6
    : size;
  return { sharesPlaced: filled };
}