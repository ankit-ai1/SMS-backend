import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { config } from '../config';
import { AppError } from '../http/errors';

/**
 * Where uploaded student documents live.
 *
 * The stored key is what goes in student_documents.gcs_path — a bucket-relative
 * object name like students/sunrise/<student-id>/<uuid>.pdf. Keeping the key
 * bucket-relative is what lets the backing store change (local disk today, a GCS
 * bucket once one exists) without touching a single row.
 */
export interface DocumentStorage {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Removing an object that is already gone is not an error. */
  remove(key: string): Promise<void>;
}

/** students/{tenant}/{student}/{uuid}{ext} — the client never picks the path. */
export function documentKey(tenantSlug: string, studentId: string, originalName: string): string {
  const ext = path.extname(originalName).toLowerCase();
  return `students/${tenantSlug}/${studentId}/${randomUUID()}${ext}`;
}

/**
 * Local-filesystem store: files land under config.documentsDir, mirroring the
 * key path. In Docker that directory is a volume, so uploads survive restarts.
 */
export class LocalDiskStorage implements DocumentStorage {
  constructor(private root: string = config.documentsDir) {}

  private resolve(key: string): string {
    // Keys are generated server-side, but never let one escape the root anyway.
    const full = path.resolve(this.root, key);
    const root = path.resolve(this.root);
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw new AppError('BAD_REQUEST', 'Invalid document path');
    }
    return full;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const full = this.resolve(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, body);
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await fs.readFile(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw AppError.notFound('Document file');
      }
      throw err;
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await fs.unlink(this.resolve(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}

let active: DocumentStorage = new LocalDiskStorage();

/** The store the document endpoints use. */
export function documentStorage(): DocumentStorage {
  return active;
}

/** Swap the backing store — a GCS driver here, a fake in tests. */
export function setDocumentStorage(store: DocumentStorage): void {
  active = store;
}
