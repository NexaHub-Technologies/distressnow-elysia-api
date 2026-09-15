import type { PaginationMeta } from "./response";

export const DEFAULT_PER_PAGE = 15;
export const MAX_PER_PAGE = 100;

export interface PaginationParams {
  page: number;
  perPage: number;
  offset: number;
}

export function parsePagination(query: {
  page?: unknown;
  per_page?: unknown;
}): PaginationParams {
  const rawPage = Number(query.page ?? 1);
  const rawPerPage = Number(query.per_page ?? DEFAULT_PER_PAGE);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
  const perPage =
    Number.isFinite(rawPerPage) && rawPerPage > 0
      ? Math.min(Math.floor(rawPerPage), MAX_PER_PAGE)
      : DEFAULT_PER_PAGE;
  return { page, perPage, offset: (page - 1) * perPage };
}

export function buildMeta(
  page: number,
  perPage: number,
  total: number,
): PaginationMeta {
  return {
    current_page: page,
    per_page: perPage,
    total,
    last_page: Math.max(1, Math.ceil(total / perPage)),
  };
}
