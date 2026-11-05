export const CATALOG_DEFAULT_PAGE_LIMIT = 50;
export const CATALOG_MAX_PAGE_LIMIT = 100;

export const CATALOG_DURATION_MIN = 1;
export const CATALOG_DURATION_MAX = 24 * 60;
export const CATALOG_BUFFER_MAX = 24 * 60;

/** Roles that may mutate the catalog (RLS + API). */
export const CATALOG_EDITOR_ROLES = ['owner', 'manager'] as const;
