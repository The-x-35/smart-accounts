import { NextRequest, NextResponse } from 'next/server';
import { Transaction, PublicKey } from '@solana/web3.js';
import { getFeePayer } from '@/lib/config/fee-payers';
import { Network } from '@/types/api';
import { sendAndConfirmTransaction } from '@solana/web3.js';
import { getSolanaRpc } from '@/lib/config/networks';
import { Connection } from '@solana/web3.js';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { transactionBase64, network = 'testnet' } = body;

    if (!transactionBase64) {
      return NextResponse.json(
        { success: false, error: 'Transaction is required' },
        { status: 400 }
      );
    }

    // Get fee payer for the network
    const feePayer = getFeePayer(network as Network);
    if (!feePayer) {
      return NextResponse.json(
        { success: false, error: `Fee payer not configured for ${network}` },
        { status: 500 }
      );
    }

    // Get Solana connection
    const rpcUrl = getSolanaRpc(network as Network);
    const connection = new Connection(rpcUrl, 'confirmed');

    // Deserialize transaction
    const transaction = Transaction.from(Buffer.from(transactionBase64, 'base64'));

    // Get fresh blockhash
    const { blockhash } = await connection.getLatestBlockhash('confirmed');

    // Update blockhash (fee payer is already set in frontend)
    transaction.recentBlockhash = blockhash;

    // Sign and send transaction
    const signature = await sendAndConfirmTransaction(
      connection,
      transaction,
      [feePayer.solanaKeypair],
      { commitment: 'confirmed' }
    );

    return NextResponse.json({
      success: true,
      data: {
        signature,
        explorerUrl: `https://www.orbmarkets.io/tx/${signature}`,
      },
    });
  } catch (error: any) {
    console.error('Error signing transaction:', error);
    return NextResponse.json(
      {
        success: false,
        error: error.message || 'Failed to sign transaction',
      },
      { status: 500 }
    );
  }
}

