import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth/middleware';
import { PublicKey } from '@solana/web3.js';
import { getMint } from '@solana/spl-token';
import { getSolanaConnection } from '@/lib/config/solana-config';
import { MINT_REGEX, formatPrice } from '@/lib/config/solana-config';
import { ValidationError, handleError } from '@/lib/utils/errors';
import { ApiResponse, SwapPriceResponse } from '@/types/api';

/**
 * Fetch token price from Jupiter lite-api
 */
async function fetchPriceV3(id: string) {
  const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${encodeURIComponent(id)}`);
  const data = await res.json();
  return { ok: res.ok, data };
}

export async function GET(request: NextRequest): Promise<NextResponse<ApiResponse<SwapPriceResponse>>> {
  try {
    // Authenticate request
    authenticateRequest(request);

    const { searchParams } = new URL(request.url);
    const tokenIdParam = searchParams.get('tokenId') || searchParams.get('id');

    if (!tokenIdParam) {
      throw new ValidationError('tokenId (mint address) is required');
    }

    const tokenId = tokenIdParam.trim();

    if (!MINT_REGEX.test(tokenId)) {
      throw new ValidationError('Provide a valid mint address (contract)');
    }

    // Fetch USD price via lite-api v3
    const { ok, data } = await fetchPriceV3(tokenId);

    if (!ok) {
      throw new Error(data?.error || 'Failed to fetch price');
    }

    // Support both data shapes: direct keyed, or nested "data"
    const node = data?.[tokenId] || data?.data?.[tokenId];
    const usdPrice = node?.usdPrice ?? node?.price;

    if (usdPrice == null) {
      throw new Error('Price not available for the given token');
    }

    // Market cap via mint supply
    const connection = getSolanaConnection(); // Price API is mainnet only
    const mintInfo = await getMint(connection, new PublicKey(tokenId));
    const supply = Number(mintInfo.supply) / Math.pow(10, mintInfo.decimals);
    const marketCap = supply * parseFloat(usdPrice);

    return NextResponse.json({
      success: true,
      data: {
        tokenId,
        price: parseFloat(usdPrice),
        priceFormatted: formatPrice(parseFloat(usdPrice)),
        marketCap,
        lastUpdated: new Date().toISOString(),
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

