import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth/middleware';
import { createSwigMultisig } from '@/lib/swig/swig-client';
import { createZeroDevMultisig } from '@/lib/zerodev/zerodev-client';
import { privateKeyToAccount } from 'viem/accounts';
import {
  isValidPrivateKey,
  validateNetwork,
  validateWalletType,
} from '@/lib/utils/validation';
import { ValidationError, handleError } from '@/lib/utils/errors';
import {
  ApiResponse,
  CreateMultisigRequest,
  MultisigResponse,
  Network,
  WalletType,
} from '@/types/api';

export async function POST(
  request: NextRequest
): Promise<NextResponse<ApiResponse<MultisigResponse>>> {
  try {
    // Authenticate request
    authenticateRequest(request);

    const body: CreateMultisigRequest = await request.json();
    const { firstPrivateKey, secondPrivateKey, network = 'mainnet', walletType } = body;

    // Validate input
    if (!firstPrivateKey || !secondPrivateKey) {
      throw new ValidationError('Both private keys are required');
    }

    if (!isValidPrivateKey(firstPrivateKey) || !isValidPrivateKey(secondPrivateKey)) {
      throw new ValidationError('Invalid private key format');
    }

    if (!validateNetwork(network)) {
      throw new ValidationError('Invalid network. Must be "mainnet" or "testnet"');
    }

    if (!validateWalletType(walletType)) {
      throw new ValidationError('Invalid wallet type. Must be "eth", "solana", or "both"');
    }

    // Format private keys
    const formattedFirstKey = firstPrivateKey.startsWith('0x')
      ? firstPrivateKey
      : `0x${firstPrivateKey}`;
    const formattedSecondKey = secondPrivateKey.startsWith('0x')
      ? secondPrivateKey
      : `0x${secondPrivateKey}`;

    // Get addresses
    const firstAccount = privateKeyToAccount(formattedFirstKey as `0x${string}`);
    const secondAccount = privateKeyToAccount(formattedSecondKey as `0x${string}`);

    const result: MultisigResponse = {};

    // Create ETH multisig if requested
    if (walletType === 'eth' || walletType === 'both') {
      try {
        const ethMultisig = await createZeroDevMultisig(
          formattedFirstKey,
          formattedSecondKey,
          network as Network
        );
        result.ethMultisig = {
          address: ethMultisig.address,
          threshold: ethMultisig.threshold,
          signers: ethMultisig.signers,
          transactionHash: ethMultisig.transactionHash,
        };
      } catch (error) {
        // If ETH multisig fails, continue with Solana if requested
        if (walletType === 'eth') {
          throw error;
        }
      }
    }

    // Create Solana multisig if requested
    if (walletType === 'solana' || walletType === 'both') {
      try {
        const solanaMultisig = await createSwigMultisig(
          formattedFirstKey,
          formattedSecondKey,
          network as Network
        );
        result.solanaMultisig = {
          address: solanaMultisig.walletAddress, // System Program owned account - USE THIS for receiving SOL/SPL tokens
          configurationAddress: solanaMultisig.address, // PDA configuration account (for reference)
          threshold: solanaMultisig.requiredSignatures,
          signers: solanaMultisig.signers.map(s => s.evmAddress),
          transactionHash: solanaMultisig.transactionSignature,
        };
      } catch (error) {
        // If Solana multisig fails, continue if ETH was successful
        if (walletType === 'solana') {
          throw error;
        }
      }
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

