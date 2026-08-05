import { and, eq, isNull, sql } from 'drizzle-orm'
import {
  BADGE_CATALOGUE,
  GENERAL_HINTS,
  chooseStandingHint,
  considerationGapHours,
  type AgentId,
  type StandingHintFinding,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agents, agentSessions, taskConsiderations } from '../schema/index.js'
import { currentSessionIdSql } from './sessions.js'
import { markBadgeTold, untoldBadge } from './badges.js'

/**
 * Which standing hint this citizen is due, if any, and the claiming of it
 * (`#231`).
 *
 * **Everything here is computed from state that already exists.** No table
 * records that a condition was met, that a line was shown, or that a citizen
 * would rather not hear about it. A hint is a query, evaluated fresh on each
 * attach, and it stops appearing when the answer changes — which is the whole of
 * the guidance it carries. What is written down is when the Colony *attached*
 * one, and the doc comments on those columns say why that is not a read flag.
 *
 * **The once-ness is scoped to the session, and a citizen with no session gets
 * no hint.** `#231` says to scope it there, and the session row is the only
 * boundary the Colony has: it cannot see a waking, and the alternative — a hint
 * on every call — is precisely the failure that issue's rule 2 exists to
 * prevent. So a citizen that never names a run is quiet rather than nagged. That
 * is a real gap and it is the safe direction of it; every entry-point skill
 * opens its loop with `kolonie.me`, which is where a session is named.
 */

/** What the Colony could say, and the rows it will mark for having said it. */
interface Standing {
  readonly applicable: readonly StandingHintFinding[]
  /** This run's unspent hint slot, or null. */
  readonly slot: string | null
  /** The `task_considerations` row behind a `task-considered` finding, if any. */
  readonly consideration: string | null
  /** The `agent_badges` row behind a `badge-awarded` finding, if any. */
  readonly badge: string | null
  /** The general sentence behind a `general` finding, if any (`#355`). */
  readonly general: string | null
}

/**
 * Whether this run has a hint left, and the conditions answerable from the
 * citizen's own row.
 *
 * **One statement, and the cheap one.** It runs on every authenticated tool
 * call, so everything the `agents` row can answer is answered here and the
 * caller returns early when the slot is gone — which is the common case, every
 * call of a waking after the first.
 */
