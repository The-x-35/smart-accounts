import { VersionedTransaction } from '@solana/web3.js';

// Jito API endpoints
const JITO_BLOCK_ENGINE_URL = process.env.JITO_BLOCK_ENGINE_URL || 'https://mainnet.block-engine.jito.wtf';
const JITO_BUNDLE_API = `${JITO_BLOCK_ENGINE_URL}/api/v1/bundles`;

export interface JitoBundleOptions {
  tipAmount?: number; // Tip amount in lamports (default: 10,000)
}

/**
 * Create a Jito bundle from a transaction
 * This wraps the transaction in a bundle for faster execution
 */
export async function createJitoBundle(
  transaction: VersionedTransaction,
  options: JitoBundleOptions = {}
): Promise<VersionedTransaction> {
  try {
    const tipAmount = options.tipAmount || 10_000; // Default 0.00001 SOL tip

    // Serialize the transaction
    const serializedTx = Buffer.from(transaction.serialize()).toString('base64');

    // Create bundle payload
    const bundlePayload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [
        [serializedTx], // Array of base64-encoded transactions
        {
          tipAccount: '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', // Jito tip account
          tipAmount,
        },
      ],
    };

    // Send bundle to Jito
    const response = await fetch(JITO_BUNDLE_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(bundlePayload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Jito bundle failed: ${errorText}`);
    }

    const result = await response.json();

    if (result.error) {
      throw new Error(`Jito bundle error: ${JSON.stringify(result.error)}`);
    }

    // Return the original transaction (bundle is handled by Jito)
    // The transaction will be included in the next Jito bundle
    return transaction;
  } catch (error) {
    // If Jito bundle fails, log and return original transaction
    // The caller can fallback to regular transaction
    console.warn('Jito bundle creation failed, falling back to regular transaction:', error);
    throw error;
  }
}

/**
 * Check if Jito bundle should be used based on transaction size
 */
export function shouldUseJitoBundle(transactionSize: number): boolean {
  // Use Jito if transaction is large (close to Solana's transaction size limit)
  // Solana transaction size limit is ~1232 bytes
  return transactionSize > 1000;
}

