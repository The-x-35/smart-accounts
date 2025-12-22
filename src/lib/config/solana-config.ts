import { Connection } from '@solana/web3.js';
import { Network } from '@/types/api';
import { getSolanaRpc } from './networks';

// Jupiter API endpoints
// Use lite-api for unauthenticated access (no API key required)
// Use api.jup.ag with API key for higher rate limits
export const JUPITER_API = {
  QUOTE: process.env.JUPITER_API_KEY 
    ? 'https://api.jup.ag/swap/v1/quote'
    : 'https://lite-api.jup.ag/swap/v1/quote',
  SWAP: process.env.JUPITER_API_KEY
    ? 'https://api.jup.ag/swap/v1/swap'
    : 'https://lite-api.jup.ag/swap/v1/swap',
  PRICE: 'https://price.jup.ag/v4/price',
  LITE_PRICE: 'https://lite-api.jup.ag/price/v3',
};

// Jupiter API Key (optional, from environment variable)
export const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '';

// Mint address validation regex
export const MINT_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// Token decimals mapping (common tokens)
export const TOKEN_DECIMALS: Record<string, number> = {
  SOL: 9,
  USDC: 6,
  USDT: 6,
  BONK: 5,
  RAY: 6,
};

// Export TOKENS from token-resolver for compatibility
export { TOKENS } from '@/lib/utils/token-resolver';

/**
 * Get Solana connection for a given network
 */
export function getSolanaConnection(network: Network = 'mainnet'): Connection {
  const rpcUrl = getSolanaRpc(network);
  return new Connection(rpcUrl, 'confirmed');
}

/**
 * Format price based on value
 */
export function formatPrice(price: number): string {
  if (price < 0.0001) return price.toFixed(12);
  if (price < 0.01) return price.toFixed(8);
  if (price < 1) return price.toFixed(6);
  return price.toFixed(4);
}

