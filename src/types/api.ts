export type Network = 'mainnet' | 'testnet';
export type WalletType = 'eth' | 'solana' | 'both';

// API Request Types
export interface CreateWalletRequest {
  ethPrivateKey: string;
  network?: Network;
}

export interface CreateMultisigRequest {
  firstPrivateKey: string;
  secondPrivateKey: string;
  network?: Network;
  walletType: WalletType;
}

export interface SendTransactionRequest {
  privateKey: string;
  walletType: 'eth' | 'solana';
  recipient: string;
  amount: string;
  network?: Network;
  secondPrivateKey?: string; // For multisig
}

export interface RegisterRequest {
  email: string;
  password: string;
  name?: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

// API Response Types
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface WalletCreationResponse {
  ethAddress: string;
  ethSmartWallet: string;
  solanaAddress: string;
  swigId: number[];
  network: string;
  transactionHashes: {
    eth?: string;
    solana: string;
  };
}

export interface MultisigResponse {
  ethMultisig?: {
    address: string;
    threshold: number;
    signers: string[];
    transactionHash: string;
  };
  solanaMultisig?: {
    address: string;
    threshold: number;
    signers: string[];
    transactionHash: string;
  };
}

export interface TransactionResponse {
  transactionHash: string;
  explorerUrl: string;
  amount: string;
  recipient: string;
  network: string;
}

export interface AuthResponse {
  token: string;
  user: {
    id: string;
    email: string;
    name?: string;
  };
}

