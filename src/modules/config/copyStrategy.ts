export type CopyInputs = {
  yourPortfolioTotal: number;   // your total portfolio value (cash + invested)
  traderPortfolioTotal: number; // trader's total portfolio value (cash + invested)
  traderTradeUsd: number;       // USD size of the trade being copied
  multiplier: number;           // scaling factor from env (1.0 = mirror exactly)
};

export type SizingResult = {
  targetUsdSize: number;  // final USD amount to place
  tradeRatio: number;     // what fraction of trader's portfolio this trade represents
  yourScaledSize: number; // tradeRatio × your portfolio (before multiplier/floor)
};

/**
 * Sizes a copy trade proportionally based on portfolio ratio.
 *
 * Logic:
 *   tradeRatio     = traderTradeUsd / traderPortfolioTotal
 *                  = "what % of their portfolio is this trade"
 *
 *   yourScaledSize = tradeRatio × yourPortfolioTotal
 *                  = "the same % of YOUR portfolio"
 *
 *   targetUsdSize  = yourScaledSize × multiplier
 *                  = allows you to scale up/down (1.0 = mirror, 2.0 = 2x)
 *
 * Example:
 *   Trader portfolio: $27.40,  trade: $2.00  →  tradeRatio = 7.3%
 *   Your portfolio:   $983.00               →  yourScaled = $71.76
 *   multiplier = 1.0                        →  target     = $71.76
 *
 * Floor: never place less than $1.05 (CLOB minimum is $1.00, buffer for float).
 */
export function computeProportionalSizing(input: CopyInputs): SizingResult {
  const { yourPortfolioTotal, traderPortfolioTotal, traderTradeUsd, multiplier } = input;

  const tradeRatio = traderTradeUsd / Math.max(1, traderPortfolioTotal);
  const yourScaledSize = tradeRatio * yourPortfolioTotal;
  const targetUsdSize = Math.max(1.05, yourScaledSize * Math.max(0, multiplier));

  return { targetUsdSize, tradeRatio, yourScaledSize };
}


