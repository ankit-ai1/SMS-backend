import { Router } from 'express';
import { TenantPoolManager } from '../../pool/tenantPoolManager';
import { asyncHandler } from '../../http/context';
import { ok } from '../../http/envelope';
import { AppError } from '../../http/errors';
import { requireRole } from '../../http/rbac';
import { TenantContext } from '../../registry/types';
import { ctxOf, staffIdOf, teacherSectionIds, parentStudentIds } from '../corePeople/scope';
import { unreadNotificationCount } from '../system/notifications';

/**
 * Base doc §5.1 — role-based dashboards. In Phase 1 (modular monolith) these
 * aggregate directly from the tenant DB. Each widget is computed independently
 * with Promise.allSettled, so one failing section degrades gracefully to null
 * instead of failing the whole dashboard — the resilience the audit flagged for
 * the fan-out pattern (and which matters more once split into services in
 * Phase 2).
 */
export function dashboardsRouter(pools: TenantPoolManager): Router {
  const r = Router();

  r.get('/dashboard/admin', requireRole('super_admin', 'admin'), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const [students, staff, feesMonth, feesPending, events] = await settleAll([
      scalar(pools, ctx, `SELECT COUNT(*)::int n FROM students WHERE deleted_at IS NULL`),
      scalar(pools, ctx, `SELECT COUNT(*)::int n FROM staff WHERE deleted_at IS NULL`),
      scalar(pools, ctx, `SELECT COALESCE(SUM(amount),0)::float n FROM payments
                            WHERE status='completed' AND to_char(payment_date,'YYYY-MM')=to_char(CURRENT_DATE,'YYYY-MM')`),
      scalar(pools, ctx, `SELECT COALESCE(SUM(amount_due-amount_paid),0)::float n FROM student_fee_allocations WHERE status<>'paid'`),
      rowsOf(pools, ctx, `SELECT id,title,event_type,start_date FROM school_events
                            WHERE is_active AND end_date>=CURRENT_DATE ORDER BY start_date LIMIT 5`),
    ]);
    res.json(ok({
      students_total: students, staff_total: staff,
      fees_collected_this_month: feesMonth, fees_pending: feesPending,
      upcoming_events: events,
    }));
  }));

  // Same widgets and the exact same response shape as /dashboard/admin — the
  // principal is a school-wide read-only role, so nothing here is scoped.
  r.get('/dashboard/principal', requireRole('super_admin', 'admin', 'principal'), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const [students, staff, feesMonth, feesPending, events] = await settleAll([
      scalar(pools, ctx, `SELECT COUNT(*)::int n FROM students WHERE deleted_at IS NULL`),
      scalar(pools, ctx, `SELECT COUNT(*)::int n FROM staff WHERE deleted_at IS NULL`),
      scalar(pools, ctx, `SELECT COALESCE(SUM(amount),0)::float n FROM payments
                            WHERE status='completed' AND to_char(payment_date,'YYYY-MM')=to_char(CURRENT_DATE,'YYYY-MM')`),
      scalar(pools, ctx, `SELECT COALESCE(SUM(amount_due-amount_paid),0)::float n FROM student_fee_allocations WHERE status<>'paid'`),
      rowsOf(pools, ctx, `SELECT id,title,event_type,start_date FROM school_events
                            WHERE is_active AND end_date>=CURRENT_DATE ORDER BY start_date LIMIT 5`),
    ]);
    res.json(ok({
      students_total: students, staff_total: staff,
      fees_collected_this_month: feesMonth, fees_pending: feesPending,
      upcoming_events: events,
    }));
  }));

  // Fee-desk view. Same response shape as /dashboard/admin; the fee totals are
  // the two widgets that actually matter here.
  r.get('/dashboard/accountant', requireRole('super_admin', 'admin', 'accountant'), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const [students, staff, feesMonth, feesPending, events] = await settleAll([
      scalar(pools, ctx, `SELECT COUNT(*)::int n FROM students WHERE deleted_at IS NULL`),
      scalar(pools, ctx, `SELECT COUNT(*)::int n FROM staff WHERE deleted_at IS NULL`),
      scalar(pools, ctx, `SELECT COALESCE(SUM(amount),0)::float n FROM payments
                            WHERE status='completed' AND to_char(payment_date,'YYYY-MM')=to_char(CURRENT_DATE,'YYYY-MM')`),
      scalar(pools, ctx, `SELECT COALESCE(SUM(amount_due-amount_paid),0)::float n FROM student_fee_allocations WHERE status<>'paid'`),
      rowsOf(pools, ctx, `SELECT id,title,event_type,start_date FROM school_events
                            WHERE is_active AND end_date>=CURRENT_DATE ORDER BY start_date LIMIT 5`),
    ]);
    res.json(ok({
      students_total: students, staff_total: staff,
      fees_collected_this_month: feesMonth, fees_pending: feesPending,
      upcoming_events: events,
    }));
  }));

  r.get('/dashboard/teacher', requireRole('teacher'), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const staffId = staffIdOf(req);
    const sectionIds = await teacherSectionIds(pools, ctx, staffId);
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    const [timetable, pendingLeaves] = await settleAll([
      sectionIds.length
        ? rowsOf(pools, ctx,
            `SELECT te.id, te.section_id, ts.name AS slot, sub.name AS subject
               FROM timetable_entries te
               JOIN time_slots ts ON ts.id=te.time_slot_id
               JOIN subjects sub ON sub.id=te.subject_id
              WHERE te.section_id = ANY($1) AND te.day_of_week=$2::day_of_week_enum
              ORDER BY ts.sort_order`, [sectionIds, today])
        : Promise.resolve([]),
      rowsOf(pools, ctx, `SELECT id,start_date,end_date,status FROM leave_requests
                            WHERE staff_id=$1 AND status='pending'`, [staffId]),
    ]);
    res.json(ok({
      my_sections: sectionIds.length,
      todays_timetable: timetable,
      pending_leave_requests: pendingLeaves,
    }));
  }));

  r.get('/dashboard/parent', requireRole('parent'), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const childIds = await parentStudentIds(pools, ctx, req.auth!.userId);
    if (childIds.length === 0) {
      // No children linked yet, but school-wide and role notices still reach
      // them — so the badge belongs here too, not just on the branch below.
      return res.json(ok({
        children: [],
        unread_notifications: await unreadNotificationCount(pools, ctx, req.auth!),
      }));
    }

    const children = await rowsOf(pools, ctx,
      `SELECT s.id, s.first_name, s.last_name,
              c.name AS class_name, sec.name AS section_name,
              (SELECT ROUND(100.0*COUNT(*) FILTER (WHERE a.status='present')/NULLIF(COUNT(*),0),1)
                 FROM attendance_records a WHERE a.enrollment_id=e.id
                  AND to_char(a.date,'YYYY-MM')=to_char(CURRENT_DATE,'YYYY-MM')) AS attendance_pct,
              (SELECT COALESCE(SUM(amount_due-amount_paid),0)::float
                 FROM student_fee_allocations al WHERE al.enrollment_id=e.id AND al.status<>'paid') AS fees_due
         FROM students s
         LEFT JOIN student_enrollments e ON e.student_id=s.id AND e.status='active'
         LEFT JOIN sections sec ON sec.id=e.section_id
         LEFT JOIN classes c ON c.id=sec.class_id
        WHERE s.id = ANY($1)`, [childIds]);
    // Same visibility rules as GET /notifications, so the badge and the list
    // can never disagree.
    const unread = await unreadNotificationCount(pools, ctx, req.auth!);
    res.json(ok({ children, unread_notifications: unread }));
  }));

  // The student's own portal. Their JWT carries a user id, not a student id, so
  // this is the endpoint that resolves the linked student record — everything
  // else the portal calls is keyed off what comes back here.
  r.get('/dashboard/student', requireRole('student'), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const a = req.auth!;
    const studentId = a.linkedEntityType === 'student' ? a.linkedEntityId : undefined;
    if (!studentId) return res.json(ok({ student: null, unread_notifications: 0 }));

    const rows = await rowsOf(pools, ctx,
      `SELECT s.id, s.first_name, s.last_name, s.admission_number,
              c.name AS class_name, sec.name AS section_name, e.id AS enrollment_id,
              (SELECT ROUND(100.0*COUNT(*) FILTER (WHERE a.status='present')/NULLIF(COUNT(*),0),1)
                 FROM attendance_records a WHERE a.enrollment_id=e.id) AS attendance_pct,
              (SELECT COALESCE(SUM(amount_due-amount_paid),0)::float
                 FROM student_fee_allocations al WHERE al.enrollment_id=e.id AND al.status<>'paid') AS fees_due
         FROM students s
         LEFT JOIN student_enrollments e ON e.student_id=s.id AND e.status='active'
         LEFT JOIN academic_years y ON y.id=e.academic_year_id AND y.is_current
         LEFT JOIN sections sec ON sec.id=e.section_id
         LEFT JOIN classes c ON c.id=sec.class_id
        WHERE s.id=$1 AND s.deleted_at IS NULL
        ORDER BY y.is_current DESC NULLS LAST
        LIMIT 1`, [studentId]);
    const unread = await unreadNotificationCount(pools, ctx, a);
    res.json(ok({ student: rows[0] ?? null, unread_notifications: unread }));
  }));

  return r;
}

// ---- aggregation helpers ----

async function scalar(pools: TenantPoolManager, ctx: TenantContext, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pools.query<{ n: number }>(ctx, sql, params);
  return rows[0]?.n ?? 0;
}
async function rowsOf(pools: TenantPoolManager, ctx: TenantContext, sql: string, params: unknown[] = []): Promise<unknown[]> {
  const { rows } = await pools.query(ctx, sql, params);
  return rows;
}
/** Run all widget promises; a failed widget resolves to null (graceful degrade). */
async function settleAll<T extends readonly Promise<unknown>[]>(promises: T): Promise<unknown[]> {
  const settled = await Promise.allSettled(promises);
  return settled.map((s) => (s.status === 'fulfilled' ? s.value : null));
}

// referenced to keep AppError import used if widgets throw domain errors
void AppError;
