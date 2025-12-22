import { NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth/middleware';
import { JUPITER_API, TOKENS, TOKEN_DECIMALS, JUPITER_API_KEY } from '@/lib/config/solana-config';
import { resolveTokenParam } from '@/lib/utils/token-resolver';

export async function GET(request: Request) {
  try {
    // Authenticate request
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      );
    }

    const { searchParams } = new URL(request.url);
    const inputToken = searchParams.get('inputToken') || 'SOL';
    const outputToken = searchParams.get('outputToken') || 'USDC';
    const amount = searchParams.get('amount');

    if (!amount) {
      return NextResponse.json(
        { error: 'Amount is required' },
        { status: 400 }
      );
    }

    // Resolve symbols or mint addresses
    const inputResolved = await resolveTokenParam(inputToken, 'SOL');
    const outputResolved = await resolveTokenParam(outputToken, 'USDC');

    const inputMint = inputResolved.mint;
    const outputMint = outputResolved.mint;

    // Convert amount to smallest unit (lamports for SOL)
    const inputDecimals = inputResolved.decimals || 9;
    const scaledAmount = Math.floor(parseFloat(amount) * Math.pow(10, inputDecimals));

    // Build Jupiter quote URL
    const quoteUrl =
      `${JUPITER_API.QUOTE}?` +
      `inputMint=${inputMint}` +
      `&outputMint=${outputMint}` +
      `&amount=${scaledAmount}` +
      `&slippageBps=50` +
      `&restrictIntermediateTokens=true`;

    console.log('Fetching Jupiter quote:', quoteUrl);

    // Build headers - API key is optional but may be required
    const headers: HeadersInit = {
      'Accept': 'application/json',
    };
    if (JUPITER_API_KEY) {
      headers['x-api-key'] = JUPITER_API_KEY;
    }

    const response = await fetch(quoteUrl, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Jupiter quote error:', errorText);
      return NextResponse.json(
        { error: `Failed to fetch quote: ${errorText}` },
        { status: response.status }
      );
    }

    const quoteData = await response.json();

    // Calculate output amount in human-readable format
    // Jupiter v1 API uses 'outAmount' (not 'outAmount' in v6)
    const outputDecimals = outputResolved.decimals || 6;
    const outAmount = quoteData.outAmount || quoteData.inAmount; // v1 uses 'outAmount'
    const outputAmount = parseFloat(outAmount) / Math.pow(10, outputDecimals);

    return NextResponse.json({
      inputAmount: parseFloat(amount),
      inputToken: inputResolved.symbol,
      outputAmount,
      outputToken: outputResolved.symbol,
      priceImpact: quoteData.priceImpactPct,
      quote: quoteData,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error fetching quote:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch quote' },
      { status: 500 }
    );
  }
}

