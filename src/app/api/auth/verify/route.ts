import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest } from '@/lib/auth/middleware';
import { getUserById } from '@/lib/auth/users';
import { ApiResponse } from '@/types/api';

export async function GET(request: NextRequest): Promise<NextResponse<ApiResponse>> {
  try {
    const { userId } = authenticateRequest(request);
    const user = getUserById(userId);

    if (!user) {
      return NextResponse.json(
        {
          success: false,
          error: 'User not found',
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Authentication failed',
      },
      { status: 401 }
    );
  }
}

