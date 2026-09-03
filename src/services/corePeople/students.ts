import { Router } from 'express';
import { TenantPoolManager } from '../../pool/tenantPoolManager';
import { asyncHandler } from '../../http/context';
import { ok } from '../../http/envelope';
import { AppError } from '../../http/errors';
import { requireRole } from '../../http/rbac';
import { pageMeta, parsePage } from '../../http/pagination';
import path from 'path';
import { ctxOf, assertParentOwnsStudent } from './scope';
import { hashPassword, isPasswordAcceptable } from '../../auth/passwords';
import { config } from '../../config';
import { TenantContext } from '../../registry/types';
import { documentKey, documentStorage } from '../../storage/documentStorage';
import { contentDisposition, requireUpload, singleFile } from '../../storage/uploads';

/** Everything the documents UI renders; the file columns are null on legacy rows. */
const DOCUMENT_COLUMNS = 'id, doc_type, gcs_path, uploaded_at, file_name, mime_type, size_bytes';

interface DocumentRow {
  id: string;
  gcs_path: string;
  file_name: string | null;
  mime_type: string | null;
}

async function loadDocument(
  pools: TenantPoolManager,
  ctx: TenantContext,
  studentId: string,
  documentId: string,
): Promise<DocumentRow> {
  const { rows } = await pools.query<DocumentRow>(
    ctx,
    `SELECT id, gcs_path, file_name, mime_type
       FROM student_documents WHERE id = $1 AND student_id = $2`,
    [documentId, studentId],
  );
  if (!rows.length) throw AppError.notFound('Document');
  return rows[0];
}

/** Uploading against a student that does not exist should 404, not 500 on the FK. */
async function assertStudentExists(
  pools: TenantPoolManager,
  ctx: TenantContext,
  studentId: string,
): Promise<void> {
  const { rows } = await pools.query(
    ctx,
    `SELECT 1 FROM students WHERE id = $1 AND deleted_at IS NULL`,
    [studentId],
  );
  if (!rows.length) throw AppError.notFound('Student');
}

const STUDENT_SORTS = ['created_at', 'last_name', 'first_name', 'admission_number'];

