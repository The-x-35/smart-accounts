'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import ProtectedRoute from '@/components/ProtectedRoute';
import { Connection, Transaction, PublicKey } from '@solana/web3.js';
import {
  Actions,
  createSecp256k1AuthorityInfo,
  findSwigPda,
  getCreateSwigInstruction,
  fetchSwig,
  getSwigWalletAddress,
  getSwigSystemAddress,
} from '@swig-wallet/classic';
import { privateKeyToAccount } from 'viem/accounts';

// Network configurations
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
 * Create Swig wallet (frontend)
 */
async function createSwigWalletFrontend(
  evmPrivateKey: string,
  network: 'mainnet' | 'testnet'
) {
  // Validate and format private key
  const formattedPrivateKey = evmPrivateKey.startsWith('0x')
    ? evmPrivateKey
    : `0x${evmPrivateKey}`;

  if (!isValidPrivateKey(formattedPrivateKey)) {
    throw new Error('Invalid Ethereum private key format');
  }

  // Create viem account from private key
  const evmAccount = privateKeyToAccount(formattedPrivateKey as `0x${string}`);

  // Generate deterministic Swig ID
  const swigId = createDeterministicSwigId(evmAccount.address);
  const swigAddress = findSwigPda(swigId);

  // Initialize Solana connection
  const rpcUrl = NETWORKS[network].solana.rpc;
  const connection = new Connection(rpcUrl, 'confirmed');

  // Check if Swig wallet already exists
  try {
    const existingSwig = await fetchSwig(connection, swigAddress);
    if (existingSwig) {
      const accountAddress = swigAddress;
      const systemAddress = await getSwigSystemAddress(existingSwig);
      const walletAddress = await getSwigWalletAddress(existingSwig);
      
      // Check if wallet is v1 (old architecture)
      if (walletAddress.equals(accountAddress)) {
        // V1 wallet detected
        return {
          address: accountAddress.toString(),
          walletAddress: systemAddress.toString(),
          id: Array.from(swigId),
          transactionSignature: '',
          explorerUrl: `https://www.orbmarkets.io/account/${accountAddress.toString()}`,
        };
      }
      
      // Wallet is v2
      return {
        address: accountAddress.toString(),
        walletAddress: walletAddress.toString(),
        id: Array.from(swigId),
        transactionSignature: '',
        explorerUrl: `https://www.orbmarkets.io/account/${walletAddress.toString()}`,
      };
    }
  } catch (error: any) {
    // Wallet doesn't exist, continue to create
    const errorMessage = error?.message?.toLowerCase() || '';
    if (!errorMessage.includes('unable to fetch') &&
        !errorMessage.includes('accountnotfound') && 
        !errorMessage.includes('not found') &&
        !errorMessage.includes('does not exist') &&
        error?.code !== 0x1) {
      throw error;
    }
  }

  // Fee payer public key (hardcoded)
  const feePayerPubkey = new PublicKey('hciZb5onspShN7vhvGDANtavRp4ww3xMzfVECXo2BR4');

  // Create authority info
  const authorityInfo = createSecp256k1AuthorityInfo(evmAccount.publicKey);

  // Set up actions - default to all actions allowed
  const rootActions = Actions.set().all().get();

  // Get recent blockhash
  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  // Create Swig instruction with actual fee payer
  const createSwigInstruction = await getCreateSwigInstruction({
    authorityInfo,
    id: swigId,
    payer: feePayerPubkey,
    actions: rootActions,
  });

  // Create transaction
  const transaction = new Transaction();
  transaction.add(createSwigInstruction);
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = feePayerPubkey;

  // Serialize transaction and send to backend to sign
  const transactionBase64 = Buffer.from(transaction.serialize({ requireAllSignatures: false })).toString('base64');

  const signResponse = await fetch('/api/transaction/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      transactionBase64,
      network,
    }),
  });

  const signData = await signResponse.json();
  if (!signData.success) {
    throw new Error(signData.error || 'Failed to sign transaction');
  }

  // Fetch the created Swig account to get the wallet address
  const swig = await fetchSwig(connection, swigAddress);
  const walletAddress = await getSwigWalletAddress(swig);

  return {
    address: swigAddress.toString(),
    walletAddress: walletAddress.toString(),
    id: Array.from(swigId),
    transactionSignature: signData.data.signature,
    explorerUrl: signData.data.explorerUrl,
  };
}

