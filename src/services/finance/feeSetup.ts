import { Router } from 'express';
import { TenantPoolManager } from '../../pool/tenantPoolManager';
import { asyncHandler } from '../../http/context';
import { ok } from '../../http/envelope';
import { AppError } from '../../http/errors';
import { requireRole } from '../../http/rbac';
import { ctxOf } from '../corePeople/scope';
import { requireFields, pickUpdatable } from '../corePeople/students';

const READ = ['super_admin', 'admin', 'principal', 'accountant'] as const;
const WRITE = ['super_admin', 'admin', 'accountant'] as const;

/** Base doc §5.4 — fee categories, structures, discounts. */
export function feeSetupRouter(pools: TenantPoolManager): Router {
  const r = Router();

  // ---- Fee categories ----
  r.get('/fee-categories', requireRole(...READ), asyncHandler(async (req, res) => {
    const { rows } = await pools.query(ctxOf(req), `SELECT id, name, frequency FROM fee_categories ORDER BY name`);
    res.json(ok(rows));
  }));
  r.post('/fee-categories', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    requireFields(b, ['name']);
    const { rows } = await pools.query(ctxOf(req),
      `INSERT INTO fee_categories (name, frequency) VALUES ($1,$2) RETURNING id`,
      [b.name, b.frequency ?? 'term']);
    res.status(201).json(ok({ id: rows[0].id }));
  }));
  r.put('/fee-categories/:id', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const f = pickUpdatable(req.body ?? {}, ['name', 'frequency']);
    if (!f.cols.length) throw AppError.validation([{ field: 'body', message: 'no updatable fields' }]);
    f.params.push(req.params.id);
    const { rowCount } = await pools.query(ctxOf(req), `UPDATE fee_categories SET ${f.set} WHERE id = $${f.params.length}`, f.params);
    if (!rowCount) throw AppError.notFound('Fee category');
    res.json(ok({ updated: true }));
  }));

  // ---- Fee structures (amount per category + class + year) ----
  r.get('/fee-structures', requireRole(...READ), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const where: string[] = ['1=1']; const params: unknown[] = [];
    if (typeof req.query.class_id === 'string' && req.query.class_id) { params.push(req.query.class_id); where.push(`fs.class_id = $${params.length}`); }
    if (typeof req.query.academic_year_id === 'string' && req.query.academic_year_id) { params.push(req.query.academic_year_id); where.push(`fs.academic_year_id = $${params.length}`); }
    const { rows } = await pools.query(ctx,
      `SELECT fs.id, fs.fee_category_id, fc.name AS category_name, fs.class_id,
              c.name AS class_name, fs.academic_year_id, fs.amount
         FROM fee_structures fs
         JOIN fee_categories fc ON fc.id = fs.fee_category_id
         JOIN classes c ON c.id = fs.class_id
        WHERE ${where.join(' AND ')} ORDER BY c.numeric_order, fc.name`, params);
    res.json(ok(rows));
  }));
  r.post('/fee-structures', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    requireFields(b, ['fee_category_id', 'class_id', 'academic_year_id', 'amount']);
    const { rows } = await pools.query(ctxOf(req),
      `INSERT INTO fee_structures (fee_category_id, class_id, academic_year_id, amount)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [b.fee_category_id, b.class_id, b.academic_year_id, b.amount]);
    res.status(201).json(ok({ id: rows[0].id }));
  }));
  r.put('/fee-structures/:id', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const f = pickUpdatable(req.body ?? {}, ['amount']);
    if (!f.cols.length) throw AppError.validation([{ field: 'body', message: 'no updatable fields' }]);
    f.params.push(req.params.id);
    const { rowCount } = await pools.query(ctxOf(req), `UPDATE fee_structures SET ${f.set} WHERE id = $${f.params.length}`, f.params);
    if (!rowCount) throw AppError.notFound('Fee structure');
    res.json(ok({ updated: true }));
  }));
  r.delete('/fee-structures/:id', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const { rowCount } = await pools.query(ctxOf(req), `DELETE FROM fee_structures WHERE id = $1`, [req.params.id]);
    if (!rowCount) throw AppError.notFound('Fee structure');
    res.json(ok({ deleted: true }));
  }));

  // ---- Discounts ----
  r.get('/fee-discounts', requireRole(...READ), asyncHandler(async (req, res) => {
    const { rows } = await pools.query(ctxOf(req),
      `SELECT id, name, type, is_percentage, value FROM fee_discounts ORDER BY name`);
    res.json(ok(rows));
  }));
  r.post('/fee-discounts', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    requireFields(b, ['name', 'type', 'value']);
    const { rows } = await pools.query(ctxOf(req),
      `INSERT INTO fee_discounts (name, type, is_percentage, value) VALUES ($1,$2,$3,$4) RETURNING id`,
      [b.name, b.type, b.is_percentage ?? true, b.value]);
    res.status(201).json(ok({ id: rows[0].id }));
  }));

  return r;
}
