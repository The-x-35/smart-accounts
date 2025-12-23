import { Network } from '@/types/api';

export interface NetworkConfig {
  eth: {
    rpc: string;
    chainId: number;
  };
  solana: {
    rpc: string;
  };
}

const networks: Record<Network, NetworkConfig> = {
  mainnet: {
    eth: {
      rpc: process.env.ETH_MAINNET_RPC || 'https://eth-mainnet.g.alchemy.com/v2/zNJmop9_ak2kOQELujgaZ9RExxSi6Q8S',
      chainId: 1,
    },
    solana: {
      rpc: process.env.SOLANA_MAINNET_RPC || 'https://mainnet.helius-rpc.com/?api-key=d9b6d595-1feb-4741-8958-484ad55afdab',
    },
  },
  testnet: {
    eth: {
      rpc: process.env.ETH_TESTNET_RPC || 'https://eth-sepolia.g.alchemy.com/v2/zNJmop9_ak2kOQELujgaZ9RExxSi6Q8S',
      chainId: 11155111, // Sepolia
    },
    solana: {
      rpc: process.env.SOLANA_TESTNET_RPC || 'https://api.devnet.solana.com',
    },
  },
};

export function getNetworkConfig(network: Network): NetworkConfig {
  return networks[network];
}

export function getEthRpc(network: Network): string {
  return networks[network].eth.rpc;
}

export function getSolanaRpc(network: Network): string {
  return networks[network].solana.rpc;
}

