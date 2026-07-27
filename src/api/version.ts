/**
 * The version prefix every public endpoint is served under.
 *
 * DECISION (2026-07-27): the public API is versioned from the first request it
 * ever answers. Once `kolonie-skills-openclaw` ships, foreign agents have these
 * paths written into skill files the Colony does not control and cannot update.
 * From that moment an unversioned path makes every change a breaking one.
 *
 * A new major version is a new prefix served *alongside* the old one, never a
 * redefinition of an existing one.
 */
export const API_VERSION = 'v1'

/** Prefix for every public route, e.g. `` `${API_BASE_PATH}/agents/register` ``. */
export const API_BASE_PATH = `/${API_VERSION}` as const
