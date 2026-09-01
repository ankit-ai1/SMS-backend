import { NextFunction, Response } from 'express';
import { AppRequest, Role } from './context';
import { AppError } from './errors';

/**
 * Coarse-grained role check — base doc §6: "Access control is enforced at the
 * API Gateway (coarse-grained: role check) and at each service (fine-grained:
 * scope check)." This is the gateway/entry layer. Fine-grained scope
 * (teacher-assigned, parent-own-child) is enforced inside each service handler.
 */
export function requireRole(...allowed: Role[]) {
  return (req: AppRequest, _res: Response, next: NextFunction): void => {
    if (!req.auth) {
      next(AppError.unauthorized());
      return;
    }
    if (!allowed.includes(req.auth.role)) {
      next(
        AppError.forbidden(
          `Role '${req.auth.role}' may not access this resource`,
        ),
      );
      return;
    }
    next();
  };
}

/** Any authenticated user. */
export function requireAuth(
  req: AppRequest,
  _res: Response,
  next: NextFunction,
): void {
  if (!req.auth) {
    next(AppError.unauthorized());
    return;
  }
  next();
}
