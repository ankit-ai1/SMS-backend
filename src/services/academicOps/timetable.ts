import { Router } from 'express';
import { TenantPoolManager } from '../../pool/tenantPoolManager';
import { asyncHandler } from '../../http/context';
import { ok } from '../../http/envelope';
import { AppError } from '../../http/errors';
import { requireRole } from '../../http/rbac';
import { ctxOf } from '../corePeople/scope';
import { requireFields } from '../corePeople/students';

const READ_ALL = ['super_admin', 'admin', 'principal', 'teacher', 'clerk', 'parent', 'student'] as const;  // accountant is fees-only
const WRITE = ['super_admin', 'admin'] as const;  // principal is read-only

/** Base doc §5.3 — time slots + timetable. */
export function timetableRouter(pools: TenantPoolManager): Router {
  const r = Router();

  r.get('/time-slots', requireRole(...READ_ALL), asyncHandler(async (req, res) => {
    const { rows } = await pools.query(ctxOf(req),
      `SELECT id, name, start_time, end_time, sort_order FROM time_slots ORDER BY sort_order, start_time`);
    res.json(ok(rows));
  }));

  r.post('/time-slots', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    requireFields(b, ['name', 'start_time', 'end_time']);
    const { rows } = await pools.query(ctxOf(req),
      `INSERT INTO time_slots (name, start_time, end_time, sort_order) VALUES ($1,$2,$3,$4) RETURNING id`,
      [b.name, b.start_time, b.end_time, b.sort_order ?? 0]);
    res.status(201).json(ok({ id: rows[0].id }));
  }));

  // GET /sections/:sectionId/timetable — full weekly grid for a section
  r.get('/sections/:sectionId/timetable', requireRole(...READ_ALL), asyncHandler(async (req, res) => {
    const { rows } = await pools.query(ctxOf(req),
      `SELECT te.id, te.day_of_week, te.time_slot_id, ts.name AS slot_name,
              ts.start_time, ts.end_time, te.subject_id, sub.name AS subject_name,
              te.teacher_id, st.first_name AS teacher_first, st.last_name AS teacher_last
         FROM timetable_entries te
         JOIN time_slots ts ON ts.id = te.time_slot_id
         JOIN subjects sub ON sub.id = te.subject_id
         LEFT JOIN staff st ON st.id = te.teacher_id
        WHERE te.section_id = $1
        ORDER BY ts.sort_order, te.day_of_week`, [req.params.sectionId]);
    res.json(ok(rows));
  }));

  // POST /timetable — create one entry
  r.post('/timetable', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    requireFields(b, ['section_id', 'subject_id', 'time_slot_id', 'day_of_week']);
    const { rows } = await pools.query(ctxOf(req),
      `INSERT INTO timetable_entries (section_id, subject_id, teacher_id, time_slot_id, day_of_week)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [b.section_id, b.subject_id, b.teacher_id ?? null, b.time_slot_id, b.day_of_week]);
    res.status(201).json(ok({ id: rows[0].id }));
  }));

  // PUT /timetable/:id
  r.put('/timetable/:id', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const { rowCount } = await pools.query(ctxOf(req),
      `UPDATE timetable_entries SET subject_id = COALESCE($1, subject_id),
              teacher_id = COALESCE($2, teacher_id)
        WHERE id = $3`, [b.subject_id ?? null, b.teacher_id ?? null, req.params.id]);
    if (!rowCount) throw AppError.notFound('Timetable entry');
    res.json(ok({ updated: true }));
  }));

  // DELETE /timetable/:id
  r.delete('/timetable/:id', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const { rowCount } = await pools.query(ctxOf(req), `DELETE FROM timetable_entries WHERE id = $1`, [req.params.id]);
    if (!rowCount) throw AppError.notFound('Timetable entry');
    res.json(ok({ deleted: true }));
  }));

  return r;
}
