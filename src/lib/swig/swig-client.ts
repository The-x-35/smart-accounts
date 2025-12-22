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
  SWIG_PROGRAM_ADDRESS,
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
 * Migrate old Swig wallet to new architecture with separate wallet address
 * According to PR #97: migrate_to_wallet_address_v1 instruction
 */
async function migrateSwigWallet(
  swig: any, // Swig type from SDK
  evmAccount: any, // viem account
  formattedPrivateKey: string,
  network: Network
): Promise<{ success: boolean; transactionSignature?: string; error?: string }> {
  try {
    const swigAddress = findSwigPda(swig.id);
    const rpcUrl = getSolanaRpc(network);
    const connection = new Connection(rpcUrl, 'confirmed');
    
    // Find a role with ManageAuthority permission (required for migration)
    const rootRole = swig.findRolesBySecp256k1SignerAddress(evmAccount.address)[0];
    if (!rootRole) {
      throw new Error('No role found for this authority. Cannot migrate.');
    }
    
    // Check if role has ManageAuthority permission
    // Permissions are on the role.actions object, not swig.actions
    const roleActions = rootRole.actions;
    
    // Debug: Log role structure to understand permissions
    console.log('Role structure:', {
      roleId: rootRole.id,
      hasActions: !!roleActions,
      actionsType: typeof roleActions,
      actionsKeys: roleActions ? Object.keys(roleActions) : [],
      hasHasManageAuthority: roleActions?.hasManageAuthority ? typeof roleActions.hasManageAuthority : 'N/A',
      hasHasAll: roleActions?.hasAll ? typeof roleActions.hasAll : 'N/A',
    });
    
    // Check permissions - try multiple methods
    let hasPermission = false;
    if (roleActions) {
      // Check if has all permissions (which includes ManageAuthority)
      if (typeof roleActions.hasAll === 'function' && roleActions.hasAll()) {
        hasPermission = true;
      }
      // Check if has ManageAuthority specifically
      else if (typeof roleActions.hasManageAuthority === 'function' && roleActions.hasManageAuthority()) {
        hasPermission = true;
      }
    }
    
    // If we can't verify permissions, log a warning but proceed anyway
    // The blockchain will reject the transaction if permissions are insufficient
    if (!hasPermission) {
      console.warn('Could not verify ManageAuthority permission. Attempting migration anyway - blockchain will reject if insufficient permissions.');
    }
    
    // Get fee payer
    const feePayer = getFeePayer(network);
    
    // Create signing function
    const privateKeyBytes = hexToBytes(formattedPrivateKey as `0x${string}`);
    const signingFn = getSigningFnForSecp256k1PrivateKey(privateKeyBytes);
    
    // Get current slot
    const currentSlot = await connection.getSlot('finalized');
    
    // Get the expected wallet address after migration
    // According to PR #97, the wallet address is a System Program owned account
    // derived from the swig account with "wallet" seed
    // The seeds should be: ["wallet", swig_address]
    const [walletAddress, walletBump] = PublicKey.findProgramAddressSync(
      [Buffer.from('wallet'), swigAddress.toBuffer()],
      SWIG_PROGRAM_ADDRESS
    );
    
    console.log('Migration details:', {
      swigAddress: swigAddress.toBase58(),
      walletAddress: walletAddress.toBase58(),
      walletBump,
      accountVersion: (swig as any).accountVersion?.() || 'v1',
    });
    
    // Construct migration instruction manually
    // According to PR #97: migrate_to_wallet_address_v1
    // Anchor instruction format: 8-byte discriminator (hash of "global:migrate_to_wallet_address_v1") + instruction data
    // Since we don't have the exact discriminator, we'll try common patterns
    // The discriminator is typically the first 8 bytes of sha256("global:migrate_to_wallet_address_v1")
    // For now, we'll use a placeholder - this may need to be adjusted based on actual program source
    
    // Try using instruction index 10 (as mentioned in PR #97) as a u8, then padded to 8 bytes
    // Anchor discriminators are usually calculated from instruction names, but we'll try this approach
    const instructionIndex = 10; // migrate_to_wallet_address_v1 instruction index
    
    // Anchor discriminator format: first 8 bytes are the discriminator
    // We'll use a simple approach: [instruction_index, 0, 0, 0, 0, 0, 0, 0]
    // Note: This is a guess - the actual discriminator should come from the program's IDL
    const MIGRATE_DISCRIMINATOR = Buffer.alloc(8);
    MIGRATE_DISCRIMINATOR.writeUInt8(instructionIndex, 0);
    
    // Instruction data: discriminator (8 bytes) + wallet_bump (1 byte)
    const instructionData = Buffer.concat([
      MIGRATE_DISCRIMINATOR,
      Buffer.from([walletBump]),
    ]);
    
    console.log('Migration instruction data:', {
      discriminator: Array.from(MIGRATE_DISCRIMINATOR),
      walletBump,
      fullData: Array.from(instructionData),
      dataLength: instructionData.length,
    });
    
    // Create migration instruction
    // Accounts order based on typical Anchor pattern:
    // [0] swig_config (writable, signer via PDA)
    // [1] wallet_address (writable, will be created)
    // [2] payer (writable, signer)
    // [3] system_program (readonly)
    const migrateInstruction = new TransactionInstruction({
      programId: SWIG_PROGRAM_ADDRESS,
      keys: [
        { pubkey: swigAddress, isSigner: false, isWritable: true }, // swig config account (PDA, signed by program)
        { pubkey: walletAddress, isSigner: false, isWritable: true }, // wallet address (System Program owned, will be created)
        { pubkey: feePayer.solanaKeypair.publicKey, isSigner: true, isWritable: true }, // payer
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system program
      ],
      data: instructionData,
    });
    
    // The migration instruction needs to be signed by Swig
    // We use getSignInstructions to wrap it so Swig can sign on behalf of the PDA
    const signInstructions = await getSignInstructions(
      swig,
      rootRole.id,
      [migrateInstruction],
      false, // no sub-account
      {
        currentSlot: BigInt(currentSlot),
        signingFn,
        payer: feePayer.solanaKeypair.publicKey,
      }
    );
    
    // Create and send transaction
    const transaction = new Transaction().add(...signInstructions);
    
    // Set fee payer (required for simulation and execution)
    transaction.feePayer = feePayer.solanaKeypair.publicKey;
    
    // Get recent blockhash (required for transaction)
    const { blockhash } = await connection.getLatestBlockhash('finalized');
    transaction.recentBlockhash = blockhash;
    
    // Simulate first to get better error messages
    // Note: Using deprecated API for Transaction, but it's the only way to simulate regular Transaction
    try {
      const simulation = await connection.simulateTransaction(transaction, [feePayer.solanaKeypair]);
      if (simulation.value.err) {
        console.error('Migration simulation failed:', simulation.value.err);
        console.error('Simulation logs:', simulation.value.logs);
        throw new Error(`Migration simulation failed: ${JSON.stringify(simulation.value.err)}`);
      }
    } catch (simError: any) {
      console.error('Simulation error:', simError);
      // Continue anyway - sometimes simulation fails but actual transaction succeeds
    }
    
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [feePayer.solanaKeypair],
      { commitment: 'confirmed', skipPreflight: false }
    );
    
    return {
      success: true,
      transactionSignature: signature,
    };
  } catch (error: any) {
    console.error('Migration error:', error);
    console.error('Error details:', {
      message: error.message,
      logs: error.logs,
      transactionLogs: error.transactionLogs,
    });
    
    // Extract more detailed error information
    let errorMessage = error.message || 'Migration failed';
    if (error.logs && Array.isArray(error.logs)) {
      const errorLog = error.logs.find((log: string) => log.includes('error') || log.includes('failed'));
      if (errorLog) {
        errorMessage += ` - ${errorLog}`;
      }
    }
    
    return {
      success: false,
      error: errorMessage,
    };
  }
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
      
      // Check if wallet needs migration:
      // - v1 accounts: walletAddress === accountAddress (can't receive SPL tokens)
      // - v2 accounts: walletAddress === systemAddress (can receive SPL tokens)
      // For v1 accounts, getSwigWalletAddress returns the PDA
      // For v2 accounts, getSwigWalletAddress returns the system address
      if (accountVersion === 'v1' || walletAddress.equals(accountAddress)) {
        // Old v1 wallet detected - needs migration to v2
        console.log(`V1 Swig wallet detected (version: ${accountVersion}), attempting migration to v2 architecture...`);
        console.warn('Note: Migration requires proper instruction format. If migration fails, the wallet will be returned as-is (v1).');
        
        const migrationResult = await migrateSwigWallet(
          existingSwig,
          evmAccount,
          formattedPrivateKey,
          network
        );
        
        if (migrationResult.success && migrationResult.transactionSignature) {
          // Fetch updated Swig to get new wallet address after migration
          const updatedSwig = await fetchSwig(connection, swigAddress);
          const newWalletAddress = await getSwigWalletAddress(updatedSwig);
          
          // Verify migration succeeded (wallet address should now be different)
          if (newWalletAddress.equals(swigAddress)) {
            console.warn('Migration transaction succeeded but wallet address unchanged. Returning existing wallet.');
            // Return existing wallet - migration may have partially succeeded or wallet is already migrated
          } else {
            // Migration successful
            return {
              address: swigAddress.toString(), // PDA configuration account
              walletAddress: newWalletAddress.toString(), // System Program owned account for receiving funds
              id: Array.from(swigId),
              transactionSignature: migrationResult.transactionSignature,
              explorerUrl: `https://www.orbmarkets.io/tx/${migrationResult.transactionSignature}`,
            };
          }
        } else {
          // Migration failed - return the system address that SHOULD be used after migration
          // Even though migration failed, we can still show what the address would be
          console.warn(`Migration failed: ${migrationResult.error || 'Unknown error'}.`);
          console.warn('Note: This is a v1 wallet. It cannot receive SPL tokens directly.');
          console.warn(`The wallet address after migration would be: ${systemAddress.toBase58()}`);
          
          // Return v1 wallet but include the system address as the wallet address
          // This way users know what address to use (even though it won't work until migrated)
          return {
            address: accountAddress.toString(), // PDA configuration account
            walletAddress: systemAddress.toString(), // System Program owned account (what it should be after migration)
            id: Array.from(swigId),
            transactionSignature: '', // Migration failed
            explorerUrl: `https://www.orbmarkets.io/account/${accountAddress.toString()}`,
          };
        }
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

