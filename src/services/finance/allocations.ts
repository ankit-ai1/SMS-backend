import { Router } from 'express';
import { TenantPoolManager } from '../../pool/tenantPoolManager';
import { asyncHandler } from '../../http/context';
import { ok } from '../../http/envelope';
import { AppError } from '../../http/errors';
import { requireRole } from '../../http/rbac';
import { pageMeta, parsePage } from '../../http/pagination';
import { ctxOf, assertParentOwnsStudent } from '../corePeople/scope';
import { requireFields } from '../corePeople/students';

const READ = ['super_admin', 'admin', 'principal', 'accountant'] as const;
const WRITE = ['super_admin', 'admin', 'accountant'] as const;

/** Base doc §5.4 — student fee allocations. */
export function allocationsRouter(pools: TenantPoolManager): Router {
  const r = Router();

  // GET /fee-allocations — filter by enrollment/status
  r.get('/fee-allocations', requireRole(...READ), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const p = parsePage(req, ['created_at', 'due_date', 'status']);
    const where: string[] = ['1=1']; const params: unknown[] = [];
    if (typeof req.query.enrollment_id === 'string' && req.query.enrollment_id) { params.push(req.query.enrollment_id); where.push(`a.enrollment_id = $${params.length}`); }
    if (typeof req.query.status === 'string' && req.query.status) { params.push(req.query.status); where.push(`a.status = $${params.length}`); }
    const clause = `WHERE ${where.join(' AND ')}`;
    const total = (await pools.query<{ n: string }>(ctx, `SELECT COUNT(*)::int n FROM student_fee_allocations a ${clause}`, params)).rows[0].n;
    const rows = (await pools.query(ctx,
      `SELECT a.id, a.enrollment_id, a.fee_structure_id, a.discount_id,
              a.amount_due, a.amount_paid, a.status, a.due_date
         FROM student_fee_allocations a ${clause}
        ORDER BY a.${p.sort} ${p.order} LIMIT ${p.perPage} OFFSET ${p.offset}`, params)).rows;
    res.json(ok(rows, pageMeta(p.page, p.perPage, Number(total))));
  }));

  // GET /fee-allocations/:id — parent may read own child's
  r.get('/fee-allocations/:id', requireRole('super_admin', 'admin', 'principal', 'accountant', 'parent'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const { rows } = await pools.query(ctx,
        `SELECT a.*, e.student_id FROM student_fee_allocations a
           JOIN student_enrollments e ON e.id = a.enrollment_id WHERE a.id = $1`, [req.params.id]);
      if (!rows.length) throw AppError.notFound('Allocation');
      if (req.auth!.role === 'parent') await assertParentOwnsStudent(pools, ctx, req.auth!.userId, rows[0].student_id);
      res.json(ok(rows[0]));
    }));

  // POST /fee-allocations — allocate one fee to one enrollment
  r.post('/fee-allocations', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req); const b = req.body ?? {};
    requireFields(b, ['enrollment_id', 'fee_structure_id']);
    const amountDue = await computeAmountDue(pools, ctx, b.fee_structure_id, b.discount_id ?? null);
    const { rows } = await pools.query(ctx,
      `INSERT INTO student_fee_allocations (enrollment_id, fee_structure_id, discount_id, amount_due, due_date)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (enrollment_id, fee_structure_id) WHERE billing_month IS NULL DO NOTHING
       RETURNING id`,
      [b.enrollment_id, b.fee_structure_id, b.discount_id ?? null, amountDue, b.due_date ?? null]);
    if (!rows.length) throw new AppError('CONFLICT', 'Fee already allocated to this enrollment');
    res.status(201).json(ok({ id: rows[0].id, amount_due: amountDue }));
  }));

  // POST /fee-allocations/generate — bulk: allocate all matching fees to all
  // active enrollments for a year (concrete form of student.enrolled -> fees).
  r.post('/fee-allocations/generate', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req); const b = req.body ?? {};
    requireFields(b, ['academic_year_id']);
    const params: unknown[] = [b.academic_year_id];
    let classFilter = '';
    if (typeof b.class_id === 'string') { params.push(b.class_id); classFilter = `AND sec.class_id = $${params.length}`; }
    const result = await pools.query<{ n: string }>(ctx,
      `WITH inserted AS (
         INSERT INTO student_fee_allocations (enrollment_id, fee_structure_id, amount_due, due_date)
         SELECT e.id, fs.id, fs.amount, $${params.length + 1}
           FROM student_enrollments e
           JOIN sections sec ON sec.id = e.section_id
           JOIN fee_structures fs
             ON fs.class_id = sec.class_id AND fs.academic_year_id = e.academic_year_id
          WHERE e.academic_year_id = $1 AND e.status = 'active' ${classFilter}
         ON CONFLICT (enrollment_id, fee_structure_id) WHERE billing_month IS NULL DO NOTHING
         RETURNING 1)
       SELECT COUNT(*)::int n FROM inserted`,
      [...params, b.due_date ?? null]);
    res.status(201).json(ok({ allocations_created: Number(result.rows[0].n) }));
  }));

  return r;
}

/** amount_due = structure amount minus discount (percentage or flat). */
async function computeAmountDue(
  pools: TenantPoolManager,
  ctx: import('../../registry/types').TenantContext,
  feeStructureId: string,
  discountId: string | null,
): Promise<string> {
  const fs = await pools.query<{ amount: string }>(ctx, `SELECT amount FROM fee_structures WHERE id = $1`, [feeStructureId]);
  if (!fs.rows.length) throw AppError.notFound('Fee structure');
  let amount = Number(fs.rows[0].amount);
  if (discountId) {
    const d = await pools.query<{ is_percentage: boolean; value: string }>(ctx,
      `SELECT is_percentage, value FROM fee_discounts WHERE id = $1`, [discountId]);
    if (d.rows.length) {
      const val = Number(d.rows[0].value);
      amount = d.rows[0].is_percentage ? amount * (1 - val / 100) : amount - val;
    }
  }
  return Math.max(0, amount).toFixed(2);
}
