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

    </div>
  );
}

