import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth/middleware';
import { resolveTokenParam } from '@/lib/utils/token-resolver';
import { getSwigAddressFromPrivateKey } from '@/lib/swig/swap-client';
import {
  isValidPrivateKey,
  isValidAmount,
  validateNetwork,
} from '@/lib/utils/validation';
import { ValidationError, handleError } from '@/lib/utils/errors';
import { Network } from '@/types/api';

const RELAY_API_URL = 'https://api.relay.link/quote';
const SOLANA_CHAIN_ID = 792703809;

export async function POST(request: NextRequest) {
  try {
    // Authenticate request
    authenticateRequest(request);

    const body = await request.json();
    const {
      privateKey,
      inputToken,
      outputToken,
      amount,
      network = 'mainnet',
      recipient,
    } = body;

    // Validate input
    if (!privateKey) {
      throw new ValidationError('Private key is required');
    }

    if (!isValidPrivateKey(privateKey)) {
      throw new ValidationError('Invalid private key format');
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

    // Get Swig wallet address from private key
    const { swigAddress } = getSwigAddressFromPrivateKey(formattedPrivateKey);
    const recipientAddress = recipient || swigAddress.toBase58();

    // Resolve tokens
    const inputResolved = await resolveTokenParam(inputToken, 'SOL');
    const outputResolved = await resolveTokenParam(outputToken, 'USDC');

    // Convert amount to smallest unit
    const inputDecimals = inputResolved.decimals || 9;
    const scaledAmount = Math.floor(parseFloat(amount) * Math.pow(10, inputDecimals));

    // Build Relay quote request
    const relayQuoteRequest = {
      user: swigAddress.toBase58(),
      originChainId: SOLANA_CHAIN_ID,
      destinationChainId: SOLANA_CHAIN_ID,
      originCurrency: inputResolved.mint,
      destinationCurrency: outputResolved.mint,
      recipient: recipientAddress,
      tradeType: 'EXACT_INPUT',
      amount: scaledAmount.toString(),
      referrer: 'relay.link',
      useDepositAddress: false,
      topupGas: false,
    };

    console.log('Fetching Relay quote:', relayQuoteRequest);

    // Call Relay API
    const response = await fetch(RELAY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(relayQuoteRequest),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Relay quote error:', errorText);
      return NextResponse.json(
        { error: `Failed to fetch Relay quote: ${errorText}` },
        { status: response.status }
      );
    }

    const quoteData = await response.json();

    // Calculate output amount in human-readable format
    const outputDecimals = outputResolved.decimals || 6;
    const outputAmountRaw = quoteData.details?.currencyOut?.amount || '0';
    const outputAmount = parseFloat(outputAmountRaw) / Math.pow(10, outputDecimals);

    return NextResponse.json({
      success: true,
      data: {
        inputAmount: parseFloat(amount),
        inputToken: inputResolved.symbol,
        outputAmount,
        outputToken: outputResolved.symbol,
        priceImpact: quoteData.details?.totalImpact?.percent || 0,
        quote: quoteData,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Error fetching Relay quote:', error);
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

