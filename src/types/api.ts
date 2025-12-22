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
  solanaAddress: string; // System Program owned wallet address - USE THIS for receiving SOL/SPL tokens
  solanaConfigurationAddress?: string; // PDA configuration account (for reference)
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
    address: string; // System Program owned wallet address - USE THIS for receiving SOL/SPL tokens
    configurationAddress?: string; // PDA configuration account (for reference)
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

// Swap-related types
export interface SwapPriceRequest {
  tokenId: string;
}

export interface SwapPriceResponse {
  tokenId: string;
  price: number;
  priceFormatted: string;
  marketCap: number;
  lastUpdated: string;
}

export interface SwapQuoteRequest {
  inputToken: string;
  outputToken: string;
  amount: string;
}

export interface SwapQuoteResponse {
  inputAmount: number;
  inputToken: string;
  outputAmount: number;
  outputToken: string;
  priceImpact: number;
  quote: any; // Jupiter quote object
  timestamp: string;
}

export interface SwapExecuteRequest {
  privateKey: string;
  secondPrivateKey?: string;
  inputToken: string;
  outputToken: string;
  amount: string;
  network?: Network;
  useJitoBundle?: boolean;
}

export interface SwapExecuteResponse {
  transactionHash: string;
  explorerUrl: string;
  inputAmount: number;
  inputToken: string;
  outputAmount: number;
  outputToken: string;
  timestamp: string;
}

