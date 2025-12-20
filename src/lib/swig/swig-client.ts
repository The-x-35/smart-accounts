import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  PublicKey,
} from '@solana/web3.js';
import {
  Actions,
  createSecp256k1AuthorityInfo,
  findSwigPda,
  getCreateSwigInstruction,
  getSignInstructions,
  fetchSwig,
  getSigningFnForSecp256k1PrivateKey,
  getAddAuthorityInstructions,
} from '@swig-wallet/classic';
import { privateKeyToAccount } from 'viem/accounts';
import { hexToBytes } from 'viem';
import bs58 from 'bs58';
import { Network } from '@/types/api';
import { getSolanaRpc } from '@/lib/config/networks';
import { getFeePayer } from '@/lib/config/fee-payers';
import { SwigWalletResult, SwigMultisigResult, SwigTransferResult } from './types';

/**
 * Create a deterministic Swig ID from an EVM address
 */
function createDeterministicSwigId(evmAddress: string): Uint8Array {
  const cleanAddress = evmAddress.startsWith('0x') ? evmAddress.slice(2) : evmAddress;
  const encoder = new TextEncoder();
  const data = encoder.encode(cleanAddress);
  
  const hash = new Uint8Array(32);
  let hashIndex = 0;
  
  for (let i = 0; i < data.length; i++) {
    hash[hashIndex] ^= data[i];
    hashIndex = (hashIndex + 1) % 32;
  }
  
  for (let i = 0; i < data.length; i++) {
    hash[hashIndex] ^= data[data.length - 1 - i];
    hashIndex = (hashIndex + 1) % 32;
  }
  
  return hash;
}

/**
 * Create keypair from private key
 */
function createKeypairFromPrivateKey(privateKey: string): Keypair {
  if (typeof privateKey === 'string') {
    const privateKeyBytes = bs58.decode(privateKey);
    return Keypair.fromSecretKey(privateKeyBytes);
  }
  throw new Error('Invalid private key format');
}

/**
 * Create Swig wallet from EVM private key
 */
export async function createSwigWallet(
  evmPrivateKey: string,
  network: Network
): Promise<SwigWalletResult> {
  // Validate and format private key
  const formattedPrivateKey = evmPrivateKey.startsWith('0x')
    ? evmPrivateKey
    : `0x${evmPrivateKey}`;

  // Create viem account from private key
  const evmAccount = privateKeyToAccount(formattedPrivateKey as `0x${string}`);

  // Generate deterministic Swig ID
  const swigId = createDeterministicSwigId(evmAccount.address);
  const swigAddress = findSwigPda(swigId);

  // Initialize Solana connection
  const rpcUrl = getSolanaRpc(network);
  const connection = new Connection(rpcUrl, 'confirmed');

  // Check if Swig wallet already exists
  try {
    const existingSwig = await fetchSwig(connection, swigAddress);
    if (existingSwig) {
      // Wallet already exists, return existing wallet info
      return {
        address: swigAddress.toString(),
        id: Array.from(swigId),
        transactionSignature: '', // Can't get original tx signature for existing wallet
        explorerUrl: `https://solscan.io/account/${swigAddress.toString()}`,
      };
    }
  } catch (error: any) {
    // If fetchSwig throws, the wallet doesn't exist yet - continue to create it
    // Common error messages: "Unable to fetch Swig account", "AccountNotFound", etc.
    // If it's a "not found" type error, proceed with creation
    const errorMessage = error?.message?.toLowerCase() || '';
    if (errorMessage.includes('unable to fetch') ||
        errorMessage.includes('accountnotfound') || 
        errorMessage.includes('not found') ||
        errorMessage.includes('does not exist') ||
        error?.code === 0x1) {
      // Wallet doesn't exist, proceed with creation - this is expected
      // Continue to the creation logic below
    } else {
      // Some other unexpected error occurred (network issue, etc.)
      console.error('Unexpected error checking for existing Swig wallet:', error);
      throw error;
    }
  }

  // Create authority info
  const authorityInfo = createSecp256k1AuthorityInfo(evmAccount.publicKey);

  // Set up actions - default to all actions allowed
  const rootActions = Actions.set().all().get();

  // Get fee payer
  const feePayer = getFeePayer(network);

  // Create Swig instruction
  const createSwigInstruction = await getCreateSwigInstruction({
    authorityInfo,
    id: swigId,
    payer: feePayer.solanaKeypair.publicKey,
    actions: rootActions,
  });

  // Create and send transaction
  const transaction = new Transaction().add(createSwigInstruction);

  try {
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [feePayer.solanaKeypair],
      { commitment: 'confirmed' }
    );

    return {
      address: swigAddress.toString(),
      id: Array.from(swigId),
      transactionSignature: signature,
      explorerUrl: `https://solscan.io/tx/${signature}`,
    };
  } catch (error: any) {
    // If error is "account already exists" (0x1), return existing wallet
    if (error?.transactionLogs?.some((log: string) => log.includes('custom program error: 0x1')) ||
        error?.message?.includes('custom program error: 0x1')) {
      // Wallet was created between our check and the transaction
      return {
        address: swigAddress.toString(),
        id: Array.from(swigId),
        transactionSignature: '', // Transaction failed but wallet exists
        explorerUrl: `https://solscan.io/account/${swigAddress.toString()}`,
      };
    }
    // Re-throw other errors
    throw error;
  }
}

/**
 * Add second signer to create 2-of-2 multisig
 */
