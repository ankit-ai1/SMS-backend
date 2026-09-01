import { Router } from 'express';
import { TenantPoolManager } from '../../pool/tenantPoolManager';
import { asyncHandler } from '../../http/context';
import { ok } from '../../http/envelope';
import { AppError } from '../../http/errors';
import { requireRole } from '../../http/rbac';
import {
  ctxOf,
  assertParentOwnsStudent,
  assertStudentSelf,
  assertTeacherOwnsSection,
  staffIdOf,
} from './scope';
import { requireFields } from './students';

/** Base doc §5.2 — Attendance. */
export function attendanceRouter(pools: TenantPoolManager): Router {
  const r = Router();

  // GET /attendance — query by date range, section, student
  r.get(
    '/attendance',
    requireRole('super_admin', 'admin', 'principal', 'teacher', 'parent', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const where: string[] = ['1=1'];
      const params: unknown[] = [];
      if (typeof req.query.section_id === 'string' && req.query.section_id) {
        params.push(req.query.section_id);
        where.push(`e.section_id = $${params.length}`);
      }
      if (typeof req.query.student_id === 'string' && req.query.student_id) {
        if (req.auth!.role === 'parent') {
          await assertParentOwnsStudent(pools, ctx, req.auth!.userId, req.query.student_id);
        }
        params.push(req.query.student_id);
        where.push(`e.student_id = $${params.length}`);
      }
      if (typeof req.query.date_from === 'string' && req.query.date_from) {
        params.push(req.query.date_from);
        where.push(`a.date >= $${params.length}`);
      }
      if (typeof req.query.date_to === 'string' && req.query.date_to) {
        params.push(req.query.date_to);
        where.push(`a.date <= $${params.length}`);
      }
      if (typeof req.query.status === 'string' && req.query.status) {
        params.push(req.query.status);
        where.push(`a.status = $${params.length}`);
      }
      const { rows } = await pools.query(
        ctx,
        `SELECT a.id, a.enrollment_id, e.student_id, a.date, a.status, a.remarks
           FROM attendance_records a
           JOIN student_enrollments e ON e.id = a.enrollment_id
          WHERE ${where.join(' AND ')}
          ORDER BY a.date DESC
          LIMIT 500`,
        params,
      );
      res.json(ok(rows));
    }),
  );

  // POST /attendance/bulk — teacher(assigned) marks a whole section for one date
  r.post(
    '/attendance/bulk',
    requireRole('super_admin', 'admin', 'teacher', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const b = req.body ?? {};
      requireFields(b, ['section_id', 'date']);
      const records = Array.isArray(b.records) ? b.records : [];
      if (records.length === 0) {
        throw AppError.validation([{ field: 'records', message: 'must be a non-empty array' }]);
      }
      if (req.auth!.role === 'teacher') {
        await assertTeacherOwnsSection(pools, ctx, staffIdOf(req), b.section_id);
      }
      const markedBy = req.auth!.linkedEntityType === 'staff' ? req.auth!.linkedEntityId : null;

      const count = await pools.withTransaction(ctx, async (client) => {
        let n = 0;
        for (const rec of records) {
          if (!rec.enrollment_id || !rec.status) {
            throw AppError.validation([
              { field: 'records', message: 'each record needs enrollment_id and status' },
            ]);
          }
          await client.query(
            `INSERT INTO attendance_records (enrollment_id, date, status, remarks, marked_by)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (enrollment_id, date) DO UPDATE
               SET status = EXCLUDED.status, remarks = EXCLUDED.remarks, marked_by = EXCLUDED.marked_by`,
            [rec.enrollment_id, b.date, rec.status, rec.remarks ?? null, markedBy],
          );
          n++;
        }
        return n;
      });
      res.status(201).json(ok({ marked: count, date: b.date }));
    }),
  );

  // PUT /attendance/:id — correct a single record
  r.put(
    '/attendance/:id',
    requireRole('super_admin', 'admin', 'teacher'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const b = req.body ?? {};
      requireFields(b, ['status']);
      const { rowCount } = await pools.query(
        ctx,
        `UPDATE attendance_records SET status = $1, remarks = $2 WHERE id = $3`,
        [b.status, b.remarks ?? null, req.params.id],
      );
      if (!rowCount) throw AppError.notFound('Attendance record');
      res.json(ok({ updated: true }));
    }),
  );

  // GET /attendance/summary — % by student/section/month
  r.get(
    '/attendance/summary',
    requireRole('super_admin', 'admin', 'principal', 'teacher', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const where: string[] = ['1=1'];
      const params: unknown[] = [];
      if (typeof req.query.section_id === 'string' && req.query.section_id) {
        params.push(req.query.section_id);
        where.push(`e.section_id = $${params.length}`);
      }
      if (typeof req.query.month === 'string' && req.query.month) {
        params.push(req.query.month); // YYYY-MM
        where.push(`to_char(a.date, 'YYYY-MM') = $${params.length}`);
      }
      const { rows } = await pools.query(
        ctx,
        `SELECT e.student_id,
                COUNT(*)::int AS total_days,
                COUNT(*) FILTER (WHERE a.status = 'present')::int AS present_days,
                ROUND(100.0 * COUNT(*) FILTER (WHERE a.status = 'present') / NULLIF(COUNT(*),0), 1) AS present_pct
           FROM attendance_records a
           JOIN student_enrollments e ON e.id = a.enrollment_id
          WHERE ${where.join(' AND ')}
          GROUP BY e.student_id`,
        params,
      );
      res.json(ok(rows));
    }),
  );

  // GET /students/:id/attendance — history (parent may read own child)
  r.get(
    '/students/:id/attendance',
    requireRole('super_admin', 'admin', 'principal', 'teacher', 'parent', 'student'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      if (req.auth!.role === 'parent') {
        await assertParentOwnsStudent(pools, ctx, req.auth!.userId, req.params.id);
      }
      if (req.auth!.role === 'student') assertStudentSelf(req, req.params.id);
      const { rows } = await pools.query(
        ctx,
        `SELECT a.date, a.status, a.remarks
           FROM attendance_records a
           JOIN student_enrollments e ON e.id = a.enrollment_id
          WHERE e.student_id = $1
          ORDER BY a.date DESC
          LIMIT 365`,
        [req.params.id],
      );
      res.json(ok(rows));
    }),
  );

  return r;
}
