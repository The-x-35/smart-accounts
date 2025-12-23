'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import ProtectedRoute from '@/components/ProtectedRoute';
import { Connection, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, ComputeBudgetProgram, AddressLookupTableAccount } from '@solana/web3.js';
import {
  findSwigPda,
  fetchSwig,
  getSignInstructions,
  getSwigSystemAddress,
  getSigningFnForSecp256k1PrivateKey,
} from '@swig-wallet/classic';
import { privateKeyToAccount } from 'viem/accounts';
import { hexToBytes } from 'viem';
import { createJupiterApiClient } from '@jup-ag/api';
import { TOKENS } from '@/lib/utils/token-resolver';

const COMMON_TOKENS = ['SOL', 'USDC', 'USDT', 'BONK', 'RAY', 'CUSTOM'];
const NETWORK: 'mainnet' = 'mainnet';

// Network configurations (kept for clarity, but swaps always use mainnet)
const NETWORKS = {
  mainnet: {
    solana: {
      rpc: 'https://mainnet.helius-rpc.com/?api-key=d9b6d595-1feb-4741-8958-484ad55afdab',
    },
  },
  testnet: {
    solana: {
      rpc: 'https://api.devnet.solana.com',
    },
  },
};

// Fee payer public key (hardcoded)
const FEE_PAYER_PUBKEY = new PublicKey('hciZb5onspShN7vhvGDANtavRp4ww3xMzfVECXo2BR4');

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
 * Validate Ethereum private key
 */
function isValidPrivateKey(key: string): boolean {
  const formatted = key.startsWith('0x') ? key : `0x${key}`;
  return /^0x[a-fA-F0-9]{64}$/.test(formatted);
}

/**
 * Resolve token parameter to token info
 */
function resolveTokenParam(tokenParam: string, defaultToken: string = 'SOL'): { mint: string; decimals: number; symbol: string } {
  const trimmed = tokenParam.trim();
  const upper = trimmed.toUpperCase();
  
  if (TOKENS[upper]) {
    return TOKENS[upper];
  }
  
  try {
    const pubkey = new PublicKey(trimmed);
    return {
      mint: pubkey.toString(),
      decimals: 9,
      symbol: trimmed,
    };
  } catch {
    if (TOKENS[defaultToken]) {
      return TOKENS[defaultToken];
    }
    throw new Error(`Invalid token: ${tokenParam}`);
  }
}

/**
 * Convert Jupiter instruction to TransactionInstruction
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
 * Execute Jupiter swap (frontend)
 */
