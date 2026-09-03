import { Router } from 'express';
import { TenantPoolManager } from '../../pool/tenantPoolManager';
import { asyncHandler } from '../../http/context';
import { ok } from '../../http/envelope';
import { AppError } from '../../http/errors';
import { requireRole, requireAuth } from '../../http/rbac';
import { pageMeta, parsePage } from '../../http/pagination';
import { ctxOf } from '../corePeople/scope';
import { requireFields, guardDbConflict } from '../corePeople/students';
import {
  NOTIFICATION_AUDIENCES,
  VISIBLE_TO_CALLER,
  visibilityParams,
} from './notifications';

const ADMIN = ['super_admin', 'admin'] as const;
const AUDIT_READ = ['super_admin', 'admin', 'principal'] as const;

/** Base doc §5.5 — notifications, audit logs, settings. */
export function systemMiscRouter(pools: TenantPoolManager): Router {
  const r = Router();

  // ---- Notifications ----
  // A notification is stored once with its audience; who has read it lives in
  // notification_reads, so one notice carries a read state per recipient.

  // GET /notifications — the caller's inbox: unread first, then newest first.
  r.get('/notifications', requireAuth, asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const params = await visibilityParams(pools, ctx, req.auth!);
    const onlyUnread = req.query.unread === 'true';
    const { rows } = await pools.query(ctx,
      `SELECT n.id, n.title, n.body, n.audience, n.created_at, r.read_at, n.created_by
         FROM notifications n
         LEFT JOIN notification_reads r
           ON r.notification_id = n.id AND r.user_id = $1
        WHERE ${VISIBLE_TO_CALLER} ${onlyUnread ? 'AND r.read_at IS NULL' : ''}
        ORDER BY (r.read_at IS NOT NULL), n.created_at DESC
        LIMIT 100`, params);
    res.json(ok(rows));
  }));

  // POST /notifications — send to the whole school, a role, a section or one
  // user. The legacy body ({ user_id, title }) still means audience 'user'.
  r.post('/notifications', requireRole('super_admin', 'admin', 'principal'), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const b = req.body ?? {};
    requireFields(b, ['title']);
    const audience: string = b.audience ?? (b.user_id ? 'user' : '');
    if (!NOTIFICATION_AUDIENCES.includes(audience as never)) {
      throw AppError.validation([
        { field: 'audience', message: `must be one of ${NOTIFICATION_AUDIENCES.join(', ')}` },
      ]);
    }
    const target: Record<string, string | null> = {
      user_id: null, audience_role: null, audience_section_id: null,
    };
    if (audience === 'user') {
      requireFields(b, ['user_id']);
      target.user_id = b.user_id;
    } else if (audience === 'role') {
      requireFields(b, ['audience_role']);
      target.audience_role = b.audience_role;
    } else if (audience === 'section') {
      requireFields(b, ['audience_section_id']);
      target.audience_section_id = b.audience_section_id;
    }

    const { rows } = await guardDbConflict(
      () => pools.query(ctx,
        `INSERT INTO notifications
           (audience, user_id, audience_role, audience_section_id, title, body, type, created_by)
         VALUES ($1,$2,$3::user_role_enum,$4,$5,$6,$7,$8)
         RETURNING id, title, body, audience, created_at, created_by`,
        [audience, target.user_id, target.audience_role, target.audience_section_id,
          b.title, b.body ?? null, b.type ?? null, req.auth!.userId]),
      'No user or section with that id',
    );
    res.status(201).json(ok({ ...rows[0], read_at: null }));
  }));

  // PUT /notifications/:id/read — records that *this* caller read it.
  r.put('/notifications/:id/read', requireAuth, asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const params = await visibilityParams(pools, ctx, req.auth!);
    const { rows } = await pools.query<{ read_at: string }>(ctx,
      `INSERT INTO notification_reads (notification_id, user_id)
       SELECT n.id, $1 FROM notifications n
        WHERE n.id = $4 AND ${VISIBLE_TO_CALLER}
       ON CONFLICT (notification_id, user_id) DO UPDATE SET read_at = notification_reads.read_at
       RETURNING read_at`,
      [...params, req.params.id]);
    // Not visible to this caller is indistinguishable from not existing, on
    // purpose: neither should confirm another tenant's or user's notice.
    if (!rows.length) throw AppError.notFound('Notification');
    res.json(ok({ read_at: rows[0].read_at }));
  }));

  // PUT /notifications/read-all — everything currently in the caller's inbox.
  r.put('/notifications/read-all', requireAuth, asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const params = await visibilityParams(pools, ctx, req.auth!);
    const { rowCount } = await pools.query(ctx,
      `INSERT INTO notification_reads (notification_id, user_id)
       SELECT n.id, $1 FROM notifications n
        WHERE ${VISIBLE_TO_CALLER}
       ON CONFLICT DO NOTHING`, params);
    res.json(ok({ marked_read: rowCount ?? 0 }));
  }));

  // DELETE /notifications/:id — withdraws the notice from everyone's inbox
  // (reads cascade), so it is a sender action, not a per-user dismiss.
  r.delete('/notifications/:id', requireRole('super_admin', 'admin', 'principal'),
    asyncHandler(async (req, res) => {
      const { rowCount } = await pools.query(ctxOf(req),
        `DELETE FROM notifications WHERE id = $1`, [req.params.id]);
      if (!rowCount) throw AppError.notFound('Notification');
      res.json(ok({ deleted: true }));
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
