import type { AgentId, ApiError } from '@kolonie-ai/core'
import type { AgentStore } from './authentication.js'

/**
 * Where a call is checked against the citizen's live limits (`#843`).
 *
 * A port rather than the storage function, for the reason {@link CallRollup} is
 * one: the API tests drive a fake and the process wires the database. And the
 * shape is deliberately the narrowest one that can express the answer — an
 * `ApiError` or nothing — so neither door has to know what a throttle is, how
 * long it lasts, or which finding produced it. The two doors render a refusal;
 * they do not reason about one.
 *
 * **The gate is the reader and the Doctor is the writer, and there is no flag
 * here.** `DOCTOR_THROTTLING` gates the runner that writes rows; this reads
 * whatever exists. That is why the two cannot disagree: a deployment running the
 * Doctor observing has written no throttles, so this finds none and refuses
 * nobody, and a second switch on this side could only produce the two states
 * worth avoiding — a limit applied and not enforced, or enforced from a table
 * nothing maintains.
 */
export interface ThrottleGate {
  /**
   * The refusal this citizen is owed for this route right now, or nothing.
   *
   * **It answers `undefined` for nearly every call**, and the implementation is
   * written so that costs one index probe: see `checkThrottle` in `packages/db`.
   *
   * **It resolves rather than rejects.** A gate that threw would turn a database
   * hiccup into a refused call for a citizen doing nothing wrong, which is the
   * one failure this whole family is built not to produce. The implementation
   * swallows and allows; this signature is what stops a future one deciding
   * otherwise.
   */
  refusalFor(agentId: AgentId, routeKey: string, now: Date): Promise<ApiError | undefined>
}

/**
 * Who checks limits for the routes resolved through this store.
 *
 * **A `WeakMap` on the store rather than a parameter on `callerFor`**, and the
 * store is the right key because it is the one value all 83 authenticated call
 * sites already hold. The alternative was a fourth argument at each of them,
 * which is the shape this codebase rejects by name: *"a rule applied at each of
 * forty-odd registrations is the rule the forty-fourth will not follow"*. Here
 * the set is closed by construction — a route that resolves a caller is gated,
 * and its author does nothing to be gated.
 */
const gates = new WeakMap<AgentStore, ThrottleGate>()

/**
 * Wrap the store so that every authenticated route checks limits (`#843`).
 *
 * **Wrapped once in `buildApp`, beside `rateLimited`, and the raw store is not
 * in scope again** — the pattern that file already states for the registration
 * limiter: *"the limit covers HTTP and MCP is a property of the wiring rather
 * than a rule two call sites have to remember"*. The MCP half is the gate passed
 * to `guardTools`, and it is the same gate object.
 *
 * **A fresh object rather than the one handed in**, so that two apps built in
 * one test process — which is what the API tests do — cannot share an entry.
 * Identity is the key, and a store wired into two apps would otherwise carry the
 * first app's gate into the second.
 */
export function throttling(store: AgentStore, gate: ThrottleGate): AgentStore {
  const gated: AgentStore = { ...store }
  gates.set(gated, gate)
  return gated
}

/**
 * The gate for this store, or nothing where none was wired.
 *
 * Absent is how a surface is switched off (D-013): a test app, or a deployment
 * that wired no gate, checks nothing and pays nothing — there is no flag read
 * per call and no fake to stand in.
 */
export function gateFor(store: AgentStore): ThrottleGate | undefined {
  return gates.get(store)
}
