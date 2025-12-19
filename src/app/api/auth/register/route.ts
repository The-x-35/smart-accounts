import { NextRequest, NextResponse } from 'next/server';
import { createUser } from '@/lib/auth/users';
import { generateToken } from '@/lib/auth/jwt';
import { isValidEmail, isValidPassword } from '@/lib/utils/validation';
import { ValidationError, handleError } from '@/lib/utils/errors';
import { ApiResponse, AuthResponse } from '@/types/api';

export async function POST(request: NextRequest): Promise<NextResponse<ApiResponse<AuthResponse>>> {
  try {
    const body = await request.json();
    const { email, password, name } = body;

    // Validate input
    if (!email || !password) {
      throw new ValidationError('Email and password are required');
    }

    if (!isValidEmail(email)) {
      throw new ValidationError('Invalid email format');
    }

    if (!isValidPassword(password)) {
      throw new ValidationError('Password must be at least 8 characters long');
    }

    // Create user
    const user = await createUser(email, password, name);

    // Generate token
    const token = generateToken({
      userId: user.id,
      email: user.email,
    });

    return NextResponse.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
        },
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

