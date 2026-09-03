import { Router } from 'express';
import { TenantPoolManager } from '../../pool/tenantPoolManager';
import { asyncHandler } from '../../http/context';
import { ok } from '../../http/envelope';
import { AppError } from '../../http/errors';
import { requireRole } from '../../http/rbac';
import { ctxOf, assertParentOwnsStudent, assertStudentSelf } from '../corePeople/scope';
import { requireFields, pickUpdatable, guardDbConflict } from '../corePeople/students';

const READ = ['super_admin', 'admin', 'clerk', 'accountant'] as const;
const WRITE = ['super_admin', 'admin', 'clerk'] as const;
const BILL = ['super_admin', 'admin', 'accountant'] as const;

/**
 * Every assignment row the UI shows. The student's name and class are joined in
 * for the same reason as everywhere else: a bus list of UUIDs is useless to the
 * person standing at the gate with it.
 */
const ASSIGNMENT_COLUMNS = `
  a.id, a.student_id,
  TRIM(s.first_name || ' ' || s.last_name) AS student_name,
  s.admission_number,
  c.name   AS class_name,
  sec.name AS section_name,
  a.route_id, rt.name AS route_name, rt.vehicle_number,
  a.stop_id, st.stop_name, st.pickup_time, st.drop_time, st.monthly_fare,
  a.start_date, a.end_date, a.created_at`;

const ASSIGNMENT_JOINS = `
  FROM transport_assignments a
  JOIN students s ON s.id = a.student_id
  JOIN transport_routes rt ON rt.id = a.route_id
  JOIN transport_stops st ON st.id = a.stop_id
  LEFT JOIN student_enrollments e
    ON e.student_id = s.id AND e.status = 'active'
  LEFT JOIN academic_years y ON y.id = e.academic_year_id AND y.is_current
  LEFT JOIN sections sec ON sec.id = e.section_id
  LEFT JOIN classes c ON c.id = sec.class_id`;

