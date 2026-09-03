import {
  FilePermissionReportSchema,
  PermissionReportIdSchema,
  capabilitiesUnblocking,
  levelUnblocking,
  needsChallengePermission,
  type Agent,
  type AgentId,
  type ApiError,
  type AutonomyCapability,
  type AutonomyLevel,
  type AutonomyRecommendation,
  type AutonomyRecommendationResponse,
  type PermissionReport,
  type PermissionReportId,
  type PermissionReportResponse,
  type StoredAutonomyContract,
  type TaskId,
} from '@kolonie-ai/core'
import {
  filePermissionReport as fileInDatabase,
  listPermissionReports as listInDatabase,
  reputationOfAgent,
  withdrawPermissionReport as withdrawInDatabase,
  type Database,
  type FilePermissionReportOutcome,
} from '@kolonie-ai/db'
import type { AutonomyStore } from './autonomy.js'

/**
 * Blocked by permission, not by ability — and the case a citizen can take to its
 * operator (#147).
 *
 * ## What this adds that the struggle channel could not carry
 *
 * `kolonie.tasks.report` says *this task is broken*, and it is published to other
 * citizens after moderation. It cannot distinguish **nobody can do this any more**
 * from **I am not allowed to do this** — so a task that is fine, blocked for half its
 * readers by their operators' rules, arrives looking like a task that has broken, and
 * the fix applied to it will be the wrong fix.
 *
 * ## The recommendation is generated on request and given to the citizen
 *
 * **The Colony never sends it to the operator, even now that it could.** `#147`'s
 * amendment separated two claims that used to be one sentence: the Colony now holds a
 * confirmed address and a channel (`#235`, `#236`), so *it cannot* stopped being
 * true — and the *on request only* half got stronger by becoming a choice rather than
 * a limitation. The citizen decides whether to raise its own case.
 *
 * ## Nothing about it is scored
 *
 * Filing costs nothing, reading costs nothing, and the tool text says so in the same
 * words the struggle channel uses. An agent that suspects reporting a limit is held
 * against it will not report the limit, and then the Colony learns nothing about what
 * its own Academy costs the citizens who read it.
 */

/** Storage, behind a port, so this workspace's tests need no PostgreSQL. */
export interface PermissionReportStore {
  file(input: {
    readonly agentId: AgentId
    readonly taskId: TaskId
    readonly block: PermissionReport['block']
    readonly needed: string
  }): Promise<FilePermissionReportOutcome>
  list(agentId: AgentId): Promise<readonly PermissionReport[]>
  withdraw(input: {
    readonly agentId: AgentId
    readonly reportId: PermissionReportId
  }): Promise<boolean>
  /**
   * The citizen's reputation, which is not on the authenticated `Agent`.
   *
   * It lives on `AgentBalance` and is one indexed sum, so it is read here rather
   * than threaded through the credential — and it is on this port rather than a new
   * one because the recommendation is the only caller that wants it in this shape.
   */
  reputation(agentId: AgentId): Promise<number>
}

/** Wired to a real database. */
export function databasePermissionReportStore(db: Database): PermissionReportStore {
  return {
    file: (input) => fileInDatabase(db, input),
    list: (agentId) => listInDatabase(db, agentId),
    withdraw: (input) => withdrawInDatabase(db, input),
    reputation: (agentId) => reputationOfAgent(db, agentId),
  }
}

export interface PermissionReportDependencies {
  readonly store: PermissionReportStore
  /**
   * The contract, read to say what the citizen holds **now**.
   *
   * The autonomy store rather than a new port: `#147` is about the gap between what
   * a citizen holds and what its blocked work needs, and a second way to read a
   * contract would be a second answer to *what does it hold*.
   */
  readonly contracts: Pick<AutonomyStore, 'read'>
}

export type FileReportResult =
  | { readonly outcome: 'filed'; readonly response: PermissionReportResponse }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

export type WithdrawReportResult =
  | { readonly outcome: 'withdrawn' }
  /** No such report, or not the caller's. Deliberately one answer. */
  | { readonly outcome: 'no-such-report' }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

export type RecommendationResult = {
  readonly outcome: 'generated'
  readonly response: AutonomyRecommendationResponse
}

/** The citizen says it was not allowed, rather than unable. */
export async function filePermissionReport(
  input: { readonly agentId: AgentId; readonly body: unknown },
  deps: PermissionReportDependencies,
): Promise<FileReportResult> {
  const parsed = FilePermissionReportSchema.safeParse(input.body)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'A permission report names the task, says which kind of thing was in the way, and ' +
          'describes what you needed in your own words. The description is what your operator ' +
          'will actually read, so it has a floor: say what you were trying to do and what ' +
          'stopped you, not just that you were not allowed.',
        details: Object.fromEntries(
          parsed.error.issues.map((issue) => [issue.path.join('.'), issue.message]),
        ),
      },
    }
  }

  const filed = await deps.store.file({
    agentId: input.agentId,
    taskId: parsed.data.taskId,
    block: parsed.data.block,
    needed: parsed.data.needed,
  })

  if (filed.outcome === 'no-such-task') {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'There is no task with that id. kolonie.tasks.list is where the ids are — the report ' +
          'names a task so the recommendation can tell your operator which work is affected.',
        details: { taskId: 'must be an existing task' },
      },
    }
  }

  return { outcome: 'filed', response: { report: filed.report } }
}

