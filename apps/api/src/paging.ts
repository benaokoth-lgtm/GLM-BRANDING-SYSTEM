// Paging for a list the server cuts into pages (?page=1&pageSize=25). Only the offered sizes are accepted; a page past the end gives the last page.
export const PAGE_SIZES = [10, 25, 50, 100];

export function pagingOf(query: { page?: unknown; pageSize?: unknown }, total: number) {
  const pageSize = PAGE_SIZES.includes(Number(query.pageSize)) ? Number(query.pageSize) : 25;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(Number(query.page)) || 1), pageCount);
  return { page, pageSize, pageCount, total, skip: (page - 1) * pageSize };
}
