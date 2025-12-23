import { NextRequest, NextResponse } from 'next/server';
import { Transaction, VersionedTransaction, PublicKey } from '@solana/web3.js';
import { getFeePayer } from '@/lib/config/fee-payers';
import { Network } from '@/types/api';
import { sendAndConfirmTransaction } from '@solana/web3.js';
import { getSolanaRpc } from '@/lib/config/networks';
import { Connection } from '@solana/web3.js';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      transactionBase64,
      network = 'testnet',
      isVersioned = false,
      feePayerPublicKey,
    } = body;

    console.log('\n=== TRANSACTION SIGN REQUEST ===');
    console.log('isVersioned:', isVersioned);
    console.log('has transactionBase64:', !!transactionBase64);
    console.log('has instructions:', !!body.instructions);
    console.log('network:', network);

    // Get fee payer for the network
    const feePayer = getFeePayer(network as Network);
    if (!feePayer) {
      return NextResponse.json(
        { success: false, error: `Fee payer not configured for ${network}` },
        { status: 500 }
      );
    }

    // Optional override (e.g., use wallet as payer)
    let overridePayer: PublicKey | null = null;
    if (feePayerPublicKey) {
      try {
        overridePayer = new PublicKey(feePayerPublicKey);
      } catch (err) {
        console.error('Invalid feePayerPublicKey provided:', feePayerPublicKey);
        return NextResponse.json(
          { success: false, error: 'Invalid feePayerPublicKey' },
          { status: 400 }
        );
      }
    }

    // Get Solana connection
    const rpcUrl = getSolanaRpc(network as Network);
    const connection = new Connection(rpcUrl, 'confirmed');

    if (isVersioned) {
      // Handle VersionedTransaction
      // Frontend sends: { instructions, lookupTableAddresses, isVersioned: true }
      const { instructions, lookupTableAddresses } = body;
      
      console.log('Versioned transaction - instructions count:', instructions?.length);
      console.log('Lookup table addresses:', lookupTableAddresses?.length || 0);
      
      if (!instructions || !Array.isArray(instructions)) {
        console.error('Missing or invalid instructions array');
        return NextResponse.json(
          { success: false, error: 'Instructions array is required for versioned transaction' },
          { status: 400 }
        );
      }
      
      // Get fresh blockhash
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');
      
      // Fetch lookup tables if provided
      const lookupTables = lookupTableAddresses && Array.isArray(lookupTableAddresses)
        ? await Promise.all(
            lookupTableAddresses.map(async (addr: string) => {
              const res = await connection.getAddressLookupTable(new PublicKey(addr));
              if (!res.value) {
                throw new Error(`Address Lookup Table ${addr} not found`);
              }
              return res.value;
            })
          )
        : [];
      
      // Import TransactionMessage and VersionedTransaction
      const { TransactionMessage, VersionedTransaction } = await import('@solana/web3.js');
      
      // Rebuild instructions from serialized format
      const { TransactionInstruction } = await import('@solana/web3.js');
      const rebuiltInstructions = instructions.map((ix: any) => 
        new TransactionInstruction({
          programId: new PublicKey(ix.programId),
          keys: ix.keys.map((k: any) => ({
            pubkey: new PublicKey(k.pubkey),
            isSigner: k.isSigner,
            isWritable: k.isWritable,
          })),
          data: Buffer.from(ix.data, 'base64'),
        })
      );
      
      // Create versioned transaction message
      const payerKey = overridePayer || feePayer.solanaKeypair.publicKey;
      const messageV0 = new TransactionMessage({
        payerKey,
        recentBlockhash: blockhash,
        instructions: rebuiltInstructions,
      }).compileToV0Message(lookupTables);
      
      // Create and sign versioned transaction
      const tx = new VersionedTransaction(messageV0);
      if (!overridePayer || overridePayer.equals(feePayer.solanaKeypair.publicKey)) {
        tx.sign([feePayer.solanaKeypair]);
      } else {
        console.error('Fee payer override provided but server lacks its private key');
        return NextResponse.json(
          { success: false, error: 'Fee payer override not available on server' },
          { status: 400 }
        );
      }
      
      // Send transaction
      const signature = await connection.sendTransaction(tx, {
        skipPreflight: true,
        preflightCommitment: 'confirmed',
      });
      
      // Confirm transaction
      await connection.confirmTransaction({
        signature,
        blockhash,
        lastValidBlockHeight,
      }, 'confirmed');

      return NextResponse.json({
        success: true,
        data: {
          signature,
          explorerUrl: `https://www.orbmarkets.io/tx/${signature}`,
        },
      });
    } else {
      // Handle regular Transaction
      if (!transactionBase64) {
        console.error('Missing transactionBase64 for regular transaction');
        return NextResponse.json(
          { success: false, error: 'Transaction is required' },
          { status: 400 }
        );
      }
      
      console.log('Regular transaction - deserializing...');
      const transaction = Transaction.from(Buffer.from(transactionBase64, 'base64'));

      // Get fresh blockhash
      const { blockhash } = await connection.getLatestBlockhash('confirmed');

      // Update blockhash and fee payer
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = overridePayer || feePayer.solanaKeypair.publicKey;

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
    }
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

