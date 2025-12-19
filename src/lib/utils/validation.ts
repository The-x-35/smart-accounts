/**
 * Validation utilities for API inputs
 */

export function isValidPrivateKey(privateKey: string): boolean {
  if (!privateKey || typeof privateKey !== 'string') {
    return false;
  }

  // Remove 0x prefix if present
  const formattedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;

  // Check length (should be 66 characters including 0x)
  if (formattedKey.length !== 66) {
    return false;
  }

  // Check if it's a valid hex string
  if (!/^0x[0-9a-fA-F]{64}$/.test(formattedKey)) {
    return false;
  }

  return true;
}

export function isValidEthereumAddress(address: string): boolean {
  if (!address || typeof address !== 'string') {
    return false;
  }

  // Ethereum address should be 42 characters (0x + 40 hex chars)
  if (address.length !== 42) {
    return false;
  }

  // Check if it's a valid hex string
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return false;
  }

  return true;
}

export function isValidSolanaAddress(address: string): boolean {
  if (!address || typeof address !== 'string') {
    return false;
  }

  // Solana addresses are base58 encoded, typically 32-44 characters
  if (address.length < 32 || address.length > 44) {
    return false;
  }

  // Basic check - Solana addresses use base58 encoding
  // More thorough validation would require base58 decoding
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

export function isValidAmount(amount: string): boolean {
  if (!amount || typeof amount !== 'string') {
    return false;
  }

  // Check if it's a valid number
  const num = parseFloat(amount);
  if (isNaN(num) || num <= 0) {
    return false;
  }

  // Check if it's a valid decimal number
  if (!/^\d+(\.\d+)?$/.test(amount)) {
    return false;
  }

  return true;
}

export function isValidEmail(email: string): boolean {
  if (!email || typeof email !== 'string') {
    return false;
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

export function isValidPassword(password: string): boolean {
  if (!password || typeof password !== 'string') {
    return false;
  }

  // Minimum 8 characters
  if (password.length < 8) {
    return false;
  }

  return true;
}

export function validateNetwork(network: string): network is 'mainnet' | 'testnet' {
  return network === 'mainnet' || network === 'testnet';
}

export function validateWalletType(walletType: string): walletType is 'eth' | 'solana' | 'both' {
  return walletType === 'eth' || walletType === 'solana' || walletType === 'both';
}

