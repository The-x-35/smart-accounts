import {
  Connection,
  TransactionInstruction,
  VersionedTransaction,
  TransactionMessage,
  PublicKey,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  SystemProgram,
} from '@solana/web3.js';
import {
  findSwigPda,
  fetchSwig,
  getSignInstructions,
  getSigningFnForSecp256k1PrivateKey,
  getSwigWalletAddress, // Auto-detects v1/v2 and returns correct address (like demo)
  SWIG_PROGRAM_ADDRESS,
} from '@swig-wallet/classic';
// Try to import internal functions for manual instruction construction
let getSignInstructionContext: any;
let getInstructionsFromContext: any;
try {
  // These might not be exported, but we'll try
  const swigLib = require('@swig-wallet/lib');
  getSignInstructionContext = swigLib.getSignInstructionContext;
  getInstructionsFromContext = swigLib.getInstructionsFromContext;
} catch (e) {
  // If not available, we'll use a different approach
  console.warn('Could not import internal Swig SDK functions, will use alternative approach');
}
import { createJupiterApiClient } from '@jup-ag/api';
import { privateKeyToAccount } from 'viem/accounts';
import { hexToBytes } from 'viem';
import { Network } from '@/types/api';
import { getSolanaRpc } from '@/lib/config/networks';
import { getFeePayer } from '@/lib/config/fee-payers';
import { resolveTokenParam } from '@/lib/utils/token-resolver';
import { Transaction, sendAndConfirmTransaction } from '@solana/web3.js';

export interface SwapResult {
  transactionSignature: string;
  explorerUrl: string;
  inputAmount: number;
  outputAmount: number;
  inputToken: string;
  outputToken: string;
  timestamp: string;
}

/**
 * Helper function to convert Jupiter instruction format to TransactionInstruction
 */
function toTransactionInstruction(instruction: any): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programId),
    keys: instruction.accounts.map((k: any) => ({
      pubkey: new PublicKey(k.pubkey),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: Buffer.from(instruction.data, 'base64'),
  });
}

/**
 * Helper function to convert Relay instruction format to TransactionInstruction
 */
function relayInstructionToTransactionInstruction(instruction: any): TransactionInstruction {
  // Relay instructions have data as hex string, need to convert
  const dataHex = instruction.data.startsWith('0x') ? instruction.data.slice(2) : instruction.data;
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programId),
    keys: instruction.keys.map((k: any) => ({
      pubkey: new PublicKey(k.pubkey),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: Buffer.from(dataHex, 'hex'),
  });
}

/**
 * Attempt to manually construct a single sign instruction with both signatures for multisig
 * This is experimental and may not work if the Swig program's instruction format is different
 * 
 * WARNING: This is a best-effort attempt without knowing the exact Swig instruction format.
 * The Swig program might require a specific format that we don't have access to.
 */
async function constructCombinedMultisigSignInstruction(
  swig: any,
  rootRole: any,
  secondRole: any,
  swapInstructions: TransactionInstruction[],
  rootSigningFn: any,
  secondSigningFn: any,
  currentSlot: bigint,
  payer: PublicKey,
  swigAddress: PublicKey
): Promise<TransactionInstruction[]> {
  console.log(`\n=== ATTEMPTING MANUAL CONSTRUCTION OF COMBINED SIGN INSTRUCTION ===`);
  
  // First, get individual sign instructions to understand the structure
  const rootSignInstructions = await getSignInstructions(
    swig,
    rootRole.id,
    swapInstructions,
    false,
    {
      currentSlot,
      signingFn: rootSigningFn,
      payer,
    }
  );
  
  const secondSignInstructions = await getSignInstructions(
    swig,
    secondRole.id,
    swapInstructions,
    false,
    {
      currentSlot,
      signingFn: secondSigningFn,
      payer,
    }
  );
  
  if (rootSignInstructions.length === 0 || secondSignInstructions.length === 0) {
    console.warn('Could not get sign instructions for both roles, falling back to separate instructions');
    return [...rootSignInstructions, ...secondSignInstructions];
  }
  
  const rootIx = rootSignInstructions[0];
  const secondIx = secondSignInstructions[0];
  
  // Analyze the instruction data structure
  console.log(`Root instruction data: ${rootIx.data.length} bytes`);
  console.log(`Second instruction data: ${secondIx.data.length} bytes`);
  console.log(`Root instruction keys: ${rootIx.keys.length}`);
  console.log(`Second instruction keys: ${secondIx.keys.length}`);
  
  // Log first few bytes of instruction data to understand structure
  const rootDataHex = Array.from(rootIx.data.slice(0, Math.min(64, rootIx.data.length)))
    .map(b => b.toString(16).padStart(2, '0')).join(' ');
  const secondDataHex = Array.from(secondIx.data.slice(0, Math.min(64, secondIx.data.length)))
    .map(b => b.toString(16).padStart(2, '0')).join(' ');
  console.log(`Root instruction data (first 64 bytes): ${rootDataHex}`);
  console.log(`Second instruction data (first 64 bytes): ${secondDataHex}`);
  
  // CRITICAL: Without the exact Swig instruction format, manually constructing
  // a combined instruction is extremely risky. The instruction data format is
  // not publicly documented, and attempting to parse and combine it could result
  // in invalid instructions that fail on-chain.
  //
  // The Swig program might actually expect TWO separate sign_v2 instructions
  // (one for each role), not a single combined instruction. The "Transaction
  // signature verification failure" error might be due to a different issue:
  // - The signatures might not be for the same transaction message
  // - The instruction order might be wrong
  // - The account keys might be incorrect
  // - The Swig program might have a bug with multisig sign_v2
  //
  // Since we cannot safely construct a combined instruction without the exact format,
  // we'll return both instructions separately. If this continues to fail, we may
  // need to contact the Swig team for guidance or check if there's a different
  // SDK function for multisig.
  
  console.log(`\nWARNING: Manual construction of combined instruction is not safe without exact format.`);
  console.log(`Returning both sign instructions separately.`);
  console.log(`If this fails, the issue might be elsewhere (signature format, instruction order, etc.)`);
  
  return [...rootSignInstructions, ...secondSignInstructions];
}