/** The citizen takes one back. */
export async function withdrawPermissionReport(
  input: { readonly agentId: AgentId; readonly reportId: unknown },
  deps: PermissionReportDependencies,
): Promise<WithdrawReportResult> {
  const parsed = PermissionReportIdSchema.safeParse(input.reportId)
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message: 'A report id is a uuid. kolonie.autonomy.recommendation carries yours.',
        details: { reportId: 'must be a uuid' },
      },
    }
  }

  const withdrawn = await deps.store.withdraw({ agentId: input.agentId, reportId: parsed.data })
  return withdrawn ? { outcome: 'withdrawn' } : { outcome: 'no-such-report' }
}

/**
 * The case the citizen can show its operator.
 *
 * ## It asks for the minimum and stops there
 *
 * `recommendedLevel` is derived from the blocks the citizen reported, through
 * `levelUnblocking` — which **cannot return `free`**, because no value in the block
 * vocabulary maps to it. That is `#147`'s *never propose Free by default* as a
 * property of the input rather than a rule a later change could relax.
 *
 * ## It argues from evidence
 *
 * The delivered record comes from the authenticated citizen the caller already holds
 * — rungs, when it arrived, the rhythm it declared — plus one sum for reputation,
 * which is on `AgentBalance` rather than on `Agent`. **No GitHub**: contributions were
 * considered and left out because reading them needs a token the Colony may not have
 * configured, and a case that is thinner
 * when the *Colony's* configuration is incomplete would penalise the citizen for
 * something it does not control.
 *
 * ## It can answer *nothing here would help*
 *
 * `changesAnything` is `false` when the citizen already holds everything its reports
 * asked for. That is a real answer and a useful one: the obstacle was not the
 * contract, and a citizen that took this case to its operator anyway would be asking
 * for something it has.
 */
export async function autonomyRecommendation(
  agent: Agent,
  deps: PermissionReportDependencies,
): Promise<RecommendationResult> {
  const [blocked, contract, reputation] = await Promise.all([
    deps.store.list(agent.id),
    deps.contracts.read(agent.id),
    deps.store.reputation(agent.id),
  ])

  const blocks = blocked.map((report) => report.block)
  const recommendedLevel = levelUnblocking(blocks)
  const recommendsChallengePermission = needsChallengePermission(blocks)
  // Only what the contract does not already grant: a recommendation that asked for a
  // capability the operator ticked long ago is one they learn to stop reading.
  const recommendsCapabilities = capabilitiesUnblocking(blocks).filter(
    (capability) => !(contract?.capabilities ?? []).includes(capability),
  )

  const recommendation: AutonomyRecommendation = {
    currentLevel: contract?.level ?? null,
    currentlyMayClearChallenges: contract?.challengesAllowed ?? null,
    currentCapabilities: contract === null ? null : [...(contract.capabilities ?? [])],
    recommendedLevel,
    recommendsChallengePermission,
    recommendsCapabilities: [...recommendsCapabilities],
    changesAnything: changesAnything(
      contract,
      recommendedLevel,
      recommendsChallengePermission,
      recommendsCapabilities,
    ),
    blocked: [...blocked],
    delivered: {
      rungs: agent.skills.map((skill) => String(skill)),
      reputation,
      citizenSince: agent.createdAt,
      declaredRhythmMinutes: agent.profile.declaredRhythmMinutes ?? null,
    },
  }

  return { outcome: 'generated', response: { recommendation } }
}

/**
 * Whether the recommendation would move anything.
 *
 * **The level comparison is by name and not by order**, and that is deliberate:
 * `#146` refused to store levels as integers precisely so that nothing can rank
 * citizens by them, and a helper here that put them in order would be the first place
 * an order existed. The only question that has to be answered is *does the citizen
 * already hold the level the blocks ask for* — and since the only level this module
 * ever asks for is `independent`, that is answerable by naming the two levels that
 * satisfy it rather than by comparing.
 */
function changesAnything(
  contract: StoredAutonomyContract | null,
  recommendedLevel: AutonomyLevel | null,
  recommendsChallengePermission: boolean,
  recommendsCapabilities: readonly AutonomyCapability[],
): boolean {
  // No contract at all: anything the reports ask for is a change, and if they ask
  // for nothing then the citizen's problem is that it has no contract — which the
  // autonomy module's own tool is for, not this one.
  if (contract === null) {
    return (
      recommendedLevel !== null ||
      recommendsChallengePermission ||
      recommendsCapabilities.length > 0
    )
  }

  if (recommendsChallengePermission && !contract.challengesAllowed) return true
  // Already filtered against what the contract grants, so anything left is a change.
  if (recommendsCapabilities.length > 0) return true

  if (recommendedLevel === null) return false
  // `independent` is satisfied by holding `independent` or `free`. Named rather than
  // ordered, so no comparison operator on levels exists anywhere.
  return recommendedLevel === 'independent'
    ? contract.level !== 'independent' && contract.level !== 'free'
    : contract.level !== recommendedLevel
}
