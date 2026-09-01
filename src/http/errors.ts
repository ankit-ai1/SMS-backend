import { ErrorDetail } from './envelope';

/** HTTP status + machine code pairs from base doc §10.2. */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'TOKEN_EXPIRED'
  | 'FORBIDDEN'
  | 'TENANT_SUSPENDED'
  | 'TENANT_MISMATCH'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 400,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  TOKEN_EXPIRED: 401,
  FORBIDDEN: 403,
  TENANT_SUSPENDED: 403,
  TENANT_MISMATCH: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

/** Throw this anywhere; the error middleware turns it into the doc's envelope. */
export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: ErrorDetail[],
  ) {
    super(message);
    this.name = 'AppError';
  }
  get httpStatus(): number {
    return STATUS[this.code];
  }
  static notFound(what = 'Resource') {
    return new AppError('NOT_FOUND', `${what} not found`);
  }
  static forbidden(msg = 'Forbidden') {
    return new AppError('FORBIDDEN', msg);
  }
  static unauthorized(msg = 'Missing or invalid token') {
    return new AppError('UNAUTHORIZED', msg);
  }
  static conflict(msg = 'Cannot delete: still in use') {
    return new AppError('CONFLICT', msg);
  }
  static validation(details: ErrorDetail[], msg = 'Validation failed') {
    return new AppError('VALIDATION_ERROR', msg, details);
  }
}
