import { Router } from 'express';
import { TenantPoolManager } from '../../pool/tenantPoolManager';
import { asyncHandler } from '../../http/context';
import { ok } from '../../http/envelope';
import { AppError } from '../../http/errors';
import { ctxOf } from './scope';
import { studentsRouter } from './students';
import { enrollmentsRouter } from './enrollments';
import { attendanceRouter } from './attendance';
import { staffRouter } from './staff';
import { leavesRouter } from './leaves';
import { gatePassesRouter } from './gatePasses';

/**
 * /internal/* — service-to-service lookups (base doc §5.7). NOT exposed through
 * the gateway; reachable only inside the cluster. No JWT/role here — protect
 * with network policy + a shared internal token at the edge.
 */
export function corePeopleInternalRouter(pools: TenantPoolManager): Router {
  const r = Router();

  r.get('/students/:id/basic', asyncHandler(async (req, res) => {
    const { rows } = await pools.query(
      ctxOf(req),
      `SELECT s.id, s.first_name, s.last_name, s.admission_number,
              c.name AS class_name, sec.name AS section_name
         FROM students s
         LEFT JOIN student_enrollments e ON e.student_id = s.id AND e.status = 'active'
         LEFT JOIN sections sec ON sec.id = e.section_id
         LEFT JOIN classes c ON c.id = sec.class_id
        WHERE s.id = $1`,
      [req.params.id],
    );
    if (!rows.length) throw AppError.notFound('Student');
    res.json(ok(rows[0]));
  }));

  r.get('/students/by-enrollment/:enrollmentId', asyncHandler(async (req, res) => {
    const { rows } = await pools.query(
      ctxOf(req),
      `SELECT s.id, s.first_name, s.last_name, s.admission_number
         FROM student_enrollments e JOIN students s ON s.id = e.student_id
        WHERE e.id = $1`,
      [req.params.enrollmentId],
    );
    if (!rows.length) throw AppError.notFound('Enrollment');
    res.json(ok(rows[0]));
  }));

  r.get('/staff/:id/basic', asyncHandler(async (req, res) => {
    const { rows } = await pools.query(
      ctxOf(req),
      `SELECT id, first_name, last_name, employee_code FROM staff WHERE id = $1`,
      [req.params.id],
    );
    if (!rows.length) throw AppError.notFound('Staff');
    res.json(ok(rows[0]));
  }));

  r.get('/enrollments/by-section/:sectionId', asyncHandler(async (req, res) => {
    const { rows } = await pools.query(
      ctxOf(req),
      `SELECT e.id AS enrollment_id, e.student_id, e.roll_number
         FROM student_enrollments e
        WHERE e.section_id = $1 AND e.status = 'active'`,
      [req.params.sectionId],
    );
    res.json(ok(rows));
  }));

  return r;
}

/**
 * Public Core People router — mounts every §5.2 resource group. The order does
 * not matter since paths are distinct; students first for readability.
 */
export function corePeopleRouter(pools: TenantPoolManager): Router {
  const r = Router();
  r.use(studentsRouter(pools));
  r.use(enrollmentsRouter(pools));
  r.use(attendanceRouter(pools));
  r.use(staffRouter(pools));
  r.use(leavesRouter(pools));
  r.use(gatePassesRouter(pools));
  return r;
}
