import { Router } from 'express';
import { TenantPoolManager } from '../../pool/tenantPoolManager';
import { asyncHandler } from '../../http/context';
import { ok } from '../../http/envelope';
import { AppError } from '../../http/errors';
import { requireRole } from '../../http/rbac';
import { ctxOf } from '../corePeople/scope';
import { requireFields, pickUpdatable } from '../corePeople/students';

const READ_ALL = ['super_admin', 'admin', 'principal', 'teacher', 'clerk', 'parent', 'student'] as const;  // accountant is fees-only
const WRITE = ['super_admin', 'admin'] as const;  // principal is read-only

/** Base doc §4 — school calendar: events, holidays, config. */
export function calendarRouter(pools: TenantPoolManager): Router {
  const r = Router();

  // ---- Events ----
  r.get('/calendar/events', requireRole(...READ_ALL), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const where: string[] = ['is_active = TRUE']; const params: unknown[] = [];
    if (typeof req.query.academic_year_id === 'string' && req.query.academic_year_id) { params.push(req.query.academic_year_id); where.push(`academic_year_id = $${params.length}`); }
    if (typeof req.query.from === 'string' && req.query.from) { params.push(req.query.from); where.push(`end_date >= $${params.length}`); }
    if (typeof req.query.to === 'string' && req.query.to) { params.push(req.query.to); where.push(`start_date <= $${params.length}`); }
    if (typeof req.query.event_type === 'string' && req.query.event_type) { params.push(req.query.event_type); where.push(`event_type = $${params.length}`); }
    const { rows } = await pools.query(ctx,
      `SELECT id, title, description, event_type, start_date, end_date, start_time, end_time,
              is_all_day, location, target_classes
         FROM school_events WHERE ${where.join(' AND ')} ORDER BY start_date`, params);
    res.json(ok(rows));
  }));

  r.post('/calendar/events', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    requireFields(b, ['academic_year_id', 'title', 'event_type', 'start_date', 'end_date']);
    const { rows } = await pools.query(ctxOf(req),
      `INSERT INTO school_events
         (academic_year_id, title, description, event_type, start_date, end_date,
          start_time, end_time, is_all_day, location, target_classes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [b.academic_year_id, b.title, b.description ?? null, b.event_type, b.start_date, b.end_date,
       b.start_time ?? null, b.end_time ?? null, b.is_all_day ?? true, b.location ?? null,
       Array.isArray(b.target_classes) ? b.target_classes : null, req.auth!.userId]);
    res.status(201).json(ok({ id: rows[0].id }));
  }));

  r.put('/calendar/events/:id', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const f = pickUpdatable(req.body ?? {}, ['title', 'description', 'event_type', 'start_date', 'end_date', 'start_time', 'end_time', 'is_all_day', 'location', 'is_active']);
    if (!f.cols.length) throw AppError.validation([{ field: 'body', message: 'no updatable fields' }]);
    f.params.push(req.params.id);
    const { rowCount } = await pools.query(ctxOf(req),
      `UPDATE school_events SET ${f.set}, updated_at = NOW() WHERE id = $${f.params.length}`, f.params);
    if (!rowCount) throw AppError.notFound('Event');
    res.json(ok({ updated: true }));
  }));

  r.delete('/calendar/events/:id', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
    const { rowCount } = await pools.query(ctxOf(req),
      `UPDATE school_events SET is_active = FALSE WHERE id = $1`, [req.params.id]);
    if (!rowCount) throw AppError.notFound('Event');
    res.json(ok({ deleted: true }));
  }));

  // ---- Holidays ----
  r.get('/calendar/holidays', requireRole(...READ_ALL), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const where: string[] = ['is_active = TRUE']; const params: unknown[] = [];
    if (typeof req.query.academic_year_id === 'string' && req.query.academic_year_id) { params.push(req.query.academic_year_id); where.push(`academic_year_id = $${params.length}`); }
    const { rows } = await pools.query(ctx,
      `SELECT id, name, description, holiday_type, start_date, end_date, is_recurring
         FROM holidays WHERE ${where.join(' AND ')} ORDER BY start_date`, params);
    res.json(ok(rows));
  }));

  r.post('/calendar/holidays', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    requireFields(b, ['academic_year_id', 'name', 'holiday_type', 'start_date', 'end_date']);
    const { rows } = await pools.query(ctxOf(req),
      `INSERT INTO holidays (academic_year_id, name, description, holiday_type, start_date, end_date, is_recurring, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [b.academic_year_id, b.name, b.description ?? null, b.holiday_type, b.start_date, b.end_date, b.is_recurring ?? false, req.auth!.userId]);
    res.status(201).json(ok({ id: rows[0].id }));
  }));

  r.delete('/calendar/holidays/:id', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
    const { rowCount } = await pools.query(ctxOf(req),
      `UPDATE holidays SET is_active = FALSE WHERE id = $1`, [req.params.id]);
    if (!rowCount) throw AppError.notFound('Holiday');
    res.json(ok({ deleted: true }));
  }));

  // ---- Calendar config (per academic year) ----
  r.get('/calendar/config/:yearId', requireRole(...READ_ALL), asyncHandler(async (req, res) => {
    const { rows } = await pools.query(ctxOf(req),
      `SELECT academic_year_id, working_days, school_start_time, school_end_time,
              half_day_end_time, total_working_days
         FROM school_calendar_config WHERE academic_year_id = $1`, [req.params.yearId]);
    res.json(ok(rows[0] ?? null));
  }));

  r.put('/calendar/config/:yearId', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    const days: string[] = Array.isArray(b.working_days) && b.working_days.length
      ? b.working_days
      : ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
    const daysLiteral = `{${days.join(',')}}`; // Postgres array literal
    const { rows } = await pools.query(ctxOf(req),
      `INSERT INTO school_calendar_config
         (academic_year_id, working_days, school_start_time, school_end_time, half_day_end_time, total_working_days)
       VALUES ($1, $2::day_of_week_enum[], COALESCE($3::time,'08:00'), COALESCE($4::time,'14:30'), $5::time, $6)
       ON CONFLICT (academic_year_id) DO UPDATE
         SET working_days = EXCLUDED.working_days,
             school_start_time = EXCLUDED.school_start_time,
             school_end_time = EXCLUDED.school_end_time,
             half_day_end_time = EXCLUDED.half_day_end_time,
             total_working_days = EXCLUDED.total_working_days,
             updated_at = NOW()
       RETURNING id`,
      [req.params.yearId, daysLiteral, b.school_start_time ?? null, b.school_end_time ?? null, b.half_day_end_time ?? null, b.total_working_days ?? null]);
    res.json(ok({ id: rows[0].id }));
  }));

  return r;
}
