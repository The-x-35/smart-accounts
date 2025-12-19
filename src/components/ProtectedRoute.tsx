'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

// Cache auth state to avoid repeated checks
let authCache: { token: string | null; isValid: boolean; timestamp: number } = {
  token: null,
  isValid: false,
  timestamp: 0,
};

const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

export default function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkAuth = async () => {
      const token = localStorage.getItem('token');
      if (!token) {
        authCache = { token: null, isValid: false, timestamp: 0 };
        router.push('/login');
        return;
      }

      // Check cache first
      const now = Date.now();
      if (
        authCache.token === token &&
        authCache.isValid &&
        now - authCache.timestamp < CACHE_DURATION
      ) {
        setIsAuthenticated(true);
        setLoading(false);
        return;
      }

      try {
        const response = await fetch('/api/auth/verify', {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (response.ok) {
          // Update cache
          authCache = { token, isValid: true, timestamp: now };
          setIsAuthenticated(true);
        } else if (response.status === 401 || response.status === 403 || response.status === 404) {
          // Only log out on actual auth failures (401, 403) or user not found (404)
          authCache = { token: null, isValid: false, timestamp: 0 };
          localStorage.removeItem('token');
          localStorage.removeItem('user');
          router.push('/login');
        } else {
          // For other errors (500, network issues), use cached state if available
          console.warn('Auth verification returned non-200 status:', response.status);
          if (authCache.isValid && authCache.token === token) {
            setIsAuthenticated(true); // Use cached valid state
          } else {
            setIsAuthenticated(true); // Assume still authenticated on non-auth errors
          }
        }
      } catch (error) {
        // Network errors shouldn't log the user out
        // Use cached state if available
        console.warn('Auth verification error (using cached state):', error);
        if (authCache.isValid && authCache.token === token) {
          setIsAuthenticated(true); // Use cached valid state
        } else {
          setIsAuthenticated(true); // Assume still authenticated on network errors
        }
      } finally {
        setLoading(false);
      }
    };

    checkAuth();
  }, [router]);

  if (loading) {
    return (
      <div className="container">
        <div className="loading">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return <>{children}</>;
}

