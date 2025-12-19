'use client';

import { useState } from 'react';
import Link from 'next/link';
import ProtectedRoute from '@/components/ProtectedRoute';

function SendTransactionContent() {
  const [privateKey, setPrivateKey] = useState('');
  const [secondPrivateKey, setSecondPrivateKey] = useState('');
  const [walletType, setWalletType] = useState<'eth' | 'solana'>('eth');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
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
      const body: any = {
        privateKey,
        walletType,
        recipient,
        amount,
        network,
      };

      // Add second private key if provided (for multisig)
      if (secondPrivateKey) {
        body.secondPrivateKey = secondPrivateKey;
      }

      const response = await fetch('/api/wallet/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
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

      <h1>Send Transaction</h1>
      <p style={{ color: '#666', marginTop: '0.5rem', marginBottom: '1rem' }}>
        Send ETH or SOL from your smart wallet
      </p>
      <div className="card" style={{ background: '#f0f4ff', padding: '1rem', marginBottom: '2rem', border: '1px solid #667eea' }}>
        <p style={{ margin: 0, fontSize: '0.9rem' }}>
          <strong>💡 For Multisig Wallets:</strong> Enter both private keys below. 
          For regular wallets, only enter the first private key.
        </p>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="form-group">
          <label>Wallet Type</label>
          <select value={walletType} onChange={(e) => setWalletType(e.target.value as 'eth' | 'solana')}>
            <option value="eth">ETH</option>
            <option value="solana">SOL</option>
          </select>
        </div>

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
            placeholder={walletType === 'eth' ? '0x...' : 'Solana address'}
            style={{ fontFamily: 'monospace' }}
          />
        </div>

        <div className="form-group">
          <label>Amount ({walletType === 'eth' ? 'ETH' : 'SOL'})</label>
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
              <p><strong>Amount:</strong> {result.amount} {walletType === 'eth' ? 'ETH' : 'SOL'}</p>
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

