'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import ProtectedRoute from '@/components/ProtectedRoute';
import { Connection, Transaction, PublicKey } from '@solana/web3.js';
import {
  Actions,
  createSecp256k1AuthorityInfo,
  findSwigPda,
  getAddAuthorityInstructions,
  fetchSwig,
  getSwigSystemAddress,
  getSigningFnForSecp256k1PrivateKey,
} from '@swig-wallet/classic';
import { privateKeyToAccount } from 'viem/accounts';
import { hexToBytes } from 'viem';

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
 * Create Swig multisig wallet (frontend)
 */
async function createSwigMultisigFrontend(
  firstPrivateKey: string,
  secondPrivateKey: string,
  network: 'mainnet' | 'testnet'
) {
  // Validate and format private keys
  const formattedFirstKey = firstPrivateKey.startsWith('0x')
    ? firstPrivateKey
    : `0x${firstPrivateKey}`;
  const formattedSecondKey = secondPrivateKey.startsWith('0x')
    ? secondPrivateKey
    : `0x${secondPrivateKey}`;

  if (!isValidPrivateKey(formattedFirstKey) || !isValidPrivateKey(formattedSecondKey)) {
    throw new Error('Invalid Ethereum private key format');
  }

  // Create viem accounts
  const firstAccount = privateKeyToAccount(formattedFirstKey as `0x${string}`);
  const secondAccount = privateKeyToAccount(formattedSecondKey as `0x${string}`);

  // Check if both keys are different
  if (firstAccount.address.toLowerCase() === secondAccount.address.toLowerCase()) {
    throw new Error('Both private keys must be different for a 2-of-2 multisig');
  }

  // Generate Swig ID (deterministic based on first address)
  const swigId = createDeterministicSwigId(firstAccount.address);
  const swigAddress = findSwigPda(swigId);

  // Initialize Solana connection
  const rpcUrl = NETWORKS[network].solana.rpc;
  const connection = new Connection(rpcUrl, 'confirmed');

  // Fetch existing Swig account (should exist from first wallet creation)
  let swig;
  try {
    swig = await fetchSwig(connection, swigAddress);
  } catch (error: any) {
    throw new Error('Swig wallet does not exist. Please create the wallet first using the Create Wallet page.');
  }

  // Find the root role
  const rootRole = swig.findRolesBySecp256k1SignerAddress(firstAccount.address)[0];
  if (!rootRole) {
    throw new Error('Root role not found. Please create the wallet first.');
  }

  // Fee payer public key (hardcoded)
  const feePayerPubkey = new PublicKey('hciZb5onspShN7vhvGDANtavRp4ww3xMzfVECXo2BR4');

  // Create authority info for the new signer
  const newAuthorityInfo = createSecp256k1AuthorityInfo(secondAccount.publicKey);

  // Set up actions for the new signer
  const newSignerActions = Actions.set().all().get();

  // Get current slot
  const currentSlot = await connection.getSlot('finalized');

  // Get recent blockhash
  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  // Create signing function for the root authority
  const privateKeyBytes = hexToBytes(formattedFirstKey as `0x${string}`);
  const signingFn = getSigningFnForSecp256k1PrivateKey(privateKeyBytes);

  // Get add authority instructions with actual fee payer
  const addAuthorityInstructions = await getAddAuthorityInstructions(
    swig,
    rootRole.id,
    newAuthorityInfo,
    newSignerActions,
    {
      payer: feePayerPubkey,
      currentSlot: BigInt(currentSlot),
      signingFn,
    }
  );

  // Create transaction
  const transaction = new Transaction();
  transaction.add(...addAuthorityInstructions);
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

  // Fetch updated Swig account
  const updatedSwig = await fetchSwig(connection, swigAddress);

  // Find the new role
  const newRole = updatedSwig.findRolesBySecp256k1SignerAddress(secondAccount.address)[0];
  if (!newRole) {
    throw new Error('Failed to find new role for the added signer');
  }

  // Get the wallet address (System Program owned account for receiving funds)
  const walletAddress = await getSwigSystemAddress(updatedSwig);

  return {
    address: swigAddress.toString(), // PDA configuration account
    walletAddress: walletAddress.toString(), // System Program owned account for receiving funds
    threshold: 2,
    signers: [
      firstAccount.address,
      secondAccount.address,
    ],
    transactionHash: signData.data.signature,
    explorerUrl: signData.data.explorerUrl,
  };
}

/**
 * Main multisig creation function
 */
