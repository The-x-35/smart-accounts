import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth/middleware';
import { transferSOLWithSwig } from '@/lib/swig/swig-client';
import { sendETHTransaction } from '@/lib/zerodev/zerodev-client';
import {
  isValidPrivateKey,
  isValidEthereumAddress,
  isValidSolanaAddress,
  isValidAmount,
  validateNetwork,
} from '@/lib/utils/validation';
import { ValidationError, handleError } from '@/lib/utils/errors';
import {
  ApiResponse,
  SendTransactionRequest,
  TransactionResponse,
  Network,
} from '@/types/api';

export async function POST(
  request: NextRequest
): Promise<NextResponse<ApiResponse<TransactionResponse>>> {
  try {
    // Authenticate request
    authenticateRequest(request);

    const body: SendTransactionRequest = await request.json();
    const {
      privateKey,
      walletType,
      recipient,
      amount,
      network = 'mainnet',
      secondPrivateKey,
    } = body;

    // Validate input
    if (!privateKey) {
      throw new ValidationError('Private key is required');
    }

    if (!isValidPrivateKey(privateKey)) {
      throw new ValidationError('Invalid private key format');
    }

    if (!recipient) {
      throw new ValidationError('Recipient address is required');
    }

    if (!amount) {
      throw new ValidationError('Amount is required');
    }

    if (!isValidAmount(amount)) {
      throw new ValidationError('Invalid amount');
    }

    if (!validateNetwork(network)) {
      throw new ValidationError('Invalid network. Must be "mainnet" or "testnet"');
    }

    if (walletType !== 'eth' && walletType !== 'solana') {
      throw new ValidationError('Invalid wallet type. Must be "eth" or "solana"');
    }

    // Format private key
    const formattedPrivateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;

    let result: TransactionResponse;

    if (walletType === 'eth') {
      // Validate recipient address
      if (!isValidEthereumAddress(recipient)) {
        throw new ValidationError('Invalid Ethereum recipient address');
      }

      // For multisig, both private keys are required
      const privateKeys = secondPrivateKey
        ? [formattedPrivateKey, secondPrivateKey.startsWith('0x') ? secondPrivateKey : `0x${secondPrivateKey}`]
        : [formattedPrivateKey];

      // Validate second private key if provided
      if (secondPrivateKey && !isValidPrivateKey(secondPrivateKey)) {
        throw new ValidationError('Invalid second private key format');
      }

      const transferResult = await sendETHTransaction(
        privateKeys,
        recipient,
        amount,
        network as Network
      );

      result = {
        transactionHash: transferResult.transactionHash,
        explorerUrl: transferResult.explorerUrl,
        amount,
        recipient,
        network,
      };
    } else {
      // Solana transfer
      if (!isValidSolanaAddress(recipient)) {
        throw new ValidationError('Invalid Solana recipient address');
      }

      // For Solana multisig, we need the swigId
      // For now, we'll use a deterministic approach
      // In production, you'd store the swigId when creating the wallet
      const { privateKeyToAccount } = await import('viem/accounts');
      const account = privateKeyToAccount(formattedPrivateKey as `0x${string}`);
      
      // Create deterministic swigId (same as in swig-client)
      const cleanAddress = account.address.startsWith('0x') ? account.address.slice(2) : account.address;
      const encoder = new TextEncoder();
      const data = encoder.encode(cleanAddress);
      const hash = new Uint8Array(32);
      let hashIndex = 0;
      for (let i = 0; i < data.length; i++) {
        hash[hashIndex] ^= data[i];
        hashIndex = (hashIndex + 1) % 32;
      }
      for (let i = 0; i < data.length; i++) {
        hash[hashIndex] ^= data[data.length - 1 - i];
        hashIndex = (hashIndex + 1) % 32;
      }
      const swigId = Array.from(hash);

      // Convert amount from SOL to lamports
      const amountLamports = Math.floor(parseFloat(amount) * 1_000_000_000);

      // Format second private key if provided (for multisig)
      const formattedSecondKey = secondPrivateKey
        ? (secondPrivateKey.startsWith('0x') ? secondPrivateKey : `0x${secondPrivateKey}`)
        : undefined;

      // Validate second private key if provided
      if (secondPrivateKey && !isValidPrivateKey(secondPrivateKey)) {
        throw new ValidationError('Invalid second private key format');
      }

      const transferResult = await transferSOLWithSwig(
        formattedPrivateKey,
        swigId,
        recipient,
        amountLamports,
        network as Network,
        formattedSecondKey // Pass second private key for multisig
      );

      result = {
        transactionHash: transferResult.transactionSignature,
        explorerUrl: transferResult.explorerUrl,
        amount,
        recipient,
        network,
      };
    }

    return NextResponse.json({
      success: true,
      data: result,
    });
  } catch (error) {
    const { message, statusCode } = handleError(error);
    return NextResponse.json(
      {
        success: false,
        error: message,
      },
      { status: statusCode }
    );
  }
}

