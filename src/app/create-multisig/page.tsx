'use client';

import { useState } from 'react';
import Link from 'next/link';
import ProtectedRoute from '@/components/ProtectedRoute';

function CreateMultisigContent() {
  const [firstPrivateKey, setFirstPrivateKey] = useState('');
  const [secondPrivateKey, setSecondPrivateKey] = useState('');
  const [network, setNetwork] = useState<'mainnet' | 'testnet'>('testnet');
  const [walletType, setWalletType] = useState<'eth' | 'solana' | 'both'>('both');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setResult(null);
    setLoading(true);

    try {
      const token = localStorage.getItem('token');
      const response = await fetch('/api/wallet/multisig', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          firstPrivateKey,
          secondPrivateKey,
          network,
          walletType,
        }),
      });

      const data = await response.json();

      if (data.success) {
        setResult(data.data);
      } else {
        setError(data.error || 'An error occurred');
      }
    } catch (err) {
      setError('Network error. Please try again.');
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

      <h1>Create Multisig Wallet</h1>
      <p style={{ color: '#666', marginTop: '0.5rem', marginBottom: '2rem' }}>
        Create 2-of-2 multisig wallets (both signers required)
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

        <div className="form-group">
          <label>Wallet Type</label>
          <select value={walletType} onChange={(e) => setWalletType(e.target.value as 'eth' | 'solana' | 'both')}>
            <option value="eth">ETH Only</option>
            <option value="solana">Solana Only</option>
            <option value="both">Both</option>
          </select>
        </div>

        {error && <div className="error">{error}</div>}
        {result && (
          <div className="success">
            <h3>✅ Multisig Created Successfully!</h3>
            <p style={{ color: '#666', marginTop: '0.5rem', marginBottom: '1rem' }}>
              Your 2-of-2 multisig wallet requires both signers to approve transactions.
            </p>

            {result.ethMultisig && (
              <div className="card" style={{ marginTop: '1rem', background: 'white', padding: '1.5rem' }}>
                <h4 style={{ marginTop: 0 }}>🔷 ETH Multisig Wallet</h4>
                <div style={{ marginTop: '1rem' }}>
                  <p>
                    <strong>Multisig Address:</strong>{' '}
                    <a 
                      href={`https://${network === 'mainnet' ? 'etherscan.io' : 'sepolia.etherscan.io'}/address/${result.ethMultisig.address}`} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      style={{ color: '#667eea', wordBreak: 'break-all' }}
                    >
                      {result.ethMultisig.address}
                    </a>
                  </p>
                  <p><strong>Threshold:</strong> {result.ethMultisig.threshold} of {result.ethMultisig.signers.length} signers required</p>
                  <p><strong>Signers ({result.ethMultisig.signers.length}):</strong></p>
                  <ul style={{ marginLeft: '1.5rem', marginTop: '0.5rem' }}>
                    {result.ethMultisig.signers.map((signer: string, idx: number) => (
                      <li key={idx} style={{ marginBottom: '0.25rem' }}>
                        <a 
                          href={`https://${network === 'mainnet' ? 'etherscan.io' : 'sepolia.etherscan.io'}/address/${signer}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: '#667eea', fontFamily: 'monospace', fontSize: '0.9rem' }}
                        >
                          {signer}
                        </a>
                      </li>
                    ))}
                  </ul>
                  <p style={{ marginTop: '1rem' }}>
                    <strong>Creation Transaction:</strong>{' '}
                    <a 
                      href={result.ethMultisig.transactionHash.includes('http') ? result.ethMultisig.transactionHash : `https://${network === 'mainnet' ? 'etherscan.io' : 'sepolia.etherscan.io'}/tx/${result.ethMultisig.transactionHash}`} 
                      target="_blank" 
                      rel="noopener noreferrer"
                      style={{ color: '#667eea', fontFamily: 'monospace', fontSize: '0.9rem' }}
                    >
                      {result.ethMultisig.transactionHash}
                    </a>
                  </p>
                </div>
              </div>
            )}

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

            <div className="card" style={{ marginTop: '1.5rem', background: '#f0f4ff', padding: '1.5rem', border: '1px solid #667eea' }}>
              <h4 style={{ marginTop: 0, color: '#667eea' }}>📖 How to Use Your Multisig Wallet</h4>
              <div style={{ marginTop: '1rem' }}>
                <p><strong>To send transactions from your multisig wallet:</strong></p>
                <ol style={{ marginLeft: '1.5rem', marginTop: '0.5rem' }}>
                  <li style={{ marginBottom: '0.5rem' }}>Go to <Link href="/send-transaction" style={{ color: '#667eea' }}>Send Transaction</Link> page</li>
                  <li style={{ marginBottom: '0.5rem' }}>Enter the <strong>first signer's private key</strong> in "Signer Private Key"</li>
                  <li style={{ marginBottom: '0.5rem' }}>Enter the <strong>second signer's private key</strong> in "Second Signer Private Key" (required for multisig)</li>
                  <li style={{ marginBottom: '0.5rem' }}>Enter recipient address and amount</li>
                  <li style={{ marginBottom: '0.5rem' }}>Select the same network ({network})</li>
                  <li>Click "Send Transaction" - both signatures will be collected automatically</li>
                </ol>
                <p style={{ marginTop: '1rem', padding: '0.75rem', background: '#fff', borderRadius: '4px', border: '1px solid #ddd' }}>
                  <strong>⚠️ Important:</strong> Both private keys are required for multisig transactions. 
                  The transaction will only execute if both signers approve it.
                </p>
              </div>
            </div>
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

