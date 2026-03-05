import type { Logger } from '../utils/logger';
import type { TradeSignal } from '../services/tradeMonitor';

export const CLOB_MIN_SHARES = 6;
const ACCUMULATOR_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export type AccumulatorFlush = {
  /**
   * The latest signal received — use its price and metadata for the order.
   * Shares to place are in `sharesToPlace`, NOT signal.sizeUsd.
   */
  signal: TradeSignal;
  sharesToPlace: number;
};

type PendingEntry = {
  side: 'BUY' | 'SELL';
  accumulatedShares: number;
  latestSignal: TradeSignal;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Accumulates sub-minimum share amounts per tokenId across multiple chunk
 * fills until the CLOB minimum (5 shares) is reached, then flushes for
 * order placement.
 *
 * Keyed by tokenId only:
 * - A SELL signal cancels any pending BUY accumulation (and vice-versa).
 * - A 30-minute inactivity timeout discards stale pending entries.
 */
export class PendingAccumulator {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Add `shares` to the accumulator for this tokenId/side.
   *
   * Returns an `AccumulatorFlush` if the threshold is now met (caller should
   * place the order), or `null` if still accumulating.
   */
  add(signal: TradeSignal, shares: number): AccumulatorFlush | null {
    const { tokenId } = signal;
    const existing = this.pending.get(tokenId);

    // If the side flipped, cancel the old accumulation.
    if (existing && existing.side !== signal.side) {
      this.logger.warn(
        `[Accumulator] ${signal.side} signal for token ${tokenId.slice(0, 10)}… ` +
        `cancelled pending ${existing.side} accumulation ` +
        `(${existing.accumulatedShares.toFixed(4)} shares discarded).`,
      );
      this.clearEntry(tokenId);
    }

    const prev = this.pending.get(tokenId);
    const total = (prev?.accumulatedShares ?? 0) + shares;

    if (total >= CLOB_MIN_SHARES) {
      // Threshold met — flush and clean up.
      this.clearEntry(tokenId);
      this.logger.info(
        `[Accumulator] Threshold reached for token ${tokenId.slice(0, 10)}… ` +
        `— flushing ${total.toFixed(4)} shares (${signal.side}).`,
      );
      return { signal, sharesToPlace: total };
    }

    // Still accumulating — (re)start the inactivity timer.
    if (prev) clearTimeout(prev.timer);

    const timer = setTimeout(() => {
      this.logger.warn(
        `[Accumulator] 30-min timeout — discarding pending ${signal.side} ` +
        `accumulation of ${total.toFixed(4)} shares for token ${tokenId.slice(0, 10)}….`,
      );
      this.pending.delete(tokenId);
    }, ACCUMULATOR_TIMEOUT_MS);

    // Keep timer alive even if the process would otherwise exit.
    if (timer.unref) timer.unref();

    this.pending.set(tokenId, {
      side: signal.side,
      accumulatedShares: total,
      latestSignal: signal,
      timer,
    });

    this.logger.info(
      `[Accumulator] ${signal.side} ${shares.toFixed(4)} shares added for ` +
      `token ${tokenId.slice(0, 10)}… ` +
      `— total ${total.toFixed(4)} / ${CLOB_MIN_SHARES} (waiting for more chunks).`,
    );

    return null;
  }

  /** How many tokens currently have pending accumulations. */
  get size(): number {
    return this.pending.size;
  }

  /**
   * Returns the share count currently pending for a given tokenId (0 if none).
   * Used by the caller to factor accumulated-but-not-yet-placed shares into
   * remainder checks, preventing stuck dust after an accumulator flush.
   */
  getPendingShares(tokenId: string): number {
    return this.pending.get(tokenId)?.accumulatedShares ?? 0;
  }

  /** Cancel all pending accumulations (e.g. on shutdown). */
  clear(): void {
    for (const tokenId of this.pending.keys()) {
      this.clearEntry(tokenId);
    }
  }

  private clearEntry(tokenId: string): void {
    const entry = this.pending.get(tokenId);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(tokenId);
    }
  }
}