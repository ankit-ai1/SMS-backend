import { Storage } from '@google-cloud/storage';
import { config } from '../config';
import { AppError } from '../http/errors';
import { DocumentStorage } from './documentStorage';

/**
 * Google Cloud Storage driver.
 *
 * Authentication is Application Default Credentials: inside Cloud Run, GKE or
 * Compute the runtime service account is picked up automatically, so no key file
 * and no GOOGLE_APPLICATION_CREDENTIALS. That service account needs
 * roles/storage.objectAdmin on the bucket (objectUser also works: read, write,
 * delete on objects — never bucket admin).
 *
 * Object names are the same keys the local driver uses, so switching drivers
 * needs no change to a single stored row.
 */
export class GcsStorage implements DocumentStorage {
  private storage = new Storage();

  constructor(private bucketName: string = config.gcsBucket) {
    if (!bucketName) {
      throw new Error('GCS_BUCKET must be set when STORAGE_DRIVER=gcs');
    }
  }

  private file(key: string) {
    return this.storage.bucket(this.bucketName).file(key);
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.file(key).save(body, {
      contentType,
      // Uniform bucket-level access rejects per-object ACLs.
      resumable: false,
    });
  }

  async get(key: string): Promise<Buffer> {
    try {
      const [buf] = await this.file(key).download();
      return buf;
    } catch (err) {
      if ((err as { code?: number }).code === 404) {
        throw AppError.notFound('Document file');
      }
      throw err;
    }
  }

  async remove(key: string): Promise<void> {
    // ignoreNotFound keeps delete idempotent, matching the local driver.
    await this.file(key).delete({ ignoreNotFound: true });
  }
}
