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
      const { rowCount } = await guardFkConflict(
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
 * Run a delete (or any write) and translate a Postgres foreign-key violation
 * (SQLSTATE 23503 — the row is still referenced elsewhere, or points at a row
 * that does not exist) into a clean 409 instead of letting it surface as a 500.
 */
export async function guardFkConflict<T>(run: () => Promise<T>, msg?: string): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if ((err as { code?: string }).code === '23503') {
      throw msg ? AppError.conflict(msg) : AppError.conflict();
    }
    throw err;
  }
}
