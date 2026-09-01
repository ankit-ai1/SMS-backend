import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { AppError } from './errors';
import { fail } from './envelope';
import { TenantContext } from '../registry/types';

/** Claims we put on the request after JWT verification (base doc §8.2). */
export interface AuthContext {
  userId: string;
  email: string;
  role: Role;
  tenantId: string;
  tenantSlug: string;
  linkedEntityId?: string;
  linkedEntityType?: 'staff' | 'student' | 'guardian';
}

/** The 8 roles from base doc §2. */
export type Role =
  | 'super_admin'
  | 'admin'
  | 'principal'
  | 'teacher'
  | 'accountant'
  | 'clerk'
  | 'parent'
  | 'student';

/** Request enriched by the tenant resolver and auth middleware. */
export interface AppRequest extends Request {
  params: Record<string, string>;
  tenantContext?: TenantContext;
  auth?: AuthContext;
  requestId?: string;
}

/** Wrap async handlers so thrown/rejected errors reach the error middleware. */
export function asyncHandler(
  fn: (req: AppRequest, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req as AppRequest, res, next).catch(next);
  };
}

/**
 * Postgres SQLSTATEs worth naming in the response. They say what class of thing
 * went wrong without describing the schema to the caller.
 */
const PG_CODES: Record<string, string> = {
  '42703': 'DB_UNDEFINED_COLUMN',
  '42P01': 'DB_UNDEFINED_TABLE',
  '42883': 'DB_UNDEFINED_FUNCTION',
  '23502': 'DB_NOT_NULL_VIOLATION',
  '23503': 'DB_FOREIGN_KEY_VIOLATION',
  '23505': 'DB_UNIQUE_VIOLATION',
  '22P02': 'DB_INVALID_INPUT',
  '53300': 'DB_TOO_MANY_CONNECTIONS',
  '57014': 'DB_QUERY_CANCELED',
  ECONNREFUSED: 'DB_UNAVAILABLE',
  ETIMEDOUT: 'DB_UNAVAILABLE',
};

/** Terminal error middleware — renders everything as the doc §10.1 envelope. */
export function errorMiddleware(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.httpStatus).json(fail(err.code, err.message, err.details));
    return;
  }

  // Unknown/unexpected. The caller gets a specific-enough code plus a trace id;
  // the full error — including the SQL that failed — goes to the log under that
  // same id, so a support ticket maps to one line in the logs.
  const traceId = randomUUID();
  const e = err as { code?: string; message?: string; detail?: string; constraint?: string; query?: string };
  const pgCode = typeof e?.code === 'string' ? e.code : undefined;
  const code = (pgCode && PG_CODES[pgCode]) ?? 'INTERNAL_ERROR';

  console.error(
    `[error] trace=${traceId} ${req.method} ${req.originalUrl} code=${code}` +
      (pgCode ? ` sqlstate=${pgCode}` : '') +
      ` message=${e?.message ?? String(err)}` +
      (e?.detail ? ` detail=${e.detail}` : '') +
      (e?.constraint ? ` constraint=${e.constraint}` : '') +
      (e?.query ? `\n  query: ${e.query.replace(/\s+/g, ' ').trim().slice(0, 500)}` : ''),
    err,
  );

  res.status(500).json(
    fail(code, 'An unexpected error occurred', [{ field: 'trace_id', message: traceId }]),
  );
}

/** 404 for unmatched routes. */
export function notFoundMiddleware(_req: Request, res: Response): void {
  res.status(404).json(fail('NOT_FOUND', 'Route not found'));
}
