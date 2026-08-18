import type { AgentId, Diagnosis } from '@kolonie-ai/core'
import type {
  ConsultationFunnel,
  DiagnosisPage,
  DiagnosisQuery,
  RuleHealthRow,
} from '@kolonie-ai/db'

/**
 * What the console's diagnoses pages read (`#841`).
 *
 * **Six reads and no writes, and the absence is the design.** A diagnosis
 * resolves when its evidence stops matching, decided by the rules that opened it
 * (`#838`) — so there is no `close`, no `reopen` and no `severity` on this
 * interface, and a future hand that wanted one would have to widen the seam in a
 * diff somebody reviews rather than add a route in a file nobody looks at twice.
 *
 * `console-diagnoses.test.ts` asserts the same thing from the other end, against
 * the router. Two checks for one rule, because the rule is the point of the
 * surface: *anything a person should decide belongs in the support queue, which
 * already exists and already has an owner.*
 */
export interface DiagnosesDesk {
  /** One page, most serious first. */
  list(query: DiagnosisQuery): Promise<DiagnosisPage>
  /** One diagnosis, or `null` for an id that names nothing. */
  byId(id: string): Promise<Diagnosis | null>
  /** How many stand in each state, for the line that says whether to read on. */
  counts(): Promise<Readonly<Record<string, number>>>
  /**
   * Whether telling citizens about findings makes them look (`#1081`).
   *
   * A read like the other three: it counts what the Doctor's two doors already
   * wrote and decides nothing. The window is the caller's, and there is one
   * caller.
   */
  funnel(since: Date): Promise<ConsultationFunnel>
  /**
   * How each rule has done, and what the citizens made of it (`#1083`).
   *
   * One row per rule per policy version, because a rule that changed is a
   * different rule and summing the two would hide the only thing the page is
   * for. No window: the two sides age differently — a finding is swept and a
   * verdict is kept — and a cutoff would silently cost one of them.
   */
  ruleHealth(): Promise<readonly RuleHealthRow[]>
  /**
   * The handles behind a page of agent-scoped rows (`#1080`).
   *
   * A read like the five above it, and batched for the reason the storage
   * function is: a page of fifty citizens is one query or it is fifty.
   *
   * **The ids come from the rows' `subject`**, which for an agent-scoped
   * diagnosis *is* the citizen's id — `recordDiagnosis` writes both columns from
   * that one value, and the published shape carries `subject` alone so that a
   * reader cannot come to think there are two identities on a row. Nothing here
   * parses it: the scope says which kind of subject it is, and an id that names
   * nobody is absent from the map rather than an error.
   */
  handles(agentIds: readonly AgentId[]): Promise<ReadonlyMap<AgentId, string>>
}
