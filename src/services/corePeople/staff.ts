import { Router } from 'express';
import { TenantPoolManager } from '../../pool/tenantPoolManager';
import { asyncHandler } from '../../http/context';
import { ok } from '../../http/envelope';
import { AppError } from '../../http/errors';
import { requireRole } from '../../http/rbac';
import { pageMeta, parsePage } from '../../http/pagination';
import { ctxOf } from './scope';
import { requireFields, pickUpdatable } from './students';

const STAFF_SORTS = ['created_at', 'last_name', 'first_name', 'employee_code'];

/** Base doc §5.2 — Staff + staff attendance. */
export function staffRouter(pools: TenantPoolManager): Router {
  const r = Router();

  // Helper: is this staff record the caller's own?
  const isSelf = (req: import('../../http/context').AppRequest, staffId: string) =>
    req.auth!.linkedEntityType === 'staff' && req.auth!.linkedEntityId === staffId;

  // GET /staff — admin, principal
  r.get(
    '/staff',
    requireRole('super_admin', 'admin', 'principal'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const p = parsePage(req, STAFF_SORTS);
      const where: string[] = ['deleted_at IS NULL'];
      const params: unknown[] = [];
      if (typeof req.query.department_id === 'string' && req.query.department_id) {
        params.push(req.query.department_id);
        where.push(`department_id = $${params.length}`);
      }
      if (typeof req.query.search === 'string' && req.query.search) {
        params.push(`%${req.query.search}%`);
        const i = params.length;
        where.push(`(first_name ILIKE $${i} OR last_name ILIKE $${i} OR employee_code ILIKE $${i})`);
      }
      const clause = `WHERE ${where.join(' AND ')}`;
      const total = (
        await pools.query<{ n: string }>(ctx, `SELECT COUNT(*)::int n FROM staff ${clause}`, params)
      ).rows[0].n;
      const rows = (
        await pools.query(
          ctx,
          `SELECT id, employee_code, first_name, last_name, email, phone,
                  department_id, designation_id, is_active
             FROM staff ${clause}
            ORDER BY ${p.sort} ${p.order}
            LIMIT ${p.perPage} OFFSET ${p.offset}`,
          params,
        )
      ).rows;
      res.json(ok(rows, pageMeta(p.page, p.perPage, Number(total))));
    }),
  );

  // GET /staff/:id — admin, principal, self
  r.get(
    '/staff/:id',
    requireRole('super_admin', 'admin', 'principal', 'teacher', 'accountant', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const privileged = ['super_admin', 'admin', 'principal'].includes(req.auth!.role);
      if (!privileged && !isSelf(req, req.params.id)) throw AppError.forbidden();
      const { rows } = await pools.query(
        ctx,
        `SELECT * FROM staff WHERE id = $1 AND deleted_at IS NULL`,
        [req.params.id],
      );
      if (rows.length === 0) throw AppError.notFound('Staff');
      res.json(ok(rows[0]));
    }),
  );

  // POST /staff — admin
  r.post(
    '/staff',
    requireRole('super_admin', 'admin'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const b = req.body ?? {};
      requireFields(b, ['employee_code', 'first_name', 'last_name']);
      const { rows } = await pools.query(
        ctx,
        `INSERT INTO staff
           (employee_code, first_name, last_name, email, phone, gender,
            date_of_birth, department_id, designation_id, join_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [
          b.employee_code, b.first_name, b.last_name, b.email ?? null, b.phone ?? null,
          b.gender ?? null, b.date_of_birth ?? null, b.department_id ?? null,
          b.designation_id ?? null, b.join_date ?? null,
        ],
      );
      res.status(201).json(ok({ id: rows[0].id }));
    }),
  );

  // PUT /staff/:id — admin
  r.put(
    '/staff/:id',
    requireRole('super_admin', 'admin'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const f = pickUpdatable(req.body ?? {}, [
        'first_name', 'last_name', 'email', 'phone', 'gender',
        'department_id', 'designation_id', 'is_active',
      ]);
      if (!f.cols.length) throw AppError.validation([{ field: 'body', message: 'no updatable fields' }]);
      f.params.push(req.params.id);
      const { rowCount } = await pools.query(
        ctx,
        `UPDATE staff SET ${f.set}, updated_at = NOW()
          WHERE id = $${f.params.length} AND deleted_at IS NULL`,
        f.params,
      );
      if (!rowCount) throw AppError.notFound('Staff');
      res.json(ok({ updated: true }));
    }),
  );

  // DELETE /staff/:id — soft delete
  r.delete(
    '/staff/:id',
    requireRole('super_admin', 'admin'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const { rowCount } = await pools.query(
        ctx,
        `UPDATE staff SET deleted_at = NOW(), is_active = FALSE WHERE id = $1 AND deleted_at IS NULL`,
        [req.params.id],
      );
      if (!rowCount) throw AppError.notFound('Staff');
      res.json(ok({ deleted: true }));
    }),
  );

  // GET /staff/:id/attendance — admin, principal, self
  r.get(
    '/staff/:id/attendance',
    requireRole('super_admin', 'admin', 'principal', 'teacher', 'accountant', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const privileged = ['super_admin', 'admin', 'principal'].includes(req.auth!.role);
      if (!privileged && !isSelf(req, req.params.id)) throw AppError.forbidden();
      const { rows } = await pools.query(
        ctx,
        `SELECT date, status, remarks FROM staff_attendance
          WHERE staff_id = $1 ORDER BY date DESC LIMIT 365`,
        [req.params.id],
      );
      res.json(ok(rows));
    }),
  );

  // POST /staff/attendance/bulk — admin marks daily staff attendance
  r.post(
    '/staff/attendance/bulk',
    requireRole('super_admin', 'admin'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const b = req.body ?? {};
      requireFields(b, ['date']);
      const records = Array.isArray(b.records) ? b.records : [];
      if (!records.length) throw AppError.validation([{ field: 'records', message: 'required' }]);
      const n = await pools.withTransaction(ctx, async (client) => {
        let c = 0;
        for (const rec of records) {
          if (!rec.staff_id || !rec.status) {
            throw AppError.validation([{ field: 'records', message: 'each needs staff_id and status' }]);
          }
          await client.query(
            `INSERT INTO staff_attendance (staff_id, date, status, remarks)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (staff_id, date) DO UPDATE
               SET status = EXCLUDED.status, remarks = EXCLUDED.remarks`,
            [rec.staff_id, b.date, rec.status, rec.remarks ?? null],
          );
          c++;
        }
        return c;
      });
      res.status(201).json(ok({ marked: n, date: b.date }));
    }),
  );

  return r;
}