async function executeJupiterSwap(
  privateKey: string,
  inputToken: string,
  outputToken: string,
  amount: string,
  network: 'mainnet' | 'testnet',
  secondPrivateKey?: string,
  inputCustomMint?: string,
  outputCustomMint?: string
) {
  // Validate inputs
  if (!privateKey) {
    throw new Error('Private key is required');
  }

  const formattedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  if (!isValidPrivateKey(formattedKey)) {
    throw new Error('Invalid private key format');
  }

  if (!amount || parseFloat(amount) <= 0) {
    throw new Error('Amount must be greater than 0');
  }

  // Create viem account
  const evmAccount = privateKeyToAccount(formattedKey as `0x${string}`);

  // Generate Swig ID
  const swigId = createDeterministicSwigId(evmAccount.address);
  const swigAddress = findSwigPda(swigId);

  // Initialize Solana connection
  const rpcUrl = NETWORKS[network].solana.rpc;
  const connection = new Connection(rpcUrl, 'confirmed');

  // Fetch Swig account
  let swig;
  try {
    swig = await fetchSwig(connection, swigAddress);
  } catch (error: any) {
    throw new Error('Swig wallet does not exist. Please create the wallet first.');
  }

  // Get wallet address (System Program owned for v2)
  const walletAddress = await getSwigSystemAddress(swig);

  // Find the root role
  const rootRole = swig.findRolesBySecp256k1SignerAddress(evmAccount.address)[0];
  if (!rootRole) {
    throw new Error('No role found for this authority');
  }

  // Resolve tokens (support custom)
  const inputResolved = resolveTokenParam(
    inputToken === 'CUSTOM' ? (inputCustomMint || '') : inputToken,
    'SOL'
  );
  const outputResolved = resolveTokenParam(
    outputToken === 'CUSTOM' ? (outputCustomMint || '') : outputToken,
    'USDC'
  );

  // Convert amount to smallest unit
  const inputDecimals = inputResolved.decimals || 9;
  const scaledAmount = Math.floor(parseFloat(amount) * Math.pow(10, inputDecimals));

  // Step 1: Get quote from Jupiter
  const jupiter = createJupiterApiClient();
  const quote = await jupiter.quoteGet({
    inputMint: inputResolved.mint,
    outputMint: outputResolved.mint,
    amount: scaledAmount,
    slippageBps: 50,
    maxAccounts: 64,
    restrictIntermediateTokens: true,
  });

  // Step 2: Get swap instructions from Jupiter
  const swapInstructionsRes = await jupiter.swapInstructionsPost({
    swapRequest: {
      quoteResponse: quote,
      userPublicKey: walletAddress.toBase58(),
      wrapAndUnwrapSol: true,
      useSharedAccounts: true,
    },
  });

  // Step 3: Convert Jupiter instructions to TransactionInstruction format
  const swapInstructions: TransactionInstruction[] = [
    ...(swapInstructionsRes.setupInstructions || []).map(toTransactionInstruction),
    toTransactionInstruction(swapInstructionsRes.swapInstruction),
  ];

  // Step 4: Get sign instructions with Swig (like send-transaction: call once with the provided key)
  // For multisig, either signer can execute - use the provided private key
  const allRoles = swig.roles || [];
  const isMultisig = allRoles.length > 1;

  // If multisig and second key provided, verify it (but don't use it for signing)
  if (isMultisig && secondPrivateKey) {
    const formattedSecondKey = secondPrivateKey.startsWith('0x') ? secondPrivateKey : `0x${secondPrivateKey}`;
    if (!isValidPrivateKey(formattedSecondKey)) {
      throw new Error('Invalid second private key format');
    }
    const secondAccount = privateKeyToAccount(formattedSecondKey as `0x${string}`);
    const secondRole = swig.findRolesBySecp256k1SignerAddress(secondAccount.address)[0];
    if (!secondRole) {
      throw new Error('Second signer not found in multisig wallet');
    }
  } else if (isMultisig && !secondPrivateKey) {
    throw new Error('This is a multisig wallet. Second private key is required.');
  }

  // Get sign instructions (only once - no duplication, like send-transaction)
  const privateKeyBytes = hexToBytes(formattedKey as `0x${string}`);
  const signingFn = getSigningFnForSecp256k1PrivateKey(privateKeyBytes);
  const currentSlot = await connection.getSlot('finalized');

  const signInstructions = await getSignInstructions(
    swig,
    rootRole.id,
    swapInstructions,
    false,
    {
      currentSlot: BigInt(currentSlot),
      signingFn,
      payer: FEE_PAYER_PUBKEY,
    }
  );

  // Step 5: Fetch address lookup tables
  const lookupTables = await Promise.all(
    (swapInstructionsRes.addressLookupTableAddresses || []).map(async (addr: string) => {
      const res = await connection.getAddressLookupTable(new PublicKey(addr));
      if (!res.value) {
        throw new Error(`Address Lookup Table ${addr} not found`);
      }
      return res.value;
    })
  );

  // Step 6: Build versioned transaction
  const outerIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50 }),
  ];

  // Serialize instructions for backend
  const allInstructions = [...outerIxs, ...signInstructions];
  const serializedInstructions = allInstructions.map(ix => ({
    programId: ix.programId.toBase58(),
    keys: ix.keys.map(k => ({
      pubkey: k.pubkey.toBase58(),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: ix.data.toString('base64'),
  }));

  const lookupTableAddresses = (swapInstructionsRes.addressLookupTableAddresses || []).map((addr: string) => addr);

  // Log what we're sending
  console.log('\n=== JUPITER SWAP - SENDING TO BACKEND ===');
  console.log('Total instructions:', allInstructions.length);
  console.log('Outer instructions (compute budget):', outerIxs.length);
  console.log('Sign instructions:', signInstructions.length);
  console.log('Lookup table addresses:', lookupTableAddresses.length);
  console.log('Network:', network);
  console.log('isVersioned: true');
  console.log('Serialized instructions count:', serializedInstructions.length);
  console.log('First instruction program:', serializedInstructions[0]?.programId);

  // Send to backend for signing
  const signPayload = {
    instructions: serializedInstructions,
    lookupTableAddresses,
    isVersioned: true,
    network,
  };
  
  console.log('Sending payload keys:', Object.keys(signPayload));
  console.log('Payload instructions array length:', signPayload.instructions?.length);
  
  const signResponse = await fetch('/api/transaction/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signPayload),
  });
  
  console.log('Sign response status:', signResponse.status);
  
  if (!signResponse.ok) {
    const errorText = await signResponse.text();
    console.error('Sign response error:', errorText);
    throw new Error(`Failed to sign transaction: ${errorText}`);
  }

  const signData = await signResponse.json();
  console.log('Sign response data:', signData);
  
  if (!signData.success) {
    console.error('Sign failed:', signData.error);
    throw new Error(signData.error || 'Failed to sign transaction');
  }
  
  console.log('Transaction signed successfully:', signData.data.signature);

  // Calculate output amount
  const outputDecimals = outputResolved.decimals || 6;
  const outputAmount = parseFloat(quote.outAmount) / Math.pow(10, outputDecimals);

  return {
    transactionHash: signData.data.signature,
    explorerUrl: signData.data.explorerUrl,
    inputAmount: parseFloat(amount),
    outputAmount,
    inputToken: inputResolved.symbol,
    outputToken: outputResolved.symbol,
  };
}

function SwapContent() {
  const [privateKey, setPrivateKey] = useState('');
  const [secondPrivateKey, setSecondPrivateKey] = useState('');
  const [inputToken, setInputToken] = useState('SOL');
  const [outputToken, setOutputToken] = useState('USDC');
  const [inputCustomMint, setInputCustomMint] = useState('');
  const [outputCustomMint, setOutputCustomMint] = useState('');
  const [amount, setAmount] = useState('');
  const [loading, setLoading] = useState(false);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quote, setQuote] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');
  const [inputPrice, setInputPrice] = useState<number | null>(null);
  const [outputPrice, setOutputPrice] = useState<number | null>(null);
  const [priceLoading, setPriceLoading] = useState(false);

  // Fetch prices when tokens change
  useEffect(() => {
    fetchPrices();
  }, [inputToken, outputToken, inputCustomMint, outputCustomMint]);

  // Fetch quote when inputs change
  useEffect(() => {
    if (
      amount &&
      parseFloat(amount) > 0 &&
      inputToken &&
      outputToken &&
      (inputToken !== 'CUSTOM' || inputCustomMint) &&
      (outputToken !== 'CUSTOM' || outputCustomMint)
    ) {
      const timeoutId = setTimeout(() => {
        fetchQuote();
      }, 500);

      return () => clearTimeout(timeoutId);
    } else {
      setQuote(null);
    }
  }, [amount, inputToken, outputToken, inputCustomMint, outputCustomMint]);

  const fetchPrices = async () => {
    setPriceLoading(true);
    try {
      const token = localStorage.getItem('token');
      if (!token) return;

      if (inputToken === 'CUSTOM' || outputToken === 'CUSTOM') {
        setInputPrice(null);
        setOutputPrice(null);
        setPriceLoading(false);
        return;
      }

      const inputMint = TOKENS[inputToken]?.mint || inputToken;
      const outputMint = TOKENS[outputToken]?.mint || outputToken;

      const [inputResponse, outputResponse] = await Promise.all([
        fetch(`/api/swap/price?tokenId=${inputMint}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`/api/swap/price?tokenId=${outputMint}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);

      const inputData = await inputResponse.json();
      const outputData = await outputResponse.json();

      if (inputData.success && inputData.data) {
        setInputPrice(inputData.data.price);
      } else {
        setInputPrice(null);
      }

      if (outputData.success && outputData.data) {
        setOutputPrice(outputData.data.price);
      } else {
        setOutputPrice(null);
      }
    } catch (err) {
      console.error('Failed to fetch prices:', err);
      setInputPrice(null);
      setOutputPrice(null);
    } finally {
      setPriceLoading(false);
    }
  };

  const fetchQuote = async () => {
    if (!amount || parseFloat(amount) <= 0) return;
    if (inputToken === 'CUSTOM' && !inputCustomMint) return;
    if (outputToken === 'CUSTOM' && !outputCustomMint) return;

    setQuoteLoading(true);
    setError('');

    try {
      const token = localStorage.getItem('token');
      const response = await fetch(
        `/api/swap/quote?inputToken=${inputToken === 'CUSTOM' ? inputCustomMint : inputToken}&outputToken=${outputToken === 'CUSTOM' ? outputCustomMint : outputToken}&amount=${amount}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      const data = await response.json();

      if (data.success && data.data) {
        setQuote(data.data);
      } else if (data.outputAmount) {
        // Jupiter API returns data directly (not wrapped in success/data)
        setQuote(data);
      } else {
        setQuote(null);
        if (data.error) {
          console.error('Quote error:', data.error);
        }
      }
    } catch (err) {
      console.error('Failed to fetch quote:', err);
      setQuote(null);
    } finally {
      setQuoteLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setResult(null);
    setLoading(true);

    if (inputToken === 'CUSTOM' && !inputCustomMint) {
      setError('Input custom mint is required');
      setLoading(false);
      return;
    }
    if (outputToken === 'CUSTOM' && !outputCustomMint) {
      setError('Output custom mint is required');
      setLoading(false);
      return;
    }

    try {
      const data = await executeJupiterSwap(
        privateKey,
        inputToken,
        outputToken,
        amount,
        NETWORK,
        secondPrivateKey || undefined,
        inputCustomMint || undefined,
        outputCustomMint || undefined
      );
      setResult(data);
    } catch (err: any) {
      setError(err.message || 'Failed to execute swap');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container">
      <nav className="nav">
        <Link href="/dashboard">Dashboard</Link>
        <Link href="/create-wallet">Create Wallet</Link>
        <Link href="/create-multisig">Create Multisig</Link>
        <Link href="/send-transaction">Send Transaction</Link>
        <Link href="/swap">Jupiter Swap</Link>
        <Link href="/swap/relay">Relay Swap</Link>
      </nav>

      <h1>Jupiter Swap</h1>
      <p style={{ color: '#666', marginTop: '0.5rem', marginBottom: '2rem' }}>
        Swap tokens using your Swig wallet. Supports multisig wallets.
      </p>

      {error && <div className="error">{error}</div>}
      {result && (
        <div className="success">
          <h3>Swap Executed Successfully!</h3>
          <div className="card" style={{ marginTop: '1rem', background: 'white' }}>
            <p><strong>Transaction Hash:</strong> {result.transactionHash}</p>
            <p><strong>Input:</strong> {result.inputAmount} {result.inputToken}</p>
            <p><strong>Output:</strong> {result.outputAmount} {result.outputToken}</p>
            <p>
              <strong>Explorer:</strong>{' '}
              <a href={result.explorerUrl} target="_blank" rel="noopener noreferrer">
                View on Orb Markets
              </a>
            </p>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label>Signer Private Key</label>
          <input
            type="text"
            value={privateKey}
            onChange={(e) => setPrivateKey(e.target.value)}
            required
            placeholder="e.g., 0x..."
            style={{ fontFamily: 'monospace' }}
          />
        </div>

        <div className="form-group">
          <label>Second Signer Private Key (for 2-of-2 multisig)</label>
          <input
            type="text"
            value={secondPrivateKey}
            onChange={(e) => setSecondPrivateKey(e.target.value)}
            placeholder="e.g., 0x... (leave empty for single signer)"
            style={{ fontFamily: 'monospace' }}
          />
          <p style={{ fontSize: '0.85rem', color: '#777', marginTop: '0.5rem' }}>
            Required if your Swig wallet is 2-of-2 multisig.
          </p>
        </div>

        <div className="form-group">
          <label>
            Input Token
            {inputPrice !== null && (
              <span style={{ marginLeft: '0.5rem', color: '#666', fontWeight: 'normal' }}>
                (${inputPrice.toFixed(4)})
              </span>
            )}
            {priceLoading && inputPrice === null && (
              <span style={{ marginLeft: '0.5rem', color: '#999', fontSize: '0.85rem' }}>Loading price...</span>
            )}
          </label>
          <select value={inputToken} onChange={(e) => setInputToken(e.target.value)}>
            {COMMON_TOKENS.map((token) => (
              <option key={token} value={token}>
                {token}
              </option>
            ))}
          </select>
        </div>
        {inputToken === 'CUSTOM' && (
          <div className="form-group">
            <label>Input Custom Mint</label>
            <input
              type="text"
              value={inputCustomMint}
              onChange={(e) => setInputCustomMint(e.target.value)}
              placeholder="Custom input mint address"
              required
            />
          </div>
        )}

        <div className="form-group">
          <label>
            Output Token
            {outputPrice !== null && (
              <span style={{ marginLeft: '0.5rem', color: '#666', fontWeight: 'normal' }}>
                (${outputPrice.toFixed(4)})
              </span>
            )}
            {priceLoading && outputPrice === null && (
              <span style={{ marginLeft: '0.5rem', color: '#999', fontSize: '0.85rem' }}>Loading price...</span>
            )}
          </label>
          <select value={outputToken} onChange={(e) => setOutputToken(e.target.value)}>
            {COMMON_TOKENS.map((token) => (
              <option key={token} value={token}>
                {token}
              </option>
            ))}
          </select>
        </div>
        {outputToken === 'CUSTOM' && (
          <div className="form-group">
            <label>Output Custom Mint</label>
            <input
              type="text"
              value={outputCustomMint}
              onChange={(e) => setOutputCustomMint(e.target.value)}
              placeholder="Custom output mint address"
              required
            />
          </div>
        )}

        <div className="form-group">
          <label>
            Amount ({inputToken})
            {amount && inputPrice !== null && parseFloat(amount) > 0 && (
              <span style={{ marginLeft: '0.5rem', color: '#666', fontWeight: 'normal' }}>
                ≈ ${(parseFloat(amount) * inputPrice).toFixed(2)}
              </span>
            )}
          </label>
          <input
            type="text"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            placeholder="e.g., 0.1"
          />
        </div>

        {quoteLoading && (
          <div style={{ marginBottom: '1rem', color: '#666' }}>Loading quote...</div>
        )}

        {quote && !quoteLoading && (
          <div className="card" style={{ marginTop: '1rem', marginBottom: '1rem' }}>
            <h3>Quote Preview</h3>
            <p>
              <strong>You will receive:</strong> {quote.outputAmount.toFixed(6)} {quote.outputToken}
            </p>
            <p>
              <strong>Price Impact:</strong> {quote.priceImpact ? `${parseFloat(quote.priceImpact.toString()).toFixed(4)}%` : 'N/A'}
            </p>
            <p style={{ fontSize: '0.85rem', color: '#777', marginTop: '0.5rem' }}>
              Slippage tolerance: 0.5%
            </p>
          </div>
        )}

        <button type="submit" className="btn" disabled={loading || quoteLoading} style={{ width: '100%' }}>
          {loading ? 'Executing Swap...' : 'Execute Swap'}
        </button>
      </form>
    </div>
  );
}

export default function SwapPage() {
  return (
    <ProtectedRoute>
      <SwapContent />
    </ProtectedRoute>
  );
}
