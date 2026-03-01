import { Wallet, providers } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';

const CLOB_HOST = 'https://clob.polymarket.com';
const POLYGON_CHAIN_ID = 137;

export type CreateClientInput = {
  rpcUrl: string;
  privateKey: string;
  proxyWallet: string;
  // Optional: if set, skips createOrDeriveApiKey() and uses these directly.
  // Recommended once working — avoids "Could not create api key" on boot.
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
};

export type PolymarketClient = ClobClient & { wallet: Wallet };

export async function createPolymarketClient(
  input: CreateClientInput,
): Promise<PolymarketClient> {
  const { rpcUrl, privateKey, proxyWallet } = input;

  const provider = new providers.JsonRpcProvider(rpcUrl);
  const wallet = new Wallet(privateKey, provider);

  // signatureType 2 = Gnosis Safe / Polymarket proxy wallet (browser-wallet users)
  const signatureType = 2;

  let apiCreds: { key: string; secret: string; passphrase: string };

  if (input.apiKey && input.apiSecret && input.apiPassphrase) {
    // Fast path: credentials already known — skip the derive call entirely.
    // This avoids the "Could not create api key" error caused by hitting the
    // 3-key limit, and saves one round-trip on every boot.
    apiCreds = {
      key: input.apiKey,
      secret: input.apiSecret,
      passphrase: input.apiPassphrase,
    };
  } else {
    // First-time path: derive credentials from the signer.
    // Run this once, then copy the printed values into your .env.
    const tempClient = new ClobClient(
      CLOB_HOST,
      POLYGON_CHAIN_ID,
      wallet,
      undefined,
      signatureType,
      proxyWallet,
    );
    apiCreds = await tempClient.createOrDeriveApiKey();
  }

  const client = new ClobClient(
    CLOB_HOST,
    POLYGON_CHAIN_ID,
    wallet,
    apiCreds,
    signatureType,
    proxyWallet,
  );

  return Object.assign(client, { wallet });
}