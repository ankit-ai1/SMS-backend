import { Router } from 'express';
import { asyncHandler, AppRequest } from '../http/context';
import { ok } from '../http/envelope';
import { AppError } from '../http/errors';
import { requireAuth } from '../http/rbac';
import { AuthService } from './authService';
import { authMiddleware } from './authMiddleware';
import { JwtKeys } from './jwt';

/**
 * /api/v1/auth/* — the authentication endpoints from base doc §5.1, plus the
 * password-reset endpoints the audit flagged as missing.
 *
 * Assumes a tenant-resolver middleware has already set req.tenantContext.
 */
export function authRouter(service: AuthService, keys: JwtKeys): Router {
  const r = Router();
  const requireJwt = authMiddleware(keys);

  const tenantOf = (req: AppRequest) => {
    if (!req.tenantContext) {
      throw new AppError('BAD_REQUEST', 'Tenant could not be resolved');
    }
    return req.tenantContext;
  };

  const str = (v: unknown, field: string): string => {
    if (typeof v !== 'string' || v.length === 0) {
      throw AppError.validation([{ field, message: 'is required' }]);
    }
    return v;
  };

  // POST /api/v1/auth/login  (public)
  r.post(
    '/login',
    asyncHandler(async (req, res) => {
      const email = str(req.body?.email, 'email');
      const password = str(req.body?.password, 'password');
      const result = await service.login(tenantOf(req), email, password);
      res.json(ok(result));
    }),
  );

  // POST /api/v1/auth/refresh  (public — token is the credential)
  r.post(
    '/refresh',
    asyncHandler(async (req, res) => {
      const refresh = str(req.body?.refresh_token, 'refresh_token');
      const result = await service.refresh(tenantOf(req), refresh);
      res.json(ok(result));
    }),
  );

  // POST /api/v1/auth/logout  (authenticated)
  r.post(
    '/logout',
    requireJwt,
    requireAuth,
    asyncHandler(async (req, res) => {
      const refresh = str(req.body?.refresh_token, 'refresh_token');
      await service.logout(tenantOf(req), refresh);
      res.json(ok({ message: 'Logged out' }));
    }),
  );

  // GET /api/v1/auth/me  (authenticated)
  r.get(
    '/me',
    requireJwt,
    requireAuth,
    asyncHandler(async (req, res) => {
      const profile = await service.me(tenantOf(req), req.auth!.userId);
      res.json(ok(profile));
    }),
  );

  // POST /api/v1/auth/password/forgot  (public, no enumeration)
  r.post(
    '/password/forgot',
    asyncHandler(async (req, res) => {
      const email = str(req.body?.email, 'email');
      const token = await service.requestPasswordReset(tenantOf(req), email);
      // In production: if token != null, enqueue an email. Never return it.
      void token;
      res.json(
        ok({ message: 'If the account exists, a reset link has been sent.' }),
      );
    }),
  );

  // POST /api/v1/auth/password/reset  (public, token is the credential)
  r.post(
    '/password/reset',
    asyncHandler(async (req, res) => {
      const token = str(req.body?.reset_token, 'reset_token');
      const password = str(req.body?.password, 'password');
      await service.resetPassword(tenantOf(req), token, password);
      res.json(ok({ message: 'Password updated. Please log in.' }));
    }),
  );

  return r;
}
