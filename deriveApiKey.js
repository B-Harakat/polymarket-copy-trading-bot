/**
 * Run with: node deriveApiKey.js
 * Must be run from the repo root where .env lives.
 */
require('dotenv').config();
const { Wallet, providers } = require('ethers');
const { ClobClient } = require('@polymarket/clob-client');

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;

async function main() {
  const { PRIVATE_KEY, PROXY_WALLET, RPC_URL } = process.env;
  if (!PRIVATE_KEY || !PROXY_WALLET || !RPC_URL) {
    throw new Error('PRIVATE_KEY, PROXY_WALLET and RPC_URL must be set in .env');
  }

  const provider = new providers.JsonRpcProvider(RPC_URL);
  const wallet = new Wallet(PRIVATE_KEY, provider);

  console.log('Signer (EOA):  ', wallet.address);
  console.log('Proxy wallet:  ', PROXY_WALLET);
  console.log('Deriving key...\n');

  const client = new ClobClient(CLOB_HOST, CHAIN_ID, wallet, undefined, 2, PROXY_WALLET);
  const creds = await client.deriveApiKey();

  console.log('Add these to your .env:\n');
  console.log('POLY_API_KEY=' + creds.key);
  console.log('POLY_API_SECRET=' + creds.secret);
  console.log('POLY_API_PASSPHRASE=' + creds.passphrase);
}

main().catch(err => { console.error('Failed:', err.message || err); process.exit(1); });