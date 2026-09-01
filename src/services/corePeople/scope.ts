import { TenantPoolManager } from '../../pool/tenantPoolManager';
import { TenantContext } from '../../registry/types';
import { AppRequest } from '../../http/context';
import { AppError } from '../../http/errors';

/**
 * Fine-grained scope checks — base doc §6.2. These run INSIDE the service,
 * after the gateway's coarse role check has already passed.
 */

export function ctxOf(req: AppRequest): TenantContext {
  if (!req.tenantContext) throw new AppError('BAD_REQUEST', 'No tenant context');
  return req.tenantContext;
}

/** staff.id for a logged-in staff/teacher (from the JWT linked entity). */
export function staffIdOf(req: AppRequest): string {
  const a = req.auth;
  if (!a || a.linkedEntityType !== 'staff' || !a.linkedEntityId) {
    throw AppError.forbidden('No staff identity on this account');
  }
  return a.linkedEntityId;
}

/** Sections a teacher is attached to (as class teacher or subject teacher). */
export async function teacherSectionIds(
  pools: TenantPoolManager,
  ctx: TenantContext,
  teacherStaffId: string,
): Promise<string[]> {
  const { rows } = await pools.query<{ section_id: string }>(
    ctx,
    `SELECT section_id FROM class_teachers WHERE teacher_id = $1
     UNION
     SELECT section_id FROM teacher_subject_assignments WHERE teacher_id = $1`,
    [teacherStaffId],
  );
  return rows.map((r) => r.section_id);
}

/** students.id for a logged-in student (from the JWT linked entity). */
export function studentIdOf(req: AppRequest): string {
  const a = req.auth;
  if (!a || a.linkedEntityType !== 'student' || !a.linkedEntityId) {
    throw AppError.forbidden('No student identity on this account');
  }
  return a.linkedEntityId;
}

/** Throw FORBIDDEN unless this is the logged-in student's own record. */
export function assertStudentSelf(req: AppRequest, studentId: string): void {
  if (studentIdOf(req) !== studentId) {
    throw AppError.forbidden('Not your record');
  }
}

/** Throw FORBIDDEN unless this enrollment belongs to the given student. */
export async function assertOwnsEnrollment(
  pools: TenantPoolManager,
  ctx: TenantContext,
  studentId: string,
  enrollmentId: string,
): Promise<void> {
  const { rows } = await pools.query(
    ctx,
    `SELECT 1 FROM student_enrollments WHERE id = $1 AND student_id = $2 LIMIT 1`,
    [enrollmentId, studentId],
  );
  if (rows.length === 0) throw AppError.forbidden('Not your record');
}

/** Student ids a parent user is guardian of. */
export async function parentStudentIds(
  pools: TenantPoolManager,
  ctx: TenantContext,
  parentUserId: string,
): Promise<string[]> {
  const { rows } = await pools.query<{ student_id: string }>(
    ctx,
    `SELECT DISTINCT student_id FROM student_guardians WHERE user_id = $1`,
    [parentUserId],
  );
  return rows.map((r) => r.student_id);
}

/** Throw FORBIDDEN unless the parent owns this student. */
export async function assertParentOwnsStudent(
  pools: TenantPoolManager,
  ctx: TenantContext,
  parentUserId: string,
  studentId: string,
): Promise<void> {
  const { rows } = await pools.query(
    ctx,
    `SELECT 1 FROM student_guardians WHERE user_id = $1 AND student_id = $2 LIMIT 1`,
    [parentUserId, studentId],
  );
  if (rows.length === 0) {
    throw AppError.forbidden('Not a guardian of this student');
  }
}

/** Throw FORBIDDEN unless the teacher is attached to this section. */
export async function assertTeacherOwnsSection(
  pools: TenantPoolManager,
  ctx: TenantContext,
  teacherStaffId: string,
  sectionId: string,
): Promise<void> {
  const ids = await teacherSectionIds(pools, ctx, teacherStaffId);
  if (!ids.includes(sectionId)) {
    throw AppError.forbidden('Section not assigned to this teacher');
  }
}
