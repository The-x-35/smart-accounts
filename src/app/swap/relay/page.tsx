'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import ProtectedRoute from '@/components/ProtectedRoute';
import { ApiResponse, SwapExecuteResponse, Network } from '@/types/api';
import { TOKENS } from '@/lib/utils/token-resolver';

const COMMON_TOKENS = ['SOL', 'USDC', 'USDT', 'BONK', 'RAY'];

interface RelayQuoteResponse {
  inputAmount: number;
  inputToken: string;
  outputAmount: number;
  outputToken: string;
  priceImpact: number;
  quote: any;
  timestamp: string;
}

function RelaySwapContent() {
  const [privateKey, setPrivateKey] = useState('');
  const [secondPrivateKey, setSecondPrivateKey] = useState('');
  const [inputToken, setInputToken] = useState('SOL');
  const [outputToken, setOutputToken] = useState('USDC');
  const [amount, setAmount] = useState('');
  const [network, setNetwork] = useState<Network>('testnet');
  const [recipient, setRecipient] = useState('');
  const [loading, setLoading] = useState(false);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quote, setQuote] = useState<RelayQuoteResponse | null>(null);
  const [result, setResult] = useState<SwapExecuteResponse | null>(null);
  const [error, setError] = useState('');

  // Fetch quote when inputs change
  useEffect(() => {
    if (amount && parseFloat(amount) > 0 && inputToken && outputToken && privateKey) {
      const timeoutId = setTimeout(() => {
        fetchQuote();
      }, 500); // Debounce

      return () => clearTimeout(timeoutId);
    } else {
      setQuote(null);
    }
  }, [amount, inputToken, outputToken, network, privateKey]);

  const fetchQuote = async () => {
    if (!amount || parseFloat(amount) <= 0 || !privateKey) return;

    setQuoteLoading(true);
    setError('');

    try {
      const token = localStorage.getItem('token');
      if (!token) {
        setError('Authentication token missing. Please log in again.');
        setQuoteLoading(false);
        return;
      }

      const response = await fetch('/api/swap/relay/quote', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          privateKey,
          inputToken,
          outputToken,
          amount,
          network,
          recipient: recipient || undefined,
        }),
      });

      const data: ApiResponse<RelayQuoteResponse> = await response.json();

      if (data.success && data.data) {
        setQuote(data.data);
      } else {
        setQuote(null);
        if (data.error) {
          console.error('Quote error:', data.error);
          setError(data.error);
        }
      }
    } catch (err: any) {
      console.error('Failed to fetch quote:', err);
      setQuote(null);
      setError(err.message || 'Failed to fetch quote');
    } finally {
      setQuoteLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setResult(null);
    setLoading(true);

    try {
      const token = localStorage.getItem('token');
      if (!token) {
        setError('Authentication token missing. Please log in again.');
        setLoading(false);
        return;
      }

      const response = await fetch('/api/swap/relay/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          privateKey,
          secondPrivateKey: secondPrivateKey || undefined,
          inputToken,
          outputToken,
          amount,
          network,
          recipient: recipient || undefined,
        }),
      });

      const data: ApiResponse<SwapExecuteResponse> = await response.json();

      if (data.success && data.data) {
        setResult(data.data);
      } else {
        setError(data.error || 'Failed to execute swap');
      }
    } catch (err: any) {
      setError(err.message || 'Network error');
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

      <h1>Relay Swap</h1>
      <p style={{ color: '#666', marginTop: '0.5rem', marginBottom: '2rem' }}>
        Swap tokens using your Swig wallet with Relay. Supports multisig wallets.
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
          <label>Network</label>
          <select value={network} onChange={(e) => setNetwork(e.target.value as Network)}>
            <option value="testnet">Testnet</option>
            <option value="mainnet">Mainnet</option>
          </select>
        </div>

        <div className="form-group">
          <label>Signer Private Key (First Key for Multisig)</label>
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
          <label>Second Signer Private Key (for 2-of-2 Multisig, optional)</label>
          <input
            type="text"
            value={secondPrivateKey}
            onChange={(e) => setSecondPrivateKey(e.target.value)}
            placeholder="e.g., 0x... (leave empty for single signer)"
            style={{ fontFamily: 'monospace' }}
          />
          <p style={{ fontSize: '0.85rem', color: '#777', marginTop: '0.5rem' }}>
            Provide this only if swapping from a 2-of-2 multisig wallet.
          </p>
        </div>

        <div className="form-group">
          <label>Input Token</label>
          <select value={inputToken} onChange={(e) => setInputToken(e.target.value)}>
            {COMMON_TOKENS.map((token) => (
              <option key={token} value={token}>
                {token}
              </option>
            ))}
          </select>
          <p style={{ fontSize: '0.85rem', color: '#777', marginTop: '0.5rem' }}>
            You can also enter a mint address directly.
          </p>
        </div>

        <div className="form-group">
          <label>Output Token</label>
          <select value={outputToken} onChange={(e) => setOutputToken(e.target.value)}>
            {COMMON_TOKENS.map((token) => (
              <option key={token} value={token}>
                {token}
              </option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label>Amount ({inputToken})</label>
          <input
            type="text"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            placeholder="e.g., 0.1"
          />
        </div>

        <div className="form-group">
          <label>Recipient Address (optional)</label>
          <input
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="Leave empty to use Swig wallet address"
            style={{ fontFamily: 'monospace' }}
          />
          <p style={{ fontSize: '0.85rem', color: '#777', marginTop: '0.5rem' }}>
            If not provided, tokens will be sent to your Swig wallet address.
          </p>
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
            {quote.quote?.details && (
              <>
                <p style={{ fontSize: '0.9rem', color: '#555', marginTop: '0.5rem' }}>
                  <strong>Rate:</strong> 1 {inputToken} = {quote.quote.details.rate} {outputToken}
                </p>
                {quote.quote.fees && (
                  <p style={{ fontSize: '0.85rem', color: '#777', marginTop: '0.5rem' }}>
                    <strong>Gas Fee:</strong> {quote.quote.fees.gas?.amountFormatted} {quote.quote.fees.gas?.currency.symbol}
                  </p>
                )}
              </>
            )}
          </div>
        )}

        <button type="submit" className="btn" disabled={loading || quoteLoading} style={{ width: '100%' }}>
          {loading ? 'Executing Swap...' : 'Execute Swap'}
        </button>
      </form>
    </div>
  );
}

export default function RelaySwapPage() {
  return (
    <ProtectedRoute>
      <RelaySwapContent />
    </ProtectedRoute>
  );
}

