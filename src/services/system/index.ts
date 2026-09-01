import { Router } from 'express';
import { TenantPoolManager } from '../../pool/tenantPoolManager';
import { asyncHandler } from '../../http/context';
import { ok } from '../../http/envelope';
import { AppError } from '../../http/errors';
import { ctxOf } from '../corePeople/scope';
import { usersRouter } from './users';
import { systemMiscRouter } from './misc';

/** /internal/* for System (base doc §5.7): user role lookup for authorization. */
export function systemInternalRouter(pools: TenantPoolManager): Router {
  const r = Router();
  r.get('/users/:id/role', asyncHandler(async (req, res) => {
    const { rows } = await pools.query(ctxOf(req),
      `SELECT id, role, status, linked_entity_id, linked_entity_type FROM users WHERE id = $1`,
      [req.params.id]);
    if (!rows.length) throw AppError.notFound('User');
    res.json(ok(rows[0]));
  }));
  return r;
}

/** Public System router — base doc §5.5. */
export function systemRouter(pools: TenantPoolManager): Router {
  const r = Router();
  r.use(usersRouter(pools));
  r.use(systemMiscRouter(pools));
  return r;
}
