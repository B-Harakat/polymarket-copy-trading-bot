import { ethers } from 'ethers';

const DATA_API = 'https://data-api.polymarket.com';
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const USDC_ABI = ['function balanceOf(address owner) view returns (uint256)'];

export type MyPortfolio = {
  cash: number;
  invested: number;
  total: number;
  proxyWallet: string;
};

/**
 * Fetches the bot's own portfolio.
 * Uses same on-chain USDC balanceOf approach as getTraderPortfolio for consistency.
 * CLOB getBalanceAllowance() used as fallback if RPC fails.
 */
export async function getMyPortfolio(
  client: any,
  proxyWallet: string,
  rpcUrl?: string,
): Promise<MyPortfolio> {
  let cash = 0;

  // Primary: on-chain USDC balance (same source as trader balance)
  if (rpcUrl) {
    try {
      const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
      const usdc = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);
      const raw: ethers.BigNumber = await usdc.balanceOf(proxyWallet);
      cash = raw.toNumber() / 1e6;
    } catch {
      // fall through to CLOB fallback
    }
  }

  // Fallback: CLOB getBalanceAllowance (already divided by 1e6 in previous fix)
  if (cash === 0 && client) {
    try {
      const balanceRes = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
      cash = parseFloat(balanceRes?.balance ?? '0') / 1e6;
    } catch {
      // non-fatal
    }
  }

  // Invested: open positions from Data API
  let invested = 0;
  try {
    const res = await fetch(`${DATA_API}/positions?user=${proxyWallet}&sizeThreshold=.1`);
    if (res.ok) {
      const positions = await res.json() as Array<{ currentValue?: number; size?: number; curPrice?: number }>;
      if (Array.isArray(positions)) {
        invested = positions.reduce((sum, p) => {
          const val = p.currentValue ?? (p.size != null && p.curPrice != null ? p.size * p.curPrice : 0);
          return sum + (val ?? 0);
        }, 0);
      }
    }
  } catch {
    // non-fatal
  }

  return { cash, invested, total: cash + invested, proxyWallet };
}

/**
 * Fetches the live on-chain share count for a specific token from the Data API.
 *
 * Used before placing SELL orders to cap the sell size against the actual
 * position held, guarding against ledger drift or stale startup seeds.
 *
 * Returns 0 if the position is not found or the API call fails (non-fatal).
 */
export async function getMyTokenBalance(
  proxyWallet: string,
  tokenId: string,
): Promise<number> {
  try {
    const res = await fetch(`${DATA_API}/positions?user=${proxyWallet}`);
    if (!res.ok) return 0;

    const positions = await res.json() as Array<{ asset?: string; size?: number }>;
    if (!Array.isArray(positions)) return 0;

    const match = positions.find((p) => p.asset === tokenId);
    return match?.size ?? 0;
  } catch {
    return 0;
  }
}