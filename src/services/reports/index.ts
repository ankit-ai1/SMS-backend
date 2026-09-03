import { Router } from 'express';
import { TenantPoolManager } from '../../pool/tenantPoolManager';
import { asyncHandler } from '../../http/context';
import { ok } from '../../http/envelope';
import { AppError } from '../../http/errors';
import { requireRole } from '../../http/rbac';
import { ctxOf } from '../corePeople/scope';

const READ = ['super_admin', 'admin', 'principal'] as const;

/**
 * Aggregate reports.
 *
 * These exist to replace a fan-out from the browser: an attendance screen with
 * 20 sections was 20 requests, each returning rows the client then reduced. Each
 * endpoint here does the grouping in one query and returns the full breakdown —
 * a totals line alone would just push the per-row work back to the client.
 */
export function reportsRouter(pools: TenantPoolManager): Router {
  const r = Router();

  /** Required uuid-ish query parameter. */
  function requireQuery(raw: unknown, field: string): string {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw AppError.validation([{ field, message: 'is required' }]);
    }
    return raw.trim();
  }

  // GET /reports/attendance?academic_year_id=&month=YYYY-MM
  // Per section: how many were marked, the average attendance, and how many
  // students sit below the 75% line that decides exam eligibility.
  r.get('/reports/attendance', requireRole(...READ), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const yearId = requireQuery(req.query.academic_year_id, 'academic_year_id');
    const month = typeof req.query.month === 'string' && req.query.month ? req.query.month : null;
    if (month !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw AppError.validation([{ field: 'month', message: 'must be YYYY-MM' }]);
    }

    const { rows } = await pools.query(
      ctx,
      `WITH per_student AS (
         SELECT e.section_id,
                e.id AS enrollment_id,
                COUNT(a.*)                                            AS marked,
                COUNT(*) FILTER (WHERE a.status = 'present')          AS present
           FROM student_enrollments e
           JOIN attendance_records a ON a.enrollment_id = e.id
          WHERE e.academic_year_id = $1
            AND ($2::text IS NULL OR to_char(a.date, 'YYYY-MM') = $2)
          GROUP BY e.section_id, e.id
       )
       SELECT sec.id            AS section_id,
              sec.name          AS section_name,
              c.id              AS class_id,
              c.name            AS class_name,
              COUNT(p.enrollment_id)::int                             AS students_with_records,
              COALESCE(SUM(p.marked), 0)::int                         AS total_marked,
              COALESCE(SUM(p.present), 0)::int                        AS total_present,
              ROUND(100.0 * COALESCE(SUM(p.present), 0)
                    / NULLIF(COALESCE(SUM(p.marked), 0), 0), 1)       AS average_attendance_pct,
              COUNT(*) FILTER (
                WHERE p.marked > 0 AND 100.0 * p.present / p.marked < 75
              )::int                                                  AS below_75_count
         FROM sections sec
         JOIN classes c ON c.id = sec.class_id
         LEFT JOIN per_student p ON p.section_id = sec.id
        WHERE sec.academic_year_id = $1
        GROUP BY sec.id, sec.name, c.id, c.name, c.numeric_order
        ORDER BY c.numeric_order, sec.name`,
      [yearId, month],
    );

    const totals = rows.reduce(
      (acc: { total_marked: number; total_present: number; below_75_count: number }, s) => {
        const row = s as Record<string, number>;
        acc.total_marked += Number(row.total_marked);
        acc.total_present += Number(row.total_present);
        acc.below_75_count += Number(row.below_75_count);
        return acc;
      },
      { total_marked: 0, total_present: 0, below_75_count: 0 },
    );
    res.json(ok({
      academic_year_id: yearId,
      month,
      sections: rows,
      totals: {
        ...totals,
        average_attendance_pct: totals.total_marked
          ? Math.round((1000 * totals.total_present) / totals.total_marked) / 10
          : null,
      },
    }));
  }));

  // GET /reports/fees?academic_year_id=
  // Class-wise billed / collected / outstanding, straight off the allocations.
  r.get('/reports/fees', requireRole(...READ), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const yearId = requireQuery(req.query.academic_year_id, 'academic_year_id');

    const { rows } = await pools.query(
      ctx,
      `SELECT c.id   AS class_id,
              c.name AS class_name,
              COUNT(DISTINCT e.student_id)::int                        AS students,
              COUNT(al.id)::int                                        AS allocations,
              COALESCE(SUM(al.amount_due), 0)::float                   AS billed,
              COALESCE(SUM(al.amount_paid), 0)::float                  AS collected,
              COALESCE(SUM(al.amount_due - al.amount_paid), 0)::float  AS outstanding,
              COUNT(*) FILTER (WHERE al.status <> 'paid')::int         AS unpaid_allocations,
              COUNT(*) FILTER (
                WHERE al.status <> 'paid' AND al.due_date < CURRENT_DATE
              )::int                                                   AS overdue_allocations
         FROM classes c
         JOIN sections sec ON sec.class_id = c.id AND sec.academic_year_id = $1
         JOIN student_enrollments e
           ON e.section_id = sec.id AND e.academic_year_id = $1
         LEFT JOIN student_fee_allocations al ON al.enrollment_id = e.id
        GROUP BY c.id, c.name, c.numeric_order
        ORDER BY c.numeric_order`,
      [yearId],
    );

    const sum = (key: string) =>
      rows.reduce((n, row) => n + Number((row as Record<string, number>)[key]), 0);
    const billed = sum('billed');
    const collected = sum('collected');
    res.json(ok({
      academic_year_id: yearId,
      classes: rows,
      totals: {
        billed,
        collected,
        outstanding: sum('outstanding'),
        collection_pct: billed ? Math.round((1000 * collected) / billed) / 10 : null,
      },
    }));
  }));

  // GET /reports/exams?exam_id=
  // Subject-wise average, pass rate and the range of marks. Pass mark comes from
  // the exam subject; where none is set, 33% of max_marks is the fallback.
  r.get('/reports/exams', requireRole(...READ), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const examId = requireQuery(req.query.exam_id, 'exam_id');

    const exam = await pools.query(
      ctx,
      `SELECT id, name, academic_year_id, term_id, start_date, end_date
         FROM exams WHERE id = $1`,
      [examId],
    );
    if (!exam.rows.length) throw AppError.notFound('Exam');

    const { rows } = await pools.query(
      ctx,
      `SELECT es.id            AS exam_subject_id,
              sub.id           AS subject_id,
              sub.name         AS subject_name,
              c.id             AS class_id,
              c.name           AS class_name,
              es.max_marks::float                                   AS max_marks,
              COALESCE(es.pass_marks, es.max_marks * 0.33)::float    AS pass_marks,
              COUNT(g.id)::int                                      AS graded,
              ROUND(AVG(g.marks_obtained), 2)::float                 AS average_marks,
              MAX(g.marks_obtained)::float                           AS highest_marks,
              MIN(g.marks_obtained)::float                           AS lowest_marks,
              COUNT(*) FILTER (
                WHERE g.marks_obtained >= COALESCE(es.pass_marks, es.max_marks * 0.33)
              )::int                                                 AS passed,
              ROUND(100.0 * COUNT(*) FILTER (
                WHERE g.marks_obtained >= COALESCE(es.pass_marks, es.max_marks * 0.33)
              ) / NULLIF(COUNT(g.id), 0), 1)                         AS pass_pct
         FROM exam_subjects es
         JOIN subjects sub ON sub.id = es.subject_id
         LEFT JOIN classes c ON c.id = es.class_id
         LEFT JOIN exam_grades g
           ON g.exam_subject_id = es.id AND g.marks_obtained IS NOT NULL
        WHERE es.exam_id = $1
        GROUP BY es.id, sub.id, sub.name, c.id, c.name, c.numeric_order,
                 es.max_marks, es.pass_marks
        ORDER BY c.numeric_order NULLS LAST, sub.name`,
      [examId],
    );

    const graded = rows.reduce((n, row) => n + Number((row as Record<string, number>).graded), 0);
    const passed = rows.reduce((n, row) => n + Number((row as Record<string, number>).passed), 0);
    res.json(ok({
      exam: exam.rows[0],
      subjects: rows,
      totals: {
        graded,
        passed,
        pass_pct: graded ? Math.round((1000 * passed) / graded) / 10 : null,
      },
    }));
  }));

  return r;
}
