import { Router } from 'express';
import { TenantPoolManager } from '../../pool/tenantPoolManager';
import { asyncHandler } from '../../http/context';
import { ok } from '../../http/envelope';
import { AppError } from '../../http/errors';
import { requireRole } from '../../http/rbac';
import { ctxOf } from '../corePeople/scope';
import { requireFields, pickUpdatable, guardDbConflict } from '../corePeople/students';
import { sectionIdsForUser } from '../system/notifications';

const READ = ['super_admin', 'admin', 'principal', 'teacher', 'clerk'] as const;
const WRITE = ['super_admin', 'admin', 'teacher'] as const;
/** Everyone who can have a timetable of their own. */
const MINE = ['super_admin', 'admin', 'principal', 'teacher', 'clerk', 'parent', 'student'] as const;

/**
 * A student looking at this needs "Maths — Ms. Sharma, 10:00 am", so the
 * subject, the section and the person who scheduled it are all joined in.
 */
const CLASS_COLUMNS = `
  oc.id, oc.section_id, sec.name AS section_name,
  c.id AS class_id, c.name AS class_name,
  oc.subject_id, sub.name AS subject_name,
  oc.title, oc.meeting_url, oc.scheduled_at, oc.duration_minutes,
  oc.created_by, u.full_name AS teacher_name, oc.created_at`;

const CLASS_JOINS = `
  FROM online_classes oc
  JOIN sections sec ON sec.id = oc.section_id
  JOIN classes c ON c.id = sec.class_id
  JOIN subjects sub ON sub.id = oc.subject_id
  LEFT JOIN users u ON u.id = oc.created_by`;

/** Base doc §5.3 — online classes: schedule a session, store its link. */
export function onlineClassesRouter(pools: TenantPoolManager): Router {
  const r = Router();

  // GET /online-classes/mine — registered before /online-classes/:id so "mine"
  // is never read as an id. Resolves the caller's own sections: the ones a
  // teacher teaches, a student sits in, or a parent's children sit in.
  r.get('/online-classes/mine', requireRole(...MINE), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const sectionIds = await sectionIdsForUser(pools, ctx, req.auth!);
    if (!sectionIds.length) {
      res.json(ok([]));
      return;
    }
    // Past sessions are dropped an hour after they end — a link nobody can join
    // is clutter on a "my classes" screen.
    const { rows } = await pools.query(
      ctx,
      `SELECT ${CLASS_COLUMNS} ${CLASS_JOINS}
        WHERE oc.section_id = ANY($1)
          AND oc.scheduled_at + (oc.duration_minutes || ' minutes')::interval
              > NOW() - INTERVAL '1 hour'
        ORDER BY oc.scheduled_at
        LIMIT 200`,
      [sectionIds],
    );
    res.json(ok(rows));
  }));

  // GET /online-classes?section_id=&subject_id=&from=&to=
  r.get('/online-classes', requireRole(...READ), asyncHandler(async (req, res) => {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    for (const [field, column] of [
      ['section_id', 'oc.section_id'], ['subject_id', 'oc.subject_id'],
    ] as const) {
      const value = req.query[field];
      if (typeof value === 'string' && value) {
        params.push(value);
        where.push(`${column} = $${params.length}`);
      }
    }
    for (const [field, op] of [['from', '>='], ['to', '<=']] as const) {
      const value = req.query[field];
      if (typeof value === 'string' && value) {
        params.push(value);
        where.push(`oc.scheduled_at ${op} $${params.length}::timestamptz`);
      }
    }
    const { rows } = await pools.query(
      ctxOf(req),
      `SELECT ${CLASS_COLUMNS} ${CLASS_JOINS}
        WHERE ${where.join(' AND ')}
        ORDER BY oc.scheduled_at DESC
        LIMIT 200`,
      params,
    );
    res.json(ok(rows));
  }));

  r.post('/online-classes', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const b = req.body ?? {};
    requireFields(b, ['section_id', 'subject_id', 'title', 'meeting_url', 'scheduled_at']);
    validateSchedule(b);

    const { rows } = await guardDbConflict(
      () => pools.query(
        ctx,
        `WITH inserted AS (
           INSERT INTO online_classes
             (section_id, subject_id, title, meeting_url, scheduled_at, duration_minutes, created_by)
           VALUES ($1,$2,$3,$4,$5::timestamptz,COALESCE($6,40),$7)
           RETURNING *
         )
         SELECT ${CLASS_COLUMNS} ${CLASS_JOINS.replace('FROM online_classes oc', 'FROM inserted oc')}`,
        [b.section_id, b.subject_id, b.title, b.meeting_url, b.scheduled_at,
          b.duration_minutes ?? null, req.auth!.userId],
      ),
      'No section or subject with that id',
    );
    res.status(201).json(ok(rows[0]));
  }));

  r.put('/online-classes/:id', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    validateSchedule(b);
    const f = pickUpdatable(b, [
      'section_id', 'subject_id', 'title', 'meeting_url', 'scheduled_at', 'duration_minutes',
    ]);
    if (!f.cols.length) throw AppError.validation([{ field: 'body', message: 'no updatable fields' }]);
    f.params.push(req.params.id);

    const { rows } = await guardDbConflict(
      () => pools.query(
        ctxOf(req),
        `WITH updated AS (
           UPDATE online_classes SET ${f.set} WHERE id = $${f.params.length}
           RETURNING *
         )
         SELECT ${CLASS_COLUMNS} ${CLASS_JOINS.replace('FROM online_classes oc', 'FROM updated oc')}`,
        f.params,
      ),
      'No section or subject with that id',
    );
    if (!rows.length) throw AppError.notFound('Online class');
    res.json(ok(rows[0]));
  }));

  r.delete('/online-classes/:id', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const { rowCount } = await pools.query(
      ctxOf(req), `DELETE FROM online_classes WHERE id = $1`, [req.params.id],
    );
    if (!rowCount) throw AppError.notFound('Online class');
    res.json(ok({ deleted: true }));
  }));

  return r;
}

/** Reject a bad timestamp or duration here rather than as a 500 from the CHECK. */
function validateSchedule(b: Record<string, unknown>): void {
  if (b.scheduled_at !== undefined && Number.isNaN(new Date(String(b.scheduled_at)).getTime())) {
    throw AppError.validation([{ field: 'scheduled_at', message: 'must be a valid timestamp' }]);
  }
  if (b.duration_minutes !== undefined && b.duration_minutes !== null) {
    const d = Number(b.duration_minutes);
    if (!Number.isInteger(d) || d < 1 || d > 600) {
      throw AppError.validation([
        { field: 'duration_minutes', message: 'must be a whole number between 1 and 600' },
      ]);
    }
  }
}