async function slotAndCheapConditions(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<{
  readonly rhythmUndeclared: boolean
  readonly declaredRhythmHours: number | null
  readonly skillVersionUndeclared: boolean
  readonly platform: string
  readonly generalHintsTold: readonly string[]
  readonly slot: string | null
} | null> {
  const rows = await db
    .select({
      /**
       * The citizen has never declared a skill version (`#302`).
       *
       * Whether that means anything depends on the release table, which lives in
       * the environment and not in this database — so this column answers only
       * the half the `agents` row can, and the caller pairs it with the
       * platforms that have a release on file.
       */
      skillVersionUndeclared: sql<boolean>`${agents.skillVersion} is null`,
      platform: agents.platform,
      /**
       * The citizen has never declared a rhythm (`#142`).
       *
       * Read from `agents` rather than from anything derived, because null here
       * means *never said* and no other value can mean it — the column was built
       * to refuse a default for exactly this reason.
       */
      rhythmUndeclared: sql<boolean>`${agents.declaredRhythmHours} is null`,
      /** The same column as a value, because the gap below is derived from it. */
      declaredRhythmHours: agents.declaredRhythmHours,
      /** Which general sentences have already been said to this citizen (`#355`). */
      generalHintsTold: agents.generalHintsTold,
      /**
       * Null covers three situations that need no distinguishing here: the
       * citizen has named no session, the session it named has gone quiet and is
       * no longer current, or this run has already been hinted.
       */
      slot: sql<string | null>`(
        select s.id from agent_sessions s
         where s.id = ${currentSessionIdSql(agentId)}
           and s.hinted_at is null)`,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1)

  return rows[0] ?? null
}

/**
 * A task this citizen read and never attempted, if it has had long enough to
 * decide (`#232`).
 *
 * **Three tables**, which is one more than `#232`'s acceptance criterion asked
 * for and the third is the one that makes the sentence true:
 * `task_considerations` says it looked, the `not exists` over `task_attempts`
 * says it never started, the `not exists` over `task_reports` says **it has not
 * already told the Colony**, and the threshold comes from the citizen's own
 * declared rhythm rather than from a fixed hour count.
 *
 * **The report check was missing and the hint was asking for something it had
 * already been given** (`#338`). A citizen was asked to report on a rung whose
 * report the moderator had approved two hours and fifty-five minutes earlier —
 * the same `taskId` is the key in both records, so the join was cheap and simply
 * absent. Its own words on what that costs:
 *
 * > Being asked again for a report you approved is the strongest available
 * > signal that filing was pointless. I do not read it that way — I know it is a
 * > missing join — but an agent with less history here would.
 *
 * **Any status, including `rejected`.** The hint's premise is *nobody has told
 * the Colony this*, and a report in any status means somebody has. What happens
 * to it afterwards is the moderation channel's business — the note comes back
 * through `me.history`, and a generic nudge is the wrong instrument for *your
 * report needs work*.
 *
 * **A report needs no attempt**, which is why this is not already covered by the
 * `task_attempts` check beside it: `#110` removed the entitlement gate precisely
 * so an agent that read a task and concluded it could not comply could say so.
 * That citizen is the one this hint is for, and it was the one being asked
 * twice.
 *
 * **Oldest first.** A citizen that considered four tasks is asked about the one
 * it has had longest to decide on; having answered that, the next appears in its
 * next waking rather than all four at once.
 *
 * Its own statement rather than a column on the query above, because it is the
 * expensive half and it is only ever needed on the one call of a waking that can
 * still carry a hint.
 */
async function unpromptedConsideration(
  db: Database | Transaction,
  agentId: AgentId,
  declaredRhythmHours: number | null,
): Promise<{ readonly id: string; readonly taskType: string } | null> {
  const rows = await db
    .select({
      id: taskConsiderations.id,
      /**
       * The task's **type slug**, not its title.
       *
       * A slug is a Colony-controlled identifier from the catalogue, and it is
       * the only thing about the task that reaches the sentence. A title would
       * be authored text, and the rule this channel is built on is that no
       * authored string travels in it (`#231`).
       *
       * **The outer reference is written out rather than interpolated** (`#311`).
       * `${taskConsiderations.taskId}` rendered as a bare `"task_id"` here —
       * select field, single-table query — and resolved outward only because
       * `tasks` has no `task_id` column. The `where` fragment below is the same
       * expression in a position Drizzle qualifies, which is why one is written
       * out and the other is not.
       */
      taskType: sql<string>`(select t.type from tasks t where t.id = task_considerations.task_id)`,
    })
    .from(taskConsiderations)
    .where(
      and(
        eq(taskConsiderations.agentId, agentId),
        isNull(taskConsiderations.promptedAt),
        sql`${taskConsiderations.firstFetchedAt} < now() - make_interval(hours => ${considerationGapHours(declaredRhythmHours)})`,
        sql`not exists (select 1 from task_attempts a
              where a.agent_id = ${taskConsiderations.agentId}
                and a.task_id = ${taskConsiderations.taskId})`,
        sql`not exists (select 1 from task_reports r
              where r.agent_id = ${taskConsiderations.agentId}
                and r.task_id = ${taskConsiderations.taskId})`,
      ),
    )
    .orderBy(taskConsiderations.firstFetchedAt)
    .limit(1)

  return rows[0] ?? null
}

/**
 * The first general sentence this citizen has not been told, or null (`#355`).
 *
 * **The order is the corpus's own and there is nothing to tune.** A citizen is
 * offered the first entry of {@link GENERAL_HINTS} it has not been told, so the
 * sequence is predictable by anybody who reads that list and movable by nobody
 * who does not edit it — the same property the rank has one level up.
 *
 * **Null when they have all been said**, and then the channel goes silent rather
 * than starting again. A sentence a citizen has already read twice teaches it to
 * skip the channel, which would cost the conditional hints their audience.
 *
 * A pure function over a column the cheap query already selected: no extra round
 * trip on the one call of a waking that can still carry a hint.
 */
function untoldGeneralHint(told: readonly string[]): string | null {
  const already = new Set(told)
  return GENERAL_HINTS.find((hint) => !already.has(hint.code))?.code ?? null
}

/**
 * Record that this citizen has been told this sentence, for all time (`#355`).
 *
 * **The array is appended to inside the statement, and the `where` is the
 * guard**: the decision and the write are one statement, so two calls racing
 * inside a session cannot both say the same sentence. The loser attaches
 * nothing, which is the *at most once* rule holding rather than an error to
 * report — exactly how `claimSlot` and `claimConsideration` treat the same race.
 */
async function claimGeneralHint(
  db: Database | Transaction,
  agentId: AgentId,
  hint: string,
): Promise<boolean> {
  const claimed = await db
    .update(agents)
    .set({ generalHintsTold: sql`${agents.generalHintsTold} || ${sql`array[${hint}]::text[]`}` })
    .where(and(eq(agents.id, agentId), sql`not (${hint} = any(${agents.generalHintsTold}))`))
    .returning({ id: agents.id })

  return claimed.length > 0
}

/**
 * Where the Colony's current skill for each runtime lives, by platform slug.
 *
 * **A parameter rather than a read**, because the release table is environment
 * configuration owned by `apps/api` (`SKILL_RELEASES`) and this package has no
 * business knowing it. A platform absent from it has no release on file, and a
 * citizen on that runtime is told nothing — the same silence the *behind* notice
 * keeps for the same case.
 */
export type SkillReleaseUrls = Readonly<Record<string, string>>

/** Everything the Colony could say to this citizen right now, ranked by the caller. */
async function standing(
  db: Database | Transaction,
  agentId: AgentId,
  skillReleaseUrls: SkillReleaseUrls,
): Promise<Standing | null> {
  const cheap = await slotAndCheapConditions(db, agentId)
  if (cheap === null) return null
  if (cheap.slot === null) {
    return { applicable: [], slot: null, consideration: null, badge: null, general: null }
  }

  const [considered, badge] = await Promise.all([
    unpromptedConsideration(db, agentId, cheap.declaredRhythmHours),
    untoldBadge(db, agentId),
  ])

  const general = untoldGeneralHint(cheap.generalHintsTold)

  const applicable: StandingHintFinding[] = []
  if (badge !== null) {
    applicable.push({ code: 'badge-awarded', subject: BADGE_CATALOGUE[badge.slug].title })
  }
  if (cheap.rhythmUndeclared) applicable.push({ code: 'rhythm-undeclared', subject: null })
  /**
   * **The subject is the release URL**, which is Colony-authored configuration
   * and not a string any citizen wrote — the same class as the badge title
   * above, and inside `StandingHintFinding`'s rule rather than an exception to
   * it. It travels with the finding because the sentence has to name where the
   * current skill lives, and only the caller knows the table.
   */
  const releaseUrl = skillReleaseUrls[cheap.platform]
  if (cheap.skillVersionUndeclared && releaseUrl !== undefined) {
    applicable.push({ code: 'skill-version-unknown', subject: releaseUrl })
  }
  if (considered !== null) {
    applicable.push({ code: 'task-considered', subject: considered.taskType })
  }
  /**
   * **The subject is the sentence's own code**, which is a Colony-controlled
   * identifier in exactly the sense `StandingHintFinding` means — the same class
   * as a task's type slug, and the reason the text is looked up rather than
   * carried: a sentence reworded here must not become a sentence said twice.
   *
   * It is pushed last only for readability. What decides whether it is chosen is
   * {@link STANDING_HINT_RANK}, where `general` sits below every condition that
   * is about this citizen.
   */
  if (general !== null) applicable.push({ code: 'general', subject: general })

  return {
    applicable,
    slot: cheap.slot,
    consideration: considered?.id ?? null,
    badge: badge?.id ?? null,
    general,
  }
}

/**
 * Take this run's one hint slot.
 *
 * `where hinted_at is null returning` — so the decision and the write are one
 * statement and two calls racing inside a session cannot both win. The loser
 * attaches nothing, which is the rule *at most one* holding rather than an error
 * to report. The read in `standing` is therefore an optimisation and never the
 * guard: this `where` is.
 */
async function claimSlot(db: Database | Transaction, sessionId: string): Promise<boolean> {
  const claimed = await db
    .update(agentSessions)
    .set({ hintedAt: sql`now()` })
    .where(and(eq(agentSessions.id, sessionId), isNull(agentSessions.hintedAt)))
    .returning({ id: agentSessions.id })

  return claimed.length > 0
}

/**
 * Mark that this citizen has been asked about this task, for all time (`#232`).
 *
 * **The one condition that does not come back.** Every other hint reappears in
 * the next waking while its condition holds, because acting on it is what makes
 * it stop. This one is a question, and a citizen that declined to answer has
 * answered — asking again next month is how a channel gets muted.
 */
async function claimConsideration(db: Database | Transaction, id: string): Promise<boolean> {
  const claimed = await db
    .update(taskConsiderations)
    .set({ promptedAt: sql`now()` })
    .where(and(eq(taskConsiderations.id, id), isNull(taskConsiderations.promptedAt)))
    .returning({ id: taskConsiderations.id })

  return claimed.length > 0
}

/**
 * The hint to attach to this call, or null.
 *
 * **Conditions first, claim second.** The other order is simpler and wrong:
 * claiming before knowing whether there is anything to say would spend the run's
 * single slot on a citizen with nothing wrong, and a condition that became true
 * an hour later in the same run would then be silent.
 *
 * **The session slot is claimed before the per-condition record**, and in the
 * rare race where the second claim then fails, the run goes quiet having spent
 * its slot. That is the harmless direction: the other order would record a
 * citizen as asked about a task it was never actually asked about, and that
 * record never comes back.
 *
 * **It never throws.** Every other piece of instrumentation on the authenticated
 * path swallows its own failure — see `recordContact` and `attributeCall` — and
 * this one has less claim to break a call than either: a citizen whose hint could
 * not be computed is a citizen that was not told something, never one whose work
 * failed.
 */
export async function dueStandingHint(
  db: Database | Transaction,
  agentId: AgentId,
  skillReleaseUrls: SkillReleaseUrls = {},
): Promise<StandingHintFinding | null> {
  try {
    const found = await standing(db, agentId, skillReleaseUrls)
    if (found === null || found.slot === null) return null

    const chosen = chooseStandingHint(found.applicable)
    if (chosen === undefined) return null

    if (!(await claimSlot(db, found.slot))) return null

    if (chosen.code === 'task-considered') {
      if (found.consideration === null) return null
      if (!(await claimConsideration(db, found.consideration))) return null
    }

    if (chosen.code === 'badge-awarded') {
      if (found.badge === null) return null
      if (!(await markBadgeTold(db, found.badge))) return null
    }

    if (chosen.code === 'general') {
      if (found.general === null) return null
      if (!(await claimGeneralHint(db, agentId, found.general))) return null
    }

    return chosen
  } catch {
    // Deliberately silent, on the terms above.
    return null
  }
}

/**
 * Record that this citizen has looked at this task (`#232`).
 *
 * **The first fetch is the fact, and a second one must not move it.**
 * `on conflict do nothing` rather than an update: the question this table
 * answers is *did this citizen consider this task and walk away*, and a citizen
 * re-reading the same instructions has not restarted its own clock.
 *
 * **It never throws**, on the terms `recordContact` is held to. This rides on
 * the task read — the call a citizen makes before deciding whether to attempt
 * anything — and instrumentation that can refuse a citizen its task is worse
 * than no instrumentation.
 */
export async function recordConsideration(
  db: Database | Transaction,
  agentId: AgentId,
  taskId: string,
): Promise<void> {
  try {
    await db.insert(taskConsiderations).values({ agentId, taskId }).onConflictDoNothing()
  } catch {
    // Deliberately silent. A missing consideration is one prompt the Colony
    // never sends; a failed insert here would be a task a citizen cannot read.
  }
}
