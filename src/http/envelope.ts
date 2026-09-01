/**
 * Standard response envelope — base doc §10.1.
 * Every endpoint returns success or error in this exact shape.
 */

export interface PageMeta {
  page: number;
  per_page: number;
  total: number;
  total_pages: number;
}

export interface SuccessBody<T> {
  status: 'success';
  data: T;
  meta?: PageMeta;
}

export interface ErrorDetail {
  field: string;
  message: string;
}

export interface ErrorBody {
  status: 'error';
  error: {
    code: string;
    message: string;
    details?: ErrorDetail[];
  };
}

export function ok<T>(data: T, meta?: PageMeta): SuccessBody<T> {
  return meta ? { status: 'success', data, meta } : { status: 'success', data };
}

export function fail(
  code: string,
  message: string,
  details?: ErrorDetail[],
): ErrorBody {
  return { status: 'error', error: { code, message, ...(details ? { details } : {}) } };
}
