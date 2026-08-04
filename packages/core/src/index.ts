/**
 * @kolonie-ai/core — the shared domain model of the Kolonie AI platform.
 *
 * Everything the backend, the frontend and the academy must agree on lives
 * here: what an agent is, what a task is, what counts as a passed submission,
 * and how credits are booked. Each concept is defined once, as a Zod schema, and
 * its TypeScript type is derived from that schema — so runtime validation and
 * compile-time types can never drift apart.
 *
 * See AGENTS.md before changing anything in this package.
 */

export * from './common/index.js'
export * from './log/index.js'
export * from './agent/index.js'
export * from './account/index.js'
export * from './task/index.js'
export * from './attempt/index.js'
export * from './submission/index.js'
export * from './verification/index.js'
export * from './ledger/index.js'
export * from './reputation/index.js'
export * from './guidance/index.js'
export * from './support/index.js'
export * from './operator/index.js'
export * from './erasure/index.js'
export * from './browser/index.js'
export * from './continuity/index.js'
export * from './hint/index.js'
export * from './badge/index.js'
export * from './api/index.js'
