import multer from 'multer';
import path from 'path';
import { NextFunction, Response } from 'express';
import { AppRequest } from '../http/context';
import { AppError } from '../http/errors';

/** Base doc §5.2 — what the front office may attach to a student record. */
export const ALLOWED_EXTENSIONS = ['.pdf', '.doc', '.docx', '.jpg', '.jpeg', '.png', '.webp'];
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  // multer defaults filenames to latin1, which turns a Hindi (or any non-ASCII)
  // filename into mojibake before we ever see it.
  defParamCharset: 'utf8',
});

/**
 * Parse a single `file` field, then turn multer's failures into the same
 * error envelope every other endpoint returns. The message is shown to the
 * user as-is, so it says what was wrong and what is allowed.
 */
export function singleFile(field = 'file') {
  const parse = upload.single(field);
  return (req: AppRequest, res: Response, next: NextFunction): void => {
    parse(req, res, (err: unknown) => {
      if (!err) {
        next();
        return;
      }
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          next(AppError.validation(
            [{ field, message: 'file is larger than the 10 MB limit' }],
            'File is too large — the maximum upload size is 10 MB',
          ));
          return;
        }
        if (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT') {
          next(AppError.validation(
            [{ field, message: `send exactly one file in the "${field}" field` }],
            `Upload one file in the "${field}" field`,
          ));
          return;
        }
        next(AppError.validation([{ field, message: err.code }], 'Upload failed'));
        return;
      }
      next(err);
    });
  };
}

export interface UploadedFile {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/**
 * The uploaded file, validated. Extension is checked server-side because the
 * browser's file picker filter is a convenience, not a control.
 */
export function requireUpload(req: AppRequest): UploadedFile {
  const file = (req as AppRequest & { file?: UploadedFile }).file;
  if (!file) {
    throw AppError.validation(
      [{ field: 'file', message: 'is required' }],
      'No file was uploaded — attach one in the "file" field',
    );
  }
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    throw AppError.validation(
      [{ field: 'file', message: `extension ${ext || '(none)'} is not allowed` }],
      `File type not allowed — accepted types are ${ALLOWED_EXTENSIONS.join(', ')}`,
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw AppError.validation(
      [{ field: 'file', message: 'file is larger than the 10 MB limit' }],
      'File is too large — the maximum upload size is 10 MB',
    );
  }
  return file;
}

/**
 * Content-Disposition that survives non-ASCII names: a stripped-down ASCII
 * fallback for old clients plus the RFC 5987 filename* both clients read.
 */
export function contentDisposition(fileName: string): string {
  const safe = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
