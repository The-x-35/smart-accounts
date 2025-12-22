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
  getSwigWalletAddress,
} from '@swig-wallet/classic';
import { createJupiterApiClient } from '@jup-ag/api';
import { privateKeyToAccount } from 'viem/accounts';
import { hexToBytes } from 'viem';
import { Network } from '@/types/api';
import { getSolanaRpc } from '@/lib/config/networks';
import { getFeePayer } from '@/lib/config/fee-payers';
import { resolveTokenParam } from '@/lib/utils/token-resolver';

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

  // Get the wallet address (System Program owned account for receiving tokens)
  const walletAddress = await getSwigWalletAddress(swig);

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
  const jupiter = createJupiterApiClient();
  const quote = await jupiter.quoteGet({
    inputMint: inputResolved.mint,
    outputMint: outputResolved.mint,
    amount: scaledAmount,
    slippageBps: 50,
    maxAccounts: 64, // Account for Swig's overhead
  });

  // Step 2: Get swap instructions from Jupiter
  // Use walletAddress (System Program owned) for token account operations
  // Swig will still sign using the PDA (swigAddress) via getSignInstructions
  const swapInstructionsRes = await jupiter.swapInstructionsPost({
    swapRequest: {
      quoteResponse: quote,
      userPublicKey: walletAddress.toBase58(), // Use wallet address for token accounts
      wrapAndUnwrapSol: true, // Let Jupiter handle wrapping - Swig should handle the SystemProgram transfers
      useSharedAccounts: true,
    },
  });

  // Step 3: Convert Jupiter instructions to TransactionInstruction format
  // Separate setup instructions and swap instruction
  const setupInstructions: TransactionInstruction[] = (swapInstructionsRes.setupInstructions || []).map(
    toTransactionInstruction
  );
  const swapInstruction = toTransactionInstruction(swapInstructionsRes.swapInstruction);

  // Filter out any SystemProgram transfer instructions that use Swig address as 'from'
  // Swig accounts are PDAs and can't be used directly in SystemProgram transfers
  // This can happen in setup instructions or in the swap instruction itself
  const filterSystemProgramTransfers = (instructions: TransactionInstruction[]): TransactionInstruction[] => {
    return instructions.filter((ix) => {
      // Check if it's a SystemProgram instruction
      if (ix.programId.equals(SystemProgram.programId)) {
        // SystemProgram transfers have the 'from' account as the first writable signer
        // Check all keys to see if Swig address is used as a signer in a transfer
        const swigKey = ix.keys.find((key) => key.pubkey.equals(swigAddress));
        if (swigKey && swigKey.isSigner) {
          console.warn('Filtering out SystemProgram instruction that uses Swig account as signer (PDA cannot be used in SystemProgram transfers)');
          console.warn('Instruction keys:', ix.keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })));
          return false;
        }
      }
      return true;
    });
  };

  // Debug: Log all instructions before filtering
  console.log('Setup instructions count:', setupInstructions.length);
  console.log('Swap instruction program:', swapInstruction.programId.toBase58());
  console.log('Swig address:', swigAddress.toBase58());

  const filteredSetupInstructions = filterSystemProgramTransfers(setupInstructions);
  const filteredSwapInstructions = filterSystemProgramTransfers([swapInstruction]);
  
  console.log('Filtered setup instructions count:', filteredSetupInstructions.length);
  console.log('Filtered swap instructions count:', filteredSwapInstructions.length);

  // Combine all instructions that need to be signed by Swig
  const swapInstructions: TransactionInstruction[] = [
    ...filteredSetupInstructions,
    ...filteredSwapInstructions,
  ];

  // Step 4: Sign instructions with Swig
  const feePayer = getFeePayer(network);
  const privateKeyBytes = hexToBytes(formattedPrivateKey as `0x${string}`);
  const signingFn = getSigningFnForSecp256k1PrivateKey(privateKeyBytes);

  // Get current slot
  const currentSlot = await connection.getSlot('finalized');

  // Get signing instructions from Swig
  // This wraps the Jupiter instructions so Swig can sign on behalf of the Swig address
  const signInstructions = await getSignInstructions(
    swig,
    rootRole.id,
    swapInstructions,
    false, // no sub-account
    {
      currentSlot: BigInt(currentSlot),
      signingFn,
      payer: feePayer.solanaKeypair.publicKey,
    }
  );

  // Step 5: Fetch address lookup tables
  const lookupTables: AddressLookupTableAccount[] = await Promise.all(
    (swapInstructionsRes.addressLookupTableAddresses || []).map(async (addr) => {
      const res = await connection.getAddressLookupTable(new PublicKey(addr));
      if (!res.value) {
        throw new Error(`Address Lookup Table ${addr} not found`);
      }
      return res.value;
    })
  );

  // Step 6: Create compute budget instructions (OUTSIDE of Swig-signed instructions)
  // These must be added separately and not signed by Swig
  const computeBudgetInstructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 150_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50 }),
  ];

  // Step 7: Build versioned transaction
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');

  // Combine compute budget (outer) + Swig-signed instructions
  const allInstructions = [...computeBudgetInstructions, ...signInstructions];

  // Create versioned transaction message
  const messageV0 = new TransactionMessage({
    payerKey: feePayer.solanaKeypair.publicKey,
    recentBlockhash: blockhash,
    instructions: allInstructions,
  }).compileToV0Message(lookupTables);

  // Create and sign versioned transaction
  const tx = new VersionedTransaction(messageV0);
  tx.sign([feePayer.solanaKeypair]);

  // Step 8: Send transaction
  let signature: string;
  
  if (useJitoBundle) {
    // TODO: Implement Jito bundle support
    // For now, fall back to regular transaction
    console.warn('Jito bundle requested but not fully implemented, using regular transaction');
  }

  // Send the transaction
  signature = await connection.sendTransaction(tx, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 3,
  });

  // Confirm transaction
  const result = await connection.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight,
  });

  if (result.value.err) {
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

  // Get Swig address
  const { swigAddress, swigId } = getSwigAddressFromPrivateKey(formattedPrivateKey);

  // Create viem account
  const evmAccount = privateKeyToAccount(formattedPrivateKey as `0x${string}`);

  // Initialize Solana connection
  const rpcUrl = getSolanaRpc(network);
  const connection = new Connection(rpcUrl, 'confirmed');

  // Fetch Swig account
  const swig = await fetchSwig(connection, swigAddress);

  // Get the wallet address (System Program owned account for receiving tokens)
  const walletAddress = await getSwigWalletAddress(swig);
  const recipientAddress = recipient || walletAddress.toBase58();

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

  // Step 1: Get quote from Relay API
  const RELAY_API_URL = 'https://api.relay.link/quote';
  const SOLANA_CHAIN_ID = 792703809;

  const relayQuoteRequest = {
    user: walletAddress.toBase58(), // Use wallet address for token account operations
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

  // Step 2: Extract instructions from Relay response
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

  // Step 3: Convert Relay instructions to TransactionInstruction format
  const swapInstructions: TransactionInstruction[] = relayInstructions.map(
    relayInstructionToTransactionInstruction
  );

  // Filter out any SystemProgram transfer instructions that use Swig address as 'from'
  // Swig accounts are PDAs and can't be used directly in SystemProgram transfers
  const filterSystemProgramTransfers = (instructions: TransactionInstruction[]): TransactionInstruction[] => {
    return instructions.filter((ix) => {
      if (ix.programId.equals(SystemProgram.programId)) {
        const swigKey = ix.keys.find((key) => key.pubkey.equals(swigAddress));
        if (swigKey && swigKey.isSigner) {
          console.warn('Filtering out SystemProgram instruction that uses Swig account as signer (PDA cannot be used in SystemProgram transfers)');
          return false;
        }
      }
      return true;
    });
  };

  const filteredInstructions = filterSystemProgramTransfers(swapInstructions);

  // Step 4: Sign instructions with Swig
  const feePayer = getFeePayer(network);
  const privateKeyBytes = hexToBytes(formattedPrivateKey as `0x${string}`);
  const signingFn = getSigningFnForSecp256k1PrivateKey(privateKeyBytes);

  // Get current slot
  const currentSlot = await connection.getSlot('finalized');

  // Get signing instructions from Swig
  const signInstructions = await getSignInstructions(
    swig,
    rootRole.id,
    filteredInstructions,
    false, // no sub-account
    {
      currentSlot: BigInt(currentSlot),
      signingFn,
      payer: feePayer.solanaKeypair.publicKey,
    }
  );

  // Step 5: Fetch address lookup tables
  const lookupTables: AddressLookupTableAccount[] = await Promise.all(
    addressLookupTableAddresses.map(async (addr: string) => {
      const res = await connection.getAddressLookupTable(new PublicKey(addr));
      if (!res.value) {
        throw new Error(`Address Lookup Table ${addr} not found`);
      }
      return res.value;
    })
  );

  // Step 6: Create compute budget instructions (OUTSIDE of Swig-signed instructions)
  const computeBudgetInstructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 150_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50 }),
  ];

  // Step 7: Build versioned transaction
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');

  // Combine compute budget (outer) + Swig-signed instructions
  const allInstructions = [...computeBudgetInstructions, ...signInstructions];

  // Create versioned transaction message
  const messageV0 = new TransactionMessage({
    payerKey: feePayer.solanaKeypair.publicKey,
    recentBlockhash: blockhash,
    instructions: allInstructions,
  }).compileToV0Message(lookupTables);

  // Create and sign versioned transaction
  const tx = new VersionedTransaction(messageV0);
  tx.sign([feePayer.solanaKeypair]);

  // Step 8: Send transaction
  const signature = await connection.sendTransaction(tx, {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 3,
  });

  // Confirm transaction
  const result = await connection.confirmTransaction({
    signature,
    blockhash,
    lastValidBlockHeight,
  });

  if (result.value.err) {
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
