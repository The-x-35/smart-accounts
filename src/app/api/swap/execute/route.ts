import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth/middleware';
import { executeSwapWithSwig } from '@/lib/swig/swap-client';
import {
  isValidPrivateKey,
  isValidAmount,
  validateNetwork,
} from '@/lib/utils/validation';
import { ValidationError, handleError } from '@/lib/utils/errors';
import {
  ApiResponse,
  SwapExecuteRequest,
  SwapExecuteResponse,
  Network,
} from '@/types/api';

export async function POST(
  request: NextRequest
): Promise<NextResponse<ApiResponse<SwapExecuteResponse>>> {
  try {
    // Authenticate request
    authenticateRequest(request);

    const body: SwapExecuteRequest = await request.json();
    const {
      privateKey,
      secondPrivateKey,
      inputToken,
      outputToken,
      amount,
      network = 'mainnet',
      useJitoBundle = false,
    } = body;

    // Validate input
    if (!privateKey) {
      throw new ValidationError('Private key is required');
    }

    if (!isValidPrivateKey(privateKey)) {
      throw new ValidationError('Invalid private key format');
    }

    if (secondPrivateKey && !isValidPrivateKey(secondPrivateKey)) {
      throw new ValidationError('Invalid second private key format');
    }

    if (!inputToken || !outputToken) {
      throw new ValidationError('Input and output tokens are required');
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

    // Format private key
    const formattedPrivateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    const formattedSecondKey = secondPrivateKey
      ? secondPrivateKey.startsWith('0x')
        ? secondPrivateKey
        : `0x${secondPrivateKey}`
      : undefined;

    // Execute swap
    const result = await executeSwapWithSwig(
      formattedPrivateKey,
      formattedSecondKey,
      inputToken,
      outputToken,
      amount,
      network as Network,
      useJitoBundle
    );

    return NextResponse.json({
      success: true,
      data: {
        transactionHash: result.transactionSignature,
        explorerUrl: result.explorerUrl,
        inputAmount: result.inputAmount,
        inputToken: result.inputToken,
        outputAmount: result.outputAmount,
        outputToken: result.outputToken,
        timestamp: new Date().toISOString(),
      },
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

