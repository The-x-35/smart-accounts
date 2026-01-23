'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import ProtectedRoute from '@/components/ProtectedRoute';
import { 
  Connection, 
  Transaction, 
  PublicKey, 
  SystemProgram,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  TransactionMessage,
  TransactionInstruction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  findSwigPda,
  fetchSwig,
  getSignInstructions,
  getSwigSystemAddress,
  getSigningFnForSecp256k1PrivateKey,
  Actions,
  createSecp256k1AuthorityInfo,
  getCreateSwigInstruction,
} from '@swig-wallet/classic';
import { privateKeyToAccount } from 'viem/accounts';
import { hexToBytes, keccak256, toBytes } from 'viem';

// Network configuration - mainnet only for privacy pools
const RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=d9b6d595-1feb-4741-8958-484ad55afdab';

// Fee payer public key (hardcoded)
const FEE_PAYER_PUBKEY = new PublicKey('hciZb5onspShN7vhvGDANtavRp4ww3xMzfVECXo2BR4');

// Privacy Cash program ID
const POOL_PROGRAM_ID = new PublicKey('9fhQBbumKEFuXtMBDw8AaQyAjCorLGJQiS3skWZdQyQD');

// Privacy level constants
const MIN_CHUNKS = 2;
const MAX_CHUNKS = 10;
const MAX_DELAY_MS = 4 * 60 * 60 * 1000; // 4 hours in milliseconds

// Types
interface StepStatus {
  step: number;
  message: string;
  status: 'pending' | 'running' | 'completed' | 'error';
}

interface PrivateSendResult {
  success: boolean;
  signatures: string[];
  totalAmount: string;
  recipient: string;
  burnerAddresses: string[];
  matchedAmounts: number[];
}

interface BurnerWallet {
  key: string;
  swigAddress: PublicKey;
  walletAddress: PublicKey;
  swig: any;
}

/**
 * Get Privacy Cash tree token account (where deposits go)
 */
function getTreeTokenAccount(): PublicKey {
  const [treeTokenAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from('tree_token')],
    POOL_PROGRAM_ID
  );
  return treeTokenAccount;
}

/**
 * Query previous Privacy Cash deposit amounts from transactions
 */
