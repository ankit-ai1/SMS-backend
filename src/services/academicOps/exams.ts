import { Router } from 'express';
import { TenantPoolManager } from '../../pool/tenantPoolManager';
import { asyncHandler } from '../../http/context';
import { ok } from '../../http/envelope';
import { AppError } from '../../http/errors';
import { requireRole } from '../../http/rbac';
import { ctxOf, staffIdOf, teacherSectionIds, studentIdOf, assertOwnsEnrollment, parentStudentIds } from '../corePeople/scope';
import { requireFields, pickUpdatable, guardFkConflict } from '../corePeople/students';

const READ_ALL = ['super_admin', 'admin', 'principal', 'teacher', 'parent'] as const;  // exams are out of scope for accountant and clerk
const WRITE = ['super_admin', 'admin'] as const;  // principal is read-only

/** Base doc §5.3 — exam types, grade scales, exams, grades, report cards. */
export function examsRouter(pools: TenantPoolManager): Router {
  const r = Router();

  // ---- Exam types ----
  r.get('/exam-types', requireRole(...READ_ALL), asyncHandler(async (req, res) => {
    const { rows } = await pools.query(ctxOf(req), `SELECT id, name FROM exam_types ORDER BY name`);
    res.json(ok(rows));
  }));
  r.post('/exam-types', requireRole(...WRITE), asyncHandler(async (req, res) => {
    requireFields(req.body ?? {}, ['name']);
    const { rows } = await pools.query(ctxOf(req), `INSERT INTO exam_types (name) VALUES ($1) RETURNING id`, [req.body.name]);
    res.status(201).json(ok({ id: rows[0].id }));
  }));

  r.put('/exam-types/:id', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
    const f = pickUpdatable(req.body ?? {}, ['name']);
    if (!f.cols.length) throw AppError.validation([{ field: 'body', message: 'no updatable fields' }]);
    f.params.push(req.params.id);
    const { rowCount } = await pools.query(ctxOf(req),
      `UPDATE exam_types SET ${f.set} WHERE id = $${f.params.length}`, f.params);
    if (!rowCount) throw AppError.notFound('Exam type');
    res.json(ok({ updated: true }));
  }));
  r.delete('/exam-types/:id', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
    const { rowCount } = await guardFkConflict(() => pools.query(ctxOf(req),
      `DELETE FROM exam_types WHERE id = $1`, [req.params.id]));
    if (!rowCount) throw AppError.notFound('Exam type');
    res.json(ok({ deleted: true }));
  }));

  // ---- Grade scales ----
  r.get('/grade-scales', requireRole(...READ_ALL), asyncHandler(async (req, res) => {
    const { rows } = await pools.query(ctxOf(req),
      `SELECT gs.id, gs.name, gs.type,
              COALESCE(json_agg(json_build_object('grade', e.grade, 'min', e.min_percent,
                'max', e.max_percent, 'point', e.grade_point) ORDER BY e.min_percent DESC)
                FILTER (WHERE e.id IS NOT NULL), '[]') AS entries
         FROM grade_scales gs LEFT JOIN grade_scale_entries e ON e.grade_scale_id = gs.id
        GROUP BY gs.id ORDER BY gs.name`);
    res.json(ok(rows));
  }));
  r.post('/grade-scales', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req); const b = req.body ?? {};
    requireFields(b, ['name', 'type']);
    const id = await pools.withTransaction(ctx, async (client) => {
      const gs = await client.query(`INSERT INTO grade_scales (name, type) VALUES ($1,$2) RETURNING id`, [b.name, b.type]);
      for (const e of Array.isArray(b.entries) ? b.entries : []) {
        await client.query(
          `INSERT INTO grade_scale_entries (grade_scale_id, grade, min_percent, max_percent, grade_point)
           VALUES ($1,$2,$3,$4,$5)`,
          [gs.rows[0].id, e.grade, e.min_percent, e.max_percent, e.grade_point ?? null]);
      }
      return gs.rows[0].id;
    });
    res.status(201).json(ok({ id }));
  }));

  // ---- Exams ----
  r.get('/exams', requireRole(...READ_ALL), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const where: string[] = ['1=1']; const params: unknown[] = [];
    if (typeof req.query.academic_year_id === 'string' && req.query.academic_year_id) { params.push(req.query.academic_year_id); where.push(`academic_year_id = $${params.length}`); }
    if (typeof req.query.term_id === 'string' && req.query.term_id) { params.push(req.query.term_id); where.push(`term_id = $${params.length}`); }
    const { rows } = await pools.query(ctx,
      `SELECT id, name, exam_type_id, academic_year_id, term_id, start_date, end_date
         FROM exams WHERE ${where.join(' AND ')} ORDER BY start_date DESC NULLS LAST`, params);
    res.json(ok(rows));
  }));
  r.get('/exams/:id', requireRole(...READ_ALL), asyncHandler(async (req, res) => {
    const { rows } = await pools.query(ctxOf(req), `SELECT * FROM exams WHERE id = $1`, [req.params.id]);
    if (!rows.length) throw AppError.notFound('Exam');
    res.json(ok(rows[0]));
  }));
  r.post('/exams', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    requireFields(b, ['academic_year_id', 'exam_type_id', 'name']);
    const { rows } = await pools.query(ctxOf(req),
      `INSERT INTO exams (academic_year_id, term_id, exam_type_id, name, start_date, end_date)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [b.academic_year_id, b.term_id ?? null, b.exam_type_id, b.name, b.start_date ?? null, b.end_date ?? null]);
    res.status(201).json(ok({ id: rows[0].id }));
  }));

  // ---- Exam subjects (schedule a subject within an exam) ----
  r.post('/exams/:examId/subjects', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    requireFields(b, ['subject_id']);
    const { rows } = await pools.query(ctxOf(req),
      `INSERT INTO exam_subjects (exam_id, subject_id, class_id, exam_date, max_marks, pass_marks)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.params.examId, b.subject_id, b.class_id ?? null, b.exam_date ?? null, b.max_marks ?? 100, b.pass_marks ?? null]);
    res.status(201).json(ok({ id: rows[0].id }));
  }));
  r.get('/exams/:examId/subjects', requireRole(...READ_ALL), asyncHandler(async (req, res) => {
    const { rows } = await pools.query(ctxOf(req),
      `SELECT es.id, es.subject_id, sub.name AS subject_name, es.class_id, es.exam_date, es.max_marks, es.pass_marks
         FROM exam_subjects es JOIN subjects sub ON sub.id = es.subject_id
        WHERE es.exam_id = $1`, [req.params.examId]);
    res.json(ok(rows));
  }));

  // ---- Grade entry (teacher(assigned) or admin) ----
  r.post('/exam-subjects/:examSubjectId/grades', requireRole('super_admin', 'admin', 'teacher'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const records = Array.isArray(req.body?.records) ? req.body.records : [];
      if (!records.length) throw AppError.validation([{ field: 'records', message: 'required' }]);

      // Teacher scope: every enrollment must be in a section this teacher teaches.
      if (req.auth!.role === 'teacher') {
        const myS = new Set(await teacherSectionIds(pools, ctx, staffIdOf(req)));
        const enrIds = records.map((x: { enrollment_id: string }) => x.enrollment_id);
        const { rows } = await pools.query<{ id: string; section_id: string }>(ctx,
          `SELECT id, section_id FROM student_enrollments WHERE id = ANY($1)`, [enrIds]);
        for (const e of rows) {
          if (!myS.has(e.section_id)) throw AppError.forbidden('Enrollment outside your sections');
        }
      }
      const enteredBy = req.auth!.linkedEntityType === 'staff' ? req.auth!.linkedEntityId : null;
      const n = await pools.withTransaction(ctx, async (client) => {
        let c = 0;
        for (const rec of records) {
          if (!rec.enrollment_id) throw AppError.validation([{ field: 'records', message: 'enrollment_id required' }]);
          await client.query(
            `INSERT INTO exam_grades (exam_subject_id, enrollment_id, marks_obtained, grade, remarks, entered_by)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (exam_subject_id, enrollment_id) DO UPDATE
               SET marks_obtained = EXCLUDED.marks_obtained, grade = EXCLUDED.grade,
                   remarks = EXCLUDED.remarks, entered_by = EXCLUDED.entered_by`,
            [req.params.examSubjectId, rec.enrollment_id, rec.marks_obtained ?? null, rec.grade ?? null, rec.remarks ?? null, enteredBy]);
          c++;
        }
        return c;
      });
      res.status(201).json(ok({ graded: n }));
    }));

  r.get('/exam-subjects/:examSubjectId/grades', requireRole(...WRITE, 'principal', 'teacher'),
    asyncHandler(async (req, res) => {
      const { rows } = await pools.query(ctxOf(req),
        `SELECT g.enrollment_id, g.marks_obtained, g.grade, g.remarks,
                s.first_name, s.last_name, s.admission_number
           FROM exam_grades g
           JOIN student_enrollments e ON e.id = g.enrollment_id
           JOIN students s ON s.id = e.student_id
          WHERE g.exam_subject_id = $1
          ORDER BY s.last_name`, [req.params.examSubjectId]);
      res.json(ok(rows));
    }));

  // ---- Report cards ----
  r.post('/report-cards/generate', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req); const b = req.body ?? {};
    requireFields(b, ['enrollment_id', 'term_id']);
    // Aggregate marks across the term's graded exam subjects for this enrollment.
    const agg = await pools.query<{ total: string | null; pct: string | null }>(ctx,
      `SELECT SUM(g.marks_obtained) AS total,
              ROUND(AVG(100.0 * g.marks_obtained / NULLIF(es.max_marks,0)), 2) AS pct
         FROM exam_grades g
         JOIN exam_subjects es ON es.id = g.exam_subject_id
         JOIN exams ex ON ex.id = es.exam_id
        WHERE g.enrollment_id = $1 AND ex.term_id = $2`, [b.enrollment_id, b.term_id]);
    const total = agg.rows[0].total; const pct = agg.rows[0].pct;
    const { rows } = await pools.query(ctx,
      `INSERT INTO report_cards (enrollment_id, term_id, total_marks, percentage, generated_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (enrollment_id, term_id) DO UPDATE
         SET total_marks = EXCLUDED.total_marks, percentage = EXCLUDED.percentage,
             generated_at = NOW(), generated_by = EXCLUDED.generated_by
       RETURNING id`, [b.enrollment_id, b.term_id, total, pct, req.auth!.userId]);
    res.status(201).json(ok({ id: rows[0].id, total_marks: total, percentage: pct }));
  }));

  r.get('/report-cards/:enrollmentId', requireRole('super_admin', 'admin', 'principal', 'parent', 'student'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      // An enrollment id alone is not an authorisation: check the caller owns it.
      if (req.auth!.role === 'student') {
        await assertOwnsEnrollment(pools, ctx, studentIdOf(req), req.params.enrollmentId);
      }
      if (req.auth!.role === 'parent') {
        const mine = await parentStudentIds(pools, ctx, req.auth!.userId);
        const owned = await Promise.all(
          mine.map((id) => assertOwnsEnrollment(pools, ctx, id, req.params.enrollmentId).then(() => true, () => false)),
        );
        if (!owned.some(Boolean)) throw AppError.forbidden('Not your record');
      }
      const { rows } = await pools.query(ctxOf(req),
        `SELECT id, term_id, total_marks, percentage, overall_grade, rank, generated_at
           FROM report_cards WHERE enrollment_id = $1 ORDER BY generated_at DESC`, [req.params.enrollmentId]);
      res.json(ok(rows));
    }));

  return r;
}
