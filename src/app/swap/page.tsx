'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import ProtectedRoute from '@/components/ProtectedRoute';
import { ApiResponse, SwapQuoteResponse, SwapExecuteResponse, SwapPriceResponse, Network } from '@/types/api';
import { TOKENS } from '@/lib/utils/token-resolver';

const COMMON_TOKENS = ['SOL', 'USDC', 'USDT', 'BONK', 'RAY'];

function SwapContent() {
  const [privateKey, setPrivateKey] = useState('');
  const [secondPrivateKey, setSecondPrivateKey] = useState('');
  const [inputToken, setInputToken] = useState('SOL');
  const [outputToken, setOutputToken] = useState('USDC');
  const [amount, setAmount] = useState('');
  const [network, setNetwork] = useState<Network>('testnet');
  const [useJitoBundle, setUseJitoBundle] = useState(false);
  const [loading, setLoading] = useState(false);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quote, setQuote] = useState<SwapQuoteResponse | null>(null);
  const [result, setResult] = useState<SwapExecuteResponse | null>(null);
  const [error, setError] = useState('');
  const [inputPrice, setInputPrice] = useState<number | null>(null);
  const [outputPrice, setOutputPrice] = useState<number | null>(null);
  const [priceLoading, setPriceLoading] = useState(false);

  // Fetch prices when tokens change
  useEffect(() => {
    fetchPrices();
  }, [inputToken, outputToken]);

  // Fetch quote when inputs change
  useEffect(() => {
    if (amount && parseFloat(amount) > 0 && inputToken && outputToken) {
      const timeoutId = setTimeout(() => {
        fetchQuote();
      }, 500); // Debounce

      return () => clearTimeout(timeoutId);
    } else {
      setQuote(null);
    }
  }, [amount, inputToken, outputToken, network]);

  const fetchPrices = async () => {
    setPriceLoading(true);
    try {
      const token = localStorage.getItem('token');
      if (!token) return;

      // Get mint addresses for tokens
      const inputMint = TOKENS[inputToken]?.mint || inputToken;
      const outputMint = TOKENS[outputToken]?.mint || outputToken;

      // Fetch both prices in parallel
      const [inputResponse, outputResponse] = await Promise.all([
        fetch(`/api/swap/price?tokenId=${inputMint}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        fetch(`/api/swap/price?tokenId=${outputMint}`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
      ]);

      const inputData: ApiResponse<SwapPriceResponse> = await inputResponse.json();
      const outputData: ApiResponse<SwapPriceResponse> = await outputResponse.json();

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

    setQuoteLoading(true);
    setError('');

    try {
      const token = localStorage.getItem('token');
      const response = await fetch(
        `/api/swap/quote?inputToken=${inputToken}&outputToken=${outputToken}&amount=${amount}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      const data: ApiResponse<SwapQuoteResponse> = await response.json();

      if (data.success && data.data) {
        setQuote(data.data);
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

    try {
      const token = localStorage.getItem('token');
      if (!token) {
        setError('Authentication token missing. Please log in again.');
        setLoading(false);
        return;
      }

      const response = await fetch('/api/swap/execute', {
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
          useJitoBundle,
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
          <p style={{ fontSize: '0.85rem', color: '#777', marginTop: '0.5rem' }}>
            You can also enter a mint address directly.
          </p>
        </div>

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
              {outputPrice !== null && (
                <span style={{ marginLeft: '0.5rem', color: '#666' }}>
                  (≈ ${(quote.outputAmount * outputPrice).toFixed(2)})
                </span>
              )}
            </p>
            <p>
              <strong>Price Impact:</strong> {quote.priceImpact ? `${parseFloat(quote.priceImpact.toString()).toFixed(4)}%` : 'N/A'}
            </p>
            {inputPrice !== null && outputPrice !== null && (
              <p style={{ fontSize: '0.9rem', color: '#555', marginTop: '0.5rem' }}>
                <strong>Exchange Rate:</strong> 1 {inputToken} = {(outputPrice / inputPrice).toFixed(6)} {outputToken}
              </p>
            )}
            <p style={{ fontSize: '0.85rem', color: '#777', marginTop: '0.5rem' }}>
              Slippage tolerance: 0.5%
            </p>
          </div>
        )}

        <div className="form-group">
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input
              type="checkbox"
              checked={useJitoBundle}
              onChange={(e) => setUseJitoBundle(e.target.checked)}
            />
            Use Jito Bundle (for faster execution of large transactions)
          </label>
        </div>

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

