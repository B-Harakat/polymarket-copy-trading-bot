/**
 * Tracks exact share counts per tokenId so SELL orders can be sized
 * precisely against what was actually bought, rather than re-deriving
 * from USD amounts (which drift as portfolio values change).
 */
export class PositionLedger {
  private readonly shares = new Map<string, number>();

  /**
   * Seed an initial position from on-chain data at startup.
   * Overwrites any existing entry for this tokenId.
   */
  seed(tokenId: string, shares: number): void {
    this.shares.set(tokenId, shares);
  }

  /** Record shares received from a filled BUY order. */
  recordBuy(tokenId: string, shares: number): void {
    const current = this.shares.get(tokenId) ?? 0;
    this.shares.set(tokenId, current + shares);
  }

  /**
   * Record shares removed by a filled SELL order.
   * Clamps to zero — never goes negative.
   */
  recordSell(tokenId: string, shares: number): void {
    const current = this.shares.get(tokenId) ?? 0;
    const remaining = Math.max(0, current - shares);
    if (remaining === 0) {
      this.shares.delete(tokenId);
    } else {
      this.shares.set(tokenId, remaining);
    }
  }

  /** Returns current share count for a token (0 if not held). */
  getShares(tokenId: string): number {
    return this.shares.get(tokenId) ?? 0;
  }

  /** Returns a snapshot of all currently tracked positions. */
  snapshot(): ReadonlyMap<string, number> {
    return this.shares;
  }
}