import { Router } from 'express';
import { TenantPoolManager } from '../../pool/tenantPoolManager';
import { asyncHandler } from '../../http/context';
import { ok } from '../../http/envelope';
import { AppError } from '../../http/errors';
import { requireRole } from '../../http/rbac';
import { pageMeta, parsePage } from '../../http/pagination';
import { ctxOf } from '../corePeople/scope';
import { requireFields, pickUpdatable } from '../corePeople/students';
import { hashPassword, isPasswordAcceptable } from '../../auth/passwords';

const ADMIN = ['super_admin', 'admin'] as const;

/** Base doc §5.5 — user management (System service owns `users`). */
export function usersRouter(pools: TenantPoolManager): Router {
  const r = Router();

  // GET /users — admin
  r.get('/users', requireRole(...ADMIN), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const p = parsePage(req, ['created_at', 'email', 'role']);
    const where: string[] = ['1=1']; const params: unknown[] = [];
    if (typeof req.query.role === 'string' && req.query.role) { params.push(req.query.role); where.push(`role = $${params.length}`); }
    if (typeof req.query.status === 'string' && req.query.status) { params.push(req.query.status); where.push(`status = $${params.length}`); }
    if (typeof req.query.search === 'string' && req.query.search) {
      params.push(`%${req.query.search}%`); const i = params.length;
      where.push(`(email ILIKE $${i} OR full_name ILIKE $${i})`);
    }
    const clause = `WHERE ${where.join(' AND ')}`;
    const total = (await pools.query<{ n: string }>(ctx, `SELECT COUNT(*)::int n FROM users ${clause}`, params)).rows[0].n;
    const rows = (await pools.query(ctx,
      `SELECT id, email, role, full_name, phone, status, linked_entity_id, linked_entity_type, created_at
         FROM users ${clause} ORDER BY ${p.sort} ${p.order} LIMIT ${p.perPage} OFFSET ${p.offset}`, params)).rows;
    res.json(ok(rows, pageMeta(p.page, p.perPage, Number(total))));
  }));

  // GET /users/:id — admin, or self
  r.get('/users/:id', requireRole('super_admin', 'admin', 'principal', 'teacher', 'accountant', 'clerk', 'parent', 'student'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const privileged = ['super_admin', 'admin'].includes(req.auth!.role);
      if (!privileged && req.auth!.userId !== req.params.id) throw AppError.forbidden();
      const { rows } = await pools.query(ctx,
        `SELECT id, email, role, full_name, phone, status, linked_entity_id, linked_entity_type FROM users WHERE id = $1`,
        [req.params.id]);
      if (!rows.length) throw AppError.notFound('User');
      res.json(ok(rows[0]));
    }));

  // POST /users — admin creates a login
  r.post('/users', requireRole(...ADMIN), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req); const b = req.body ?? {};
    requireFields(b, ['email', 'password', 'role', 'full_name']);
    if (!isPasswordAcceptable(b.password)) {
      throw AppError.validation([{ field: 'password', message: 'must be at least 8 characters' }]);
    }
    const hash = await hashPassword(b.password);
    const { rows } = await pools.query(ctx,
      `INSERT INTO users (email, password_hash, role, full_name, phone, linked_entity_id, linked_entity_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [b.email, hash, b.role, b.full_name, b.phone ?? null, b.linked_entity_id ?? null, b.linked_entity_type ?? null]);
    if (!rows.length) throw new AppError('CONFLICT', 'Email already in use');
    res.status(201).json(ok({ id: rows[0].id }));
  }));

  // PUT /users/:id — admin edits profile/role
  r.put('/users/:id', requireRole(...ADMIN), asyncHandler(async (req, res) => {
    const f = pickUpdatable(req.body ?? {}, ['full_name', 'phone', 'role', 'linked_entity_id', 'linked_entity_type']);
    if (!f.cols.length) throw AppError.validation([{ field: 'body', message: 'no updatable fields' }]);
    f.params.push(req.params.id);
    const { rowCount } = await pools.query(ctxOf(req),
      `UPDATE users SET ${f.set}, updated_at = NOW() WHERE id = $${f.params.length}`, f.params);
    if (!rowCount) throw AppError.notFound('User');
    res.json(ok({ updated: true }));
  }));

  // PUT /users/:id/password — admin or self
  r.put('/users/:id/password', requireRole('super_admin', 'admin', 'principal', 'teacher', 'accountant', 'clerk', 'parent', 'student'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const privileged = ['super_admin', 'admin'].includes(req.auth!.role);
      if (!privileged && req.auth!.userId !== req.params.id) throw AppError.forbidden();
      const pwd = req.body?.password;
      if (!isPasswordAcceptable(pwd)) {
        throw AppError.validation([{ field: 'password', message: 'must be at least 8 characters' }]);
      }
      const hash = await hashPassword(pwd);
      const { rowCount } = await pools.query(ctx,
        `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`, [hash, req.params.id]);
      if (!rowCount) throw AppError.notFound('User');
      // Existing sessions should be invalidated by revoking refresh tokens
      // (handled by AuthService.changePassword in the auth layer).
      res.json(ok({ updated: true }));
    }));

  // PUT /users/:id/status — admin enable/disable
  r.put('/users/:id/status', requireRole(...ADMIN), asyncHandler(async (req, res) => {
    const status = req.body?.status;
    if (status !== 'active' && status !== 'disabled') {
      throw AppError.validation([{ field: 'status', message: "must be 'active' or 'disabled'" }]);
    }
    const { rowCount } = await pools.query(ctxOf(req),
      `UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2`, [status, req.params.id]);
    if (!rowCount) throw AppError.notFound('User');
    res.json(ok({ status }));
  }));

  // DELETE /users/:id — disable (never hard-delete a user with audit history)
  r.delete('/users/:id', requireRole(...ADMIN), asyncHandler(async (req, res) => {
    const { rowCount } = await pools.query(ctxOf(req),
      `UPDATE users SET status = 'disabled', updated_at = NOW() WHERE id = $1`, [req.params.id]);
    if (!rowCount) throw AppError.notFound('User');
    res.json(ok({ disabled: true }));
  }));

  return r;
}
