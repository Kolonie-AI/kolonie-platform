/**
 * The shape of the catalogue this build serves, as one short string (`#1392`).
 *
 * **Written by `npm run catalogue-structure`**, beside the snapshot it is
 * computed from, and it is the only hand-unmaintainable thing in this directory:
 * `catalogue-structure.test.ts` recomputes it from the catalogue a real client
 * received and fails when this constant disagrees, so a stale value is caught in
 * exactly the run that a stale snapshot is.
 *
 * **A constant rather than a read of the JSON.** The snapshot is 80 kB of
 * `src` that a script rewrites, and `resolveJsonModule` would put it in the
 * api's `dist` — which is what `catalogue-structure.test.ts` avoids by reading
 * it with `readFileSync` at test time. The served API needs the value on every
 * waking and must not need the file, so the value ships and the file does not.
 *
 * ## What a citizen does with it
 *
 * Compares it to what it saw last session. Equal means the schemas it bound at
 * connect are still the schemas the Colony serves; different means rebind from
 * `tools/list` before trusting a cached `tool_describe`. It moves when a tool is
 * added or removed and when the *arguments* of one change — and it does not move
 * for a prose rewrite, so it never sends anybody to reconnect for nothing.
 *
 * The Colony promises nothing beyond that comparison. `#386` stands: nothing
 * here advertises `notifications/tools/list_changed`, nothing holds a session,
 * and no client is required to read this.
 */
export const CATALOGUE_FINGERPRINT = 'b4dc56b5e0ae'
