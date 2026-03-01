import type { ClobClient } from '@polymarket/clob-client';
import type { RuntimeEnv } from '../config/env';
import type { Logger } from '../utils/logger';
import { getMyPortfolio } from '../utils/getMyBalance';
import { getTraderPortfolio } from '../utils/getTraderBalance';

const DATA_API = 'https://data-api.polymarket.com';

type DataApiTrade = {
  proxyWallet: string;
  side: 'BUY' | 'SELL';
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
  outcome: string;
  outcomeIndex: number;
  transactionHash: string;
  title: string;
};

export type TradeSignal = {
  traderAddress: string;
  marketId: string;
  tokenId: string;
  outcome: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  sizeUsd: number;
  price: number;
  timestamp: number;
  txHash: string;
  marketTitle: string;
};

export type TradeMonitorDeps = {
  client: ClobClient;
  env: RuntimeEnv;
  logger: Logger;
  userAddresses: string[];
  onDetectedTrade: (signal: TradeSignal) => Promise<void>;
};

export class TradeMonitor {
  private readonly deps: TradeMonitorDeps;
  private timer?: NodeJS.Timeout;
  private readonly seenTxHashes = new Set<string>();
  private initialised = false;

  constructor(deps: TradeMonitorDeps) {
    this.deps = deps;
  }

  async start(): Promise<void> {
    const { logger, env, client } = this.deps;

    logger.info('========================================');
    logger.info('  Polymarket Copy Trading Bot — STARTUP ');
    logger.info('========================================');
    logger.info(`Watching ${this.deps.userAddresses.length} trader(s), polling every ${env.fetchIntervalSeconds}s`);

    // Show our own portfolio first
    logger.info('----------------------------------------');
    logger.info('BOT WALLET (your portfolio):');
    try {
      const mine = await getMyPortfolio(client as any, env.proxyWallet, env.rpcUrl);
      logger.info(`  Proxy wallet: ${mine.proxyWallet}`);
      logger.info(`  Portfolio: $${mine.total.toFixed(2)}  |  Invested: $${mine.invested.toFixed(2)}  |  Cash: $${mine.cash.toFixed(2)}`);
    } catch (e) {
      logger.warn(`  Could not fetch own portfolio: ${(e as Error).message}`);
    }

    // Show each tracked trader's portfolio and last trade
    for (const address of this.deps.userAddresses) {
      logger.info('----------------------------------------');
      logger.info(`COPYING TRADER: ${address}`);
      logger.info(`  Profile: https://polymarket.com/profile/${address}`);

      try {
        const trader = await getTraderPortfolio(address, env.rpcUrl);
        logger.info(`  Portfolio: $${trader.total.toFixed(2)}  |  Invested: $${trader.invested.toFixed(2)}  |  Cash: $${trader.cash.toFixed(2)}`);
      } catch (e) {
        logger.warn(`  Could not fetch trader portfolio: ${(e as Error).message}`);
      }

      try {
        const tradeRes = await fetch(`${DATA_API}/trades?user=${address}&limit=1&takerOnly=false`);
        if (tradeRes.ok) {
          const trades = await tradeRes.json() as DataApiTrade[];
          if (trades.length > 0) {
            const t = trades[0];
            const when = new Date(t.timestamp * 1000).toISOString();
            logger.info(`  Last trade: ${t.side} ${t.outcome} on "${t.title}"`);
            logger.info(`    size: ${t.size} @ $${t.price}  |  ${when}`);
            logger.info(`    tx:   ${t.transactionHash}`);
          } else {
            logger.warn(`  ⚠ No trades found — verify this is the PROXY wallet, not the EOA`);
          }
        }
      } catch (e) {
        logger.warn(`  Could not fetch last trade: ${(e as Error).message}`);
      }
    }

    logger.info('----------------------------------------');
    logger.info('Startup checks complete — beginning monitoring loop');
    logger.info('========================================');

    await this.tick();
    this.timer = setInterval(
      () =>
        void this.tick().catch((err) =>
          logger.error('Monitor tick threw unexpected error', err as Error),
        ),
      env.fetchIntervalSeconds * 1000,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async tick(): Promise<void> {
    const { logger } = this.deps;

    for (const traderAddress of this.deps.userAddresses) {
      try {
        const trades = await this.fetchRecentTrades(traderAddress);

        if (!this.initialised) {
          for (const trade of trades) {
            this.seenTxHashes.add(this.dedupKey(traderAddress, trade.transactionHash));
          }
          logger.info(`Seeded ${trades.length} historical trade(s) for ${traderAddress}`);
          continue;
        }

        for (const trade of trades) {
          const key = this.dedupKey(traderAddress, trade.transactionHash);
          if (this.seenTxHashes.has(key)) continue;
          this.seenTxHashes.add(key);

          const signal = this.toSignal(traderAddress, trade);
          logger.info(
            `New trade detected — ${trade.side} ${trade.outcome} on "${trade.title}" ` +
            `| $${signal.sizeUsd.toFixed(2)} (${trade.size} shares @ $${trade.price}) ` +
            `| tx: ${trade.transactionHash}`,
          );

          await this.deps.onDetectedTrade(signal);
        }
      } catch (err) {
        logger.error(`Failed to poll trades for ${traderAddress}`, err as Error);
      }
    }

    if (!this.initialised) {
      this.initialised = true;
    }
  }

  private async fetchRecentTrades(traderAddress: string): Promise<DataApiTrade[]> {
    const url = `${DATA_API}/trades?user=${traderAddress}&limit=20&takerOnly=false`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Data API ${response.status} for ${traderAddress}: ${await response.text()}`);
    }
    const data = (await response.json()) as DataApiTrade[];
    return data.sort((a, b) => a.timestamp - b.timestamp);
  }

  private toSignal(traderAddress: string, trade: DataApiTrade): TradeSignal {
    return {
      traderAddress,
      marketId: trade.conditionId,
      tokenId: trade.asset,
      outcome: trade.outcomeIndex === 0 ? 'YES' : 'NO',
      side: trade.side,
      sizeUsd: trade.size * trade.price,
      price: trade.price,
      timestamp: trade.timestamp,
      txHash: trade.transactionHash,
      marketTitle: trade.title,
    };
  }

  private dedupKey(traderAddress: string, txHash: string): string {
    return `${traderAddress.toLowerCase()}:${txHash}`;
  }
}

