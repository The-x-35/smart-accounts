export interface ZeroDevWalletResult {
  address: string;
  transactionHash?: string;
  explorerUrl?: string;
}

export interface ZeroDevMultisigResult {
  address: string;
  threshold: number;
  signers: string[];
  transactionHash: string;
  explorerUrl: string;
}

export interface ZeroDevTransferResult {
  transactionHash: string;
  explorerUrl: string;
  amount: string;
  recipient: string;
}

