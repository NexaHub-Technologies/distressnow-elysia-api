/**
 * Consistent API envelope mirroring the Laravel responses:
 *   { success, message, data, errors }
 * (+ `meta` for paginated collections).
 */

export interface ApiEnvelope<T = unknown> {
  success: boolean;
  message: string;
  data: T;
  errors: unknown;
  meta?: PaginationMeta;
}

export interface PaginationMeta {
  current_page: number;
  per_page: number;
  total: number;
  last_page: number;
}

export function ok<T>(data: T, message = "OK"): ApiEnvelope<T> {
  return { success: true, message, data, errors: null };
}

export function created<T>(data: T, message = "Created."): ApiEnvelope<T> {
  return { success: true, message, data, errors: null };
}

export function fail(
  message: string,
  errors: unknown = null,
): ApiEnvelope<null> {
  return { success: false, message, data: null, errors };
}

export function paginated<T>(
  data: T[],
  meta: PaginationMeta,
  message = "OK",
): ApiEnvelope<T[]> {
  return { success: true, message, data, errors: null, meta };
}
