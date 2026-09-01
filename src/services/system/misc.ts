import { Router } from 'express';
import { TenantPoolManager } from '../../pool/tenantPoolManager';
import { asyncHandler } from '../../http/context';
import { ok } from '../../http/envelope';
import { AppError } from '../../http/errors';
import { requireRole, requireAuth } from '../../http/rbac';
import { pageMeta, parsePage } from '../../http/pagination';
import { ctxOf } from '../corePeople/scope';
import { requireFields } from '../corePeople/students';

const ADMIN = ['super_admin', 'admin'] as const;
const AUDIT_READ = ['super_admin', 'admin', 'principal'] as const;

/** Base doc §5.5 — notifications, audit logs, settings. */
export function systemMiscRouter(pools: TenantPoolManager): Router {
  const r = Router();

  // ---- Notifications (per-user) ----
  r.get('/notifications', requireAuth, asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const onlyUnread = req.query.unread === 'true';
    const { rows } = await pools.query(ctx,
      `SELECT id, title, body, type, is_read, created_at
         FROM notifications
        WHERE user_id = $1 ${onlyUnread ? 'AND is_read = FALSE' : ''}
        ORDER BY created_at DESC LIMIT 100`, [req.auth!.userId]);
    res.json(ok(rows));
  }));

  // POST /notifications — admin/principal send to a user
  r.post('/notifications', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    requireFields(b, ['user_id', 'title']);
    const { rows } = await pools.query(ctxOf(req),
      `INSERT INTO notifications (user_id, title, body, type) VALUES ($1,$2,$3,$4) RETURNING id`,
      [b.user_id, b.title, b.body ?? null, b.type ?? null]);
    res.status(201).json(ok({ id: rows[0].id }));
  }));

  // PUT /notifications/:id/read — only your own
  r.put('/notifications/:id/read', requireAuth, asyncHandler(async (req, res) => {
    const { rowCount } = await pools.query(ctxOf(req),
      `UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.auth!.userId]);
    if (!rowCount) throw AppError.notFound('Notification');
    res.json(ok({ is_read: true }));
  }));

  // PUT /notifications/read-all
  r.put('/notifications/read-all', requireAuth, asyncHandler(async (req, res) => {
    const { rowCount } = await pools.query(ctxOf(req),
      `UPDATE notifications SET is_read = TRUE WHERE user_id = $1 AND is_read = FALSE`, [req.auth!.userId]);
    res.json(ok({ marked_read: rowCount ?? 0 }));
  }));

  // ---- Audit logs (read-only) ----
  r.get('/audit-logs', requireRole(...AUDIT_READ), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const p = parsePage(req, ['created_at']);
    const where: string[] = ['1=1']; const params: unknown[] = [];
    if (typeof req.query.table_name === 'string' && req.query.table_name) { params.push(req.query.table_name); where.push(`table_name = $${params.length}`); }
    if (typeof req.query.changed_by === 'string' && req.query.changed_by) { params.push(req.query.changed_by); where.push(`changed_by = $${params.length}`); }
    if (typeof req.query.action === 'string' && req.query.action) { params.push(req.query.action); where.push(`action = $${params.length}`); }
    const clause = `WHERE ${where.join(' AND ')}`;
    const total = (await pools.query<{ n: string }>(ctx, `SELECT COUNT(*)::int n FROM audit_logs ${clause}`, params)).rows[0].n;
    const rows = (await pools.query(ctx,
      `SELECT id, table_name, record_id, action, changed_by, changes, request_id, created_at
         FROM audit_logs ${clause} ORDER BY created_at ${p.order} LIMIT ${p.perPage} OFFSET ${p.offset}`, params)).rows;
    res.json(ok(rows, pageMeta(p.page, p.perPage, Number(total))));
  }));

  // ---- System settings ----
  r.get('/settings', requireRole(...ADMIN), asyncHandler(async (req, res) => {
    const { rows } = await pools.query(ctxOf(req), `SELECT key, value, updated_at FROM system_settings ORDER BY key`);
    res.json(ok(rows));
  }));

  r.get('/settings/:key', requireRole(...ADMIN), asyncHandler(async (req, res) => {
    const { rows } = await pools.query(ctxOf(req),
      `SELECT key, value, updated_at FROM system_settings WHERE key = $1`, [req.params.key]);
    if (!rows.length) throw AppError.notFound('Setting');
    res.json(ok(rows[0]));
  }));

  r.put('/settings/:key', requireRole(...ADMIN), asyncHandler(async (req, res) => {
    if (req.body?.value === undefined) {
      throw AppError.validation([{ field: 'value', message: 'is required' }]);
    }
    await pools.query(ctxOf(req),
      `INSERT INTO system_settings (key, value, updated_by) VALUES ($1,$2,$3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [req.params.key, JSON.stringify(req.body.value), req.auth!.userId]);
    res.json(ok({ key: req.params.key }));
  }));

  return r;
}
