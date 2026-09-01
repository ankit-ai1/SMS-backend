import { Router } from 'express';
import { TenantPoolManager } from '../../pool/tenantPoolManager';
import { asyncHandler } from '../../http/context';
import { ok } from '../../http/envelope';
import { AppError } from '../../http/errors';
import { requireRole } from '../../http/rbac';
import { ctxOf, assertParentOwnsStudent, assertStudentSelf } from '../corePeople/scope';
import { requireFields } from '../corePeople/students';

const READ = ['super_admin', 'admin', 'principal', 'accountant'] as const;
const WRITE = ['super_admin', 'admin', 'accountant'] as const;

/** Base doc §5.4 — payments + refunds. */
export function paymentsRouter(pools: TenantPoolManager): Router {
  const r = Router();

  // POST /payments — record a payment; recompute the allocation's paid/status
  r.post('/payments', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req); const b = req.body ?? {};
    requireFields(b, ['allocation_id', 'amount', 'payment_mode']);
    if (Number(b.amount) <= 0) throw AppError.validation([{ field: 'amount', message: 'must be > 0' }]);

    const out = await pools.withTransaction(ctx, async (client) => {
      const alloc = await client.query(`SELECT id, amount_due FROM student_fee_allocations WHERE id = $1 FOR UPDATE`, [b.allocation_id]);
      if (!alloc.rows.length) throw AppError.notFound('Allocation');
      const pay = await client.query(
        `INSERT INTO payments (allocation_id, amount, payment_mode, status, transaction_reference, payment_date, remarks, recorded_by)
         VALUES ($1,$2,$3,'completed',$4,COALESCE($5,CURRENT_DATE),$6,$7) RETURNING id`,
        [b.allocation_id, b.amount, b.payment_mode, b.transaction_reference ?? null, b.payment_date ?? null, b.remarks ?? null, req.auth!.userId]);
      // recompute amount_paid + status from all completed payments
      const upd = await client.query(
        `WITH paid AS (
           SELECT COALESCE(SUM(amount),0) p FROM payments WHERE allocation_id = $1 AND status = 'completed')
         UPDATE student_fee_allocations a
            SET amount_paid = paid.p,
                status = (CASE WHEN paid.p >= a.amount_due THEN 'paid'
                             WHEN paid.p > 0 THEN 'partial' ELSE 'pending' END)::allocation_status_enum
           FROM paid WHERE a.id = $1
           RETURNING a.amount_paid, a.amount_due, a.status`, [b.allocation_id]);
      return { paymentId: pay.rows[0].id, allocation: upd.rows[0] };
    });
    res.status(201).json(ok({ id: out.paymentId, allocation: out.allocation }));
  }));

  // GET /payments — filter by allocation/date
  r.get('/payments', requireRole(...READ), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const where: string[] = ['1=1']; const params: unknown[] = [];
    if (typeof req.query.allocation_id === 'string' && req.query.allocation_id) { params.push(req.query.allocation_id); where.push(`allocation_id = $${params.length}`); }
    if (typeof req.query.date_from === 'string' && req.query.date_from) { params.push(req.query.date_from); where.push(`payment_date >= $${params.length}`); }
    if (typeof req.query.date_to === 'string' && req.query.date_to) { params.push(req.query.date_to); where.push(`payment_date <= $${params.length}`); }
    const { rows } = await pools.query(ctx,
      `SELECT id, allocation_id, amount, payment_mode, status, transaction_reference, payment_date
         FROM payments WHERE ${where.join(' AND ')} ORDER BY payment_date DESC LIMIT 500`, params);
    res.json(ok(rows));
  }));

  // GET /payments/:id
  r.get('/payments/:id', requireRole(...READ), asyncHandler(async (req, res) => {
    const { rows } = await pools.query(ctxOf(req), `SELECT * FROM payments WHERE id = $1`, [req.params.id]);
    if (!rows.length) throw AppError.notFound('Payment');
    res.json(ok(rows[0]));
  }));

  // GET /students/:id/payments — parent may read own child
  r.get('/students/:id/payments', requireRole('super_admin', 'admin', 'principal', 'accountant', 'parent', 'student'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      if (req.auth!.role === 'parent') await assertParentOwnsStudent(pools, ctx, req.auth!.userId, req.params.id);
      if (req.auth!.role === 'student') assertStudentSelf(req, req.params.id);
      const { rows } = await pools.query(ctx,
        `SELECT p.id, p.amount, p.payment_mode, p.status, p.payment_date, a.fee_structure_id
           FROM payments p
           JOIN student_fee_allocations a ON a.id = p.allocation_id
           JOIN student_enrollments e ON e.id = a.enrollment_id
          WHERE e.student_id = $1 ORDER BY p.payment_date DESC`, [req.params.id]);
      res.json(ok(rows));
    }));

  // ---- Refunds ----
  r.get('/refunds', requireRole(...READ), asyncHandler(async (req, res) => {
    const { rows } = await pools.query(ctxOf(req),
      `SELECT id, payment_id, amount, reason, status FROM fee_refunds ORDER BY created_at DESC`);
    res.json(ok(rows));
  }));

  r.post('/refunds', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    requireFields(b, ['payment_id', 'amount']);
    const { rows } = await pools.query(ctxOf(req),
      `INSERT INTO fee_refunds (payment_id, amount, reason, requested_by) VALUES ($1,$2,$3,$4) RETURNING id`,
      [b.payment_id, b.amount, b.reason ?? null, req.auth!.userId]);
    res.status(201).json(ok({ id: rows[0].id }));
  }));

  // PUT /refunds/:id/approve — admin only (principal is read-only)
  r.put('/refunds/:id/approve', requireRole('super_admin', 'admin'),
    asyncHandler(async (req, res) => {
      const { rowCount } = await pools.query(ctxOf(req),
        `UPDATE fee_refunds SET status = 'approved', approved_by = $1 WHERE id = $2 AND status = 'requested'`,
        [req.auth!.userId, req.params.id]);
      if (!rowCount) throw new AppError('CONFLICT', 'Refund not found or not in requested state');
      res.json(ok({ status: 'approved' }));
    }));

  // PUT /refunds/:id/process — accountant marks it paid out
  r.put('/refunds/:id/process', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const { rowCount } = await pools.query(ctxOf(req),
      `UPDATE fee_refunds SET status = 'processed' WHERE id = $1 AND status = 'approved'`, [req.params.id]);
    if (!rowCount) throw new AppError('CONFLICT', 'Refund not found or not approved');
    res.json(ok({ status: 'processed' }));
  }));

  return r;
}
