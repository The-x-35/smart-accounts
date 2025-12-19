import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Swig Smart Wallet API',
  description: 'Create and manage Swig smart wallets',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

