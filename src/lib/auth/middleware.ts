import { NextRequest } from 'next/server';
import { verifyToken, extractTokenFromHeader } from './jwt';
import { AuthenticationError } from '../utils/errors';

export interface AuthenticatedRequest extends NextRequest {
  user?: {
    userId: string;
    email: string;
  };
}

export function authenticateRequest(request: NextRequest): { userId: string; email: string } {
  const authHeader = request.headers.get('authorization');
  const token = extractTokenFromHeader(authHeader);

  if (!token) {
    throw new AuthenticationError('No token provided');
  }

  try {
    const payload = verifyToken(token);
    return payload;
  } catch (error) {
    throw new AuthenticationError('Invalid or expired token');
  }
}

