import { AppRequest } from './context';
import { PageMeta } from './envelope';
import { AppError } from './errors';

export interface PageParams {
  page: number;
  perPage: number;
  sort: string;
  order: 'asc' | 'desc';
  offset: number;
}

const MAX_PER_PAGE = 100;
const DEFAULT_PER_PAGE = 20;

/**
 * Parse pagination + sort from query string — base doc §10.3.
 *   page (default 1), per_page (default 20, max 100), sort, order (asc|desc).
 * sortWhitelist prevents SQL injection via the sort column.
 */
export function parsePage(
  req: AppRequest,
  sortWhitelist: string[],
  defaultSort = 'created_at',
): PageParams {
  const q = req.query;
  const page = Math.max(1, toInt(q.page, 1));
  const perPage = Math.min(MAX_PER_PAGE, Math.max(1, toInt(q.per_page, DEFAULT_PER_PAGE)));

  const sort = typeof q.sort === 'string' && q.sort ? q.sort : defaultSort;
  if (!sortWhitelist.includes(sort)) {
    throw new AppError('VALIDATION_ERROR', `Cannot sort by '${sort}'`, [
      { field: 'sort', message: `allowed: ${sortWhitelist.join(', ')}` },
    ]);
  }
  const order = q.order === 'asc' ? 'asc' : 'desc';
  return { page, perPage, sort, order, offset: (page - 1) * perPage };
}

export function pageMeta(page: number, perPage: number, total: number): PageMeta {
  return {
    page,
    per_page: perPage,
    total,
    total_pages: Math.max(1, Math.ceil(total / perPage)),
  };
}

function toInt(v: unknown, fallback: number): number {
  if (typeof v !== 'string') return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}
