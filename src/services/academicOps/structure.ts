import { Router } from 'express';
import { TenantPoolManager } from '../../pool/tenantPoolManager';
import { asyncHandler } from '../../http/context';
import { ok } from '../../http/envelope';
import { AppError } from '../../http/errors';
import { requireRole } from '../../http/rbac';
import { ctxOf, teacherSectionIds } from '../corePeople/scope';
import { requireFields, pickUpdatable, guardFkConflict } from '../corePeople/students';

// The accountant is fees-only, but fee screens are built on years/classes/sections,
// so those three reads keep them and the rest of the academic detail does not.
const READ_ALL = ['super_admin', 'admin', 'principal', 'teacher', 'accountant', 'clerk', 'parent', 'student'] as const;
const READ_ACADEMIC = ['super_admin', 'admin', 'principal', 'teacher', 'clerk', 'parent', 'student'] as const;
// classes/sections are the school-wide lists; a student only sees their own
// placement, which /dashboard/student already returns.
const READ_SCAFFOLD = ['super_admin', 'admin', 'principal', 'teacher', 'accountant', 'clerk', 'parent'] as const;
// departments/designations are staff-org data; the front office does not see them.
const READ_ORG = ['super_admin', 'admin', 'principal', 'teacher', 'parent'] as const;
const WRITE = ['super_admin', 'admin'] as const;  // principal is read-only

