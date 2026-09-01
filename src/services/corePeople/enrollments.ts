import { Router } from 'express';
import { TenantPoolManager } from '../../pool/tenantPoolManager';
import { asyncHandler } from '../../http/context';
import { ok } from '../../http/envelope';
import { AppError } from '../../http/errors';
import { requireRole } from '../../http/rbac';
import { pageMeta, parsePage } from '../../http/pagination';
import { ctxOf, assertParentOwnsStudent, assertTeacherOwnsSection, staffIdOf } from './scope';
import { requireFields, pickUpdatable } from './students';

/** Base doc §5.2 — Enrollments. */
export function enrollmentsRouter(pools: TenantPoolManager): Router {
  const r = Router();

  // GET /enrollments — filter by year, class, section
  r.get(
    '/enrollments',
    requireRole('super_admin', 'admin', 'principal', 'teacher', 'accountant', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const p = parsePage(req, ['created_at', 'roll_number']);
      const where: string[] = ['1=1'];
      const params: unknown[] = [];
      for (const [q, col] of [
        ['academic_year_id', 'e.academic_year_id'],
        ['section_id', 'e.section_id'],
        ['status', 'e.status'],
      ] as const) {
        if (typeof req.query[q] === 'string') {
          params.push(req.query[q]);
          where.push(`${col} = $${params.length}`);
        }
      }
      const clause = `WHERE ${where.join(' AND ')}`;
      const total = (
        await pools.query<{ n: string }>(
          ctx,
          `SELECT COUNT(*)::int n FROM student_enrollments e ${clause}`,
          params,
        )
      ).rows[0].n;
      const rows = (
        await pools.query(
          ctx,
          `SELECT e.id, e.student_id, e.section_id, e.academic_year_id,
                  e.roll_number, e.status,
                  s.first_name, s.last_name, s.admission_number
             FROM student_enrollments e
             JOIN students s ON s.id = e.student_id
            ${clause}
            ORDER BY e.${p.sort} ${p.order}
            LIMIT ${p.perPage} OFFSET ${p.offset}`,
          params,
        )
      ).rows;
      res.json(ok(rows, pageMeta(p.page, p.perPage, Number(total))));
    }),
  );

  // GET /enrollments/:id — parent may read own
  r.get(
    '/enrollments/:id',
    requireRole('super_admin', 'admin', 'principal', 'teacher', 'parent'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const { rows } = await pools.query(
        ctx,
        `SELECT * FROM student_enrollments WHERE id = $1`,
        [req.params.id],
      );
      if (rows.length === 0) throw AppError.notFound('Enrollment');
      if (req.auth!.role === 'parent') {
        await assertParentOwnsStudent(pools, ctx, req.auth!.userId, rows[0].student_id);
      }
      res.json(ok(rows[0]));
    }),
  );

  // POST /enrollments — admin
  r.post(
    '/enrollments',
    requireRole('super_admin', 'admin', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const b = req.body ?? {};
      requireFields(b, ['student_id', 'section_id', 'academic_year_id']);
      const { rows } = await pools.query(
        ctx,
        `INSERT INTO student_enrollments (student_id, section_id, academic_year_id, roll_number)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [b.student_id, b.section_id, b.academic_year_id, b.roll_number ?? null],
      );
      res.status(201).json(ok({ id: rows[0].id }));
    }),
  );

  // PUT /enrollments/:id — transfer/withdraw
  r.put(
    '/enrollments/:id',
    requireRole('super_admin', 'admin'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const f = pickUpdatable(req.body ?? {}, ['section_id', 'roll_number', 'status']);
      if (!f.cols.length) throw AppError.validation([{ field: 'body', message: 'no updatable fields' }]);
      f.params.push(req.params.id);
      const { rowCount } = await pools.query(
        ctx,
        `UPDATE student_enrollments SET ${f.set} WHERE id = $${f.params.length}`,
        f.params,
      );
      if (!rowCount) throw AppError.notFound('Enrollment');
      res.json(ok({ updated: true }));
    }),
  );

  // GET /sections/:sectionId/enrollments — teacher(assigned) scope
  r.get(
    '/sections/:sectionId/enrollments',
    // the accountant's fee roster is built from this list (names + roll numbers)
    requireRole('super_admin', 'admin', 'principal', 'teacher', 'accountant', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      if (req.auth!.role === 'teacher') {
        await assertTeacherOwnsSection(pools, ctx, staffIdOf(req), req.params.sectionId);
      }
      const { rows } = await pools.query(
        ctx,
        `SELECT e.id AS enrollment_id, e.roll_number, e.status,
                s.id AS student_id, s.first_name, s.last_name, s.admission_number
           FROM student_enrollments e
           JOIN students s ON s.id = e.student_id
          WHERE e.section_id = $1 AND e.status = 'active'
          ORDER BY e.roll_number NULLS LAST, s.last_name`,
        [req.params.sectionId],
      );
      res.json(ok(rows));
    }),
  );

  return r;
}