async function createMultisig(
  firstPrivateKey: string,
  secondPrivateKey: string,
  network: 'mainnet' | 'testnet' = 'testnet'
) {
  // Validate input
  if (!firstPrivateKey || !secondPrivateKey) {
    throw new Error('Both private keys are required');
  }

  const formattedFirstKey = firstPrivateKey.startsWith('0x') 
    ? firstPrivateKey 
    : `0x${firstPrivateKey}`;
  const formattedSecondKey = secondPrivateKey.startsWith('0x') 
    ? secondPrivateKey 
    : `0x${secondPrivateKey}`;

  if (!isValidPrivateKey(formattedFirstKey) || !isValidPrivateKey(formattedSecondKey)) {
    throw new Error('Invalid Ethereum private key format');
  }

  if (network !== 'mainnet' && network !== 'testnet') {
    throw new Error('Network must be "mainnet" or "testnet"');
  }

  // Create multisig wallet
  const result = await createSwigMultisigFrontend(formattedFirstKey, formattedSecondKey, network);

  return {
    solanaMultisig: {
      address: result.walletAddress,
      configurationAddress: result.address,
      threshold: result.threshold,
      signers: result.signers,
      transactionHash: result.transactionHash,
    },
    network,
  };
}

function CreateMultisigContent() {
  const [firstPrivateKey, setFirstPrivateKey] = useState('');
  const [secondPrivateKey, setSecondPrivateKey] = useState('');
  const [network, setNetwork] = useState<'mainnet' | 'testnet'>('testnet');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');

  // Expose function to window for console access
  useEffect(() => {
    (window as any).createMultisig = createMultisig;
    console.log('💡 You can now use: window.createMultisig("0x...", "0x...", "testnet")');
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setResult(null);
    setLoading(true);

    try {
      const data = await createMultisig(firstPrivateKey, secondPrivateKey, network);
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
        <Link href="/private-send">Private Send</Link>
        <Link href="/swap">Jupiter Swap</Link>
        <Link href="/swap/relay">Relay Swap</Link>
      </nav>

      <h1>Create Multisig Wallet</h1>
      <p style={{ color: '#666', marginTop: '0.5rem', marginBottom: '2rem' }}>
        Create 2-of-2 multisig wallet (both signers required). The wallet must already exist from Create Wallet page.
      </p>

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label>First Signer Private Key</label>
          <input
            type="text"
            value={firstPrivateKey}
            onChange={(e) => setFirstPrivateKey(e.target.value)}
            required
            placeholder="0x..."
            style={{ fontFamily: 'monospace' }}
          />
        </div>

        <div className="form-group">
          <label>Second Signer Private Key</label>
          <input
            type="text"
            value={secondPrivateKey}
            onChange={(e) => setSecondPrivateKey(e.target.value)}
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
            <h3>✅ Multisig Created Successfully!</h3>
            <p style={{ color: '#666', marginTop: '0.5rem', marginBottom: '1rem' }}>
              Your 2-of-2 multisig wallet requires both signers to approve transactions.
            </p>

            {result.solanaMultisig && (
              <div className="card" style={{ marginTop: '1rem', background: 'white', padding: '1.5rem' }}>
                <h4 style={{ marginTop: 0 }}>🟣 Solana Multisig Wallet</h4>
                <div style={{ marginTop: '1rem' }}>
                  <p>
                    <strong>Solana Wallet Address (USE THIS for receiving SOL/SPL tokens):</strong>{' '}
                    <a 
                      href={`https://www.orbmarkets.io/account/${result.solanaMultisig.address}`} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      style={{ color: '#667eea', wordBreak: 'break-all' }}
                    >
                      {result.solanaMultisig.address}
                    </a>
                  </p>
                  {result.solanaMultisig.configurationAddress && (
                    <p>
                      <strong>Swig Configuration Address (PDA):</strong>{' '}
                      <a
                        href={`https://www.orbmarkets.io/account/${result.solanaMultisig.configurationAddress}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: '#667eea', wordBreak: 'break-all' }}
                      >
                        {result.solanaMultisig.configurationAddress}
                      </a>
                    </p>
                  )}
                  <p style={{ marginTop: '1rem' }}><strong>Threshold:</strong> {result.solanaMultisig.threshold} of {result.solanaMultisig.signers.length} signers required</p>
                  <p><strong>Signers ({result.solanaMultisig.signers.length}):</strong></p>
                  <ul style={{ marginLeft: '1.5rem', marginTop: '0.5rem' }}>
                    {result.solanaMultisig.signers.map((signer: string, idx: number) => (
                      <li key={idx} style={{ marginBottom: '0.25rem' }}>
                        <span style={{ fontFamily: 'monospace', fontSize: '0.9rem' }}>{signer}</span>
                      </li>
                    ))}
                  </ul>
                  <p style={{ marginTop: '1rem' }}>
                    <strong>Creation Transaction:</strong>{' '}
                    <a 
                      href={`https://www.orbmarkets.io/tx/${result.solanaMultisig.transactionHash}`} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      style={{ color: '#667eea', fontFamily: 'monospace', fontSize: '0.9rem' }}
                    >
                      {result.solanaMultisig.transactionHash}
                    </a>
                  </p>
                </div>
              </div>
            )}
          </div>
        )}

        <button type="submit" className="btn" disabled={loading} style={{ width: '100%' }}>
          {loading ? 'Creating Multisig...' : 'Create Multisig'}
        </button>
      </form>
    </div>
  );
}

export default function CreateMultisig() {
  return (
    <ProtectedRoute>
      <CreateMultisigContent />
    </ProtectedRoute>
  );
}
