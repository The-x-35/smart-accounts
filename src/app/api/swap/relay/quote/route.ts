import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth/middleware';
import { resolveTokenParam } from '@/lib/utils/token-resolver';
import { findSwigPda } from '@swig-wallet/classic';
import { privateKeyToAccount } from 'viem/accounts';
import {
  isValidPrivateKey,
  isValidAmount,
  validateNetwork,
} from '@/lib/utils/validation';
import { ValidationError, handleError } from '@/lib/utils/errors';
import { Network } from '@/types/api';

const RELAY_API_URL = 'https://api.relay.link/quote';
const SOLANA_CHAIN_ID = 792703809;

/**
 * Create deterministic Swig ID from EVM address
 */
function createDeterministicSwigId(evmAddress: string): Uint8Array {
  const cleanAddress = evmAddress.startsWith('0x') ? evmAddress.slice(2) : evmAddress;
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
  
  return hash;
}

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

    // Trim and format private key before validation
    const trimmedKey = privateKey.trim();
    const formattedPrivateKey = trimmedKey.startsWith('0x') ? trimmedKey : `0x${trimmedKey}`;
    
    console.log('\n=== RELAY QUOTE API ===');
    console.log('Received private key length:', privateKey?.length || 0);
    console.log('Formatted private key length:', formattedPrivateKey.length);
    
    if (!isValidPrivateKey(formattedPrivateKey)) {
      console.error('Invalid private key format');
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

    // Get Swig address from private key (already formatted above)
    const evmAccount = privateKeyToAccount(formattedPrivateKey as `0x${string}`);
    const swigId = createDeterministicSwigId(evmAccount.address);
    const swigAddress = findSwigPda(swigId);
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