export async function createSwigMultisig(
  rootEvmPrivateKey: string,
  secondEvmPrivateKey: string,
  network: Network
): Promise<SwigMultisigResult> {
  // Validate and format private keys
  const formattedRootPrivateKey = rootEvmPrivateKey.startsWith('0x')
    ? rootEvmPrivateKey
    : `0x${rootEvmPrivateKey}`;

  const formattedSecondPrivateKey = secondEvmPrivateKey.startsWith('0x')
    ? secondEvmPrivateKey
    : `0x${secondEvmPrivateKey}`;

  // Create viem accounts
  const rootEvmAccount = privateKeyToAccount(formattedRootPrivateKey as `0x${string}`);
  const secondEvmAccount = privateKeyToAccount(formattedSecondPrivateKey as `0x${string}`);

  // Generate Swig ID (deterministic based on root address)
  const swigId = createDeterministicSwigId(rootEvmAccount.address);
  const swigAddress = findSwigPda(swigId);

  // Initialize Solana connection
  const rpcUrl = getSolanaRpc(network);
  const connection = new Connection(rpcUrl, 'confirmed');

  // Fetch existing Swig account (should exist from first wallet creation)
  const swig = await fetchSwig(connection, swigAddress);

  // Find the root role
  const rootRole = swig.findRolesBySecp256k1SignerAddress(rootEvmAccount.address)[0];
  if (!rootRole) {
    throw new Error('Root role not found. Please create the wallet first.');
  }

  // Create authority info for the new signer
  const newAuthorityInfo = createSecp256k1AuthorityInfo(secondEvmAccount.publicKey);

  // Set up actions for the new signer
  const newSignerActions = Actions.set().all().get();

  // Get fee payer
  const feePayer = getFeePayer(network);

  // Create signing function for the root authority
  const privateKeyBytes = hexToBytes(formattedRootPrivateKey as `0x${string}`);
  const signingFn = getSigningFnForSecp256k1PrivateKey(privateKeyBytes);

  // Get current slot
  const currentSlot = await connection.getSlot('finalized');

  // Get add authority instructions
  const addAuthorityInstructions = await getAddAuthorityInstructions(
    swig,
    rootRole.id,
    newAuthorityInfo,
    newSignerActions,
    {
      payer: feePayer.solanaKeypair.publicKey,
      currentSlot: BigInt(currentSlot),
      signingFn,
    }
  );

  // Create and send transaction
  const transaction = new Transaction().add(...addAuthorityInstructions);

  const signature = await sendAndConfirmTransaction(
    connection,
    transaction,
    [feePayer.solanaKeypair],
    { commitment: 'confirmed' }
  );

  // Fetch updated Swig account
  const updatedSwig = await fetchSwig(connection, swigAddress);

  // Find the new role
  const newRole = updatedSwig.findRolesBySecp256k1SignerAddress(secondEvmAccount.address)[0];
  if (!newRole) {
    throw new Error('Failed to find new role for the added signer');
  }

  return {
    address: swigAddress.toString(),
    id: Array.from(swigId),
    totalSigners: 2,
    requiredSignatures: 2, // 2-of-2 multisig
    signers: [
      {
        evmAddress: rootEvmAccount.address,
        publicKey: hexToBytes(rootEvmAccount.publicKey),
        roleId: rootRole.id,
      },
      {
        evmAddress: secondEvmAccount.address,
        publicKey: hexToBytes(secondEvmAccount.publicKey),
        roleId: newRole.id,
      },
    ],
    transactionSignature: signature,
    explorerUrl: `https://solscan.io/tx/${signature}`,
  };
}

/**
 * Transfer SOL using Swig wallet
 */
export async function transferSOLWithSwig(
  evmPrivateKey: string,
  swigId: number[],
  recipient: string,
  amount: number, // in lamports
  network: Network
): Promise<SwigTransferResult> {
  // Validate and format private key
  const formattedPrivateKey = evmPrivateKey.startsWith('0x')
    ? evmPrivateKey
    : `0x${evmPrivateKey}`;

  // Create viem account
  const evmAccount = privateKeyToAccount(formattedPrivateKey as `0x${string}`);

  // Convert swigId array to Uint8Array
  const swigIdBytes = new Uint8Array(swigId);
  const swigAddress = findSwigPda(swigIdBytes);

  // Initialize Solana connection
  const rpcUrl = getSolanaRpc(network);
  const connection = new Connection(rpcUrl, 'confirmed');

  // Fetch Swig account
  const swig = await fetchSwig(connection, swigAddress);

  // Find the role for this EVM address
  const rootRole = swig.findRolesBySecp256k1SignerAddress(evmAccount.address)[0];
  if (!rootRole) {
    throw new Error('No role found for this authority');
  }

  // Get fee payer
  const feePayer = getFeePayer(network);

  // Create signing function
  const privateKeyBytes = hexToBytes(formattedPrivateKey as `0x${string}`);
  const signingFn = getSigningFnForSecp256k1PrivateKey(privateKeyBytes);

  // Get current slot
  const currentSlot = await connection.getSlot('finalized');

  // Create transfer instruction
  const transferInstruction = SystemProgram.transfer({
    fromPubkey: swigAddress,
    toPubkey: new PublicKey(recipient),
    lamports: amount,
  });

  // Get signing instructions
  const signInstructions = await getSignInstructions(
    swig,
    rootRole.id,
    [transferInstruction],
    false,
    {
      currentSlot: BigInt(currentSlot),
      signingFn,
      payer: feePayer.solanaKeypair.publicKey,
    }
  );

  // Create and send transaction
  const transaction = new Transaction().add(...signInstructions);

  const signature = await sendAndConfirmTransaction(
    connection,
    transaction,
    [feePayer.solanaKeypair],
    { commitment: 'confirmed' }
  );

  return {
    transactionSignature: signature,
    explorerUrl: `https://solscan.io/tx/${signature}`,
    amount,
    recipient,
  };
}

