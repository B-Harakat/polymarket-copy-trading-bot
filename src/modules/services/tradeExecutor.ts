import type { RuntimeEnv } from '../config/env';
import type { Logger } from '../utils/logger';
import type { TradeSignal } from './tradeMonitor';
import type { PolymarketClient } from '../services/createClobClient';
import { computeProportionalSizing } from '../config/copyStrategy';
import { postOrder } from '../utils/postOrder';
import { getMyPortfolio } from '../utils/getMyBalance';
import { getTraderPortfolio } from '../utils/getTraderBalance';

export type TradeExecutorDeps = {
  client: PolymarketClient;
  proxyWallet: string;
  env: RuntimeEnv;
  logger: Logger;
};

function fmt(label: string, p: { total: number; invested: number; cash: number }): string {
  return `${label}: portfolio=$${p.total.toFixed(2)}  invested=$${p.invested.toFixed(2)}  cash=$${p.cash.toFixed(2)}`;
}

export class TradeExecutor {
  private readonly deps: TradeExecutorDeps;

  constructor(deps: TradeExecutorDeps) {
    this.deps = deps;
  }

  async copyTrade(signal: TradeSignal): Promise<void> {
    const { logger, env, client } = this.deps;
    try {
      const [mine, trader] = await Promise.all([
        getMyPortfolio(client, this.deps.proxyWallet, env.rpcUrl),
        getTraderPortfolio(signal.traderAddress, env.rpcUrl),
      ]);

      const sizing = computeProportionalSizing({
        yourPortfolioTotal: mine.total,
        traderPortfolioTotal: trader.total,
        traderTradeUsd: signal.sizeUsd,
        multiplier: env.tradeMultiplier,
      });

      logger.info(`Copying ${signal.side} "${signal.marketTitle}" @ $${signal.price}`);
      logger.info(`  ${fmt('Trader', trader)}`);
      logger.info(`  ${fmt('You   ', mine)}`);
      logger.info(`  Trade: $${signal.sizeUsd.toFixed(2)} = ${(sizing.tradeRatio * 100).toFixed(2)}% of their portfolio => $${sizing.targetUsdSize.toFixed(2)} for you`);

      await postOrder({
        client,
        tokenId: signal.tokenId,
        conditionId: signal.marketId,
        side: signal.side,
        sizeUsd: sizing.targetUsdSize,
        price: signal.price,
        maxAcceptablePrice: signal.price * 1.05,
      });

      logger.info(`  ✓ Order placed — tx ref: ${signal.txHash}`);
    } catch (err) {
      logger.error(`Failed to copy trade on "${signal.marketTitle}"`, err as Error);
    }
  }
}
