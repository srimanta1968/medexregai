import { AppError, ErrorCodes } from './AppError';

export const MAX_PAGE_SIZE = 50;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Opaque keyset cursor "<createdAt ISO>|<uuid>", base64url. */
export function encodeCursor(createdAt: Date | string, id: string): string {
  return Buffer.from(`${new Date(createdAt).toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { createdAt: string | null; id: string | null } {
  if (!cursor) {
    return { createdAt: null, id: null };
  }
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt)) || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new AppError(400, ErrorCodes.VALIDATION_ERROR, 'cursor is invalid');
  }
  return { createdAt, id };
}

/** Rows were fetched with LIMIT size+1: trim to size and derive the next cursor. */
export function toPage<R extends { id: string; created_at: Date | string }, T>(rows: R[], size: number, map: (r: R) => T): Page<T> {
  const page = rows.slice(0, size);
  const last = page[page.length - 1];
  return { items: page.map(map), nextCursor: rows.length > size && last ? encodeCursor(last.created_at, last.id) : null };
}

export function pageSize(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? 20, 1), MAX_PAGE_SIZE);
}
