import { TenantPoolManager } from '../../pool/tenantPoolManager';
import { TenantContext } from '../../registry/types';
import { AuthContext } from '../../http/context';
import { parentStudentIds } from '../corePeople/scope';

/**
 * Notification visibility, in one place because both the inbox and the unread
 * badge on the dashboards have to agree — a count that disagrees with the list
 * it summarises is worse than no count.
 */

export const NOTIFICATION_AUDIENCES = ['school', 'role', 'section', 'user'] as const;
export type NotificationAudience = (typeof NOTIFICATION_AUDIENCES)[number];

/**
 * Sections this user counts as a member of, which is what a section-targeted
 * notice is delivered to:
 *   student — the section they are enrolled in
 *   parent  — their children's sections
 *   teacher — the sections they teach
 * Everyone else has none; staff notices go to a role or to them by name.
 */
export async function sectionIdsForUser(
  pools: TenantPoolManager,
  ctx: TenantContext,
  auth: AuthContext,
): Promise<string[]> {
  if (auth.role === 'student') {
    if (auth.linkedEntityType !== 'student' || !auth.linkedEntityId) return [];
    const { rows } = await pools.query<{ section_id: string }>(
      ctx,
      `SELECT section_id FROM student_enrollments WHERE student_id = $1 AND status = 'active'`,
      [auth.linkedEntityId],
    );
    return rows.map((r) => r.section_id);
  }
  if (auth.role === 'parent') {
    const children = await parentStudentIds(pools, ctx, auth.userId);
    if (!children.length) return [];
    const { rows } = await pools.query<{ section_id: string }>(
      ctx,
      `SELECT DISTINCT section_id FROM student_enrollments
        WHERE student_id = ANY($1) AND status = 'active'`,
      [children],
    );
    return rows.map((r) => r.section_id);
  }
  if (auth.role === 'teacher') {
    if (auth.linkedEntityType !== 'staff' || !auth.linkedEntityId) return [];
    const { rows } = await pools.query<{ section_id: string }>(
      ctx,
      `SELECT section_id FROM class_teachers WHERE teacher_id = $1
       UNION
       SELECT section_id FROM teacher_subject_assignments WHERE teacher_id = $1`,
      [auth.linkedEntityId],
    );
    return rows.map((r) => r.section_id);
  }
  return [];
}

/** WHERE fragment matching every notification addressed to $1/$2/$3. */
export const VISIBLE_TO_CALLER = `(
     n.audience = 'school'
  OR (n.audience = 'role'    AND n.audience_role = $3::user_role_enum)
  OR (n.audience = 'section' AND n.audience_section_id = ANY($2::uuid[]))
  OR (n.audience = 'user'    AND n.user_id = $1)
)`;

/** [userId, sectionIds, role] — the parameters VISIBLE_TO_CALLER expects. */
export async function visibilityParams(
  pools: TenantPoolManager,
  ctx: TenantContext,
  auth: AuthContext,
): Promise<[string, string[], string]> {
  return [auth.userId, await sectionIdsForUser(pools, ctx, auth), auth.role];
}

/** Unread badge for the dashboards — same rules as GET /notifications. */
export async function unreadNotificationCount(
  pools: TenantPoolManager,
  ctx: TenantContext,
  auth: AuthContext,
): Promise<number> {
  const params = await visibilityParams(pools, ctx, auth);
  const { rows } = await pools.query<{ n: number }>(
    ctx,
    `SELECT COUNT(*)::int AS n
       FROM notifications n
       LEFT JOIN notification_reads r
         ON r.notification_id = n.id AND r.user_id = $1
      WHERE ${VISIBLE_TO_CALLER} AND r.read_at IS NULL`,
    params,
  );
  return rows[0]?.n ?? 0;
}