/** Base doc §5.6 — transport: routes, stops, who rides, what they are billed. */
export function transportRouter(pools: TenantPoolManager): Router {
  const r = Router();

  // ---- Routes ----------------------------------------------------------

  // GET /transport/routes — with the rider count, so the list needs no
  // follow-up call per route.
  r.get('/transport/routes', requireRole(...READ), asyncHandler(async (req, res) => {
    const { rows } = await pools.query(
      ctxOf(req),
      // Scalar subqueries, not two LEFT JOINs: joining riders and stops in the
      // same row set multiplies them together, and the counts come out as
      // riders x stops.
      `SELECT rt.id, rt.name, rt.vehicle_number, rt.driver_name, rt.driver_phone,
              rt.capacity, rt.is_active, rt.created_at,
              (SELECT COUNT(*)::int FROM transport_assignments a
                WHERE a.route_id = rt.id AND a.end_date IS NULL) AS assigned_students,
              (SELECT COUNT(*)::int FROM transport_stops st
                WHERE st.route_id = rt.id)                        AS stop_count
         FROM transport_routes rt
        ORDER BY rt.name`,
    );
    res.json(ok(rows));
  }));

  r.post('/transport/routes', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    requireFields(b, ['name']);
    const { rows } = await guardDbConflict(
      () => pools.query(
        ctxOf(req),
        `INSERT INTO transport_routes (name, vehicle_number, driver_name, driver_phone, capacity)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, name, vehicle_number, driver_name, driver_phone, capacity, is_active, created_at`,
        [b.name, b.vehicle_number ?? null, b.driver_name ?? null,
          b.driver_phone ?? null, b.capacity ?? null],
      ),
      'A route with that name already exists',
    );
    res.status(201).json(ok({ ...rows[0], assigned_students: 0, stop_count: 0 }));
  }));

  r.put('/transport/routes/:id', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const f = pickUpdatable(req.body ?? {}, [
      'name', 'vehicle_number', 'driver_name', 'driver_phone', 'capacity', 'is_active',
    ]);
    if (!f.cols.length) throw AppError.validation([{ field: 'body', message: 'no updatable fields' }]);
    f.params.push(req.params.id);
    const { rows } = await guardDbConflict(
      () => pools.query(
        ctxOf(req),
        `UPDATE transport_routes SET ${f.set} WHERE id = $${f.params.length}
         RETURNING id, name, vehicle_number, driver_name, driver_phone, capacity, is_active, created_at`,
        f.params,
      ),
      'A route with that name already exists',
    );
    if (!rows.length) throw AppError.notFound('Route');
    res.json(ok(rows[0]));
  }));

  // Deleting a route takes its stops and assignments with it (ON DELETE
  // CASCADE), so refuse while anyone is still riding it.
  r.delete('/transport/routes/:id', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const riders = await pools.query<{ n: number }>(
      ctx,
      `SELECT COUNT(*)::int AS n FROM transport_assignments
        WHERE route_id = $1 AND end_date IS NULL`,
      [req.params.id],
    );
    if (riders.rows[0].n > 0) {
      throw AppError.conflict(
        `Cannot delete: ${riders.rows[0].n} student(s) are still assigned to this route`,
      );
    }
    const { rowCount } = await pools.query(
      ctx, `DELETE FROM transport_routes WHERE id = $1`, [req.params.id],
    );
    if (!rowCount) throw AppError.notFound('Route');
    res.json(ok({ deleted: true }));
  }));

  // ---- Stops -----------------------------------------------------------

  r.get('/transport/routes/:routeId/stops', requireRole(...READ), asyncHandler(async (req, res) => {
    const { rows } = await pools.query(
      ctxOf(req),
      `SELECT st.id, st.route_id, st.stop_name, st.pickup_time, st.drop_time,
              st.monthly_fare, st.created_at,
              COUNT(a.id) FILTER (WHERE a.end_date IS NULL)::int AS assigned_students
         FROM transport_stops st
         LEFT JOIN transport_assignments a ON a.stop_id = st.id
        WHERE st.route_id = $1
        GROUP BY st.id
        ORDER BY st.pickup_time NULLS LAST, st.stop_name`,
      [req.params.routeId],
    );
    res.json(ok(rows));
  }));

  r.post('/transport/routes/:routeId/stops', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const b = req.body ?? {};
    requireFields(b, ['stop_name']);
    if (b.monthly_fare !== undefined && Number(b.monthly_fare) < 0) {
      throw AppError.validation([{ field: 'monthly_fare', message: 'cannot be negative' }]);
    }
    const { rows } = await guardDbConflict(
      () => pools.query(
        ctxOf(req),
        `INSERT INTO transport_stops (route_id, stop_name, pickup_time, drop_time, monthly_fare)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, route_id, stop_name, pickup_time, drop_time, monthly_fare, created_at`,
        [req.params.routeId, b.stop_name, b.pickup_time ?? null,
          b.drop_time ?? null, b.monthly_fare ?? 0],
      ),
      'That route has no such id, or already has a stop with that name',
    );
    res.status(201).json(ok({ ...rows[0], assigned_students: 0 }));
  }));

  r.delete('/transport/routes/:routeId/stops/:stopId', requireRole(...WRITE),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const riders = await pools.query<{ n: number }>(
        ctx,
        `SELECT COUNT(*)::int AS n FROM transport_assignments
          WHERE stop_id = $1 AND end_date IS NULL`,
        [req.params.stopId],
      );
      if (riders.rows[0].n > 0) {
        throw AppError.conflict(
          `Cannot delete: ${riders.rows[0].n} student(s) board at this stop`,
        );
      }
      const { rowCount } = await pools.query(
        ctx,
        `DELETE FROM transport_stops WHERE id = $1 AND route_id = $2`,
        [req.params.stopId, req.params.routeId],
      );
      if (!rowCount) throw AppError.notFound('Stop');
      res.json(ok({ deleted: true }));
    }));

  // ---- Assignments -----------------------------------------------------

  // GET /transport/assignments?route_id=&stop_id=&student_id=&active=
  r.get('/transport/assignments', requireRole(...READ), asyncHandler(async (req, res) => {
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    for (const [field, column] of [
      ['route_id', 'a.route_id'], ['stop_id', 'a.stop_id'], ['student_id', 'a.student_id'],
    ] as const) {
      const value = req.query[field];
      if (typeof value === 'string' && value) {
        params.push(value);
        where.push(`${column} = $${params.length}`);
      }
    }
    // Default to current riders; ?active=false shows the history too.
    if (req.query.active !== 'false') where.push('a.end_date IS NULL');

    const { rows } = await pools.query(
      ctxOf(req),
      `SELECT ${ASSIGNMENT_COLUMNS} ${ASSIGNMENT_JOINS}
        WHERE ${where.join(' AND ')}
        ORDER BY rt.name, st.pickup_time NULLS LAST, s.last_name, s.first_name`,
      params,
    );
    res.json(ok(rows));
  }));

  r.post('/transport/assignments', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const b = req.body ?? {};
    requireFields(b, ['student_id', 'route_id', 'stop_id']);

    // The stop has to belong to the route, or the fare billed would come from
    // a stop the child never boards at.
    const stop = await pools.query(
      ctx, `SELECT id FROM transport_stops WHERE id = $1 AND route_id = $2`,
      [b.stop_id, b.route_id],
    );
    if (!stop.rows.length) {
      throw AppError.validation([{ field: 'stop_id', message: 'is not a stop on that route' }]);
    }

    const { rows } = await guardDbConflict(
      () => pools.query(
        ctx,
        `WITH inserted AS (
           INSERT INTO transport_assignments (student_id, route_id, stop_id, start_date)
           VALUES ($1,$2,$3,COALESCE($4::date, CURRENT_DATE))
           RETURNING *
         )
         SELECT ${ASSIGNMENT_COLUMNS} ${ASSIGNMENT_JOINS.replace('FROM transport_assignments a', 'FROM inserted a')}`,
        [b.student_id, b.route_id, b.stop_id, b.start_date ?? null],
      ),
      'That student already rides a bus — end the current assignment first',
    );
    res.status(201).json(ok(rows[0]));
  }));

  // DELETE ends the ride. Past assignments are kept: they are what the fee
  // history was billed against.
  r.delete('/transport/assignments/:id', requireRole(...WRITE), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const hard = req.query.purge === 'true';
    if (hard) {
      const { rowCount } = await pools.query(
        ctx, `DELETE FROM transport_assignments WHERE id = $1`, [req.params.id],
      );
      if (!rowCount) throw AppError.notFound('Assignment');
      res.json(ok({ deleted: true }));
      return;
    }
    const { rowCount } = await pools.query(
      ctx,
      `UPDATE transport_assignments SET end_date = CURRENT_DATE
        WHERE id = $1 AND end_date IS NULL`,
      [req.params.id],
    );
    if (!rowCount) throw new AppError('CONFLICT', 'Assignment not found, or already ended');
    res.json(ok({ ended: true }));
  }));

  // GET /students/:id/transport — the child's current ride, or null.
  // A parent may look up their own child and a student themselves; the bus,
  // stop and pickup time are exactly what they need to know.
  r.get('/students/:id/transport', requireRole(...READ, 'parent', 'student'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      if (req.auth!.role === 'parent') {
        await assertParentOwnsStudent(pools, ctx, req.auth!.userId, req.params.id);
      }
      if (req.auth!.role === 'student') assertStudentSelf(req, req.params.id);
      const { rows } = await pools.query(
        ctx,
        `SELECT ${ASSIGNMENT_COLUMNS} ${ASSIGNMENT_JOINS}
          WHERE a.student_id = $1 AND a.end_date IS NULL
          LIMIT 1`,
        [req.params.id],
      );
      res.json(ok(rows[0] ?? null));
    }));

  // ---- Fee side --------------------------------------------------------

  // POST /transport/fees/generate { fee_structure_id, month, due_date? }
  //
  // Bills every current rider their own stop's monthly fare for one month. The
  // allocation rows carry the amount and the month, so a single "Transport Fee"
  // structure serves the whole year while each child is charged for the
  // distance they actually travel — and October's run does not collide with
  // September's.
  r.post('/transport/fees/generate', requireRole(...BILL), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const b = req.body ?? {};
    requireFields(b, ['fee_structure_id', 'month']);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(b.month))) {
      throw AppError.validation([{ field: 'month', message: 'must be YYYY-MM' }]);
    }

    const structure = await pools.query<{ academic_year_id: string }>(
      ctx, `SELECT academic_year_id FROM fee_structures WHERE id = $1`, [b.fee_structure_id],
    );
    if (!structure.rows.length) throw AppError.notFound('Fee structure');

    const { rows } = await pools.query<{ id: string }>(
      ctx,
      `INSERT INTO student_fee_allocations
         (enrollment_id, fee_structure_id, amount_due, due_date, billing_month)
       SELECT e.id, $1, st.monthly_fare, COALESCE($2::date, CURRENT_DATE), $4
         FROM transport_assignments a
         JOIN transport_stops st ON st.id = a.stop_id
         JOIN student_enrollments e
           ON e.student_id = a.student_id AND e.status = 'active'
          AND e.academic_year_id = $3
        WHERE a.end_date IS NULL AND st.monthly_fare > 0
       ON CONFLICT (enrollment_id, fee_structure_id, billing_month)
         WHERE billing_month IS NOT NULL DO NOTHING
       RETURNING id`,
      [b.fee_structure_id, b.due_date ?? null, structure.rows[0].academic_year_id, b.month],
    );

    const riders = await pools.query<{ n: number }>(
      ctx,
      `SELECT COUNT(*)::int AS n FROM transport_assignments WHERE end_date IS NULL`,
    );
    res.status(201).json(ok({
      month: b.month,
      allocations_created: rows.length,
      current_riders: riders.rows[0].n,
      skipped: riders.rows[0].n - rows.length,
    }));
  }));

  return r;
}