/** Base doc §5.3 — academic structure (years, terms, departments, classes, sections, subjects). */
export function structureRouter(pools: TenantPoolManager): Router {
  const r = Router();

  // ---- Academic years ----
  r.get('/academic-years', requireRole(...READ_ALL), asyncHandler(async (req, res) => {
    const { rows } = await pools.query(ctxOf(req),
      `SELECT id, name, start_date, end_date, is_current FROM academic_years ORDER BY start_date DESC`);
    res.json(ok(rows));
  }));

  r.post('/academic-years', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    requireFields(b, ['name', 'start_date', 'end_date']);
    const { rows } = await pools.query(ctxOf(req),
      `INSERT INTO academic_years (name, start_date, end_date) VALUES ($1,$2,$3) RETURNING id`,
      [b.name, b.start_date, b.end_date]);
    res.status(201).json(ok({ id: rows[0].id }));
  }));

  r.put('/academic-years/:id', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const f = pickUpdatable(req.body ?? {}, ['name', 'start_date', 'end_date']);
    if (!f.cols.length) throw AppError.validation([{ field: 'body', message: 'no updatable fields' }]);
    f.params.push(req.params.id);
    const { rowCount } = await pools.query(ctxOf(req),
      `UPDATE academic_years SET ${f.set} WHERE id = $${f.params.length}`, f.params);
    if (!rowCount) throw AppError.notFound('Academic year');
    res.json(ok({ updated: true }));
  }));

  // PUT /academic-years/:id/set-current — atomically flip the current year
  r.put('/academic-years/:id/set-current', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    await pools.withTransaction(ctx, async (client) => {
      await client.query(`UPDATE academic_years SET is_current = FALSE WHERE is_current`);
      const upd = await client.query(`UPDATE academic_years SET is_current = TRUE WHERE id = $1`, [req.params.id]);
      if (!upd.rowCount) throw AppError.notFound('Academic year');
    });
    res.json(ok({ is_current: true }));
  }));

  r.delete('/academic-years/:id', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const id = req.params.id;
    // terms/sections/exams cascade from academic_years, so a plain DELETE would
    // silently take them with it — check explicitly and refuse instead.
    const { rows } = await pools.query<{ in_use: boolean }>(ctx,
      `SELECT EXISTS (SELECT 1 FROM terms WHERE academic_year_id = $1)
            OR EXISTS (SELECT 1 FROM sections WHERE academic_year_id = $1)
            OR EXISTS (SELECT 1 FROM student_enrollments WHERE academic_year_id = $1) AS in_use`,
      [id]);
    if (rows[0].in_use) throw AppError.conflict();
    const { rowCount } = await guardFkConflict(() => pools.query(ctx,
      `DELETE FROM academic_years WHERE id = $1`, [id]));
    if (!rowCount) throw AppError.notFound('Academic year');
    res.json(ok({ deleted: true }));
  }));

  // ---- Terms ----
  r.get('/academic-years/:yearId/terms', requireRole(...READ_ACADEMIC), asyncHandler(async (req, res) => {
    const { rows } = await pools.query(ctxOf(req),
      `SELECT id, name, start_date, end_date FROM terms WHERE academic_year_id = $1 ORDER BY start_date`,
      [req.params.yearId]);
    res.json(ok(rows));
  }));

  r.post('/academic-years/:yearId/terms', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    requireFields(b, ['name', 'start_date', 'end_date']);
    const { rows } = await pools.query(ctxOf(req),
      `INSERT INTO terms (academic_year_id, name, start_date, end_date) VALUES ($1,$2,$3,$4) RETURNING id`,
      [req.params.yearId, b.name, b.start_date, b.end_date]);
    res.status(201).json(ok({ id: rows[0].id }));
  }));

  r.put('/academic-years/:yearId/terms/:termId', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
    const f = pickUpdatable(req.body ?? {}, ['name', 'start_date', 'end_date']);
    if (!f.cols.length) throw AppError.validation([{ field: 'body', message: 'no updatable fields' }]);
    f.params.push(req.params.termId, req.params.yearId);
    const { rowCount } = await pools.query(ctxOf(req),
      `UPDATE terms SET ${f.set}
        WHERE id = $${f.params.length - 1} AND academic_year_id = $${f.params.length}`, f.params);
    if (!rowCount) throw AppError.notFound('Term');
    res.json(ok({ updated: true }));
  }));

  r.delete('/academic-years/:yearId/terms/:termId', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
    const { rowCount } = await guardFkConflict(() => pools.query(ctxOf(req),
      `DELETE FROM terms WHERE id = $1 AND academic_year_id = $2`,
      [req.params.termId, req.params.yearId]));
    if (!rowCount) throw AppError.notFound('Term');
    res.json(ok({ deleted: true }));
  }));

  // ---- Departments ----
  r.get('/departments', requireRole(...READ_ORG), asyncHandler(async (req, res) => {
    const { rows } = await pools.query(ctxOf(req), `SELECT id, name FROM departments ORDER BY name`);
    res.json(ok(rows));
  }));
  r.post('/departments', requireRole(...WRITE), asyncHandler(async (req, res) => {
    requireFields(req.body ?? {}, ['name']);
    const { rows } = await pools.query(ctxOf(req), `INSERT INTO departments (name) VALUES ($1) RETURNING id`, [req.body.name]);
    res.status(201).json(ok({ id: rows[0].id }));
  }));

  r.put('/departments/:id', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
    const f = pickUpdatable(req.body ?? {}, ['name']);
    if (!f.cols.length) throw AppError.validation([{ field: 'body', message: 'no updatable fields' }]);
    f.params.push(req.params.id);
    const { rowCount } = await pools.query(ctxOf(req),
      `UPDATE departments SET ${f.set} WHERE id = $${f.params.length}`, f.params);
    if (!rowCount) throw AppError.notFound('Department');
    res.json(ok({ updated: true }));
  }));
  r.delete('/departments/:id', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
    const { rowCount } = await guardFkConflict(() => pools.query(ctxOf(req),
      `DELETE FROM departments WHERE id = $1`, [req.params.id]));
    if (!rowCount) throw AppError.notFound('Department');
    res.json(ok({ deleted: true }));
  }));

  // ---- Designations ----
  r.get('/designations', requireRole(...READ_ORG), asyncHandler(async (req, res) => {
    const { rows } = await pools.query(ctxOf(req), `SELECT id, title FROM designations ORDER BY title`);
    res.json(ok(rows));
  }));
  r.post('/designations', requireRole(...WRITE), asyncHandler(async (req, res) => {
    requireFields(req.body ?? {}, ['title']);
    const { rows } = await pools.query(ctxOf(req), `INSERT INTO designations (title) VALUES ($1) RETURNING id`, [req.body.title]);
    res.status(201).json(ok({ id: rows[0].id }));
  }));

  r.put('/designations/:id', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
    const f = pickUpdatable(req.body ?? {}, ['title']);
    if (!f.cols.length) throw AppError.validation([{ field: 'body', message: 'no updatable fields' }]);
    f.params.push(req.params.id);
    const { rowCount } = await pools.query(ctxOf(req),
      `UPDATE designations SET ${f.set} WHERE id = $${f.params.length}`, f.params);
    if (!rowCount) throw AppError.notFound('Designation');
    res.json(ok({ updated: true }));
  }));
  r.delete('/designations/:id', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
    const { rowCount } = await guardFkConflict(() => pools.query(ctxOf(req),
      `DELETE FROM designations WHERE id = $1`, [req.params.id]));
    if (!rowCount) throw AppError.notFound('Designation');
    res.json(ok({ deleted: true }));
  }));

  // ---- Classes ----
  r.get('/classes', requireRole(...READ_SCAFFOLD), asyncHandler(async (req, res) => {
    const { rows } = await pools.query(ctxOf(req),
      `SELECT id, name, numeric_order FROM classes ORDER BY numeric_order`);
    res.json(ok(rows));
  }));
  r.post('/classes', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    requireFields(b, ['name', 'numeric_order']);
    const { rows } = await pools.query(ctxOf(req),
      `INSERT INTO classes (name, numeric_order) VALUES ($1,$2) RETURNING id`, [b.name, b.numeric_order]);
    res.status(201).json(ok({ id: rows[0].id }));
  }));
  r.put('/classes/:id', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const f = pickUpdatable(req.body ?? {}, ['name', 'numeric_order']);
    if (!f.cols.length) throw AppError.validation([{ field: 'body', message: 'no updatable fields' }]);
    f.params.push(req.params.id);
    const { rowCount } = await pools.query(ctxOf(req), `UPDATE classes SET ${f.set} WHERE id = $${f.params.length}`, f.params);
    if (!rowCount) throw AppError.notFound('Class');
    res.json(ok({ updated: true }));
  }));
  r.delete('/classes/:id', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
    const { rowCount } = await guardFkConflict(() => pools.query(ctxOf(req),
      `DELETE FROM classes WHERE id = $1`, [req.params.id]));
    if (!rowCount) throw AppError.notFound('Class');
    res.json(ok({ deleted: true }));
  }));

  // ---- Sections ----
  // Registered ahead of every /sections/:id route so "mine" is never read as an id.
  r.get('/sections/mine', requireRole('super_admin', 'admin', 'principal', 'teacher'), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const auth = req.auth!;
    // staffIdOf() would 403 here; this endpoint is teacher-centric, so an account
    // with no staff link (admin/principal, typically) just sees an empty list.
    if (auth.linkedEntityType !== 'staff' || !auth.linkedEntityId) {
      res.json(ok([]));
      return;
    }
    const ids = await teacherSectionIds(pools, ctx, auth.linkedEntityId);
    if (!ids.length) {
      res.json(ok([]));
      return;
    }
    const { rows } = await pools.query(ctx,
      `SELECT sec.id, sec.name, sec.class_id, c.name AS class_name, sec.academic_year_id
         FROM sections sec JOIN classes c ON c.id = sec.class_id
        WHERE sec.id = ANY($1) ORDER BY c.numeric_order, sec.name`, [ids]);
    res.json(ok(rows));
  }));

  r.get('/sections', requireRole(...READ_SCAFFOLD), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const where: string[] = ['1=1']; const params: unknown[] = [];
    if (typeof req.query.class_id === 'string' && req.query.class_id) { params.push(req.query.class_id); where.push(`s.class_id = $${params.length}`); }
    if (typeof req.query.academic_year_id === 'string' && req.query.academic_year_id) { params.push(req.query.academic_year_id); where.push(`s.academic_year_id = $${params.length}`); }
    const { rows } = await pools.query(ctx,
      `SELECT s.id, s.name, s.capacity, s.class_id, c.name AS class_name, s.academic_year_id
         FROM sections s JOIN classes c ON c.id = s.class_id
        WHERE ${where.join(' AND ')} ORDER BY c.numeric_order, s.name`, params);
    res.json(ok(rows));
  }));
  r.post('/sections', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    requireFields(b, ['class_id', 'academic_year_id', 'name']);
    const { rows } = await pools.query(ctxOf(req),
      `INSERT INTO sections (class_id, academic_year_id, name, capacity) VALUES ($1,$2,$3,$4) RETURNING id`,
      [b.class_id, b.academic_year_id, b.name, b.capacity ?? null]);
    res.status(201).json(ok({ id: rows[0].id }));
  }));
  r.put('/sections/:id', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const f = pickUpdatable(req.body ?? {}, ['name', 'capacity']);
    if (!f.cols.length) throw AppError.validation([{ field: 'body', message: 'no updatable fields' }]);
    f.params.push(req.params.id);
    const { rowCount } = await pools.query(ctxOf(req), `UPDATE sections SET ${f.set} WHERE id = $${f.params.length}`, f.params);
    if (!rowCount) throw AppError.notFound('Section');
    res.json(ok({ updated: true }));
  }));
  r.delete('/sections/:id', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
    const { rowCount } = await guardFkConflict(() => pools.query(ctxOf(req),
      `DELETE FROM sections WHERE id = $1`, [req.params.id]));
    if (!rowCount) throw AppError.notFound('Section');
    res.json(ok({ deleted: true }));
  }));

  // ---- Subjects + class_subjects ----
  r.get('/subjects', requireRole(...READ_ACADEMIC), asyncHandler(async (req, res) => {
    const { rows } = await pools.query(ctxOf(req), `SELECT id, name, code FROM subjects ORDER BY name`);
    res.json(ok(rows));
  }));
  r.post('/subjects', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    requireFields(b, ['name']);
    const { rows } = await pools.query(ctxOf(req), `INSERT INTO subjects (name, code) VALUES ($1,$2) RETURNING id`, [b.name, b.code ?? null]);
    res.status(201).json(ok({ id: rows[0].id }));
  }));
  r.put('/subjects/:id', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
    const f = pickUpdatable(req.body ?? {}, ['name', 'code']);
    if (!f.cols.length) throw AppError.validation([{ field: 'body', message: 'no updatable fields' }]);
    f.params.push(req.params.id);
    const { rowCount } = await pools.query(ctxOf(req),
      `UPDATE subjects SET ${f.set} WHERE id = $${f.params.length}`, f.params);
    if (!rowCount) throw AppError.notFound('Subject');
    res.json(ok({ updated: true }));
  }));
  r.delete('/subjects/:id', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
    const { rowCount } = await guardFkConflict(() => pools.query(ctxOf(req),
      `DELETE FROM subjects WHERE id = $1`, [req.params.id]));
    if (!rowCount) throw AppError.notFound('Subject');
    res.json(ok({ deleted: true }));
  }));

  r.post('/classes/:classId/subjects', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    requireFields(b, ['subject_id']);
    const { rows } = await pools.query(ctxOf(req),
      `INSERT INTO class_subjects (class_id, subject_id, is_elective) VALUES ($1,$2,$3) RETURNING id`,
      [req.params.classId, b.subject_id, !!b.is_elective]);
    res.status(201).json(ok({ id: rows[0].id }));
  }));
  r.get('/classes/:classId/subjects', requireRole(...READ_ACADEMIC), asyncHandler(async (req, res) => {
    const { rows } = await pools.query(ctxOf(req),
      `SELECT cs.id, cs.subject_id, sub.name, sub.code, cs.is_elective
         FROM class_subjects cs JOIN subjects sub ON sub.id = cs.subject_id
        WHERE cs.class_id = $1 ORDER BY sub.name`, [req.params.classId]);
    res.json(ok(rows));
  }));

  return r;
}
