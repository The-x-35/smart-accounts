'use client';

import { useState } from 'react';
import Link from 'next/link';
import ProtectedRoute from '@/components/ProtectedRoute';

function CreateWalletContent() {
  const [ethPrivateKey, setEthPrivateKey] = useState('');
  const [network, setNetwork] = useState<'mainnet' | 'testnet'>('testnet');
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
      const response = await fetch('/api/wallet/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          ethPrivateKey,
          network,
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

      <h1>Create Smart Wallet</h1>
      <p style={{ color: '#666', marginTop: '0.5rem', marginBottom: '2rem' }}>
        Create ETH and Solana smart wallets from an Ethereum private key
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
              <p><strong>ETH Smart Wallet:</strong> {result.ethSmartWallet}</p>
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
          {loading ? 'Creating Wallets...' : 'Create Wallets'}
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

