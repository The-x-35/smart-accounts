export interface SwigWalletResult {
  address: string;
  id: number[];
  transactionSignature: string;
  explorerUrl: string;
}

export interface SwigMultisigResult {
  address: string;
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

