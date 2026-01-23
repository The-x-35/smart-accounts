'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import ProtectedRoute from '@/components/ProtectedRoute';

function DashboardContent() {
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    const userStr = localStorage.getItem('user');
    if (userStr) {
      setUser(JSON.parse(userStr));
    }
  }, []);

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/login';
  };

  return (
    <div className="container">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <h1>Dashboard</h1>
          {user && <p style={{ color: '#666', marginTop: '0.5rem' }}>Welcome, {user.email}</p>}
        </div>
        <button onClick={handleLogout} className="btn btn-secondary">
          Logout
        </button>
      </div>

      <nav className="nav">
        <Link href="/dashboard">Dashboard</Link>
        <Link href="/create-wallet">Create Wallet</Link>
        <Link href="/create-multisig">Create Multisig</Link>
        <Link href="/send-transaction">Send Transaction</Link>
        <Link href="/private-send">Private Send</Link>
        <Link href="/swap">Jupiter Swap</Link>
        <Link href="/swap/relay">Relay Swap</Link>
      </nav>

      <div className="card">
        <h3>Quick Actions</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '1rem', marginTop: '1rem' }}>
          <Link href="/create-wallet" className="btn" style={{ textAlign: 'center', display: 'block' }}>
            Create New Wallet
          </Link>
          <Link href="/create-multisig" className="btn" style={{ textAlign: 'center', display: 'block' }}>
            Create Multisig
          </Link>
          <Link href="/send-transaction" className="btn" style={{ textAlign: 'center', display: 'block' }}>
            Send Transaction
          </Link>
          <Link href="/swap" className="btn" style={{ textAlign: 'center', display: 'block' }}>
            Jupiter Swap
          </Link>
          <Link href="/swap/relay" className="btn" style={{ textAlign: 'center', display: 'block' }}>
            Relay Swap
          </Link>
        </div>
      </div>

    
    </div>
  );
}

export default function Dashboard() {
  return (
    <ProtectedRoute>
      <DashboardContent />
    </ProtectedRoute>
  );
}

