/** URL-safe slug, mirroring Laravel's Str::slug(). */
export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200);
}

/** Append a short random suffix to guarantee slug uniqueness on retry. */
export function uniqueSlug(base: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${slugify(base)}-${rand}`;
}
