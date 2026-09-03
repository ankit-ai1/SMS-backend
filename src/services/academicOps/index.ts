import { Router } from 'express';
import { TenantPoolManager } from '../../pool/tenantPoolManager';
import { asyncHandler } from '../../http/context';
import { ok } from '../../http/envelope';
import { AppError } from '../../http/errors';
import { ctxOf } from '../corePeople/scope';
import { structureRouter } from './structure';
import { timetableRouter } from './timetable';
import { examsRouter } from './exams';
import { calendarRouter } from './calendar';
import { seatingRouter } from './seating';
import { onlineClassesRouter } from './onlineClasses';

/** /internal/* for Academic Ops (base doc §5.7). */
export function academicOpsInternalRouter(pools: TenantPoolManager): Router {
  const r = Router();

  r.get('/sections/:id/details', asyncHandler(async (req, res) => {
    const { rows } = await pools.query(ctxOf(req),
      `SELECT sec.id, sec.name AS section_name, c.id AS class_id, c.name AS class_name,
              sec.academic_year_id
         FROM sections sec JOIN classes c ON c.id = sec.class_id
        WHERE sec.id = $1`, [req.params.id]);
    if (!rows.length) throw AppError.notFound('Section');
    res.json(ok(rows[0]));
  }));

  r.get('/academic-years/current', asyncHandler(async (req, res) => {
    const { rows } = await pools.query(ctxOf(req),
      `SELECT id, name, start_date, end_date FROM academic_years WHERE is_current LIMIT 1`);
    if (!rows.length) throw AppError.notFound('Current academic year');
    res.json(ok(rows[0]));
  }));

  return r;
}

/** Public Academic Ops router — mounts every §5.3 + §4 resource group. */
export function academicOpsRouter(pools: TenantPoolManager): Router {
  const r = Router();
  r.use(structureRouter(pools));
  r.use(timetableRouter(pools));
  r.use(examsRouter(pools));
  r.use(calendarRouter(pools));
  r.use(seatingRouter(pools));
  r.use(onlineClassesRouter(pools));
  return r;
}
