import { Network } from '@/types/api';
import { Keypair } from '@solana/web3.js';
import { privateKeyToAccount } from 'viem/accounts';
import bs58 from 'bs58';

export interface FeePayerConfig {
  ethPrivateKey: string;
  solanaPrivateKey: string;
  ethAccount: ReturnType<typeof privateKeyToAccount>;
  solanaKeypair: Keypair;
}

const feePayers: Record<Network, FeePayerConfig | null> = {
  mainnet: null,
  testnet: null,
};

function isValidEthPrivateKey(key: string): boolean {
  if (!key || key.length === 0) return false;
  const formatted = key.startsWith('0x') ? key : `0x${key}`;
  // ETH private key should be 0x + 64 hex characters = 66 total
  return /^0x[a-fA-F0-9]{64}$/.test(formatted);
}

function isValidSolanaPrivateKey(key: string): boolean {
  if (!key || key.length === 0) return false;
  try {
    bs58.decode(key);
    return true;
  } catch {
    return false;
  }
}

function initializeFeePayers() {
  // ETH Mainnet
  const ethMainnetKey = process.env.ETH_MAINNET_FEE_PAYER_PRIVATE_KEY?.trim();
  const solanaMainnetKey = process.env.SOLANA_MAINNET_FEE_PAYER_PRIVATE_KEY?.trim();

  if (ethMainnetKey && solanaMainnetKey && 
      isValidEthPrivateKey(ethMainnetKey) && 
      isValidSolanaPrivateKey(solanaMainnetKey)) {
    try {
      // Ensure ETH key has 0x prefix
      const formattedEthKey = ethMainnetKey.startsWith('0x') 
        ? ethMainnetKey 
        : `0x${ethMainnetKey}`;
      
      feePayers.mainnet = {
        ethPrivateKey: formattedEthKey,
        solanaPrivateKey: solanaMainnetKey,
        ethAccount: privateKeyToAccount(formattedEthKey as `0x${string}`),
        solanaKeypair: Keypair.fromSecretKey(bs58.decode(solanaMainnetKey)),
      };
    } catch (error) {
      console.warn('Failed to initialize mainnet fee payers:', error);
    }
  }

  // ETH Testnet
  const ethTestnetKey = process.env.ETH_TESTNET_FEE_PAYER_PRIVATE_KEY?.trim();
  const solanaTestnetKey = process.env.SOLANA_TESTNET_FEE_PAYER_PRIVATE_KEY?.trim();

  if (ethTestnetKey && solanaTestnetKey && 
      isValidEthPrivateKey(ethTestnetKey) && 
      isValidSolanaPrivateKey(solanaTestnetKey)) {
    try {
      // Ensure ETH key has 0x prefix
      const formattedEthKey = ethTestnetKey.startsWith('0x') 
        ? ethTestnetKey 
        : `0x${ethTestnetKey}`;
      
      feePayers.testnet = {
        ethPrivateKey: formattedEthKey,
        solanaPrivateKey: solanaTestnetKey,
        ethAccount: privateKeyToAccount(formattedEthKey as `0x${string}`),
        solanaKeypair: Keypair.fromSecretKey(bs58.decode(solanaTestnetKey)),
      };
    } catch (error) {
      console.warn('Failed to initialize testnet fee payers:', error);
    }
  }
}

// Initialize on module load (but only if env vars are set)
initializeFeePayers();

export function getFeePayer(network: Network): FeePayerConfig {
  // Re-initialize in case env vars were set after module load
  if (!feePayers[network]) {
    initializeFeePayers();
  }
  
  const feePayer = feePayers[network];
  if (!feePayer) {
    throw new Error(
      `Fee payer not configured for ${network}. ` +
      `Please set ETH_${network.toUpperCase()}_FEE_PAYER_PRIVATE_KEY and ` +
      `SOLANA_${network.toUpperCase()}_FEE_PAYER_PRIVATE_KEY environment variables.`
    );
  }
  return feePayer;
}

export function hasFeePayer(network: Network): boolean {
  return feePayers[network] !== null;
}

