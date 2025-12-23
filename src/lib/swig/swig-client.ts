import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  TransactionInstruction,
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
  getSwigWalletAddress,
  getSwigSystemAddress,
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
      // Check account version (v1 or v2) - according to SDK docs
      const accountVersion = (existingSwig as any).accountVersion?.() || 'v1'; // Default to v1 if method doesn't exist
      
      // Get the account address (PDA) - use swigAddress we already have (from findSwigPda)
      // Don't use getSwigAccountAddress as it has a bug in the SDK (recursive call)
      const accountAddress = swigAddress; // This is the PDA from findSwigPda(swigId)
      const systemAddress = await getSwigSystemAddress(existingSwig);
      const walletAddress = await getSwigWalletAddress(existingSwig);
      
      console.log('Swig account addresses:', {
        accountVersion,
        accountAddress: accountAddress.toBase58(),
        systemAddress: systemAddress.toBase58(),
        walletAddress: walletAddress.toBase58(),
        swigAddress: swigAddress.toBase58(),
        isV1: walletAddress.equals(accountAddress),
        isV2: !walletAddress.equals(accountAddress),
      });
      
      // Check if wallet is v1 (old architecture)
      // - v1 accounts: walletAddress === accountAddress (can't receive SPL tokens)
      // - v2 accounts: walletAddress === systemAddress (can receive SPL tokens)
      if (accountVersion === 'v1' || walletAddress.equals(accountAddress)) {
        // V1 wallet detected - return as-is (no migration)
        console.log('V1 Swig wallet detected. Returning existing wallet.');
        return {
          address: accountAddress.toString(), // PDA configuration account
          walletAddress: systemAddress.toString(), // System Program owned account (what it would be after migration)
          id: Array.from(swigId),
          transactionSignature: '',
          explorerUrl: `https://www.orbmarkets.io/account/${accountAddress.toString()}`,
        };
      }
      
      // Wallet is already v2 (migrated) or newly created with v2
      // getSwigWalletAddress should return the system address for v2 accounts
      return {
        address: accountAddress.toString(), // PDA configuration account
        walletAddress: walletAddress.toString(), // System Program owned account for receiving funds
        id: Array.from(swigId),
        transactionSignature: '', // Can't get original tx signature for existing wallet
        explorerUrl: `https://www.orbmarkets.io/account/${walletAddress.toString()}`,
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

    // Fetch the created Swig account to get the wallet address
    const swig = await fetchSwig(connection, swigAddress);
    const walletAddress = await getSwigWalletAddress(swig);

    return {
      address: swigAddress.toString(), // PDA configuration account
      walletAddress: walletAddress.toString(), // System Program owned account for receiving funds
      id: Array.from(swigId),
      transactionSignature: signature,
      explorerUrl: `https://www.orbmarkets.io/tx/${signature}`,
    };
  } catch (error: any) {
    // If error is "account already exists" (0x1), return existing wallet
    if (error?.transactionLogs?.some((log: string) => log.includes('custom program error: 0x1')) ||
        error?.message?.includes('custom program error: 0x1')) {
      // Wallet was created between our check and the transaction
      // Fetch the Swig account to get the wallet address
      const swig = await fetchSwig(connection, swigAddress);
      const walletAddress = await getSwigWalletAddress(swig);
      return {
        address: swigAddress.toString(), // PDA configuration account
        walletAddress: walletAddress.toString(), // System Program owned account for receiving funds
        id: Array.from(swigId),
        transactionSignature: '', // Transaction failed but wallet exists
        explorerUrl: `https://www.orbmarkets.io/account/${walletAddress.toString()}`,
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

  // Get the wallet address (System Program owned account for receiving funds)
  // Use getSwigSystemAddress to get the correct system program address
  const walletAddress = await getSwigSystemAddress(updatedSwig);

  return {
    address: swigAddress.toString(), // PDA configuration account
    walletAddress: walletAddress.toString(), // System Program owned account for receiving funds
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
    explorerUrl: `https://www.orbmarkets.io/tx/${signature}`,
  };
}

/**
 * Transfer SOL using Swig wallet
 * Supports both single signer and 2-of-2 multisig wallets
 */
export async function transferSOLWithSwig(
  evmPrivateKey: string,
  swigId: number[],
  recipient: string,
  amount: number, // in lamports
  network: Network,
  secondEvmPrivateKey?: string // Optional, for multisig
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

  // Check account version and get wallet address
  const accountVersion = (swig as any).accountVersion?.() || 'v1';
  
  // Get the wallet address (System Program owned for v2, PDA for v1)
  let fromAddress: PublicKey;
  if (accountVersion === 'v2') {
    fromAddress = await getSwigSystemAddress(swig);
    console.log(`Using v2 wallet address for transfer: ${fromAddress.toBase58()}`);
  } else {
    // For v1, use PDA (but this won't work for SPL tokens)
    fromAddress = swigAddress;
    console.warn(`Using v1 PDA for transfer (may not work for SPL tokens): ${fromAddress.toBase58()}`);
  }

  // Find the role for this EVM address
  const rootRole = swig.findRolesBySecp256k1SignerAddress(evmAccount.address)[0];
  if (!rootRole) {
    throw new Error('No role found for this authority');
  }

  // Check if multisig and verify second signer if provided
  const allRoles = swig.roles || [];
  const isMultisig = allRoles.length > 1;
  
  if (isMultisig && secondEvmPrivateKey) {
    const formattedSecondKey = secondEvmPrivateKey.startsWith('0x')
      ? secondEvmPrivateKey
      : `0x${secondEvmPrivateKey}`;
    const secondAccount = privateKeyToAccount(formattedSecondKey as `0x${string}`);
    const secondRole = swig.findRolesBySecp256k1SignerAddress(secondAccount.address)[0];
    if (!secondRole) {
      throw new Error('Second signer not found in multisig wallet. Please create multisig wallet first.');
    }
    console.log(`Multisig wallet detected: ${allRoles.length} signers, using both private keys`);
  } else if (isMultisig && !secondEvmPrivateKey) {
    console.warn(`Multisig wallet detected but second private key not provided. Transaction may fail if 2-of-2 multisig.`);
  }

  // Get fee payer
  const feePayer = getFeePayer(network);

  // Create signing function
  const privateKeyBytes = hexToBytes(formattedPrivateKey as `0x${string}`);
  const signingFn = getSigningFnForSecp256k1PrivateKey(privateKeyBytes);

  // Get current slot
  const currentSlot = await connection.getSlot('finalized');

  // Create transfer instruction using the correct from address
  const transferInstruction = SystemProgram.transfer({
    fromPubkey: fromAddress, // Use wallet address for v2, PDA for v1
    toPubkey: new PublicKey(recipient),
    lamports: amount,
  });

  // Get signing instructions (automatically uses sign_v2 for v2 accounts)
  // For multisig, getSignInstructions should handle collecting both signatures
  // if both signers are provided via the signing function
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
    explorerUrl: `https://www.orbmarkets.io/tx/${signature}`,
    amount,
    recipient,
  };
}

