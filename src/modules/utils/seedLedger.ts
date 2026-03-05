import type { Logger } from '../utils/logger';
import type { PositionLedger } from '../utils/positionLedger';

const DATA_API = 'https://data-api.polymarket.com';

type PositionResponse = {
  asset: string;       // tokenId
  size: number;        // current share count
  title?: string;      // market title (for logging)
  redeemable?: boolean;
};

/**
 * Fetches all open positions for `proxyWallet` from the Polymarket Data API
 * and seeds the provided PositionLedger with the current share counts.
 *
 * Call this once at bot startup before beginning to process trade signals.
 */
export async function seedLedgerFromChain(
  proxyWallet: string,
  ledger: PositionLedger,
  logger: Logger,
): Promise<void> {
  logger.info(`[seedLedger] Fetching open positions for ${proxyWallet}...`);

  const url = `${DATA_API}/positions?user=${proxyWallet}`;
  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(
      `[seedLedger] Positions API returned ${res.status} ${res.statusText} for ${url}`,
    );
  }

  const positions: PositionResponse[] = await res.json();

  if (!Array.isArray(positions) || positions.length === 0) {
    logger.info('[seedLedger] No open positions found — ledger starts empty.');
    return;
  }

  let seeded = 0;
  for (const pos of positions) {
    // Skip positions that are redeemable (market resolved) — no point tracking them.
    if (pos.redeemable) continue;
    if (!pos.asset || pos.size <= 0) continue;

    ledger.seed(pos.asset, pos.size);
    seeded++;

    logger.info(
      `[seedLedger]  + ${pos.size.toFixed(4)} shares of ` +
      `${pos.asset.slice(0, 10)}... ${pos.title ? `"${pos.title}"` : ''}`,
    );
  }

  logger.info(`[seedLedger] Done — seeded ${seeded} position(s) into ledger.`);
}