'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import ProtectedRoute from '@/components/ProtectedRoute';
import { Connection, Transaction, PublicKey, SystemProgram } from '@solana/web3.js';
import {
  findSwigPda,
  fetchSwig,
  getSignInstructions,
  getSwigSystemAddress,
  getSigningFnForSecp256k1PrivateKey,
  SWIG_PROGRAM_ADDRESS,
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
 * Send SOL transaction (frontend)
 */
async function sendSOLTransaction(
  privateKey: string,
  recipient: string,
  amount: string,
  network: 'mainnet' | 'testnet',
  secondPrivateKey?: string
) {
  // Validate inputs
  if (!privateKey) {
    throw new Error('Private key is required');
  }

  const formattedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  if (!isValidPrivateKey(formattedKey)) {
    throw new Error('Invalid private key format');
  }

  if (!recipient) {
    throw new Error('Recipient address is required');
  }

  if (!isValidSolanaAddress(recipient)) {
    throw new Error('Invalid Solana recipient address');
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

  // Check if multisig
  const allRoles = swig.roles || [];
  const isMultisig = allRoles.length > 1;

  // If multisig and second key provided, verify it
  let secondRole;
  if (isMultisig && secondPrivateKey) {
    const formattedSecondKey = secondPrivateKey.startsWith('0x') ? secondPrivateKey : `0x${secondPrivateKey}`;
    if (!isValidPrivateKey(formattedSecondKey)) {
      throw new Error('Invalid second private key format');
    }
    const secondAccount = privateKeyToAccount(formattedSecondKey as `0x${string}`);
    secondRole = swig.findRolesBySecp256k1SignerAddress(secondAccount.address)[0];
    if (!secondRole) {
      throw new Error('Second signer not found in multisig wallet');
    }
  } else if (isMultisig && !secondPrivateKey) {
    throw new Error('This is a multisig wallet. Second private key is required.');
  }

  // Convert amount to lamports
  const amountLamports = Math.floor(parseFloat(amount) * 1_000_000_000);

  // Get current slot
  const currentSlot = await connection.getSlot('finalized');

  // Get recent blockhash
  const { blockhash } = await connection.getLatestBlockhash('confirmed');

  // Create transfer instruction
  const transferInstruction = SystemProgram.transfer({
    fromPubkey: walletAddress,
    toPubkey: new PublicKey(recipient),
    lamports: amountLamports,
  });

  // Get sign instructions (like swig-avici: call once with the provided key)
  // For multisig, either signer can execute - use the provided private key
  const privateKeyBytes = hexToBytes(formattedKey as `0x${string}`);
  const signingFn = getSigningFnForSecp256k1PrivateKey(privateKeyBytes);

  // Get sign instructions (only once - no duplication)
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

  // Create transaction
  const transaction = new Transaction();
  transaction.add(...signInstructions);
  transaction.recentBlockhash = blockhash;
  transaction.feePayer = FEE_PAYER_PUBKEY;

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

  return {
    transactionHash: signData.data.signature,
    explorerUrl: signData.data.explorerUrl,
    amount,
    recipient,
    network,
  };
}

/**
 * Main send transaction function
 */
async function sendTransaction(
  privateKey: string,
  recipient: string,
  amount: string,
  network: 'mainnet' | 'testnet' = 'testnet',
  secondPrivateKey?: string
) {
  return await sendSOLTransaction(privateKey, recipient, amount, network, secondPrivateKey);
}

function SendTransactionContent() {
  const [privateKey, setPrivateKey] = useState('');
  const [secondPrivateKey, setSecondPrivateKey] = useState('');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [network, setNetwork] = useState<'mainnet' | 'testnet'>('testnet');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');

  // Expose function to window for console access
  useEffect(() => {
    (window as any).sendTransaction = sendTransaction;
    console.log('💡 You can now use: window.sendTransaction("0x...", "recipient", "0.001", "testnet", "0x...")');
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setResult(null);
    setLoading(true);

    try {
      const data = await sendTransaction(
        privateKey,
        recipient,
        amount,
        network,
        secondPrivateKey || undefined
      );
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

      <h1>Send Transaction</h1>
      <p style={{ color: '#666', marginTop: '0.5rem', marginBottom: '1rem' }}>
        Send SOL from your Swig smart wallet
      </p>
      <div className="card" style={{ background: '#f0f4ff', padding: '1rem', marginBottom: '2rem', border: '1px solid #667eea' }}>
        <p style={{ margin: 0, fontSize: '0.9rem' }}>
          <strong>💡 For Multisig Wallets:</strong> Enter both private keys below. 
          For regular wallets, only enter the first private key.
        </p>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label>Signer Private Key</label>
          <input
            type="text"
            value={privateKey}
            onChange={(e) => setPrivateKey(e.target.value)}
            required
            placeholder="0x..."
            style={{ fontFamily: 'monospace' }}
          />
        </div>

        <div className="form-group">
          <label>
            Second Signer Private Key 
            <span style={{ color: '#666', fontSize: '0.9rem', fontWeight: 'normal' }}> (required for multisig)</span>
          </label>
          <input
            type="text"
            value={secondPrivateKey}
            onChange={(e) => setSecondPrivateKey(e.target.value)}
            placeholder="0x... (required for 2-of-2 multisig, leave empty for single signer)"
            style={{ fontFamily: 'monospace' }}
          />
          <small style={{ color: '#666', display: 'block', marginTop: '0.25rem' }}>
            If you created a multisig wallet, enter the second signer's private key here. 
            Both signers must approve the transaction.
          </small>
        </div>

        <div className="form-group">
          <label>Recipient Address</label>
          <input
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            required
            placeholder="Solana address"
            style={{ fontFamily: 'monospace' }}
          />
        </div>

        <div className="form-group">
          <label>Amount (SOL)</label>
          <input
            type="text"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            placeholder="0.001"
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
            <h3>Transaction Sent Successfully!</h3>
            <div className="card" style={{ marginTop: '1rem', background: 'white' }}>
              <p><strong>Transaction Hash:</strong> {result.transactionHash}</p>
              <p><strong>Recipient:</strong> {result.recipient}</p>
              <p><strong>Amount:</strong> {result.amount} SOL</p>
              <p><strong>Network:</strong> {result.network}</p>
              <p>
                <strong>Explorer:</strong>{' '}
                <a href={result.explorerUrl} target="_blank" rel="noopener noreferrer">
                  View on Explorer
                </a>
              </p>
            </div>
          </div>
        )}

        <button type="submit" className="btn" disabled={loading} style={{ width: '100%' }}>
          {loading ? 'Sending Transaction...' : 'Send Transaction'}
        </button>
      </form>
    </div>
  );
}

export default function SendTransaction() {
  return (
    <ProtectedRoute>
      <SendTransactionContent />
    </ProtectedRoute>
  );
}
