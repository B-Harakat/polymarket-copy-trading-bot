import { ethers } from 'ethers';

const DATA_API = 'https://data-api.polymarket.com';

// USDC.e on Polygon — 6 decimals
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];

export type TraderPortfolio = {
  cash: number;        // on-chain USDC balance (uninvested)
  invested: number;    // open positions mark-to-market value
  total: number;       // cash + invested
  proxyWallet: string;
};

/**
 * Fetches a trader's full portfolio breakdown.
 *
 * cash     = on-chain USDC balanceOf(proxyWallet) — the authoritative source.
 *            Same method Polymarket's own accounting snapshot uses.
 * invested = Data API /positions → sum of (size × curPrice) across open positions.
 * total    = cash + invested.
 *
 * @param proxyWallet - Trader's Polymarket proxy wallet address
 * @param rpcUrl      - Polygon RPC URL (from env.rpcUrl)
 */
export async function getTraderPortfolio(
  proxyWallet: string,
  rpcUrl: string,
): Promise<TraderPortfolio> {
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);

  // Fetch USDC cash balance and positions in parallel
  const [rawBalance, positionsRes] = await Promise.all([
    usdc.balanceOf(proxyWallet) as Promise<ethers.BigNumber>,
    fetch(`${DATA_API}/positions?user=${proxyWallet}&sizeThreshold=.1`),
  ]);

  const cash = rawBalance.toNumber() / 1e6;

  let invested = 0;
  if (positionsRes.ok) {
    const positions = await positionsRes.json() as Array<{
      currentValue?: number;
      value?: number;
      size?: number;
      curPrice?: number;
    }>;
    if (Array.isArray(positions)) {
      invested = positions.reduce((sum, p) => {
        // currentValue preferred; fallback to size × curPrice
        const val = p.currentValue ?? (p.size != null && p.curPrice != null ? p.size * p.curPrice : 0);
        return sum + (val ?? 0);
      }, 0);
    }
  }

  return { cash, invested, total: cash + invested, proxyWallet };
}

// Legacy export
export async function getTraderUsdBalance(proxyWallet: string, rpcUrl: string): Promise<number> {
  const p = await getTraderPortfolio(proxyWallet, rpcUrl);
  return p.total;
}