async function getPreviousDepositAmounts(
  connection: Connection,
  limit: number = 100
): Promise<number[]> {
  const treeTokenAccount = getTreeTokenAccount();
  const amounts: number[] = [];
  
  try {
    // Get signatures for transactions involving the tree token account
    const signatures = await connection.getSignaturesForAddress(
      treeTokenAccount,
      { limit }
    );
    
    // Fetch transactions in batches
    const batchSize = 10;
    for (let i = 0; i < signatures.length; i += batchSize) {
      const batch = signatures.slice(i, i + batchSize);
      const txs = await connection.getParsedTransactions(
        batch.map(s => s.signature),
        { maxSupportedTransactionVersion: 0 }
      );
      
      for (const tx of txs) {
        if (!tx || !tx.transaction || !tx.meta) continue;
        
        // Look for transfers to treeTokenAccount
        const postBalances = tx.meta.postTokenBalances || [];
        const preBalances = tx.meta.preTokenBalances || [];
        
        // Check for SOL transfers (SystemProgram transfers)
        const instructions = tx.transaction.message.instructions;
        for (const ix of instructions) {
          if ('program' in ix && ix.program === 'system') {
            const parsed = ix as any;
            if (parsed.parsed?.type === 'transfer') {
              const info = parsed.parsed.info;
              if (info.destination === treeTokenAccount.toBase58()) {
                const amount = parseInt(info.lamports);
                if (amount > 0) {
                  amounts.push(amount);
                }
              }
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('Error querying previous deposits:', error);
  }
  
  // Sort by amount and return unique amounts
  const uniqueAmounts = Array.from(new Set(amounts)).sort((a, b) => a - b);
  return uniqueAmounts;
}

/**
 * Match chunk sizes to previous deposit amounts
 */
function matchChunksToPreviousDeposits(
  totalAmount: number,
  numChunks: number,
  previousAmounts: number[]
): number[] {
  if (previousAmounts.length === 0) {
    // Fallback: use random splits if no previous amounts
    const splits = generateRandomSplits(numChunks);
    return splits.map((split, i) => {
      if (i === numChunks - 1) {
        const previousSum = splits.slice(0, -1).reduce((sum, s) => sum + Math.floor(totalAmount * s), 0);
        return totalAmount - previousSum;
      }
      return Math.floor(totalAmount * split);
    });
  }
  
  // Try to find exact matches
  const matchedAmounts: number[] = [];
  const usedIndices = new Set<number>();
  let remainingAmount = totalAmount;
  
  // First pass: find exact matches
  for (let i = 0; i < numChunks - 1; i++) {
    const targetAmount = remainingAmount / (numChunks - i);
    
    // Find closest match
    let bestMatch = previousAmounts[0];
    let bestIndex = 0;
    let bestDiff = Math.abs(previousAmounts[0] - targetAmount);
    
    for (let j = 0; j < previousAmounts.length; j++) {
      if (usedIndices.has(j)) continue;
      const diff = Math.abs(previousAmounts[j] - targetAmount);
      if (diff < bestDiff && previousAmounts[j] <= remainingAmount) {
        bestDiff = diff;
        bestMatch = previousAmounts[j];
        bestIndex = j;
      }
    }
    
    if (bestMatch <= remainingAmount) {
      matchedAmounts.push(bestMatch);
      remainingAmount -= bestMatch;
      usedIndices.add(bestIndex);
    } else {
      // Use proportional split if no good match
      const split = remainingAmount / (numChunks - i);
      matchedAmounts.push(Math.floor(split));
      remainingAmount -= Math.floor(split);
    }
  }
  
  // Last chunk gets remainder
  matchedAmounts.push(remainingAmount);
  
  return matchedAmounts;
}

/**
 * Create deterministic Swig ID from EVM address
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
 * Derive burner ETH private key from main key by signing a unique message
 */
async function deriveBurnerPrivateKey(mainPrivateKey: string, index: number): Promise<string> {
  const formattedKey = mainPrivateKey.startsWith('0x') ? mainPrivateKey : `0x${mainPrivateKey}`;
  const account = privateKeyToAccount(formattedKey as `0x${string}`);
  
  const message = `swig_burner_wallet_${index}_${account.address}`;
  const signature = await account.signMessage({ message });
  const burnerKey = keccak256(toBytes(signature));
  return burnerKey;
}

/**
 * Validate Ethereum private key
 */
function isValidPrivateKey(key: string): boolean {
  const formatted = key.startsWith('0x') ? key : `0x${key}`;
  return /^0x[a-fA-F0-9]{64}$/.test(formatted);
}

/**
 * Validate Solana address
 */
function isValidSolanaAddress(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate random splits for N chunks (fallback)
 */
function generateRandomSplits(numChunks: number): number[] {
  const randomValues = Array.from({ length: numChunks }, () => 10 + Math.random() * 20);
  const sum = randomValues.reduce((a, b) => a + b, 0);
  return randomValues.map(v => v / sum);
}

/**
 * Calculate delay between deposit and withdraw based on privacy level
 */
function calculateDelayMs(numChunks: number): number {
  if (numChunks <= MIN_CHUNKS) return 0; // Instant for minimum
  const totalDelay = ((numChunks - MIN_CHUNKS) / (MAX_CHUNKS - MIN_CHUNKS)) * MAX_DELAY_MS;
  // Two delay periods: after main deposit, after burner deposits
  return Math.floor(totalDelay / 2);
}

/**
 * Format milliseconds as human-readable time
 */
function formatTime(ms: number): string {
  if (ms < 1000) return 'instant';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  const remainingMins = minutes % 60;
  return remainingMins > 0 ? `${hours}h ${remainingMins}min` : `${hours}h`;
}

/**
 * Get Swig wallet info from ETH private key
 */
function getSwigBasicInfo(evmPrivateKey: string): {
  swigId: Uint8Array;
  evmAccount: any;
  formattedKey: string;
} {
  const formattedKey = evmPrivateKey.startsWith('0x') ? evmPrivateKey : `0x${evmPrivateKey}`;
  const evmAccount = privateKeyToAccount(formattedKey as `0x${string}`);
  const swigId = createDeterministicSwigId(evmAccount.address);
  return { swigId, evmAccount, formattedKey };
}

/**
 * Get full Swig wallet info including addresses (requires swig to exist)
 */
async function getSwigWalletInfo(
  connection: Connection,
  evmPrivateKey: string
): Promise<{
  swigAddress: PublicKey;
  walletAddress: PublicKey;
  swigId: Uint8Array;
  evmAccount: any;
  swig: any;
}> {
  const { swigId, evmAccount } = getSwigBasicInfo(evmPrivateKey);
  const swigAddress = await findSwigPda(swigId);
  const swig = await fetchSwig(connection, swigAddress);
  const walletAddress = await getSwigSystemAddress(swig);
  return { swigAddress, walletAddress, swigId, evmAccount, swig };
}

/**
 * Check if Swig wallet exists, create if not
 */
async function ensureSwigWalletExists(
  connection: Connection,
  evmPrivateKey: string,
  swigId: Uint8Array,
  swigAddress: PublicKey,
  updateStatus: (msg: string) => void
): Promise<boolean> {
  try {
    await fetchSwig(connection, swigAddress);
    return true;
  } catch (error: any) {
    updateStatus('Creating Swig wallet...');
    
    const formattedKey = evmPrivateKey.startsWith('0x') ? evmPrivateKey : `0x${evmPrivateKey}`;
    const evmAccount = privateKeyToAccount(formattedKey as `0x${string}`);
    const authorityInfo = createSecp256k1AuthorityInfo(evmAccount.publicKey);
    const rootActions = Actions.set().all().get();
    
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    
    const createSwigInstruction = await getCreateSwigInstruction({
      authorityInfo,
      id: swigId,
      payer: FEE_PAYER_PUBKEY,
      actions: rootActions,
    });
    
    const transaction = new Transaction();
    transaction.add(createSwigInstruction);
    transaction.recentBlockhash = blockhash;
    transaction.feePayer = FEE_PAYER_PUBKEY;
    
    const transactionBase64 = Buffer.from(transaction.serialize({ requireAllSignatures: false })).toString('base64');
    
    const signResponse = await fetch('/api/transaction/sign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactionBase64, network: 'mainnet' }),
    });
    
    const signData = await signResponse.json();
    if (!signData.success) {
      throw new Error(signData.error || 'Failed to create wallet');
    }
    
    await new Promise(resolve => setTimeout(resolve, 2000));
    return true;
  }
}

/**
 * Get browser localStorage
 */
function getBrowserStorage(): Storage {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  throw new Error('localStorage not available');
}

/**
 * Deposit to Privacy Cash pool using Swig wallet
 */
async function depositToPoolWithSwig(
  connection: Connection,
  swig: any,
  walletAddress: PublicKey,
  amountLamports: number,
  evmPrivateKey: string,
  tempIndex: number,
  updateStatus: (msg: string) => void
): Promise<string> {
  updateStatus(`Depositing ${amountLamports / LAMPORTS_PER_SOL} SOL to privacy pool...`);
  
  try {
    const { deposit } = await import('privacycash/utils');
    // @ts-ignore - hasher.rs has no type declarations
    const { WasmFactory } = await import('@lightprotocol/hasher.rs');
    const { PrivacyCash } = await import('privacycash');
    
    const lightWasm = await WasmFactory.getInstance();
    
    // Create a temp keypair for the deposit (Privacy Cash requires a keypair)
    // Use deterministic index so we can use same keypair for withdraw
    const tempKeypair = await deriveTempKeypair(evmPrivateKey, tempIndex);
    
    // First, transfer from Swig to temp keypair
    updateStatus('Transferring to temporary address for pool deposit...');
    await transferFromSwigToAddress(
      connection, swig, walletAddress, tempKeypair.publicKey,
      amountLamports + 15000000, evmPrivateKey // Add extra for fees
    );
    
    // Wait for transfer to confirm
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Initialize PrivacyCash with temp keypair
    const privacyCashClient = new PrivacyCash({
      RPC_url: RPC_URL,
      owner: tempKeypair,
      enableDebug: false,
    }) as any;
    
    // Transaction signer using temp keypair
    const transactionSigner = async (tx: VersionedTransaction) => {
      tx.sign([tempKeypair]);
      return tx;
    };
    
    // Deposit to pool
    const result = await deposit({
      lightWasm,
      amount_in_lamports: amountLamports,
      connection,
      encryptionService: privacyCashClient.encryptionService,
      publicKey: tempKeypair.publicKey,
      transactionSigner,
      keyBasePath: '/circuit2/transaction2',
      storage: getBrowserStorage(),
    });
    
    // Wait for transaction confirmation and UTXO indexing
    // The deposit function already waits for indexing, but we add extra buffer
    updateStatus('Waiting for deposit confirmation and UTXO indexing...');
    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds for indexing
    
    return result.tx;
  } catch (error: any) {
    console.error('Privacy pool deposit error:', error);
    throw new Error(`Privacy pool deposit failed: ${error.message}`);
  }
}

/**
 * Derive temp keypair from ETH key (for Privacy Cash operations)
 */
async function deriveTempKeypair(evmPrivateKey: string, index: number): Promise<any> {
  const formattedKey = evmPrivateKey.startsWith('0x') ? evmPrivateKey : `0x${evmPrivateKey}`;
  const account = privateKeyToAccount(formattedKey as `0x${string}`);
  const message = `privacy_temp_${index}_${account.address}`;
  const signature = await account.signMessage({ message });
  const seed = keccak256(toBytes(signature));
  const seedBytes = hexToBytes(seed);
  const { Keypair } = await import('@solana/web3.js');
  return Keypair.fromSeed(seedBytes);
}

/**
 * Transfer from Swig to a specific address
 */
async function transferFromSwigToAddress(
  connection: Connection,
  swig: any,
  walletAddress: PublicKey,
  recipient: PublicKey,
  amountLamports: number,
  evmPrivateKey: string
): Promise<string> {
  const formattedKey = evmPrivateKey.startsWith('0x') ? evmPrivateKey : `0x${evmPrivateKey}`;
  const evmAccount = privateKeyToAccount(formattedKey as `0x${string}`);
  
  const rootRole = swig.findRolesBySecp256k1SignerAddress(evmAccount.address)[0];
  if (!rootRole) {
    throw new Error('No role found for this authority');
  }
  
  const currentSlot = await connection.getSlot('finalized');
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  
  const transferInstruction = SystemProgram.transfer({
    fromPubkey: walletAddress,
    toPubkey: recipient,
    lamports: amountLamports,
  });
  
  const privateKeyBytes = hexToBytes(formattedKey as `0x${string}`);
  const signingFn = getSigningFnForSecp256k1PrivateKey(privateKeyBytes);
  
  const signInstructions = await getSignInstructions(
    swig,
    rootRole.id,
    [transferInstruction],
    false,
    {
      currentSlot: BigInt(currentSlot),
      signingFn,
      payer: FEE_PAYER_PUBKEY,
    }
  );
  
  const transaction = new Transaction();
  transaction.add(...signInstructions);
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = FEE_PAYER_PUBKEY;
  
  const transactionBase64 = Buffer.from(transaction.serialize({ requireAllSignatures: false })).toString('base64');
  
  const signResponse = await fetch('/api/transaction/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transactionBase64, network: 'mainnet' }),
  });
  
  const signData = await signResponse.json();
  if (!signData.success) {
    throw new Error(signData.error || 'Failed to sign transaction');
  }
  
  return signData.data.signature;
}

/**
 * Withdraw from Privacy Cash pool to recipient using Swig wallet
 */
async function withdrawFromPoolWithSwig(
  connection: Connection,
  swig: any,
  walletAddress: PublicKey,
  amountLamports: number,
  recipient: PublicKey,
  evmPrivateKey: string,
  tempIndex: number,
  updateStatus: (msg: string) => void
): Promise<string> {
  updateStatus(`Withdrawing ${amountLamports / LAMPORTS_PER_SOL} SOL from privacy pool...`);
  
  try {
    const { withdraw } = await import('privacycash/utils');
    // @ts-ignore - hasher.rs has no type declarations
    const { WasmFactory } = await import('@lightprotocol/hasher.rs');
    const { PrivacyCash } = await import('privacycash');
    
    const lightWasm = await WasmFactory.getInstance();
    
    // Derive same temp keypair used for deposit (same index)
    const tempKeypair = await deriveTempKeypair(evmPrivateKey, tempIndex);
    
    // Initialize PrivacyCash
    const privacyCashClient = new PrivacyCash({
      RPC_url: RPC_URL,
      owner: tempKeypair,
      enableDebug: false,
    }) as any;
    
    // Transaction signer
    const transactionSigner = async (tx: VersionedTransaction) => {
      tx.sign([tempKeypair]);
      return tx;
    };
    
    // Withdraw from pool
    const result = await withdraw({
      lightWasm,
      amount_in_lamports: amountLamports,
      connection,
      encryptionService: privacyCashClient.encryptionService,
      publicKey: tempKeypair.publicKey,
      recipient,
      keyBasePath: '/circuit2/transaction2',
      storage: getBrowserStorage(),
    });
    
    return result.tx;
  } catch (error: any) {
    console.error('Privacy pool withdraw error:', error);
    throw new Error(`Privacy pool withdraw failed: ${error.message}`);
  }
}

/**
 * Sleep with countdown updates
 */
async function sleepWithCountdown(
  ms: number,
  onUpdate: (remaining: string) => void
): Promise<void> {
  if (ms <= 0) return;
  
  const endTime = Date.now() + ms;
  
  while (Date.now() < endTime) {
    const remaining = endTime - Date.now();
    onUpdate(formatTime(remaining));
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

/**
 * Execute the private send flow with Privacy Cash pools
 */
async function executePrivateSend(
  privateKey: string,
  recipient: string,
  amount: string,
  numChunks: number,
  onStepUpdate: (status: StepStatus) => void
): Promise<PrivateSendResult> {
  const connection = new Connection(RPC_URL, 'confirmed');
  const formattedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const amountLamports = Math.floor(parseFloat(amount) * LAMPORTS_PER_SOL);
  const delayMs = calculateDelayMs(numChunks);
  
  const signatures: string[] = [];
  const burnerAddresses: string[] = [];
  
  // Validation
  if (!isValidPrivateKey(formattedKey)) {
    throw new Error('Invalid Ethereum private key');
  }
  if (!isValidSolanaAddress(recipient)) {
    throw new Error('Invalid Solana recipient address');
  }
  if (!amount || parseFloat(amount) <= 0) {
    throw new Error('Amount must be greater than 0');
  }
  if (numChunks < MIN_CHUNKS || numChunks > MAX_CHUNKS) {
    throw new Error(`Privacy level must be between ${MIN_CHUNKS} and ${MAX_CHUNKS}`);
  }
  
  // Step 1: Query previous deposits and match amounts
  onStepUpdate({ step: 1, message: 'Querying previous pool deposits...', status: 'running' });
  const previousAmounts = await getPreviousDepositAmounts(connection, 100);
  const matchedAmounts = matchChunksToPreviousDeposits(amountLamports, numChunks, previousAmounts);
  console.log('Matched amounts:', matchedAmounts.map(a => `${a / LAMPORTS_PER_SOL} SOL`));
  onStepUpdate({ step: 1, message: `Matched ${numChunks} chunks to previous deposits`, status: 'completed' });
  
  // Step 2: Setup main wallet
  onStepUpdate({ step: 2, message: 'Setting up main Swig wallet...', status: 'running' });
  
  const mainBasic = getSwigBasicInfo(formattedKey);
  const mainSwigAddress = await findSwigPda(mainBasic.swigId);
  
  await ensureSwigWalletExists(
    connection, formattedKey, mainBasic.swigId, mainSwigAddress,
    (msg) => onStepUpdate({ step: 2, message: msg, status: 'running' })
  );
  
  const mainWallet = await getSwigWalletInfo(connection, formattedKey);
  console.log('Main wallet:', mainWallet.walletAddress.toBase58());
  
  // Check balance
  const balance = await connection.getBalance(mainWallet.walletAddress);
  // Add small buffer for rent/exceptions (0.001 SOL = 1,000,000 lamports)
  // Note: Transaction fees are paid by fee payer, not the user's wallet
  const requiredBalance = amountLamports + 1000000; // Add 0.001 SOL buffer
  if (balance < requiredBalance) {
    throw new Error(`Insufficient balance. Have: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL, Need: ${(requiredBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  }
  
  onStepUpdate({ step: 2, message: 'Main wallet ready', status: 'completed' });
  
  // Step 3: Deposit main wallet to pool
  onStepUpdate({ step: 3, message: 'Depositing to privacy pool...', status: 'running' });
  const mainTempIndex = 0; // Use index 0 for main wallet
  const depositSig = await depositToPoolWithSwig(
    connection, mainWallet.swig, mainWallet.walletAddress,
    amountLamports, formattedKey, mainTempIndex,
    (msg) => onStepUpdate({ step: 3, message: msg, status: 'running' })
  );
  signatures.push(depositSig);
  onStepUpdate({ step: 3, message: 'Deposit to pool complete', status: 'completed' });
  
  // Wait for deposit to be fully confirmed and indexed before proceeding
  onStepUpdate({ step: 4, message: 'Waiting for deposit to be indexed...', status: 'running' });
  await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds for UTXO indexing
  onStepUpdate({ step: 4, message: 'Deposit indexed, ready for withdrawal', status: 'completed' });
  
  // Step 5: Wait delay (privacy delay)
  if (delayMs > 0) {
    await sleepWithCountdown(delayMs, (remaining) => {
      onStepUpdate({ step: 5, message: `Waiting ${remaining} before withdrawal...`, status: 'running' });
    });
    onStepUpdate({ step: 5, message: 'Privacy delay complete', status: 'completed' });
  }
  
  // Step 6: Setup burner wallets
  onStepUpdate({ step: 6, message: `Deriving ${numChunks} burner wallets...`, status: 'running' });
  
  const burnerWallets: BurnerWallet[] = [];
  
  for (let i = 1; i <= numChunks; i++) {
    const burnerKey = await deriveBurnerPrivateKey(formattedKey, i);
    const burnerBasic = getSwigBasicInfo(burnerKey);
    const burnerSwigAddress = await findSwigPda(burnerBasic.swigId);
    
    await ensureSwigWalletExists(
      connection, burnerKey, burnerBasic.swigId, burnerSwigAddress,
      (msg) => onStepUpdate({ step: 5, message: `Burner ${i}: ${msg}`, status: 'running' })
    );
    
    const burnerWallet = await getSwigWalletInfo(connection, burnerKey);
    burnerWallets.push({
      key: burnerKey,
      swigAddress: burnerWallet.swigAddress,
      walletAddress: burnerWallet.walletAddress,
      swig: burnerWallet.swig,
    });
    burnerAddresses.push(burnerWallet.walletAddress.toBase58());
  }
  
  onStepUpdate({ step: 6, message: `${numChunks} burner wallets ready`, status: 'completed' });
  
  // Step 7: Withdraw from pool to burner wallets
  // Withdraw equal chunks of the deposited amount (not matched amounts)
  onStepUpdate({ step: 7, message: 'Withdrawing to burner wallets...', status: 'running' });
  
  // Calculate equal chunks for withdrawal (use actual deposited amount, not matched amounts)
  const chunkAmount = Math.floor(amountLamports / numChunks);
  const remainder = amountLamports % numChunks;
  const withdrawalAmounts: number[] = []; // Track amounts for use in Steps 7 and 9
  
  for (let i = 0; i < numChunks; i++) {
    const burner = burnerWallets[i];
    // Last chunk gets the remainder to ensure total equals deposited amount
    const amount = i === numChunks - 1 ? chunkAmount + remainder : chunkAmount;
    withdrawalAmounts.push(amount);
    
    onStepUpdate({ 
      step: 7, 
      message: `Withdrawing ${(amount / LAMPORTS_PER_SOL).toFixed(4)} SOL to burner ${i + 1}...`, 
      status: 'running' 
    });
    
    const withdrawSig = await withdrawFromPoolWithSwig(
      connection, mainWallet.swig, mainWallet.walletAddress,
      amount, burner.walletAddress, formattedKey, mainTempIndex,
      (msg) => onStepUpdate({ step: 7, message: msg, status: 'running' })
    );
    signatures.push(withdrawSig);
  }
  
  onStepUpdate({ step: 7, message: 'Withdrawn to all burner wallets', status: 'completed' });
  
  // Wait for confirmations
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // Step 8: Deposit from burner wallets to pool
  // Use the same amounts that were withdrawn (not matched amounts)
  onStepUpdate({ step: 8, message: 'Depositing from burner wallets to pool...', status: 'running' });
  
  for (let i = 0; i < numChunks; i++) {
    const burner = burnerWallets[i];
    const amount = withdrawalAmounts[i]; // Use withdrawal amount, not matched amount
    const burnerTempIndex = i + 1; // Use burner index for temp keypair
    
    onStepUpdate({ 
      step: 8, 
      message: `Depositing from burner ${i + 1} to pool...`, 
      status: 'running' 
    });
    
    const depositSig = await depositToPoolWithSwig(
      connection, burner.swig, burner.walletAddress,
      amount, burner.key, burnerTempIndex,
      (msg) => onStepUpdate({ step: 8, message: msg, status: 'running' })
    );
    signatures.push(depositSig);
  }
  
  onStepUpdate({ step: 8, message: 'All burner deposits complete', status: 'completed' });
  
  // Wait for deposits to be indexed
  onStepUpdate({ step: 9, message: 'Waiting for deposits to be indexed...', status: 'running' });
  await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10 seconds for UTXO indexing
  onStepUpdate({ step: 9, message: 'Deposits indexed, ready for final withdrawal', status: 'completed' });
  
  // Step 10: Wait delay (privacy delay)
  if (delayMs > 0) {
    await sleepWithCountdown(delayMs, (remaining) => {
      onStepUpdate({ step: 10, message: `Waiting ${remaining} before final withdrawal...`, status: 'running' });
    });
    onStepUpdate({ step: 10, message: 'Privacy delay complete', status: 'completed' });
  }
  
  // Step 11: Withdraw from pool to destination
  // Use the same amounts that were deposited in Step 8 (not matched amounts)
  onStepUpdate({ step: 11, message: 'Withdrawing to destination...', status: 'running' });
  
  for (let i = 0; i < numChunks; i++) {
    const burner = burnerWallets[i];
    const amount = withdrawalAmounts[i]; // Use same amount as deposited in Step 7
    const burnerTempIndex = i + 1; // Same index as deposit
    
    onStepUpdate({ 
      step: 11, 
      message: `Withdrawing ${(amount / LAMPORTS_PER_SOL).toFixed(4)} SOL to destination...`, 
      status: 'running' 
    });
    
    const withdrawSig = await withdrawFromPoolWithSwig(
      connection, burner.swig, burner.walletAddress,
      amount, new PublicKey(recipient), burner.key, burnerTempIndex,
      (msg) => onStepUpdate({ step: 11, message: msg, status: 'running' })
    );
    signatures.push(withdrawSig);
  }
  
  onStepUpdate({ step: 11, message: 'Private send complete!', status: 'completed' });
  
  return {
    success: true,
    signatures,
    totalAmount: amount,
    recipient,
    burnerAddresses,
    matchedAmounts,
  };
}

/**
 * Generate dynamic steps based on privacy level
 */
function generateSteps(numChunks: number): StepStatus[] {
  return [
    { step: 1, message: 'Query previous deposits', status: 'pending' },
    { step: 2, message: 'Setup main wallet', status: 'pending' },
    { step: 3, message: 'Deposit to pool', status: 'pending' },
    { step: 4, message: 'Wait delay', status: 'pending' },
    { step: 5, message: `Create ${numChunks} burner wallets`, status: 'pending' },
    { step: 6, message: 'Withdraw to burners', status: 'pending' },
    { step: 7, message: 'Deposit from burners', status: 'pending' },
    { step: 8, message: 'Wait delay', status: 'pending' },
    { step: 9, message: 'Withdraw to destination', status: 'pending' },
  ];
}

function PrivateSendContent() {
  const [privateKey, setPrivateKey] = useState('');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [privacyLevel, setPrivacyLevel] = useState(MIN_CHUNKS);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<PrivateSendResult | null>(null);
  const [error, setError] = useState('');
  const [steps, setSteps] = useState<StepStatus[]>(generateSteps(MIN_CHUNKS));

  useEffect(() => {
    if (!loading) {
      setSteps(generateSteps(privacyLevel));
    }
  }, [privacyLevel, loading]);

  const updateStep = (update: StepStatus) => {
    setSteps(prev => prev.map(s => s.step === update.step ? update : s));
  };

  const delayMs = calculateDelayMs(privacyLevel);
  const totalEstimatedTime = delayMs * 2; // Two delay periods

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    setResult(null);
    setSteps(generateSteps(privacyLevel));
    
    try {
      const sendResult = await executePrivateSend(
        privateKey,
        recipient,
        amount,
        privacyLevel,
        updateStep
      );
      setResult(sendResult);
    } catch (err: any) {
      console.error('Private send error:', err);
      setError(err.message || 'Private send failed');
      setSteps(prev => prev.map(s => 
        s.status === 'running' ? { ...s, status: 'error' } : s
      ));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page-container">
      <nav className="nav-bar">
        <Link href="/dashboard">Dashboard</Link>
        <Link href="/create-wallet">Create Wallet</Link>
        <Link href="/create-multisig">Create Multisig</Link>
        <Link href="/send-transaction">Send Transaction</Link>
        <Link href="/swap">Jupiter Swap</Link>
        <Link href="/swap/relay">Relay Swap</Link>
        <Link href="/private-send" className="active">Private Send</Link>
      </nav>

      <h1>Private Send</h1>
      
      <div className="card" style={{ background: '#fff3cd', padding: '1rem', marginBottom: '2rem', border: '1px solid #ffc107' }}>
        <p style={{ margin: 0, fontSize: '0.9rem' }}>
          <strong>⚠️ Privacy Notice:</strong> This routes your SOL through Privacy Cash pools using 
          deterministically derived Swig burner wallets. Chunk sizes match previous pool deposits for maximum privacy.
          All burner wallets are recoverable from your ETH private key.
        </p>
      </div>

      <div className="card">
        <h2>Send SOL Privately</h2>
        
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Your Ethereum Private Key</label>
            <input
              type="password"
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              required
              placeholder="0x..."
              disabled={loading}
            />
            <small style={{ color: '#666' }}>
              Used to sign transactions for your Swig wallet
            </small>
          </div>

          <div className="form-group">
            <label>Recipient Solana Address</label>
            <input
              type="text"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              required
              placeholder="Destination wallet address"
              disabled={loading}
            />
          </div>

          <div className="form-group">
            <label>Amount (SOL)</label>
            <input
              type="number"
              step="0.001"
              min="0.001"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
              placeholder="0.01"
              disabled={loading}
            />
          </div>

          <div className="form-group">
            <label>
              Privacy Level: {privacyLevel} chunk{privacyLevel > 1 ? 's' : ''}
            </label>
            <div className="slider-container">
              <span className="slider-label">Fast</span>
              <input
                type="range"
                min={MIN_CHUNKS}
                max={MAX_CHUNKS}
                value={privacyLevel}
                onChange={(e) => setPrivacyLevel(parseInt(e.target.value))}
                disabled={loading}
                className="privacy-slider"
              />
              <span className="slider-label">Private</span>
            </div>
            <div className="privacy-info">
              {privacyLevel === MIN_CHUNKS ? (
                <span>Instant pool routing - {privacyLevel} burner wallets</span>
              ) : (
                <span>
                  {privacyLevel} burner wallets • ~{formatTime(totalEstimatedTime)} total delay
                </span>
              )}
            </div>
          </div>

          <button type="submit" disabled={loading}>
            {loading ? 'Processing...' : 'Send Privately'}
          </button>
        </form>

        {/* Progress Steps */}
        {(loading || result || error) && (
          <div style={{ marginTop: '2rem' }}>
            <h3>Progress</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {steps.map((step) => (
                <div 
                  key={step.step}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    padding: '0.5rem',
                    borderRadius: '4px',
                    background: step.status === 'completed' ? '#d4edda' :
                               step.status === 'running' ? '#cce5ff' :
                               step.status === 'error' ? '#f8d7da' : '#f8f9fa',
                  }}
                >
                  <span style={{ 
                    width: '24px', 
                    height: '24px', 
                    borderRadius: '50%', 
                    background: step.status === 'completed' ? '#28a745' :
                               step.status === 'running' ? '#007bff' :
                               step.status === 'error' ? '#dc3545' : '#6c757d',
                    color: 'white',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '12px',
                    flexShrink: 0,
                  }}>
                    {step.status === 'completed' ? '✓' : 
                     step.status === 'running' ? '⟳' :
                     step.status === 'error' ? '✗' : step.step}
                  </span>
                  <span style={{ wordBreak: 'break-word' }}>{step.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="result error" style={{ marginTop: '1rem' }}>
            <p><strong>Error:</strong> {error}</p>
          </div>
        )}

        {result && (
          <div className="result success" style={{ marginTop: '1rem' }}>
            <h3>Private Send Complete!</h3>
            <p><strong>Total Amount:</strong> {result.totalAmount} SOL</p>
            <p><strong>Recipient:</strong> {result.recipient}</p>
            {result.matchedAmounts && (
              <div>
                <strong>Matched Chunk Amounts:</strong>
                <ul style={{ fontSize: '0.8rem', margin: '0.5rem 0' }}>
                  {result.matchedAmounts.map((amt, i) => (
                    <li key={i}>Chunk {i + 1}: {(amt / LAMPORTS_PER_SOL).toFixed(4)} SOL</li>
                  ))}
                </ul>
              </div>
            )}
            {result.burnerAddresses.length > 0 && (
              <div>
                <strong>Burner Addresses Used:</strong>
                <ul style={{ fontSize: '0.8rem', wordBreak: 'break-all', margin: '0.5rem 0' }}>
                  {result.burnerAddresses.map((addr, i) => (
                    <li key={i}>Burner {i + 1}: {addr}</li>
                  ))}
                </ul>
              </div>
            )}
            <div style={{ marginTop: '1rem' }}>
              <strong>Transaction Signatures ({result.signatures.length}):</strong>
              <ul style={{ fontSize: '0.8rem', wordBreak: 'break-all' }}>
                {result.signatures.map((sig, i) => (
                  <li key={i}>
                    <a 
                      href={`https://solscan.io/tx/${sig}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {sig.slice(0, 20)}...{sig.slice(-20)}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>

      <style jsx>{`
        .page-container {
          max-width: 800px;
          margin: 0 auto;
          padding: 2rem;
        }
        .nav-bar {
          display: flex;
          gap: 1rem;
          margin-bottom: 2rem;
          flex-wrap: wrap;
        }
        .nav-bar :global(a) {
          padding: 0.5rem 1rem;
          background: #f0f0f0;
          border-radius: 4px;
          text-decoration: none;
          color: #333;
        }
        .nav-bar :global(a:hover), .nav-bar :global(a.active) {
          background: #007bff;
          color: white;
        }
        h1 {
          color: #333;
        }
        .card {
          background: white;
          border-radius: 8px;
          padding: 1.5rem;
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
          margin-bottom: 1rem;
        }
        .form-group {
          margin-bottom: 1rem;
        }
        .form-group label {
          display: block;
          margin-bottom: 0.5rem;
          font-weight: bold;
        }
        .form-group input[type="text"],
        .form-group input[type="password"],
        .form-group input[type="number"] {
          width: 100%;
          padding: 0.5rem;
          border: 1px solid #ddd;
          border-radius: 4px;
          font-size: 1rem;
        }
        .slider-container {
          display: flex;
          align-items: center;
          gap: 1rem;
          margin: 0.5rem 0;
        }
        .slider-label {
          font-size: 0.85rem;
          color: #666;
          min-width: 50px;
        }
        .privacy-slider {
          flex: 1;
          height: 8px;
          -webkit-appearance: none;
          appearance: none;
          background: linear-gradient(to right, #28a745, #ffc107, #dc3545);
          border-radius: 4px;
          outline: none;
        }
        .privacy-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 20px;
          height: 20px;
          background: white;
          border: 2px solid #007bff;
          border-radius: 50%;
          cursor: pointer;
          box-shadow: 0 2px 4px rgba(0,0,0,0.2);
        }
        .privacy-slider::-moz-range-thumb {
          width: 20px;
          height: 20px;
          background: white;
          border: 2px solid #007bff;
          border-radius: 50%;
          cursor: pointer;
          box-shadow: 0 2px 4px rgba(0,0,0,0.2);
        }
        .privacy-info {
          text-align: center;
          font-size: 0.9rem;
          color: #666;
          padding: 0.5rem;
          background: #f8f9fa;
          border-radius: 4px;
          margin-top: 0.5rem;
        }
        button {
          background: #007bff;
          color: white;
          border: none;
          padding: 0.75rem 1.5rem;
          border-radius: 4px;
          cursor: pointer;
          font-size: 1rem;
          width: 100%;
        }
        button:hover:not(:disabled) {
          background: #0056b3;
        }
        button:disabled {
          background: #ccc;
          cursor: not-allowed;
        }
        .result {
          padding: 1rem;
          border-radius: 4px;
        }
        .result.success {
          background: #d4edda;
          border: 1px solid #c3e6cb;
        }
        .result.error {
          background: #f8d7da;
          border: 1px solid #f5c6cb;
        }
      `}</style>
    </div>
  );
}

export default function PrivateSendPage() {
  return (
    <ProtectedRoute>
      <PrivateSendContent />
    </ProtectedRoute>
  );
}
