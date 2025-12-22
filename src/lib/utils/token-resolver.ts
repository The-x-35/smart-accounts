import { PublicKey } from '@solana/web3.js';

// Common token definitions
export const TOKENS: Record<string, { mint: string; decimals: number; symbol: string }> = {
  SOL: {
    mint: 'So11111111111111111111111111111111111111112', // Wrapped SOL
    decimals: 9,
    symbol: 'SOL',
  },
  USDC: {
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
    symbol: 'USDC',
  },
  USDT: {
    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    decimals: 6,
    symbol: 'USDT',
  },
  BONK: {
    mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    decimals: 5,
    symbol: 'BONK',
  },
  RAY: {
    mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    decimals: 6,
    symbol: 'RAY',
  },
};

// Testnet tokens
export const TESTNET_TOKENS: Record<string, { mint: string; decimals: number; symbol: string }> = {
  SOL: {
    mint: 'So11111111111111111111111111111111111111112',
    decimals: 9,
    symbol: 'SOL',
  },
  USDC: {
    mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', // Testnet USDC
    decimals: 6,
    symbol: 'USDC',
  },
};

export interface ResolvedToken {
  mint: string;
  decimals: number;
  symbol: string;
}

/**
 * Resolve a token parameter (symbol or mint address) to token info
 */
export async function resolveTokenParam(
  tokenParam: string,
  defaultToken: string = 'SOL'
): Promise<ResolvedToken> {
  const trimmed = tokenParam.trim().toUpperCase();

  // Check if it's a known symbol
  if (TOKENS[trimmed]) {
    return TOKENS[trimmed];
  }

  // Check if it's a valid mint address
  try {
    const pubkey = new PublicKey(trimmed);
    // If it's a valid public key, assume it's a mint address
    // We'll need to fetch decimals from the mint account
    // For now, return with default decimals
    return {
      mint: pubkey.toString(),
      decimals: 9, // Default, should be fetched from mint account
      symbol: trimmed,
    };
  } catch (error) {
    // Not a valid public key, try default token
    if (TOKENS[defaultToken]) {
      return TOKENS[defaultToken];
    }
    throw new Error(`Invalid token: ${tokenParam}. Must be a symbol (SOL, USDC, etc.) or a valid mint address.`);
  }
}

/**
 * Get token info for a specific network
 */
export function getTokenForNetwork(
  tokenParam: string,
  network: 'mainnet' | 'testnet' = 'mainnet'
): ResolvedToken {
  const trimmed = tokenParam.trim().toUpperCase();
  const tokenMap = network === 'mainnet' ? TOKENS : TESTNET_TOKENS;

  if (tokenMap[trimmed]) {
    return tokenMap[trimmed];
  }

  // If not found in token map, validate as mint address
  try {
    const pubkey = new PublicKey(trimmed);
    return {
      mint: pubkey.toString(),
      decimals: 9, // Default
      symbol: trimmed,
    };
  } catch (error) {
    throw new Error(`Invalid token: ${tokenParam}`);
  }
}

