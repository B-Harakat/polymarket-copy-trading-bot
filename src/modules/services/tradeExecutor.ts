import type { RuntimeEnv } from '../config/env';
import type { Logger } from '../utils/logger';
import type { TradeSignal } from './tradeMonitor';
import type { PolymarketClient } from '../services/createClobClient';
import { computeProportionalSizing } from '../config/copyStrategy';
import { postOrder } from '../utils/postOrder';
import { getMyPortfolio } from '../utils/getMyBalance';
import { getTraderPortfolio } from '../utils/getTraderBalance';
import { PositionLedger } from '../utils/positionLedger';
import { PendingAccumulator, CLOB_MIN_SHARES } from '../utils/pendingAccumulator';

const FULL_CLOSE_THRESHOLD = 0.95;

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
  readonly ledger = new PositionLedger();
  private readonly accumulator: PendingAccumulator;

  constructor(deps: TradeExecutorDeps) {
    this.deps = deps;
    this.accumulator = new PendingAccumulator(deps.logger);
  }

  async copyTrade(signal: TradeSignal): Promise<void> {
    if (signal.side === 'SELL') {
      await this.copySell(signal);
    } else {
      await this.copyBuy(signal);
    }
  }

  // BUY

  private async copyBuy(signal: TradeSignal): Promise<void> {
    const { logger, env, client } = this.deps;
    try {
      const [mine, trader] = await Promise.all([
        getMyPortfolio(client, this.deps.proxyWallet, env.rpcUrl),
        getTraderPortfolio(signal.traderAddress, env.rpcUrl),
      ]);

      const sizing = computeProportionalSizing({
        yourPortfolioTotal:   mine.total,
        traderPortfolioTotal: trader.total,
        traderTradeUsd:       signal.sizeUsd,
        multiplier:           env.tradeMultiplier,
      });

      // Compute target shares using signal price (pre-slippage) so the
      // accumulator works in consistent share units across chunks.
      const targetShares = sizing.targetUsdSize / signal.price;

      logger.info(`Copying BUY "${signal.marketTitle}" @ $${signal.price}`);
      logger.info(`  ${fmt('Trader', trader)}`);
      logger.info(`  ${fmt('You   ', mine)}`);
      logger.info(
        `  Trade: $${signal.sizeUsd.toFixed(2)} = ${(sizing.tradeRatio * 100).toFixed(2)}% ` +
        `of their portfolio => $${sizing.targetUsdSize.toFixed(2)} / ${targetShares.toFixed(4)} shares for you`,
      );

      if (targetShares < CLOB_MIN_SHARES) {
        const flush = this.accumulator.add(signal, targetShares);
        if (!flush) return;
        await this.placeBuy(flush.signal, flush.sharesToPlace);
      } else {
        await this.placeBuy(signal, targetShares);
      }
    } catch (err) {
      logger.error(`Failed to copy BUY on "${signal.marketTitle}"`, err as Error);
    }
  }

  private async placeBuy(signal: TradeSignal, shares: number): Promise<void> {
    const { logger, client } = this.deps;

    const fill = await postOrder({
      client,
      tokenId:     signal.tokenId,
      conditionId: signal.marketId,
      side:        'BUY',
      // Convert back to USD using the latest signal price so postOrder
      // can apply its 2% slippage correctly.
      sizeUsd:     shares * signal.price,
      price:       signal.price,
    });

    this.ledger.recordBuy(signal.tokenId, fill.sharesPlaced);

    logger.info(
      `  BUY placed -- ${fill.sharesPlaced.toFixed(4)} shares @ $${signal.price} ` +
      `| tx ref: ${signal.txHash}`,
    );
    logger.info(
      `  Ledger: now holding ${this.ledger.getShares(signal.tokenId).toFixed(4)} shares ` +
      `of token ${signal.tokenId.slice(0, 10)}...`,
    );
  }

  // SELL
  //
  // 1. Proportional sizing -> targetUsdSize  (same logic as BUY)
  // 2. Convert to shares:  sharesToSell = targetUsdSize / signal.price
  // 3. Cap to ledger:      sharesToSell = min(sharesToSell, ledgerShares)
  // 4. 95% threshold:      if sharesToSell / ledgerShares >= 0.95 -> sell all (bypass accumulator)
  // 5. CLOB minimum:       accumulate if sharesToSell < 5

  private async copySell(signal: TradeSignal): Promise<void> {
    const { logger, env, client } = this.deps;
    try {
      const ledgerShares = this.ledger.getShares(signal.tokenId);
      if (ledgerShares === 0) {
        logger.warn(
          `SELL signal for "${signal.marketTitle}" -- no ledger entry for ` +
          `token ${signal.tokenId.slice(0, 10)}... (never bought or already closed). Skipping.`,
        );
        return;
      }

      const [mine, trader] = await Promise.all([
        getMyPortfolio(client, this.deps.proxyWallet, env.rpcUrl),
        getTraderPortfolio(signal.traderAddress, env.rpcUrl),
      ]);

      const sizing = computeProportionalSizing({
        yourPortfolioTotal:   mine.total,
        traderPortfolioTotal: trader.total,
        traderTradeUsd:       signal.sizeUsd,
        multiplier:           env.tradeMultiplier,
      });

      let sharesToSell = sizing.targetUsdSize / signal.price;

      if (sharesToSell > ledgerShares) {
        logger.warn(
          `  Sell estimate ${sharesToSell.toFixed(4)} exceeds ledger ` +
          `${ledgerShares.toFixed(4)} -- capping.`,
        );
        sharesToSell = ledgerShares;
      }

      logger.info(`Copying SELL "${signal.marketTitle}" @ $${signal.price}`);
      logger.info(`  ${fmt('Trader', trader)}`);
      logger.info(`  ${fmt('You   ', mine)}`);

      // Full close: bypass accumulator -- always above minimum
      const sellRatio = sharesToSell / ledgerShares;
      if (sellRatio >= FULL_CLOSE_THRESHOLD) {
        logger.info(
          `  Sell ratio ${(sellRatio * 100).toFixed(1)}% >= ${FULL_CLOSE_THRESHOLD * 100}% ` +
          `-- upgrading to full close (${ledgerShares.toFixed(4)} shares).`,
        );
        await this.placeSell(signal, ledgerShares);
        return;
      }

      logger.info(
        `  Trade: $${signal.sizeUsd.toFixed(2)} = ${(sizing.tradeRatio * 100).toFixed(2)}% ` +
        `of their portfolio => selling ${sharesToSell.toFixed(4)} of our ` +
        `${ledgerShares.toFixed(4)} shares`,
      );

      // Accumulate if below CLOB minimum
      if (sharesToSell < CLOB_MIN_SHARES) {
        const flush = this.accumulator.add(signal, sharesToSell);
        if (!flush) return;
        await this.placeSell(flush.signal, flush.sharesToPlace);
      } else {
        await this.placeSell(signal, sharesToSell);
      }
    } catch (err) {
      logger.error(`Failed to copy SELL on "${signal.marketTitle}"`, err as Error);
    }
  }

  private async placeSell(signal: TradeSignal, shares: number): Promise<void> {
    const { logger, client } = this.deps;

    const fill = await postOrder({
      client,
      tokenId:     signal.tokenId,
      conditionId: signal.marketId,
      side:        'SELL',
      sharesExact: shares,
      price:       signal.price,
    });

    this.ledger.recordSell(signal.tokenId, fill.sharesPlaced);

    logger.info(
      `  SELL placed -- ${fill.sharesPlaced.toFixed(4)} shares @ $${signal.price} ` +
      `| tx ref: ${signal.txHash}`,
    );
    logger.info(
      `  Ledger: ${this.ledger.getShares(signal.tokenId).toFixed(4)} shares remaining ` +
      `for token ${signal.tokenId.slice(0, 10)}...`,
    );
  }
}