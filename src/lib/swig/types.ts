export interface SwigWalletResult {
  address: string; // PDA configuration account (for backward compatibility)
  walletAddress: string; // System Program owned account - USE THIS for receiving SOL/SPL tokens
  id: number[];
  transactionSignature: string;
  explorerUrl: string;
}

export interface SwigMultisigResult {
  address: string; // PDA configuration account (for backward compatibility)
  walletAddress: string; // System Program owned account - USE THIS for receiving SOL/SPL tokens
  id: number[];
  totalSigners: number;
  requiredSignatures: number;
  signers: Array<{
    evmAddress: string;
    publicKey: Uint8Array;
    roleId: number;
  }>;
  transactionSignature: string;
  explorerUrl: string;
}

export interface SwigTransferResult {
  transactionSignature: string;
  explorerUrl: string;
  amount: number;
  recipient: string;
}

