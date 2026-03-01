import 'dotenv/config';
import { loadEnv } from './modules/config/env';
import { createPolymarketClient } from './modules/services/createClobClient';
import { TradeMonitor } from './modules/services/tradeMonitor';
import { TradeExecutor } from './modules/services/tradeExecutor';
import { ConsoleLogger } from './modules/utils/logger';

async function main(): Promise<void> {
  const logger = new ConsoleLogger();
  const env = loadEnv();

  logger.info('Starting Polymarket Copy Trading Bot');

  // Read API creds directly from process.env (populated by dotenv above).
  // These bypass loadEnv() to avoid needing to modify the env schema.
  // If missing, createPolymarketClient will derive them and print them to logs.
  const apiKey        = process.env.POLY_API_KEY?.trim()        || undefined;
  const apiSecret     = process.env.POLY_API_SECRET?.trim()     || undefined;
  const apiPassphrase = process.env.POLY_API_PASSPHRASE?.trim() || undefined;

  if (apiKey) {
    logger.info(`Using hardcoded API key: ${apiKey.slice(0, 8)}...`);
  } else {
    logger.info('No POLY_API_KEY found — will derive on boot (slower, may hit key limit)');
  }

  const client = await createPolymarketClient({
    rpcUrl: env.rpcUrl,
    privateKey: env.privateKey,
    proxyWallet: env.proxyWallet,
    apiKey,
    apiSecret,
    apiPassphrase,
  });

  const executor = new TradeExecutor({ client, proxyWallet: env.proxyWallet, logger, env });

  const monitor = new TradeMonitor({
    client,
    logger,
    env,
    userAddresses: env.userAddresses,
    onDetectedTrade: async (signal) => {
      await executor.copyTrade(signal);
    },
  });

  await monitor.start();
}

main().catch((err) => {
  console.error('Fatal error', err);
  process.exit(1);
});