/**
 * Execute a Jupiter swap using Swig wallet
 * Follows the pattern from Jupiter + Swig documentation
 */
export async function executeSwapWithSwig(
  evmPrivateKey: string,
  secondEvmPrivateKey: string | undefined,
  inputToken: string,
  outputToken: string,
  amount: string,
  network: Network,
  useJitoBundle: boolean = false
): Promise<SwapResult> {
  // Validate and format private key
  const formattedPrivateKey = evmPrivateKey.startsWith('0x')
    ? evmPrivateKey
    : `0x${evmPrivateKey}`;

  // Create viem account
  const evmAccount = privateKeyToAccount(formattedPrivateKey as `0x${string}`);

  // Generate deterministic Swig ID
  const cleanAddress = evmAccount.address.startsWith('0x') ? evmAccount.address.slice(2) : evmAccount.address;
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
  const swigId = hash;
  const swigAddress = findSwigPda(swigId);

  // Initialize Solana connection
  const rpcUrl = getSolanaRpc(network);
  const connection = new Connection(rpcUrl, 'confirmed');

  // Fetch Swig account
  const swig = await fetchSwig(connection, swigAddress);

  // Get wallet address from Swig account - use getSwigWalletAddress (like in demo)
  // This auto-detects v1/v2 and returns the correct address
  const walletAddress = await getSwigWalletAddress(swig);
  
  // Check account version
  const accountVersion = (swig as any).accountVersion?.() || 'v1';
  
  // Check if it's a multisig wallet (has more than 1 role)
  const allRoles = swig.roles || [];
  const isMultisig = allRoles.length > 1;
  
  console.log(`\n=== WALLET INFO ===`);
  console.log(`Account version: ${accountVersion}`);
  console.log(`Swig PDA (config): ${swigAddress.toBase58()}`);
  console.log(`Wallet address: ${walletAddress.toBase58()}`);
  console.log(`Is multisig: ${isMultisig}`);
  console.log(`Total roles: ${allRoles.length}`);
  
  // Just use the wallet address we got - proceed with swap
  // Don't try to migrate - user said they already migrated
  console.log(`\n=== PROCEEDING WITH SWAP ===`);
  console.log(`Using wallet address: ${walletAddress.toBase58()}`);
  
  // Skip all migration logic - just proceed with swap
  return await continueSwapWithV2Wallet(
    swig,
    walletAddress,
    swigAddress,
    evmAccount,
    formattedPrivateKey,
    secondEvmPrivateKey,
    inputToken,
    outputToken,
    amount,
    network,
    useJitoBundle,
    connection
  );
}

/**
 * Continue swap execution with v2 wallet
 */
