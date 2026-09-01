import { NextFunction, Response } from 'express';
import { AppRequest } from '../http/context';
import { AppError } from '../http/errors';
import { JwtKeys, verifyAccessToken } from './jwt';

/**
 * Verifies the Bearer access token and attaches req.auth.
 *
 * Must run AFTER the tenant resolver so req.tenantContext is set. Enforces the
 * base doc §8.1 step [4]: "Verify JWT tenant_id matches resolved tenant_id ->
 * else 403 Tenant Mismatch". This stops a valid token for tenant A being
 * replayed against tenant B's subdomain.
 */
export function authMiddleware(keys: JwtKeys) {
  return (req: AppRequest, _res: Response, next: NextFunction): void => {
    try {
      const header = req.headers['authorization'];
      if (!header || Array.isArray(header) || !header.startsWith('Bearer ')) {
        throw AppError.unauthorized('Missing Bearer token');
      }
      const token = header.slice('Bearer '.length).trim();
      const auth = verifyAccessToken(keys, token);

      const resolved = req.tenantContext;
      if (resolved && auth.tenantId !== resolved.tenant.id) {
        throw new AppError(
          'TENANT_MISMATCH',
          'Token tenant does not match host subdomain',
        );
      }
      req.auth = auth;
      next();
    } catch (err) {
      next(err);
    }
  };
}
