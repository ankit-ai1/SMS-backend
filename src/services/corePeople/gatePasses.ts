import { Router } from 'express';
import { TenantPoolManager } from '../../pool/tenantPoolManager';
import { asyncHandler, AppRequest } from '../../http/context';
import { ok } from '../../http/envelope';
import { AppError } from '../../http/errors';
import { requireRole } from '../../http/rbac';
import { config } from '../../config';
import { ctxOf } from './scope';
import { requireFields, guardDbConflict } from './students';

const PASS_STATUSES = ['pending', 'approved', 'rejected'] as const;
const RAISE = ['super_admin', 'admin', 'clerk'] as const;
const DECIDE = ['super_admin', 'admin', 'principal'] as const;

/**
 * Everything the gate desk shows. The student's name and class are joined in
 * rather than left as ids — a guard holding a phone cannot match a UUID to the
 * child standing in front of them.
 */
const PASS_COLUMNS = `
  gp.id, gp.student_id,
  TRIM(s.first_name || ' ' || s.last_name) AS student_name,
  c.name   AS class_name,
  sec.name AS section_name,
  gp.reason, gp.out_time, gp.expected_return, gp.status,
  gp.approved_by, ap.full_name AS approved_by_name, gp.decided_at,
  gp.created_by, cr.full_name AS created_by_name,
  gp.guardian_name, gp.created_at`;

const PASS_JOINS = `
  FROM gate_passes gp
  JOIN students s ON s.id = gp.student_id
  LEFT JOIN users ap ON ap.id = gp.approved_by
  LEFT JOIN users cr ON cr.id = gp.created_by
  LEFT JOIN student_enrollments e
    ON e.student_id = s.id AND e.status = 'active'
  LEFT JOIN academic_years y ON y.id = e.academic_year_id AND y.is_current
  LEFT JOIN sections sec ON sec.id = e.section_id
  LEFT JOIN classes c ON c.id = sec.class_id`;

/** Base doc §5.2 — gate passes (front office raises, principal approves). */
export function gatePassesRouter(pools: TenantPoolManager): Router {
  const r = Router();

  // GET /gate-passes?date=YYYY-MM-DD&status=
  // Pending first — those are the ones somebody is waiting on — then the most
  // recent departures.
  r.get('/gate-passes', requireRole(...RAISE, ...DECIDE), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const where: string[] = ['1=1'];
    const params: unknown[] = [];

    const date = req.query.date;
    if (typeof date === 'string' && date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw AppError.validation([{ field: 'date', message: 'must be YYYY-MM-DD' }]);
      }
      // The stored instant is UTC; "which day" has to be read in the school's
      // timezone or an evening pass lands on tomorrow's list.
      params.push(config.schoolTimezone, date);
      where.push(`(gp.out_time AT TIME ZONE $${params.length - 1})::date = $${params.length}::date`);
    }
    const status = req.query.status;
    if (typeof status === 'string' && status) {
      // Checked here rather than let the enum cast fail: an unknown status is a
      // bad request, not a database error.
      if (!PASS_STATUSES.includes(status as never)) {
        throw AppError.validation([
          { field: 'status', message: `must be one of ${PASS_STATUSES.join(', ')}` },
        ]);
      }
      params.push(status);
      where.push(`gp.status = $${params.length}::gate_pass_status_enum`);
    }

    const { rows } = await pools.query(
      ctx,
      `SELECT ${PASS_COLUMNS} ${PASS_JOINS}
        WHERE ${where.join(' AND ')}
        ORDER BY (gp.status <> 'pending'), gp.out_time DESC, gp.created_at DESC
        LIMIT 500`,
      params,
    );
    res.json(ok(rows));
  }));

  // POST /gate-passes — the front office raises it; it starts pending.
  r.post('/gate-passes', requireRole(...RAISE), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const b = req.body ?? {};
    requireFields(b, ['student_id', 'reason']);

    // The table has a CHECK for this; catching it here turns what would be a
    // bare 500 into a message the front office can act on.
    if (b.expected_return) {
      const out = b.out_time ? new Date(b.out_time) : new Date();
      const back = new Date(b.expected_return);
      if (Number.isNaN(back.getTime()) || Number.isNaN(out.getTime())) {
        throw AppError.validation([
          { field: 'expected_return', message: 'must be a valid timestamp' },
        ]);
      }
      if (back < out) {
        throw AppError.validation([
          { field: 'expected_return', message: 'cannot be before out_time' },
        ]);
      }
    }

    const { rows } = await guardDbConflict(
      () => pools.query(
        ctx,
        `WITH inserted AS (
           INSERT INTO gate_passes
             (student_id, reason, guardian_name, out_time, expected_return, created_by)
           VALUES ($1,$2,$3,COALESCE($4::timestamptz, NOW()),$5,$6)
           RETURNING *
         )
         SELECT ${PASS_COLUMNS} ${PASS_JOINS.replace('FROM gate_passes gp', 'FROM inserted gp')}`,
        [b.student_id, b.reason, b.guardian_name ?? null,
          b.out_time ?? null, b.expected_return ?? null, req.auth!.userId],
      ),
      'No student with that id',
    );
    res.status(201).json(ok(rows[0]));
  }));

  // PUT /gate-passes/:id/approve — principal or admin
  r.put('/gate-passes/:id/approve', requireRole(...DECIDE),
    asyncHandler((req, res) => decide(pools, req, res, 'approved')));

  // PUT /gate-passes/:id/reject — principal or admin
  r.put('/gate-passes/:id/reject', requireRole(...DECIDE),
    asyncHandler((req, res) => decide(pools, req, res, 'rejected')));

  return r;
}

/**
 * Approve or reject, once. A pass that has already been decided answers 409
 * naming its current status, so the UI can say what actually happened rather
 * than "not found".
 */
async function decide(
  pools: TenantPoolManager,
  req: AppRequest,
  res: import('express').Response,
  status: 'approved' | 'rejected',
): Promise<void> {
  const ctx = ctxOf(req);
  const current = await pools.query<{ status: string }>(
    ctx,
    `SELECT status FROM gate_passes WHERE id = $1`,
    [req.params.id],
  );
  if (!current.rows.length) throw AppError.notFound('Gate pass');
  if (current.rows[0].status !== 'pending') {
    throw new AppError('CONFLICT', `Gate pass is already ${current.rows[0].status}`);
  }

  const { rows } = await pools.query(
    ctx,
    `WITH updated AS (
       UPDATE gate_passes
          SET status = $1::gate_pass_status_enum, approved_by = $2, decided_at = NOW()
        WHERE id = $3 AND status = 'pending'
        RETURNING *
     )
     SELECT ${PASS_COLUMNS} ${PASS_JOINS.replace('FROM gate_passes gp', 'FROM updated gp')}`,
    [status, req.auth!.userId, req.params.id],
  );
  if (!rows.length) throw new AppError('CONFLICT', 'Gate pass was decided by someone else');
  res.json(ok(rows[0]));
}