/** Base doc §5.2 — Students, guardians, documents, medical. */
export function studentsRouter(pools: TenantPoolManager): Router {
  const r = Router();

  // GET /students — list (admin, principal, teacher)
  r.get(
    '/students',
    // the accountant searches this list to find whose fee they are collecting;
    // the per-student record stays closed to them.
    requireRole('super_admin', 'admin', 'principal', 'teacher', 'accountant', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const p = parsePage(req, STUDENT_SORTS);
      const where: string[] = ['deleted_at IS NULL'];
      const params: unknown[] = [];
      if (typeof req.query.gender === 'string' && req.query.gender) {
        params.push(req.query.gender);
        where.push(`gender = $${params.length}`);
      }
      if (typeof req.query.search === 'string' && req.query.search) {
        params.push(`%${req.query.search}%`);
        const i = params.length;
        where.push(
          `(first_name ILIKE $${i} OR last_name ILIKE $${i} OR admission_number ILIKE $${i})`,
        );
      }
      if (typeof req.query.section_id === 'string' && req.query.section_id) {
        params.push(req.query.section_id);
        where.push(
          `id IN (SELECT student_id FROM student_enrollments WHERE section_id = $${params.length} AND status = 'active')`,
        );
      }
      const clause = `WHERE ${where.join(' AND ')}`;
      const total = (
        await pools.query<{ n: string }>(
          ctx,
          `SELECT COUNT(*)::int AS n FROM students ${clause}`,
          params,
        )
      ).rows[0].n;
      const rows = (
        await pools.query(
          ctx,
          `SELECT id, admission_number, first_name, last_name, date_of_birth,
                  gender, is_active
             FROM students ${clause}
            ORDER BY ${p.sort} ${p.order}
            LIMIT ${p.perPage} OFFSET ${p.offset}`,
          params,
        )
      ).rows;
      res.json(ok(rows, pageMeta(p.page, p.perPage, Number(total))));
    }),
  );

  // GET /students/birthdays?month=MM&day=DD — whose birthday it is. Registered
  // before /students/:id so "birthdays" is never read as a student id.
  //
  // No month/day means today, in the school's timezone rather than the
  // container's: on Cloud Run that is UTC, which would roll the date over at
  // 05:30 local and show tomorrow's birthdays all evening.
  r.get(
    '/students/birthdays',
    requireRole('super_admin', 'admin', 'principal', 'teacher', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const month = parseDatePart(req.query.month, 'month', 1, 12);
      const day = parseDatePart(req.query.day, 'day', 1, 31);
      if ((month === undefined) !== (day === undefined)) {
        throw AppError.validation([
          { field: month === undefined ? 'month' : 'day', message: 'month and day must be given together' },
        ]);
      }

      const today = schoolToday();
      const targetMonth = month ?? today.month;
      const targetDay = day ?? today.day;
      // A 29 February birthday would otherwise come round once every four
      // years, so in a common year those students are greeted on the 28th.
      const alsoFeb29 =
        targetMonth === 2 && targetDay === 28 && !isLeapYear(today.year);

      const { rows } = await pools.query(
        ctx,
        `SELECT s.id, s.first_name, s.last_name, s.admission_number, s.date_of_birth,
                c.name AS class_name, sec.name AS section_name
           FROM students s
           LEFT JOIN student_enrollments e
             ON e.student_id = s.id AND e.status = 'active'
           LEFT JOIN academic_years y ON y.id = e.academic_year_id AND y.is_current
           LEFT JOIN sections sec ON sec.id = e.section_id
           LEFT JOIN classes c ON c.id = sec.class_id
          WHERE s.deleted_at IS NULL AND s.is_active
            AND ((EXTRACT(MONTH FROM s.date_of_birth), EXTRACT(DAY FROM s.date_of_birth)) = ($1, $2)
                 OR ($3 AND EXTRACT(MONTH FROM s.date_of_birth) = 2
                        AND EXTRACT(DAY FROM s.date_of_birth) = 29))
          ORDER BY c.numeric_order NULLS LAST, sec.name NULLS LAST,
                   s.last_name, s.first_name`,
        [targetMonth, targetDay, alsoFeb29],
      );
      res.json(ok(rows));
    }),
  );

  // GET /students/:id — parent may read own child
  r.get(
    '/students/:id',
    requireRole('super_admin', 'admin', 'principal', 'teacher', 'parent', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const id = req.params.id;
      if (req.auth!.role === 'parent') {
        await assertParentOwnsStudent(pools, ctx, req.auth!.userId, id);
      }
      const { rows } = await pools.query(
        ctx,
        `SELECT * FROM students WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      if (rows.length === 0) throw AppError.notFound('Student');
      res.json(ok(rows[0]));
    }),
  );

  // POST /students — admin (student + guardians + address in one transaction)
  r.post(
    '/students',
    requireRole('super_admin', 'admin', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const b = req.body ?? {};
      requireFields(b, ['first_name', 'last_name', 'date_of_birth', 'admission_number']);
      const created = await pools.withTransaction(ctx, async (client) => {
        const s = await client.query(
          `INSERT INTO students
             (admission_number, first_name, last_name, date_of_birth, gender,
              blood_group, admission_date, nationality, religion, category,
              aadhaar_ref, photo_url)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING id`,
          [
            b.admission_number, b.first_name, b.last_name, b.date_of_birth,
            b.gender ?? null, b.blood_group ?? null, b.admission_date ?? null,
            b.nationality ?? null, b.religion ?? null, b.category ?? null,
            b.aadhaar_ref ?? null, b.photo_url ?? null,
          ],
        );
        const studentId = s.rows[0].id;
        for (const g of Array.isArray(b.guardians) ? b.guardians : []) {
          await client.query(
            `INSERT INTO student_guardians (student_id, name, relation, phone, email, is_primary)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [studentId, g.name, g.relation, g.phone ?? null, g.email ?? null, !!g.is_primary],
          );
        }
        if (b.address) {
          const a = b.address;
          await client.query(
            `INSERT INTO student_addresses (student_id, type, line1, line2, city, state, pincode)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [studentId, a.type ?? 'current', a.line1, a.line2 ?? null, a.city ?? null, a.state ?? null, a.pincode ?? null],
          );
        }
        return studentId;
      });
      res.status(201).json(ok({ id: created }));
    }),
  );

  // PUT /students/:id — admin
  r.put(
    '/students/:id',
    requireRole('super_admin', 'admin', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const fields = pickUpdatable(req.body ?? {}, [
        'first_name', 'last_name', 'date_of_birth', 'gender', 'blood_group',
        'nationality', 'religion', 'category', 'photo_url', 'is_active',
      ]);
      if (fields.cols.length === 0) throw AppError.validation([{ field: 'body', message: 'no updatable fields' }]);
      fields.params.push(req.params.id);
      const { rowCount } = await pools.query(
        ctx,
        `UPDATE students SET ${fields.set}, updated_at = NOW()
          WHERE id = $${fields.params.length} AND deleted_at IS NULL`,
        fields.params,
      );
      if (!rowCount) throw AppError.notFound('Student');
      res.json(ok({ updated: true }));
    }),
  );

  // DELETE /students/:id — soft delete
  r.delete(
    '/students/:id',
    requireRole('super_admin', 'admin', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const { rowCount } = await pools.query(
        ctx,
        `UPDATE students SET deleted_at = NOW(), is_active = FALSE
          WHERE id = $1 AND deleted_at IS NULL`,
        [req.params.id],
      );
      if (!rowCount) throw AppError.notFound('Student');
      res.json(ok({ deleted: true }));
    }),
  );

  // GET /students/:id/guardians
  r.get(
    '/students/:id/guardians',
    requireRole('super_admin', 'admin', 'principal', 'parent', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      if (req.auth!.role === 'parent') {
        await assertParentOwnsStudent(pools, ctx, req.auth!.userId, req.params.id);
      }
      const { rows } = await pools.query(
        ctx,
        `SELECT g.id, g.name, g.relation, g.phone, g.email, g.is_primary,
                g.user_id, u.email AS user_email
           FROM student_guardians g
           LEFT JOIN users u ON u.id = g.user_id
          WHERE g.student_id = $1`,
        [req.params.id],
      );
      res.json(ok(rows));
    }),
  );

  // GET /students/:id/siblings — other students who share a guardian.
  //
  // Guardians are stored per student (two brothers each have their own "father"
  // row), so there is no shared guardian record to join on. A guardian is
  // treated as the same person when the rows share a parent login, or a phone,
  // or an email — the three identifiers a school actually re-uses across
  // siblings. Name is deliberately not matched: too many namesakes.
  r.get(
    '/students/:id/siblings',
    requireRole('super_admin', 'admin', 'accountant', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      await assertStudentExists(pools, ctx, req.params.id);
      const { rows } = await pools.query(
        ctx,
        `WITH mine AS (
           SELECT user_id,
                  NULLIF(TRIM(phone), '')          AS phone,
                  LOWER(NULLIF(TRIM(email), ''))   AS email
             FROM student_guardians
            WHERE student_id = $1
         )
         -- DISTINCT first (a sibling can match on several identifiers at once),
         -- then order outside so numeric_order need not be in the output.
         SELECT id, first_name, last_name, admission_number, class_name, section_name
           FROM (
             SELECT DISTINCT s.id, s.first_name, s.last_name, s.admission_number,
                    c.name AS class_name, sec.name AS section_name, c.numeric_order
               FROM student_guardians g
               JOIN students s ON s.id = g.student_id
               LEFT JOIN student_enrollments e
                 ON e.student_id = s.id AND e.status = 'active'
               LEFT JOIN academic_years y ON y.id = e.academic_year_id AND y.is_current
               LEFT JOIN sections sec ON sec.id = e.section_id
               LEFT JOIN classes c ON c.id = sec.class_id
              WHERE g.student_id <> $1
                AND s.deleted_at IS NULL AND s.is_active
                AND EXISTS (
                  SELECT 1 FROM mine m
                   WHERE (m.user_id IS NOT NULL AND m.user_id = g.user_id)
                      OR (m.phone   IS NOT NULL AND m.phone   = NULLIF(TRIM(g.phone), ''))
                      OR (m.email   IS NOT NULL AND m.email   = LOWER(NULLIF(TRIM(g.email), '')))
                )
           ) sib
          ORDER BY numeric_order NULLS LAST, section_name NULLS LAST,
                   last_name, first_name`,
        [req.params.id],
      );
      res.json(ok(rows));
    }),
  );

  // POST /students/:id/guardians
  r.post(
    '/students/:id/guardians',
    requireRole('super_admin', 'admin', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const b = req.body ?? {};
      requireFields(b, ['name', 'relation']);
      const { rows } = await pools.query(
        ctx,
        `INSERT INTO student_guardians (student_id, name, relation, phone, email, is_primary)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [req.params.id, b.name, b.relation, b.phone ?? null, b.email ?? null, !!b.is_primary],
      );
      res.status(201).json(ok({ id: rows[0].id }));
    }),
  );

  // POST /students/:studentId/guardians/:guardianId/create-login — make a parent
  // login for this guardian and attach it, both or neither.
  r.post(
    '/students/:studentId/guardians/:guardianId/create-login',
    requireRole('super_admin', 'admin', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const b = req.body ?? {};
      requireFields(b, ['email', 'password']);
      if (!isPasswordAcceptable(b.password)) {
        throw AppError.validation([{ field: 'password', message: 'must be at least 8 characters' }]);
      }
      const hash = await hashPassword(b.password);
      const userId = await pools.withTransaction(ctx, async (client) => {
        const g = await client.query(
          `SELECT name, phone FROM student_guardians WHERE id = $1 AND student_id = $2`,
          [req.params.guardianId, req.params.studentId],
        );
        if (!g.rows.length) throw AppError.notFound('Guardian');
        const created = await client.query(
          `INSERT INTO users (email, password_hash, role, full_name, phone,
                              linked_entity_id, linked_entity_type)
           VALUES ($1,$2,'parent',$3,$4,$5,'guardian')
           ON CONFLICT (email) DO NOTHING
           RETURNING id`,
          [b.email, hash, g.rows[0].name, g.rows[0].phone ?? null, req.params.guardianId],
        );
        if (!created.rows.length) throw new AppError('CONFLICT', 'Email already in use');
        await client.query(
          `UPDATE student_guardians SET user_id = $1 WHERE id = $2 AND student_id = $3`,
          [created.rows[0].id, req.params.guardianId, req.params.studentId],
        );
        return created.rows[0].id as string;
      });
      res.status(201).json(ok({ user_id: userId }));
    }),
  );

  // POST /students/:studentId/guardians/:guardianId/link-user — attach an
  // existing parent login to this guardian.
  r.post(
    '/students/:studentId/guardians/:guardianId/link-user',
    requireRole('super_admin', 'admin', 'clerk'),
    asyncHandler(async (req, res) => {
      const b = req.body ?? {};
      requireFields(b, ['user_id']);
      const { rowCount } = await guardDbConflict(
        () =>
          pools.query(
            ctxOf(req),
            `UPDATE student_guardians SET user_id = $1 WHERE id = $2 AND student_id = $3`,
            [b.user_id, req.params.guardianId, req.params.studentId],
          ),
        'No user with that user_id',
      );
      if (!rowCount) throw AppError.notFound('Guardian');
      res.json(ok({ updated: true }));
    }),
  );

  // PUT /students/:id/guardians/:guardianId
  r.put(
    '/students/:id/guardians/:guardianId',
    requireRole('super_admin', 'admin', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const fields = pickUpdatable(req.body ?? {}, [
        'name', 'relation', 'phone', 'email', 'is_primary',
      ]);
      if (fields.cols.length === 0) throw AppError.validation([{ field: 'body', message: 'no updatable fields' }]);
      fields.params.push(req.params.guardianId, req.params.id);
      const { rowCount } = await pools.query(
        ctx,
        `UPDATE student_guardians SET ${fields.set}
          WHERE id = $${fields.params.length - 1} AND student_id = $${fields.params.length}`,
        fields.params,
      );
      if (!rowCount) throw AppError.notFound('Guardian');
      res.json(ok({ updated: true }));
    }),
  );

  // DELETE /students/:id/guardians/:guardianId
  r.delete(
    '/students/:id/guardians/:guardianId',
    requireRole('super_admin', 'admin', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const { rowCount } = await pools.query(
        ctx,
        `DELETE FROM student_guardians WHERE id = $1 AND student_id = $2`,
        [req.params.guardianId, req.params.id],
      );
      if (!rowCount) throw AppError.notFound('Guardian');
      res.json(ok({ deleted: true }));
    }),
  );

  // GET /students/:id/documents
  r.get(
    '/students/:id/documents',
    requireRole('super_admin', 'admin', 'principal', 'parent', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      if (req.auth!.role === 'parent') {
        await assertParentOwnsStudent(pools, ctx, req.auth!.userId, req.params.id);
      }
      const { rows } = await pools.query(
        ctx,
        `SELECT ${DOCUMENT_COLUMNS} FROM student_documents WHERE student_id = $1`,
        [req.params.id],
      );
      res.json(ok(rows));
    }),
  );

  // POST /students/:id/documents — multipart upload (doc_type + file). The old
  // JSON form (doc_type + a hand-typed gcs_path) still works for callers that
  // put the object in the bucket themselves.
  r.post(
    '/students/:id/documents',
    requireRole('super_admin', 'admin', 'clerk'),
    singleFile(),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const b = req.body ?? {};
      const uploaded = (req as typeof req & { file?: unknown }).file;

      if (!uploaded && typeof b.gcs_path === 'string' && b.gcs_path) {
        requireFields(b, ['doc_type', 'gcs_path']);
        const { rows } = await pools.query(
          ctx,
          `INSERT INTO student_documents (student_id, doc_type, gcs_path)
           VALUES ($1,$2,$3) RETURNING ${DOCUMENT_COLUMNS}`,
          [req.params.id, b.doc_type, b.gcs_path],
        );
        res.status(201).json(ok(rows[0]));
        return;
      }

      requireFields(b, ['doc_type']);
      const file = requireUpload(req);
      await assertStudentExists(pools, ctx, req.params.id);

      const key = documentKey(ctx.tenant.slug, req.params.id, file.originalname);
      await documentStorage().put(key, file.buffer, file.mimetype);
      try {
        const { rows } = await pools.query(
          ctx,
          `INSERT INTO student_documents
             (student_id, doc_type, gcs_path, file_name, mime_type, size_bytes)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${DOCUMENT_COLUMNS}`,
          [req.params.id, b.doc_type, key, file.originalname, file.mimetype, file.size],
        );
        res.status(201).json(ok(rows[0]));
      } catch (err) {
        // Never leave an object behind that no row points at.
        await documentStorage().remove(key);
        throw err;
      }
    }),
  );

  // GET /students/:id/documents/:documentId/file — the bytes, not an envelope.
  r.get(
    '/students/:id/documents/:documentId/file',
    requireRole('super_admin', 'admin', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const doc = await loadDocument(pools, ctx, req.params.id, req.params.documentId);
      const body = await documentStorage().get(doc.gcs_path);
      const name = doc.file_name ?? path.basename(doc.gcs_path);
      res.setHeader('Content-Type', doc.mime_type ?? 'application/octet-stream');
      res.setHeader('Content-Disposition', contentDisposition(name));
      res.setHeader('Content-Length', String(body.length));
      res.end(body);
    }),
  );

  // PUT /students/:id/documents/:documentId/file — replace the file, keep the row.
  r.put(
    '/students/:id/documents/:documentId/file',
    requireRole('super_admin', 'admin', 'clerk'),
    singleFile(),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const doc = await loadDocument(pools, ctx, req.params.id, req.params.documentId);
      const file = requireUpload(req);

      const key = documentKey(ctx.tenant.slug, req.params.id, file.originalname);
      await documentStorage().put(key, file.buffer, file.mimetype);
      let rows;
      try {
        ({ rows } = await pools.query(
          ctx,
          `UPDATE student_documents
              SET gcs_path = $1, file_name = $2, mime_type = $3, size_bytes = $4,
                  uploaded_at = NOW()
            WHERE id = $5 AND student_id = $6
            RETURNING ${DOCUMENT_COLUMNS}`,
          [key, file.originalname, file.mimetype, file.size, req.params.documentId, req.params.id],
        ));
      } catch (err) {
        await documentStorage().remove(key);
        throw err;
      }
      if (!rows.length) {
        await documentStorage().remove(key);
        throw AppError.notFound('Document');
      }
      // The row points at the new object now, so the old one is safe to drop.
      if (doc.gcs_path !== key) await documentStorage().remove(doc.gcs_path);
      res.json(ok(rows[0]));
    }),
  );

  // PUT /students/:id/documents/:documentId
  r.put(
    '/students/:id/documents/:documentId',
    requireRole('super_admin', 'admin', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const fields = pickUpdatable(req.body ?? {}, ['doc_type', 'gcs_path']);
      if (fields.cols.length === 0) throw AppError.validation([{ field: 'body', message: 'no updatable fields' }]);
      fields.params.push(req.params.documentId, req.params.id);
      const { rowCount } = await pools.query(
        ctx,
        `UPDATE student_documents SET ${fields.set}
          WHERE id = $${fields.params.length - 1} AND student_id = $${fields.params.length}`,
        fields.params,
      );
      if (!rowCount) throw AppError.notFound('Document');
      res.json(ok({ updated: true }));
    }),
  );

  // DELETE /students/:id/documents/:documentId
  r.delete(
    '/students/:id/documents/:documentId',
    requireRole('super_admin', 'admin', 'clerk'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const { rows } = await pools.query<{ gcs_path: string }>(
        ctx,
        `DELETE FROM student_documents WHERE id = $1 AND student_id = $2
         RETURNING gcs_path`,
        [req.params.documentId, req.params.id],
      );
      if (!rows.length) throw AppError.notFound('Document');
      // The row is gone; drop the object too so uploads do not pile up orphaned.
      await documentStorage().remove(rows[0].gcs_path);
      res.json(ok({ deleted: true }));
    }),
  );

  // GET /students/:id/medical — admin, principal only (doc §5.2)
  r.get(
    '/students/:id/medical',
    requireRole('super_admin', 'admin', 'principal'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const { rows } = await pools.query(
        ctx,
        `SELECT allergies, conditions, medications, notes, updated_at
           FROM student_medical_info WHERE student_id = $1`,
        [req.params.id],
      );
      res.json(ok(rows[0] ?? null));
    }),
  );

  // PUT /students/:id/medical — upsert
  r.put(
    '/students/:id/medical',
    requireRole('super_admin', 'admin'),
    asyncHandler(async (req, res) => {
      const ctx = ctxOf(req);
      const b = req.body ?? {};
      await pools.query(
        ctx,
        `INSERT INTO student_medical_info (student_id, allergies, conditions, medications, notes)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (student_id) DO UPDATE
           SET allergies = EXCLUDED.allergies, conditions = EXCLUDED.conditions,
               medications = EXCLUDED.medications, notes = EXCLUDED.notes,
               updated_at = NOW()`,
        [req.params.id, b.allergies ?? null, b.conditions ?? null, b.medications ?? null, b.notes ?? null],
      );
      res.json(ok({ updated: true }));
    }),
  );

  return r;
}

