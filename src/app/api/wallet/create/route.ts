import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth/middleware';
import { createSwigWallet } from '@/lib/swig/swig-client';
import { createZeroDevWallet } from '@/lib/zerodev/zerodev-client';
import { privateKeyToAccount } from 'viem/accounts';
import { isValidPrivateKey, validateNetwork } from '@/lib/utils/validation';
import { ValidationError, handleError } from '@/lib/utils/errors';
import { ApiResponse, CreateWalletRequest, WalletCreationResponse, Network } from '@/types/api';

export async function POST(
  request: NextRequest
): Promise<NextResponse<ApiResponse<WalletCreationResponse>>> {
  try {
    // Authenticate request
    authenticateRequest(request);

    const body: CreateWalletRequest = await request.json();
    const { ethPrivateKey, network = 'mainnet' } = body;

    // Validate input
    if (!ethPrivateKey) {
      throw new ValidationError('Ethereum private key is required');
    }

    if (!isValidPrivateKey(ethPrivateKey)) {
      throw new ValidationError('Invalid Ethereum private key format');
    }

    if (!validateNetwork(network)) {
      throw new ValidationError('Invalid network. Must be "mainnet" or "testnet"');
    }

    // Format private key
    const formattedPrivateKey = ethPrivateKey.startsWith('0x')
      ? ethPrivateKey
      : `0x${ethPrivateKey}`;

    // Get ETH address
    const evmAccount = privateKeyToAccount(formattedPrivateKey as `0x${string}`);
    const ethAddress = evmAccount.address;

    // Create wallets in parallel
    const [swigResult, zerodevResult] = await Promise.all([
      createSwigWallet(formattedPrivateKey, network as Network),
      createZeroDevWallet(formattedPrivateKey, network as Network),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        ethAddress,
        ethSmartWallet: zerodevResult.address,
        solanaAddress: swigResult.walletAddress, // System Program owned account - USE THIS for receiving SOL/SPL tokens
        solanaConfigurationAddress: swigResult.address, // PDA configuration account (for reference)
        swigId: swigResult.id,
        network,
        transactionHashes: {
          solana: swigResult.transactionSignature,
          // ETH wallet is deployed on first transaction, so no hash yet
        },
      },
    });
  } catch (error) {
    console.error('Error in /api/wallet/create:', error);
    const { message, statusCode } = handleError(error);
    return NextResponse.json(
      {
        success: false,
        error: message,
        ...(process.env.NODE_ENV === 'development' && error instanceof Error && {
          details: {
            name: error.name,
            stack: error.stack,
          },
        }),
      },
      { status: statusCode }
    );
  }
}