/**
 * Main wallet creation function
 */
async function createWallet(
  ethPrivateKey: string,
  network: 'mainnet' | 'testnet' = 'testnet'
) {
  // Validate input
  if (!ethPrivateKey) {
    throw new Error('Ethereum private key is required');
  }

  const formattedKey = ethPrivateKey.startsWith('0x') 
    ? ethPrivateKey 
    : `0x${ethPrivateKey}`;

  if (!isValidPrivateKey(formattedKey)) {
    throw new Error('Invalid Ethereum private key format');
  }

  if (network !== 'mainnet' && network !== 'testnet') {
    throw new Error('Network must be "mainnet" or "testnet"');
  }

  // Get ETH address
  const evmAccount = privateKeyToAccount(formattedKey as `0x${string}`);
  const ethAddress = evmAccount.address;

  // Create Swig wallet
  const swigResult = await createSwigWalletFrontend(formattedKey, network);

  return {
    ethAddress,
    solanaAddress: swigResult.walletAddress,
    solanaConfigurationAddress: swigResult.address,
    swigId: swigResult.id,
    network,
    transactionHashes: {
      solana: swigResult.transactionSignature,
    },
  };
}

function CreateWalletContent() {
  const [ethPrivateKey, setEthPrivateKey] = useState('');
  const [network, setNetwork] = useState<'mainnet' | 'testnet'>('testnet');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');

  // Expose function to window for console access
  useEffect(() => {
    (window as any).createWallet = createWallet;
    console.log('💡 You can now use: window.createWallet("0x...", "testnet")');
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setResult(null);
    setLoading(true);

    try {
      const data = await createWallet(ethPrivateKey, network);
      setResult(data);
    } catch (err: any) {
      setError(err.message || 'Network error. Please try again.');
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
      </nav>

      <h1>Create Smart Wallet</h1>
      <p style={{ color: '#666', marginTop: '0.5rem', marginBottom: '2rem' }}>
        Create Solana smart wallet from an Ethereum private key
      </p>

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label>Ethereum Private Key</label>
          <input
            type="text"
            value={ethPrivateKey}
            onChange={(e) => setEthPrivateKey(e.target.value)}
            required
            placeholder="0x..."
            style={{ fontFamily: 'monospace' }}
          />
        </div>

        <div className="form-group">
          <label>Network</label>
          <select value={network} onChange={(e) => setNetwork(e.target.value as 'mainnet' | 'testnet')}>
            <option value="testnet">Testnet</option>
            <option value="mainnet">Mainnet</option>
          </select>
        </div>

        {error && <div className="error">{error}</div>}
        {result && (
          <div className="success">
            <h3>Wallets Created Successfully!</h3>
            <div className="card" style={{ marginTop: '1rem', background: 'white' }}>
              <p><strong>ETH Address:</strong> {result.ethAddress}</p>
              <p>
                <strong>Solana Wallet Address (USE THIS for receiving SOL/SPL tokens):</strong>{' '}
                <a
                  href={`https://www.orbmarkets.io/account/${result.solanaAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: '#667eea', wordBreak: 'break-all' }}
                >
                  {result.solanaAddress}
                </a>
              </p>
              {result.solanaConfigurationAddress && (
                <p>
                  <strong>Swig Configuration Address (PDA):</strong>{' '}
                  <a
                    href={`https://www.orbmarkets.io/account/${result.solanaConfigurationAddress}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: '#667eea', wordBreak: 'break-all' }}
                  >
                    {result.solanaConfigurationAddress}
                  </a>
                </p>
              )}
              <p style={{ marginTop: '1rem' }}><strong>Network:</strong> {result.network}</p>
              {result.transactionHashes.solana && (
                <p>
                  <strong>Solana TX:</strong>{' '}
                  <a href={`https://www.orbmarkets.io/tx/${result.transactionHashes.solana}`} target="_blank" rel="noopener noreferrer">
                    {result.transactionHashes.solana}
                  </a>
                </p>
              )}
            </div>
          </div>
        )}

        <button type="submit" className="btn" disabled={loading} style={{ width: '100%' }}>
          {loading ? 'Creating Wallet...' : 'Create Wallet'}
        </button>
      </form>
    </div>
  );
}

export default function CreateWallet() {
  return (
    <ProtectedRoute>
      <CreateWalletContent />
    </ProtectedRoute>
  );
}