// ---- small shared helpers ----

export function requireFields(body: Record<string, unknown>, fields: string[]): void {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '');
  if (missing.length) {
    throw AppError.validation(missing.map((f) => ({ field: f, message: 'is required' })));
  }
}

export function pickUpdatable(
  body: Record<string, unknown>,
  allowed: string[],
): { set: string; cols: string[]; params: unknown[] } {
  const cols: string[] = [];
  const params: unknown[] = [];
  for (const key of allowed) {
    if (body[key] !== undefined) {
      params.push(body[key]);
      cols.push(`${key} = $${params.length}`);
    }
  }
  return { set: cols.join(', '), cols, params };
}

/**
 * Run a write and turn the two "conflicts with data that already exists"
 * Postgres errors into a clean 409 instead of a 500:
 *   23503 — foreign key: the row is still referenced, or points at nothing
 *   23505 — unique: something with that key is already there
 * Callers pass the message that fits their case.
 */
export async function guardDbConflict<T>(run: () => Promise<T>, msg?: string): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23503' || code === '23505') {
      throw msg ? AppError.conflict(msg) : AppError.conflict();
    }
    throw err;
  }
}

/**
 * Read an optional numeric query part (month/day). Absent stays absent;
 * anything present must be a whole number inside the range.
 */
function parseDatePart(
  raw: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string') {
    throw AppError.validation([{ field, message: 'must be a single value' }]);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw AppError.validation([{ field, message: `must be a whole number between ${min} and ${max}` }]);
  }
  return n;
}

/**
 * Today as the school sees it. The container clock is UTC, which in India rolls
 * the date over at 05:30 local — so "today" is read in config.schoolTimezone.
 */
export function schoolToday(now = new Date()): { year: number; month: number; day: number } {
  // en-CA formats as YYYY-MM-DD, which parses without any locale guesswork.
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.schoolTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(now)
    .split('-')
    .map(Number);
  return { year, month, day };
}

export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