async function continueSwapWithV2Wallet(
  swig: any,
  walletAddress: PublicKey,
  swigAddress: PublicKey,
  evmAccount: any,
  formattedPrivateKey: string,
  secondEvmPrivateKey: string | undefined,
  inputToken: string,
  outputToken: string,
  amount: string,
  network: Network,
  useJitoBundle: boolean,
  connection: Connection
): Promise<SwapResult> {

  // Find the role for this EVM address
  const rootRole = swig.findRolesBySecp256k1SignerAddress(evmAccount.address)[0];
  if (!rootRole) {
    throw new Error('No role found for this authority. Please create the wallet first.');
  }

  // For multisig, verify second signer exists
  if (secondEvmPrivateKey) {
    const formattedSecondKey = secondEvmPrivateKey.startsWith('0x')
      ? secondEvmPrivateKey
      : `0x${secondEvmPrivateKey}`;
    const secondAccount = privateKeyToAccount(formattedSecondKey as `0x${string}`);
    const secondRole = swig.findRolesBySecp256k1SignerAddress(secondAccount.address)[0];
    if (!secondRole) {
      throw new Error('Second signer not found in multisig wallet. Please create multisig wallet first.');
    }
  }

  // Resolve tokens
  const inputResolved = await resolveTokenParam(inputToken, 'SOL');
  const outputResolved = await resolveTokenParam(outputToken, 'USDC');

  // Convert amount to smallest unit
  const inputDecimals = inputResolved.decimals || 9;
  const scaledAmount = Math.floor(parseFloat(amount) * Math.pow(10, inputDecimals));

  // Step 1: Get quote from Jupiter using API client
  // Use native SOL mint for quotes - Jupiter will handle wrapping
  // Lower maxAccounts to force simpler routes that won't exceed compute limits
  const jupiter = createJupiterApiClient();
  const quote = await jupiter.quoteGet({
    inputMint: inputResolved.mint,
    outputMint: outputResolved.mint,
    amount: scaledAmount,
    slippageBps: 50,
    maxAccounts: 64, // Reduced from 64 to force simpler routes (avoid CU limit issues)
    restrictIntermediateTokens: true, // Restrict intermediate tokens to avoid complex multi-hop routes
  });

  // Step 2: Get swap instructions from Jupiter (exactly like demo)
  // Use walletAddress (System Program owned) as userPublicKey - Jupiter will generate instructions with this address
  // Swig will sign using the PDA (swigAddress) via getSignInstructions
  const swapInstructionsRes = await jupiter.swapInstructionsPost({
    swapRequest: {
      quoteResponse: quote,
      userPublicKey: walletAddress.toBase58(), // Use System Program owned wallet address (like demo)
      wrapAndUnwrapSol: true, // Let Jupiter handle wrapping
      useSharedAccounts: true,
    },
  });

  // Step 3: Convert Jupiter instructions to TransactionInstruction format (exactly like demo)
  // Combine setup and swap instructions - NO filtering or replacement needed
  // Jupiter already uses walletAddress since we passed it as userPublicKey
  const swapInstructions: TransactionInstruction[] = [
    ...(swapInstructionsRes.setupInstructions || []).map(toTransactionInstruction),
    toTransactionInstruction(swapInstructionsRes.swapInstruction),
  ];

  // Step 4: Sign instructions with Swig (following demo pattern)
  const feePayer = getFeePayer(network);
  const privateKeyBytes = hexToBytes(formattedPrivateKey as `0x${string}`);
  const signingFn = getSigningFnForSecp256k1PrivateKey(privateKeyBytes);

  // Get current slot (required for Secp256k1 signing)
  const currentSlot = await connection.getSlot('finalized');

  // Check if multisig
  const allRoles = swig.roles || [];
  const isMultisig = allRoles.length > 1 && secondEvmPrivateKey;
  
  let signInstructions: TransactionInstruction[];
  
  if (isMultisig) {
    // For multisig, get sign instructions for both roles (like demo but for two roles)
    const formattedSecondKey = secondEvmPrivateKey.startsWith('0x')
      ? secondEvmPrivateKey
      : `0x${secondEvmPrivateKey}`;
    const secondAccount = privateKeyToAccount(formattedSecondKey as `0x${string}`);
    
    // Validate that both addresses are different
    if (evmAccount.address.toLowerCase() === secondAccount.address.toLowerCase()) {
      throw new Error(
        'Both private keys resolve to the same EVM address. ' +
        'For a 2-of-2 multisig wallet, you need TWO DIFFERENT private keys.'
      );
    }
    
    // Find the second role
    const secondRole = swig.findRolesBySecp256k1SignerAddress(secondAccount.address)[0];
    if (!secondRole) {
      throw new Error('Second signer not found in multisig wallet.');
    }
    
    const secondPrivateKeyBytes = hexToBytes(formattedSecondKey as `0x${string}`);
    const secondSigningFn = getSigningFnForSecp256k1PrivateKey(secondPrivateKeyBytes);
    
    // Get sign instructions for both roles
    // CRITICAL: For Secp256k1 (non-Ed25519), we MUST provide payer and currentSlot
    // The demo uses Ed25519 which doesn't require these, but Secp256k1 does
    const rootSignInstructions = await getSignInstructions(
      swig,
      rootRole.id,
      swapInstructions,
      false,
      {
        signingFn,
        payer: feePayer.solanaKeypair.publicKey,
        currentSlot: BigInt(currentSlot),
      }
    );
    
    const secondSignInstructions = await getSignInstructions(
      swig,
      secondRole.id,
      swapInstructions,
      false,
      {
        signingFn: secondSigningFn,
        payer: feePayer.solanaKeypair.publicKey,
        currentSlot: BigInt(currentSlot),
      }
    );
    
    // Combine both sign instructions (like demo but for multisig)
    signInstructions = [...rootSignInstructions, ...secondSignInstructions];
    
    // Log instruction details for debugging
    if (rootSignInstructions.length > 0) {
      const rootIx = rootSignInstructions[0];
      console.log(`Root sign instruction: program=${rootIx.programId.toBase58()}, keys=${rootIx.keys.length}, data=${rootIx.data.length} bytes`);
      // Check if Swig PDA is in the keys
      const hasPda = rootIx.keys.some(k => k.pubkey.equals(swigAddress));
      console.log(`  Contains Swig PDA: ${hasPda}`);
      if (rootIx.keys.length > 0) {
        console.log(`  First key: ${rootIx.keys[0].pubkey.toBase58()}, isSigner=${rootIx.keys[0].isSigner}`);
      }
    }
    if (secondSignInstructions.length > 0) {
      const secondIx = secondSignInstructions[0];
      console.log(`Second sign instruction: program=${secondIx.programId.toBase58()}, keys=${secondIx.keys.length}, data=${secondIx.data.length} bytes`);
      // Check if Swig PDA is in the keys
      const hasPda = secondIx.keys.some(k => k.pubkey.equals(swigAddress));
      console.log(`  Contains Swig PDA: ${hasPda}`);
      if (secondIx.keys.length > 0) {
        console.log(`  First key: ${secondIx.keys[0].pubkey.toBase58()}, isSigner=${secondIx.keys[0].isSigner}`);
      }
    }
    
    // NOTE: If this still fails, the Swig program likely requires a single sign instruction
    // with both signatures embedded. This would require manually constructing the instruction
    // by understanding the Swig program's instruction format (sign_v2 discriminator + data structure).
    // Alternatively, we might need to contact the Swig team for guidance on multisig signing with sign_v2.
  } else {
    // Single signer wallet
    // CRITICAL: For Secp256k1 (non-Ed25519), we MUST provide payer and currentSlot
    // The demo uses Ed25519 which doesn't require these, but Secp256k1 does
    signInstructions = await getSignInstructions(
      swig,
      rootRole.id,
      swapInstructions,
      false,
      {
        signingFn,
        payer: feePayer.solanaKeypair.publicKey,
        currentSlot: BigInt(currentSlot),
      }
    );
  }
  
  console.log(`\n=== SWIG SIGN INSTRUCTIONS ===`);
  console.log(`Sign instructions count: ${signInstructions.length}`);
  signInstructions.forEach((ix, idx) => {
    console.log(`Sign Instruction ${idx}:`);
    console.log(`  Program: ${ix.programId.toBase58()}`);
    if (ix.programId.equals(SystemProgram.programId)) {
      console.log(`  *** SYSTEM PROGRAM IN SIGN INSTRUCTIONS ***`);
      ix.keys.forEach((key, keyIdx) => {
        const isPda = key.pubkey.equals(swigAddress);
        const isWallet = key.pubkey.equals(walletAddress);
        console.log(`    [${keyIdx}] ${key.pubkey.toBase58()} - isSigner: ${key.isSigner}, isWritable: ${key.isWritable}, ${isPda ? '*** PDA ***' : ''} ${isWallet ? '*** WALLET ***' : ''}`);
      });
    }
  });

  // Step 5: Fetch address lookup tables (exactly like demo)
  const lookupTables = await Promise.all(
    (swapInstructionsRes.addressLookupTableAddresses || []).map(async (addr) => {
      const res = await connection.getAddressLookupTable(new PublicKey(addr));
      if (!res.value) {
        throw new Error(`Address Lookup Table ${addr} not found`);
      }
      return res.value;
    })
  );

  // Step 6: Build versioned transaction (exactly like demo)
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
  
  // Outer instructions (compute budget) - increased limit to handle complex swaps
  // Even with simpler routes, we need higher CU limit for Swig overhead
  const outerIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), // Increased from 150k to 400k
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50 }),
  ];

  // Create versioned transaction message (exactly like demo)
  const messageV0 = new TransactionMessage({
    payerKey: feePayer.solanaKeypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [...outerIxs, ...signInstructions],
  }).compileToV0Message(lookupTables);

  // Create and sign versioned transaction (exactly like demo)
  const tx = new VersionedTransaction(messageV0);
  tx.sign([feePayer.solanaKeypair]);

  // Log transaction structure for debugging
  console.log(`\n=== TRANSACTION STRUCTURE ===`);
  console.log(`Total instructions: ${outerIxs.length + signInstructions.length}`);
  console.log(`Compute budget instructions: ${outerIxs.length}`);
  console.log(`Sign instructions: ${signInstructions.length}`);
  signInstructions.forEach((ix, idx) => {
    console.log(`  Sign Ix ${idx}: Program=${ix.programId.toBase58()}, keys=${ix.keys.length}`);
    if (ix.programId.equals(SystemProgram.programId)) {
      console.log(`    *** SYSTEM PROGRAM INSTRUCTION IN SIGN INSTRUCTIONS ***`);
      ix.keys.forEach((key, keyIdx) => {
        console.log(`      [${keyIdx}] ${key.pubkey.toBase58()} - isSigner=${key.isSigner}, isWritable=${key.isWritable}`);
      });
    }
  });

  // Simulate transaction first to get detailed error logs
  try {
    const simulation = await connection.simulateTransaction(tx, {
      replaceRecentBlockhash: true,
      sigVerify: false,
    });
    
    if (simulation.value.err) {
      console.error('\n=== SIMULATION ERROR ===');
      console.error('Error:', JSON.stringify(simulation.value.err, null, 2));
      console.error('Logs:', simulation.value.logs);
      if (simulation.value.logs) {
        simulation.value.logs.forEach((log, idx) => {
          console.error(`  [${idx}] ${log}`);
        });
      }
      throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}. Logs: ${simulation.value.logs?.join('\n') || 'No logs'}`);
    }
    
    console.log('\n=== SIMULATION SUCCESS ===');
    console.log(`Compute units used: ${simulation.value.unitsConsumed}`);
  } catch (simError: any) {
    console.error('\n=== SIMULATION EXCEPTION ===');
    console.error('Error:', simError.message);
    if (simError.logs) {
      console.error('Logs:', simError.logs);
    }
    throw simError;
  }

  // Step 7: Send transaction (exactly like demo)
  const signature = await connection.sendTransaction(tx, {
    skipPreflight: true, // Like demo
    preflightCommitment: 'confirmed',
  });
  
  // Confirm transaction (exactly like demo)
  const result = await connection.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight,
  });

  if (result.value.err) {
    // Try to get transaction logs for more details
    try {
      const txDetails = await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (txDetails?.meta?.logMessages) {
        console.error('\n=== TRANSACTION LOGS ===');
        txDetails.meta.logMessages.forEach((log, idx) => {
          console.error(`  [${idx}] ${log}`);
        });
      }
      if (txDetails?.meta?.err) {
        console.error('\n=== TRANSACTION ERROR ===');
        console.error('Error:', JSON.stringify(txDetails.meta.err, null, 2));
      }
    } catch (logError) {
      console.error('Could not fetch transaction logs:', logError);
    }
    throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
  }

  // Calculate output amount
  const outputDecimals = outputResolved.decimals || 6;
  const outputAmount = parseFloat(quote.outAmount) / Math.pow(10, outputDecimals);

  return {
    transactionSignature: signature,
    explorerUrl: `https://www.orbmarkets.io/tx/${signature}`,
    inputAmount: parseFloat(amount),
    outputAmount,
    inputToken: inputResolved.symbol,
    outputToken: outputResolved.symbol,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Get Swig wallet address deterministically from EVM private key
 */
export function getSwigAddressFromPrivateKey(evmPrivateKey: string): { swigAddress: PublicKey; swigId: Uint8Array } {
  const formattedPrivateKey = evmPrivateKey.startsWith('0x')
    ? evmPrivateKey
    : `0x${evmPrivateKey}`;

  const evmAccount = privateKeyToAccount(formattedPrivateKey as `0x${string}`);

  // Generate deterministic Swig ID
  const cleanAddress = evmAccount.address.startsWith('0x') ? evmAccount.address.slice(2) : evmAccount.address;
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
  const swigId = hash;
  const swigAddress = findSwigPda(swigId);

  return { swigAddress, swigId };
}

/**
 * Execute a Relay swap using Swig wallet
 * Follows the same pattern as Jupiter swap
 */
export async function executeRelaySwapWithSwig(
  evmPrivateKey: string,
  secondEvmPrivateKey: string | undefined,
  inputToken: string,
  outputToken: string,
  amount: string,
  network: Network,
  recipient?: string
): Promise<SwapResult> {
  // Validate and format private key
  const formattedPrivateKey = evmPrivateKey.startsWith('0x')
    ? evmPrivateKey
    : `0x${evmPrivateKey}`;

  // Create viem account
  const evmAccount = privateKeyToAccount(formattedPrivateKey as `0x${string}`);

  // Generate deterministic Swig ID
  const cleanAddress = evmAccount.address.startsWith('0x') ? evmAccount.address.slice(2) : evmAccount.address;
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
  const swigId = hash;
  const swigAddress = findSwigPda(swigId);

  // Initialize Solana connection
  const rpcUrl = getSolanaRpc(network);
  const connection = new Connection(rpcUrl, 'confirmed');

  // Fetch Swig account
  const swig = await fetchSwig(connection, swigAddress);

  // Get wallet address from Swig account - use getSwigWalletAddress (like Jupiter)
  // This auto-detects v1/v2 and returns the correct address
  const walletAddress = await getSwigWalletAddress(swig);
  
  // Check account version
  const accountVersion = (swig as any).accountVersion?.() || 'v1';
  
  // Check if it's a multisig wallet (has more than 1 role)
  const allRoles = swig.roles || [];
  const isMultisig = allRoles.length > 1;
  
  console.log(`\n=== RELAY SWAP WALLET INFO ===`);
  console.log(`Account version: ${accountVersion}`);
  console.log(`Swig PDA (config): ${swigAddress.toBase58()}`);
  console.log(`Wallet address: ${walletAddress.toBase58()}`);
  console.log(`Is multisig: ${isMultisig}`);
  console.log(`Total roles: ${allRoles.length}`);

  // Find the role for this EVM address
  const rootRole = swig.findRolesBySecp256k1SignerAddress(evmAccount.address)[0];
  if (!rootRole) {
    throw new Error('No role found for this authority. Please create the wallet first.');
  }

  // For multisig, verify second signer exists
  if (secondEvmPrivateKey) {
    const formattedSecondKey = secondEvmPrivateKey.startsWith('0x')
      ? secondEvmPrivateKey
      : `0x${secondEvmPrivateKey}`;
    const secondAccount = privateKeyToAccount(formattedSecondKey as `0x${string}`);
    const secondRole = swig.findRolesBySecp256k1SignerAddress(secondAccount.address)[0];
    if (!secondRole) {
      throw new Error('Second signer not found in multisig wallet. Please create multisig wallet first.');
    }
  }

  // Resolve tokens
  const inputResolved = await resolveTokenParam(inputToken, 'SOL');
  const outputResolved = await resolveTokenParam(outputToken, 'USDC');

  // Convert amount to smallest unit
  const inputDecimals = inputResolved.decimals || 9;
  const scaledAmount = Math.floor(parseFloat(amount) * Math.pow(10, inputDecimals));

  // Step 1: Get quote from Relay API (exactly like Jupiter Step 1)
  // Use walletAddress (System Program owned) as user - Relay will generate instructions with this address
  // Swig will sign using the PDA (swigAddress) via getSignInstructions
  const RELAY_API_URL = 'https://api.relay.link/quote/v2';
  const SOLANA_CHAIN_ID = 792703809;
  const recipientAddress = recipient || walletAddress.toBase58();

  const relayQuoteRequest = {
    user: walletAddress.toBase58(), // Use System Program owned wallet address (like Jupiter)
    originChainId: SOLANA_CHAIN_ID,
    destinationChainId: SOLANA_CHAIN_ID,
    originCurrency: inputResolved.mint,
    destinationCurrency: outputResolved.mint,
    recipient: recipientAddress,
    tradeType: 'EXACT_INPUT',
    amount: scaledAmount.toString(),
    referrer: 'relay.link',
    useDepositAddress: false,
    topupGas: false,
  };

  console.log('Fetching Relay quote:', relayQuoteRequest);

  const relayResponse = await fetch(RELAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(relayQuoteRequest),
  });

  if (!relayResponse.ok) {
    const errorText = await relayResponse.text();
    console.error('Relay quote error:', errorText);
    throw new Error(`Failed to fetch Relay quote: ${errorText}`);
  }

  const relayQuote = await relayResponse.json();
  console.log('Relay quote received');

  // Step 2: Extract instructions from Relay response (like Jupiter Step 2)
  // Response structure: steps[0].items[0].data.instructions
  if (!relayQuote.steps || !relayQuote.steps[0] || !relayQuote.steps[0].items || !relayQuote.steps[0].items[0] || !relayQuote.steps[0].items[0].data) {
    throw new Error('Invalid Relay quote response structure');
  }

  const relayData = relayQuote.steps[0].items[0].data;
  const relayInstructions = relayData.instructions || [];
  const addressLookupTableAddresses = relayData.addressLookupTableAddresses || [];

  if (relayInstructions.length === 0) {
    throw new Error('No instructions found in Relay quote response');
  }

  // Log raw Relay instruction objects from response
  console.log(`\n=== RAW RELAY INSTRUCTIONS FROM API ===`);
  console.log(`Total instructions: ${relayInstructions.length}`);
  relayInstructions.forEach((ix: any, idx: number) => {
    console.log(`\nInstruction ${idx}:`);
    console.log(JSON.stringify(ix, null, 2));
  });

  // Step 3: Convert Relay instructions to TransactionInstruction format (exactly like Jupiter Step 3)
  // CRITICAL: Set wallet signer to false - Swig will sign via PDA, not wallet directly
  // This prevents Jupiter from expecting the wallet to sign directly
  const swapInstructions: TransactionInstruction[] = relayInstructions.map((ix: any) => {
    const converted = relayInstructionToTransactionInstruction(ix);
    // Set wallet address signer flag to false - Swig will handle signing
    const newKeys = converted.keys.map((key: any) => {
      if (key.pubkey.equals(walletAddress) && key.isSigner) {
        return {
          pubkey: key.pubkey,
          isSigner: false, // Remove signer flag - Swig will sign via PDA
          isWritable: key.isWritable,
        };
      }
      return key;
    });
    return new TransactionInstruction({
      programId: converted.programId,
      keys: newKeys,
      data: converted.data,
    });
  });

  console.log(`\n=== RELAY INSTRUCTIONS (converted) ===`);
  console.log(`Total instructions: ${swapInstructions.length}`);
  swapInstructions.forEach((ix, idx) => {
    const hasWalletSigner = ix.keys.some(k => k.pubkey.equals(walletAddress) && k.isSigner);
    const walletSignerKeys = ix.keys.filter(k => k.pubkey.equals(walletAddress) && k.isSigner);
    console.log(`Instruction ${idx}: Program=${ix.programId.toBase58()}, Keys=${ix.keys.length}, HasWalletSigner=${hasWalletSigner}`);
    if (hasWalletSigner) {
      console.log(`  Wallet signer keys: ${walletSignerKeys.length}`);
      walletSignerKeys.forEach((key, kIdx) => {
        console.log(`    Wallet Signer Key[${kIdx}]: isSigner=${key.isSigner}, isWritable=${key.isWritable}`);
      });
    }
    // Log all signers in this instruction
    const allSigners = ix.keys.filter(k => k.isSigner);
    console.log(`  All signers in instruction: ${allSigners.length}`);
    allSigners.forEach((key, kIdx) => {
      const isWallet = key.pubkey.equals(walletAddress);
      const isPda = key.pubkey.equals(swigAddress);
      console.log(`    Signer[${kIdx}]: ${key.pubkey.toBase58()} ${isWallet ? '*** WALLET ***' : ''} ${isPda ? '*** PDA ***' : ''}`);
    });
  });

  // Step 4: Sign instructions with Swig (following Jupiter pattern)
  const feePayer = getFeePayer(network);
  const privateKeyBytes = hexToBytes(formattedPrivateKey as `0x${string}`);
  const signingFn = getSigningFnForSecp256k1PrivateKey(privateKeyBytes);

  // Get current slot (required for Secp256k1 signing)
  const currentSlot = await connection.getSlot('finalized');

  // Check if multisig
  const isMultisigWallet = allRoles.length > 1 && secondEvmPrivateKey;
  
  let signInstructions: TransactionInstruction[];
  
  if (isMultisigWallet) {
    // For multisig, get sign instructions for both roles (like Jupiter)
    const formattedSecondKey = secondEvmPrivateKey.startsWith('0x')
      ? secondEvmPrivateKey
      : `0x${secondEvmPrivateKey}`;
    const secondAccount = privateKeyToAccount(formattedSecondKey as `0x${string}`);
    
    // Validate that both addresses are different
    if (evmAccount.address.toLowerCase() === secondAccount.address.toLowerCase()) {
      throw new Error(
        'Both private keys resolve to the same EVM address. ' +
        'For a 2-of-2 multisig wallet, you need TWO DIFFERENT private keys.'
      );
    }
    
    // Find the second role
    const secondRole = swig.findRolesBySecp256k1SignerAddress(secondAccount.address)[0];
    if (!secondRole) {
      throw new Error('Second signer not found in multisig wallet.');
    }
    
    const secondPrivateKeyBytes = hexToBytes(formattedSecondKey as `0x${string}`);
    const secondSigningFn = getSigningFnForSecp256k1PrivateKey(secondPrivateKeyBytes);
    
    // Get sign instructions for both roles
    // CRITICAL: For Secp256k1 (non-Ed25519), we MUST provide payer and currentSlot
    const rootSignInstructions = await getSignInstructions(
      swig,
      rootRole.id,
      swapInstructions,
      false,
      {
        signingFn,
        payer: feePayer.solanaKeypair.publicKey,
        currentSlot: BigInt(currentSlot),
      }
    );
    
    const secondSignInstructions = await getSignInstructions(
      swig,
      secondRole.id,
      swapInstructions,
      false,
      {
        signingFn: secondSigningFn,
        payer: feePayer.solanaKeypair.publicKey,
        currentSlot: BigInt(currentSlot),
      }
    );
    
    // Combine both sign instructions (like Jupiter)
    signInstructions = [...rootSignInstructions, ...secondSignInstructions];
  } else {
    // Single signer wallet
    // CRITICAL: For Secp256k1 (non-Ed25519), we MUST provide payer and currentSlot
    signInstructions = await getSignInstructions(
      swig,
      rootRole.id,
      swapInstructions,
      false,
      {
        signingFn,
        payer: feePayer.solanaKeypair.publicKey,
        currentSlot: BigInt(currentSlot),
      }
    );
  }
  
  console.log(`\n=== SWIG SIGN INSTRUCTIONS (RELAY) ===`);
  console.log(`Sign instructions count: ${signInstructions.length}`);
  signInstructions.forEach((ix, idx) => {
    console.log(`Sign Instruction ${idx}:`);
    console.log(`  Program: ${ix.programId.toBase58()}`);
    console.log(`  Keys: ${ix.keys.length}`);
    console.log(`  Data length: ${ix.data.length} bytes`);
    
    // Log all keys in the sign instruction
    ix.keys.forEach((key, keyIdx) => {
      const isPda = key.pubkey.equals(swigAddress);
      const isWallet = key.pubkey.equals(walletAddress);
      const isJupiter = key.pubkey.equals(new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'));
      console.log(`    [${keyIdx}] ${key.pubkey.toBase58()} - isSigner: ${key.isSigner}, isWritable: ${key.isWritable}${isPda ? ' *** PDA ***' : ''}${isWallet ? ' *** WALLET ***' : ''}${isJupiter ? ' *** JUPITER ***' : ''}`);
    });
    
    if (ix.programId.equals(SystemProgram.programId)) {
      console.log(`  *** SYSTEM PROGRAM IN SIGN INSTRUCTIONS ***`);
    }
  });

  // Step 5: Fetch address lookup tables (exactly like Jupiter Step 5)
  const lookupTables = await Promise.all(
    addressLookupTableAddresses.map(async (addr: string) => {
      const res = await connection.getAddressLookupTable(new PublicKey(addr));
      if (!res.value) {
        throw new Error(`Address Lookup Table ${addr} not found`);
      }
      return res.value;
    })
  );

  // Step 6: Build versioned transaction (exactly like Jupiter Step 6)
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
  
  // Outer instructions (compute budget) - increased limit to handle complex swaps
  // Even with simpler routes, we need higher CU limit for Swig overhead
  const outerIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), // Increased from 150k to 400k (like Jupiter)
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50 }),
  ];

  // Create versioned transaction message (exactly like Jupiter)
  const messageV0 = new TransactionMessage({
    payerKey: feePayer.solanaKeypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [...outerIxs, ...signInstructions],
  }).compileToV0Message(lookupTables);

  // Create and sign versioned transaction (exactly like Jupiter)
  const tx = new VersionedTransaction(messageV0);
  tx.sign([feePayer.solanaKeypair]);

  // Log transaction structure for debugging
  console.log(`\n=== TRANSACTION STRUCTURE ===`);
  console.log(`Total instructions: ${outerIxs.length + signInstructions.length}`);
  console.log(`Compute budget instructions: ${outerIxs.length}`);
  console.log(`Sign instructions: ${signInstructions.length}`);

  // Simulate transaction first to get detailed error logs (exactly like Jupiter)
  try {
    const simulation = await connection.simulateTransaction(tx, {
      replaceRecentBlockhash: true,
      sigVerify: false,
    });
    
    if (simulation.value.err) {
      console.error('\n=== SIMULATION ERROR ===');
      console.error('Error:', JSON.stringify(simulation.value.err, null, 2));
      console.error('Logs:', simulation.value.logs);
      if (simulation.value.logs) {
        simulation.value.logs.forEach((log, idx) => {
          console.error(`  [${idx}] ${log}`);
        });
      }
      throw new Error(`Transaction simulation failed: ${JSON.stringify(simulation.value.err)}. Logs: ${simulation.value.logs?.join('\n') || 'No logs'}`);
    }
    
    console.log('\n=== SIMULATION SUCCESS ===');
    console.log(`Compute units used: ${simulation.value.unitsConsumed}`);
  } catch (simError: any) {
    console.error('\n=== SIMULATION EXCEPTION ===');
    console.error('Error:', simError.message);
    if (simError.logs) {
      console.error('Logs:', simError.logs);
    }
    throw simError;
  }

  // Step 7: Send transaction (exactly like Jupiter Step 7)
  const signature = await connection.sendTransaction(tx, {
    skipPreflight: true, // Like Jupiter
    preflightCommitment: 'confirmed',
  });
  
  // Confirm transaction (exactly like Jupiter)
  const result = await connection.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight,
  });

  if (result.value.err) {
    // Try to get transaction logs for more details
    try {
      const txDetails = await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (txDetails?.meta?.logMessages) {
        console.error('\n=== TRANSACTION LOGS ===');
        txDetails.meta.logMessages.forEach((log, idx) => {
          console.error(`  [${idx}] ${log}`);
        });
      }
      if (txDetails?.meta?.err) {
        console.error('\n=== TRANSACTION ERROR ===');
        console.error('Error:', JSON.stringify(txDetails.meta.err, null, 2));
      }
    } catch (logError) {
      console.error('Could not fetch transaction logs:', logError);
    }
    throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
  }

  // Calculate output amount from Relay quote response
  const outputDecimals = outputResolved.decimals || 6;
  const outputAmountRaw = relayQuote.details?.currencyOut?.amount || '0';
  const outputAmount = parseFloat(outputAmountRaw) / Math.pow(10, outputDecimals);

  return {
    transactionSignature: signature,
    explorerUrl: `https://www.orbmarkets.io/tx/${signature}`,
    inputAmount: parseFloat(amount),
    outputAmount,
    inputToken: inputResolved.symbol,
    outputToken: outputResolved.symbol,
    timestamp: new Date().toISOString(),
  };
}
