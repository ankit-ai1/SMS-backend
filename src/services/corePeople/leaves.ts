import { Router } from 'express';
import { TenantPoolManager } from '../../pool/tenantPoolManager';
import { asyncHandler } from '../../http/context';
import { ok } from '../../http/envelope';
import { AppError } from '../../http/errors';
import { requireRole } from '../../http/rbac';
import { pageMeta, parsePage } from '../../http/pagination';
import { ctxOf, staffIdOf } from './scope';
import { requireFields } from './students';

/** Base doc §5.2 — Leave management. */
export function leavesRouter(pools: TenantPoolManager): Router {
  const r = Router();

  // GET /leave-types — all authenticated
  r.get(
    '/leave-types',
    requireRole('super_admin', 'admin', 'principal', 'teacher', 'accountant', 'clerk'),
    asyncHandler(async (req, res) => {
      const { rows } = await pools.query(
        ctxOf(req),
        `SELECT id, name, max_days_year FROM leave_types ORDER BY name`,
      );
      res.json(ok(rows));
    }),
  );

  // GET /leaves
  //   ?scope=mine      — the caller's own requests, whatever their role
  //   no scope, admin  — everyone's, principals included
  //   no scope, princ. — the staff they approve for (not their own: an admin
  //                      decides those, and the principal reads them via
  //                      ?scope=mine)
  //   no scope, staff  — their own
  r.get(
    '/leaves',
    requireRole('super_admin', 'admin', 'principal', 'teacher', 'accountant', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const p = parsePage(req, ['created_at', 'start_date']);
      const where: string[] = ['1=1'];
      const params: unknown[] = [];
      const auth = req.auth!;
      const isAdmin = auth.role === 'super_admin' || auth.role === 'admin';
      const wantsMine = req.query.scope === 'mine';

      if (wantsMine || (!isAdmin && auth.role !== 'principal')) {
        params.push(staffIdOf(req));
        where.push(`lr.staff_id = $${params.length}`);
      } else if (auth.role === 'principal') {
        where.push(`(u.role IS NULL OR u.role NOT IN ('super_admin','admin','principal'))`);
        if (auth.linkedEntityType === 'staff' && auth.linkedEntityId) {
          params.push(auth.linkedEntityId);
          where.push(`lr.staff_id <> $${params.length}`);
        }
      }
      if (typeof req.query.status === 'string' && req.query.status) {
        params.push(req.query.status);
        where.push(`lr.status = $${params.length}::leave_status_enum`);
      }
      if (typeof req.query.staff_id === 'string' && req.query.staff_id) {
        params.push(req.query.staff_id);
        where.push(`lr.staff_id = $${params.length}`);
      }
      const clause = `WHERE ${where.join(' AND ')}`;
      // u = the applicant's login, which is where their role (and so their place
      // in the approval chain) lives. Staff with no login have role NULL.
      const applicantJoin = `LEFT JOIN users u
             ON u.linked_entity_type = 'staff' AND u.linked_entity_id = lr.staff_id`;
      const total = (
        await pools.query<{ n: string }>(
          ctx,
          `SELECT COUNT(*)::int n FROM leave_requests lr ${applicantJoin} ${clause}`,
          params,
        )
      ).rows[0].n;
      // staff_name / leave_type_name are joined in so the approvals screen can
      // show people, not ids.
      const rows = (
        await pools.query(
          ctx,
          `SELECT lr.id, lr.leave_type_id, lt.name AS leave_type_name,
                  lr.staff_id, TRIM(s.first_name || ' ' || s.last_name) AS staff_name,
                  lr.start_date, lr.end_date, lr.reason, lr.status,
                  lr.created_at AS applied_on
             FROM leave_requests lr
             JOIN staff s ON s.id = lr.staff_id
             JOIN leave_types lt ON lt.id = lr.leave_type_id
             ${applicantJoin}
             ${clause}
            ORDER BY lr.${p.sort} ${p.order}
            LIMIT ${p.perPage} OFFSET ${p.offset}`,
          params,
        )
      ).rows;
      res.json(ok(rows, pageMeta(p.page, p.perPage, Number(total))));
    }),
  );

  // GET /leaves/:id — admin, principal, self
  r.get(
    '/leaves/:id',
    requireRole('super_admin', 'admin', 'principal', 'teacher', 'accountant', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const { rows } = await pools.query(ctx, `SELECT * FROM leave_requests WHERE id = $1`, [req.params.id]);
      if (rows.length === 0) throw AppError.notFound('Leave request');
      const privileged = ['super_admin', 'admin', 'principal'].includes(req.auth!.role);
      const own = req.auth!.linkedEntityType === 'staff' && req.auth!.linkedEntityId === rows[0].staff_id;
      if (!privileged && !own) throw AppError.forbidden();
      res.json(ok(rows[0]));
    }),
  );

  // POST /leaves — any employee submits for themselves (principals and
  // accountants are employees too)
  r.post(
    '/leaves',
    requireRole('super_admin', 'admin', 'principal', 'teacher', 'accountant', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const b = req.body ?? {};
      requireFields(b, ['leave_type_id', 'start_date', 'end_date']);
      const staffId = staffIdOf(req); // applicant is always the caller
      const { rows } = await pools.query(
        ctx,
        `INSERT INTO leave_requests (staff_id, leave_type_id, start_date, end_date, reason)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [staffId, b.leave_type_id, b.start_date, b.end_date, b.reason ?? null],
      );
      res.status(201).json(ok({ id: rows[0].id }));
    }),
  );

  // PUT /leaves/:id/approve — admin, principal
  r.put('/leaves/:id/approve', requireRole('super_admin', 'admin', 'principal'),
    asyncHandler((req, res) => decide(pools, req, res, 'approved')));

  // PUT /leaves/:id/reject — admin, principal
  r.put('/leaves/:id/reject', requireRole('super_admin', 'admin', 'principal'),
    asyncHandler((req, res) => decide(pools, req, res, 'rejected')));

  // PATCH /leaves/:id — approve or reject in one call, subject to the
  // approval chain in assertMayDecide().
  r.patch(
    '/leaves/:id',
    requireRole('super_admin', 'admin', 'principal'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const b = req.body ?? {};
      requireFields(b, ['status']);
      if (b.status !== 'approved' && b.status !== 'rejected') {
        throw AppError.validation([{ field: 'status', message: "must be 'approved' or 'rejected'" }]);
      }
      const current = await loadForDecision(pools, ctx, req.params.id);
      if (current.status !== 'pending') {
        throw new AppError('CONFLICT', `Leave request is already ${current.status}`);
      }
      const a = req.auth!;
      assertMayDecide(a, current);
      const { rowCount } = await pools.query(
        ctx,
        `UPDATE leave_requests SET status = $1, reviewed_by = $2
          WHERE id = $3 AND status = 'pending'`,
        [b.status, a.userId, req.params.id],
      );
      if (!rowCount) throw new AppError('CONFLICT', 'Leave request was decided by someone else');
      res.json(ok({ updated: true }));
    }),
  );

  // PUT /leaves/:id/cancel — self (applicant cancels own pending request)
  r.put(
    '/leaves/:id/cancel',
    requireRole('super_admin', 'admin', 'principal', 'teacher', 'accountant', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const staffId = staffIdOf(req);
      const { rowCount } = await pools.query(
        ctx,
        `UPDATE leave_requests SET status = 'cancelled'
          WHERE id = $1 AND staff_id = $2 AND status = 'pending'`,
        [req.params.id, staffId],
      );
      if (!rowCount) throw new AppError('CONFLICT', 'Not your pending request, or already decided');
      res.json(ok({ status: 'cancelled' }));
    }),
  );

  return r;
}

async function decide(
  pools: TenantPoolManager,
  req: import('../../http/context').AppRequest,
  res: import('express').Response,
  status: 'approved' | 'rejected',
): Promise<void> {
  const ctx = ctxOf(req);
  const current = await loadForDecision(pools, ctx, req.params.id);
  assertMayDecide(req.auth!, current);
  const { rowCount } = await pools.query(
    ctx,
    `UPDATE leave_requests SET status = $1, reviewed_by = $2
      WHERE id = $3 AND status = 'pending'`,
    [status, req.auth!.userId, req.params.id],
  );
  if (!rowCount) throw new AppError('CONFLICT', 'Request not found or already decided');
  res.json(ok({ status }));
}

interface PendingDecision {
  status: string;
  staff_id: string;
  applicant_role: string | null;
}

/** The request plus the applicant's role, which fixes who may decide it. */
async function loadForDecision(
  pools: TenantPoolManager,
  ctx: import('../../registry/types').TenantContext,
  id: string,
): Promise<PendingDecision> {
  const { rows } = await pools.query<PendingDecision>(
    ctx,
    `SELECT lr.status, lr.staff_id, u.role AS applicant_role
       FROM leave_requests lr
       LEFT JOIN users u
         ON u.linked_entity_type = 'staff' AND u.linked_entity_id = lr.staff_id
      WHERE lr.id = $1`,
    [id],
  );
  if (!rows.length) throw AppError.notFound('Leave request');
  return rows[0];
}

/**
 * Approval chain: a principal decides for the staff below them; a principal's
 * own request goes up to an admin. Nobody decides their own, however senior.
 */
function assertMayDecide(
  auth: NonNullable<import('../../http/context').AppRequest['auth']>,
  req: PendingDecision,
): void {
  if (auth.linkedEntityType === 'staff' && auth.linkedEntityId === req.staff_id) {
    throw AppError.forbidden('Cannot decide your own leave request');
  }
  const isAdmin = auth.role === 'super_admin' || auth.role === 'admin';
  if (isAdmin) return;
  if (req.applicant_role && ['super_admin', 'admin', 'principal'].includes(req.applicant_role)) {
    throw AppError.forbidden('This request is decided by an admin');
  }
}
