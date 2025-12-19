import Link from 'next/link';

export default function Home() {
  return (
    <div className="container">
      <h1>Swig Smart Wallet API</h1>
      <p style={{ marginTop: '1rem', marginBottom: '2rem', color: '#666' }}>
        Create and manage Swig smart wallets on Ethereum and Solana
      </p>

      <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem' }}>
        <Link href="/login" className="btn">
          Login
        </Link>
        <Link href="/dashboard" className="btn btn-secondary">
          Dashboard
        </Link>
      </div>

      <div className="card">
        <h3>Features</h3>
        <ul style={{ marginTop: '1rem', paddingLeft: '1.5rem' }}>
          <li>Create ETH and Solana smart wallets from private keys</li>
          <li>Create 2-of-2 multisig wallets</li>
          <li>Send ETH and SOL transactions</li>
          <li>Fee sponsorship for transactions</li>
          <li>JWT authentication</li>
        </ul>
      </div>

      <div className="card" style={{ marginTop: '1rem' }}>
        <h3>API Endpoints</h3>
        <ul style={{ marginTop: '1rem', paddingLeft: '1.5rem' }}>
          <li>
            <strong>POST /api/wallet/create</strong> - Create wallets from ETH private key
          </li>
          <li>
            <strong>POST /api/wallet/multisig</strong> - Create 2-of-2 multisig wallets
          </li>
          <li>
            <strong>POST /api/wallet/send</strong> - Send ETH or SOL transactions
          </li>
        </ul>
      </div>
    </div>
  );
}

