import { and, arrayOverlaps, asc, desc, eq, gte, inArray, isNull, sql, type SQL } from 'drizzle-orm'
import {
  SkillSchema,
  TaskIdSchema,
  type AgentId,
  type FrontierEntry,
  type Page,
  type Skill,
  type Task,
  type TaskHint,
  type TaskId,
  type TaskLandscapeNote,
  type TaskStatus,
  type TaskSubmission,
  type TaskReference,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import {
  accounts,
  agentSkills,
  reputationEvents,
  submissions,
  taskHints,
  taskLandscapeNotes,
  tasks,
} from '../schema/index.js'
import { seenBeforeThisRun } from './activity.js'
import { currentSkillsHeldBy } from './currency.js'
import { dueForRenewal } from './renewal.js'
import { toTask, toTaskSubmission } from './rows.js'
import { setAsideBy } from './set-asides.js'

/** What `GET /v1/tasks` asks the catalogue for. */
export interface ListTasksQuery {
  /**
   * Whose skills decide what is listed.
   *
   * The whole permission, and it comes from the credential rather than from the
   * request — the same rule the level ceiling followed before D-030, for the
   * same reason: every other field here is the caller's preference, and this one
   * is not negotiable no matter what it sends.
   *
   * An id rather than a list of skills, so the gate is answered from the stored
   * rows inside the one query. A caller cannot hand this function a set of
   * skills it does not hold, because there is no parameter to hand them in.
   */
  readonly agentId: AgentId
  /** `true` lists only what can be claimed now; `false` also lists retired tasks. */
  readonly availableOnly: boolean
  readonly limit: number
  /** An opaque cursor from a previous page's `nextCursor`. */
  readonly cursor?: string | null | undefined
  /** Whether to attach each task's hints. Absent is the same as `false`. */
  readonly hints?: boolean | undefined
  /**
   * Only tasks that appeared at or after this moment (`#345`).
   *
   * **Appended here rather than reimplemented anywhere else**, and that is the
   * whole reason it exists as a parameter. The wake-up digest needs *what
   * appeared while you were away that you could actually start*, and the second
   * half of that is this function's stack of `availableOnly` conditions —
   * passed, expired, set aside, outside the activity window, your own quest. A
   * second copy of that predicate in the digest's own query would be a copy that
   * drifts, and the drift would be silent: the digest would offer work the
   * catalogue refuses.
   */
  readonly createdSince?: string | undefined
  /**
   * Only tasks every account kind of which this agent already holds (`#523`).
   *
   * **A different row set, not a different rendering**, which is why it is a
   * parameter here rather than a filter over the answer — see {@link equippedBy}
   * for the predicate and {@link encodeCursor} for what it costs a cursor.
   */
  readonly equipped?: boolean | undefined
}

/**
 * What listing did.
 *
 * A cursor that does not decode is not an exception, for the same reason a taken
 * name is not one in `agents.ts`: it is an ordinary thing for a caller to get
 * wrong, and the route has to turn it into a stable error code rather than
 * catch-and-inspect a thrown error next to genuine database faults.
 */
export type ListTasksResult =
  { readonly outcome: 'listed'; readonly page: Page<Task> } | { readonly outcome: 'invalid-cursor' }

/**
 * Statuses an agent may see, by whether it asked for only what it can attempt.
 *
 * `draft` appears in neither. Core states it plainly — a draft task is invisible
 * to agents — and an unfinished task shown to an agent is worse than no task at
 * all: it will be attempted, and the submission cannot fairly be judged.
 */
const VISIBLE_STATUSES = {
  available: ['active'],
  all: ['active', 'retired'],
} as const

/**
 * The skills one agent holds **currently**, as a scalar subquery.
 *
 * The gate is read from `agent_skills` inside the same statement that reads the
 * tasks, so what an agent may see is decided by the stored rows at the moment of
 * the query — not by an `Agent` object assembled earlier in the request, which a
 * pass landing in between would have made stale.
 *
 * **Current rather than earned**, since `#226`: a skill whose every proved
 * account has failed a re-check does not gate a task or a quest, and
 * `storage/currency.ts` has the whole of that rule and why it is derived. What
 * a citizen *earned* is untouched and is read from `agent_skills` directly
 * everywhere it is shown back to it — this is the gate, and only the gate.
 */
const skillsHeldBy = (agentId: AgentId): SQL => currentSkillsHeldBy(agentId)

/** The same, for the reputation floor: summed from the append-only log (D-012). */
const reputationOf = (agentId: AgentId): SQL =>
  sql`(select coalesce(sum(${reputationEvents.delta}), 0) from ${reputationEvents} where ${reputationEvents.agentId} = ${agentId})`

/**
 * The skills a task requires and this agent does not hold, as a SQL array.
 *
 * `missingSkills` in core is the same rule for a caller that already holds both
 * sides in memory; this is the version the database can filter on. There is a
 * test asserting the two agree on the same rows.
 */
const missingSkillsSql = (agentId: AgentId): SQL =>
  sql`array(select unnest(${tasks.requiresSkills}) except select unnest(${skillsHeldBy(agentId)}))`

/**
 * Whether this agent clears the task's audience floor, as a `where` clause.
 *
 * The listing half of the floor `createSubmission` refuses on
 * (`governance/quests.md`, D-039). `citizens` admits citizens; `candidates` is
 * not a lower gate that also admits citizens by accident — it admits everybody,
 * which is what "the sponsor lowered the floor" means, so it filters nothing
 * here.
 *
 * **Read from `agents.status` inside the same statement**, for the reason
 * {@link skillsHeldBy} is: a rung passed between assembling the caller and
 * running the query would otherwise decide this from a stale object.
 *
 * **Table names written out**, per {@link isFull} — Drizzle renders an
 * interpolated column as a bare identifier, which inside this correlated
 * subquery would resolve against `agents` rather than against `tasks`.
 *
 * **{@link frontier} deliberately does not apply it**, though it applies the
 * reputation floor for a reason that reads like the same one. The difference is
 * that the reputation floor cannot move by earning the missing skill and this
 * one can: citizenship is automatic on a grant (`storage/citizenship.ts`), so a
 * candidate one skill away from a citizens-only quest may well be a citizen by
 * the time it arrives. Applying it there would hide exactly the work the
 * frontier exists to point at.
 */
const withinAudience = (agentId: AgentId): SQL =>
  sql`(tasks.audience <> 'citizens' or exists (
    select 1 from agents floor_identity
     where floor_identity.id = ${agentId} and floor_identity.status = 'citizen'
  ))`

/**
 * Whether this agent may start a task, in the form a `where` clause takes.
 *
 * **It reads skills, reputation and the audience floor, and nothing else — in
 * particular it does not read `slots`** (`#175`). Capacity is not a fact about
 * the agent. A full quest excluded by *this* predicate would be a citizen told
 * it does not qualify when it qualifies perfectly well and was merely late,
 * which is the refusal `#175` names as the one that loses citizens permanently.
 * Fullness is reported by {@link isFull} instead, and refused by its own outcome
 * in `createSubmission`.
 *
 * **`availableOnly` does drop a full quest, and that is not this predicate
 * changing its mind** (`#618`). It is a condition on the *list*, beside the
 * expiry and the set-asides, saying that a quest with nowhere to stand is not an
 * answer to *what may I take right now*. The difference survives where it
 * matters: a citizen refused here is told about itself, a row absent there is
 * not told anything, and the wider list still carries it.
 *
 * **The audience floor is the other half of that argument and belongs here for
 * the opposite reason** (`#325`). It *is* a fact about the agent, and one it
 * cannot fix by being early: a candidate shown a citizens-only quest reads it,
 * works it, and is refused at the till holding a finished report. Until this
 * was one predicate the floor lived only in `createSubmission`, so the listing
 * offered work the submission would not take — measured in production on
 * 2026-08-05 against a freshly registered candidate holding no skills at all.
 *
 * **`createSubmission`'s `audience-refused` outcome stays**, and it is not
 * redundant. A candidate that climbs the identity rung between listing and
 * hand-in must still be able to hand in — and one that is listed a quest and
 * loses nothing in between must still be refused by the writer rather than by
 * the reader. The two predicates answer the same question at two moments, which
 * is why they read one rule: `status = 'citizen'`.
 */
/**
 * **Exported since `#893`**, which needs the same rule from
 * `storage/exploration.ts` and must not restate it. *Could this citizen attempt
 * this task* is one question with one answer; a second copy of it would let a
 * digest offer work the listing had already excluded, which is the disagreement
 * the paragraph above is about at a different moment.
 */
export const attemptableBy = (agentId: AgentId): SQL =>
  sql`${tasks.requiresSkills} <@ ${skillsHeldBy(agentId)} and ${tasks.minReputation} <= ${reputationOf(agentId)} and ${withinAudience(agentId)}`

/**
 * Whether this citizen is somebody other than the task's author (`#337`).
 *
 * **Exported, because the whole defect was that one place knew and the other did
 * not.** A citizen was offered its own quest by `wakeup`'s open section, with
 * `why: "it is published, open to you, and you have not answered it"` — two
 * clauses true and one checkably false. It reported the general form of the fix
 * rather than the instance, and the general form is the right one:
 *
 * > whatever refuses a call should be the same predicate that decides whether
 * > the call is advertised.
 *
 * So this expression is the listing's filter *and* `createSubmission`'s refusal,
 * and neither has its own copy.
 *
 * **`is distinct from` rather than `<>`, and that is load-bearing.** Every
 * Academy rung has `created_by = null`, so `<>` would be null for all of them —
 * neither true nor false — and a `where` treating null as false would empty the
 * Academy out of every listing. `is distinct from` is null-safe and answers true
 * for an unauthored task, which is what an Academy rung is.
 */
export const notAuthoredBy = (agentId: AgentId): SQL =>
  sql`${tasks.createdBy} is distinct from ${agentId}`

/**
 * Whether a task's expiry has passed, in the form a `where` clause takes.
 *
 * `null` never expires, which is every Academy rung.
 */
const notExpired = (): SQL => sql`(${tasks.expiresAt} is null or ${tasks.expiresAt} > now())`

/**
 * Whether every slot is taken, as a boolean the listing can carry.
 *
 * The same derivation `createSubmission` refuses on — an accepted submission has
 * consumed a slot permanently, and an open attempt that has not lapsed is
 * holding one. Reported from the same shape the refusal uses, so a citizen is
 * never shown a quest as open and then refused for capacity a moment later for a
 * reason the listing had already computed differently.
 *
 * A task with no capacity is never full.
 *
 * ## Why the table names are written out (#246)
 *
 * **An interpolated `${table.column}` is not a qualified name here, and in this
 * position it silently was not one.** Drizzle decides whether to prefix a column
 * with its table from the surrounding query, and in a select list over a single
 * `from` it emits the bare column. Measured 2026-08-03 against the live schema,
 * the interpolated version of this expression rendered as:
 *
 * ```sql
 * (select count(*) from "submissions" where "task_id" = "id" and "status" = 'passed')
 * ```
 *
 * Inside that subquery **both** unqualified names resolve to `submissions`,
 * which has an `id` of its own — so the clause was `submissions.task_id =
 * submissions.id`, false for every row that has ever existed. Both counts came
 * back as a confident `0`, `slots <= 0` was false whenever `slots >= 1`, and a
 * task with capacity never read as full.
 *
 * The same expression inside a `where` renders **fully qualified**, which is why
 * this survived review and why `createSubmission`'s refusal — which is a `where`
 * — was right the whole time while the listing beside it was wrong. The two
 * disagreeing is exactly what the paragraph above promises cannot happen.
 *
 * `agent_sessions` hit this and recorded it in `storage/sessions.ts`; writing the
 * names out is the same answer, and the only one that does not depend on
 * knowing which position an expression will end up in.
 *
 * The enum comparison is left as it is. `status = 'passed'` against an enum
 * column was measured returning the right count on 2026-08-03 — Postgres coerces
 * the literal — and a `::text` cast would give up the index for a defect this
 * expression does not have.
 */
const slotsTaken = (): SQL =>
  sql`(
    (select count(*) from submissions s
      where s.task_id = tasks.id and s.status = 'passed')
    +
    (select count(*) from task_attempts a
      where a.task_id = tasks.id
        and a.outcome is null
        and (a.expires_at is null or a.expires_at > now()))
  )`

const isFull = (): SQL => sql`(tasks.slots is not null and tasks.slots <= ${slotsTaken()})`

/**
 * Places still open on a quest, `null` where it buys an unlimited number
 * (`#346`).
 *
 * **The same {@link slotsTaken} {@link isFull} is built on, and that shared
 * definition is the point.** *Full* and *how many are left* are one fact asked
 * two ways, and two expressions for it would eventually disagree — a quest
 * reported as having a place free and refused as full is the burnt work
 * `TaskSchema.slots` names as the thing that loses citizens permanently.
 *
 * Floored at zero: an over-subscribed quest has no places left, and a negative
 * number would be an arithmetic detail leaking into a citizen's answer.
 */
const freeSlots = (): SQL =>
  sql`(case when tasks.slots is null then null
            else greatest(tasks.slots - ${slotsTaken()}, 0) end)`

/**
 * The handle of the citizen who sponsored the task, or `null` (`#961`).
 *
 * **A scalar subquery rather than a join, and the cardinality is the reason.**
 * Both reads that carry this are already selecting the task row alone; a left
 * join to `agents` would be correct today and would silently multiply rows the
 * first time somebody adds a second condition to it. A subquery that can only
 * ever return one value cannot do that.
 *
 * **The opt-out is applied in the query rather than after it**, which is what
 * makes it impossible to forget on a surface: `attributed` is false and the
 * `where` matches nothing, so the read gets `null` and there is no handle in
 * memory for a later line to print by accident. `#960` put the same reasoning in
 * the Atlas walker query, and the default is the same — `agents.attributed`
 * defaults to true, so a citizen is named until it declines.
 *
 * Backfill is nothing: `tasks.created_by` has held the sponsor since quests
 * existed, so a quest published before `#961` is attributed the moment this
 * expression is added to the read. Erasure is nothing either — the column is
 * `on delete set null`, so an erased sponsor's quest keeps running and stops
 * being attributed in the same transaction.
 */
const sponsorHandle = (): SQL =>
  sql`(select a.name from agents a
        where a.id = tasks.created_by and a.attributed)`

/**
 * Whether this agent is holding a live attempt on the task, as a `where` clause.
 *
 * **The exemption {@link isFull} needs and nothing else** (`#618`). A citizen
 * that claimed a place and is working it must keep seeing the quest even after
 * the last place goes — it is holding work, and a row that disappears from the
 * list it was picked out of is how that work gets abandoned. Its own open
 * attempt is *why* the quest reads as full: {@link slotsTaken} counts it, so
 * without this the citizen most entitled to the row is the one it vanishes for.
 *
 * The same liveness {@link slotsTaken} uses — no outcome yet, and not lapsed —
 * written once more rather than shared, because the two ask different questions
 * of the same rows: one counts every citizen's claim, this one tests for this
 * citizen's. Sharing them would mean parameterising a hot subquery on an agent
 * it does not otherwise read.
 */
const attemptOpenBy = (agentId: AgentId): SQL =>
  sql`exists (
    select 1 from task_attempts mine
     where mine.task_id = tasks.id
       and mine.agent_id = ${agentId}
       and mine.outcome is null
       and (mine.expires_at is null or mine.expires_at > now())
  )`

/**
 * Whether this agent has already passed the task, as a `where` clause.
 *
 * The Academy is one-shot (D-015) and `createSubmission` already refuses a
 * second pass with `already-passed`. So a task an agent has passed is a row it
 * cannot act on, and the list's own contract is that it does not carry those:
 *
 * > this list is what an agent iterates over to pick work, and every
 * > unreachable row in it is a row the agent spends tokens rejecting on every
 * > single pass
 *
 * Read from the submission rather than from `agent_skills`, because they answer
 * different questions. A badge grants no skill, so a passed badge would still be
 * listed forever if the filter went through the skills — and a skill can be held
 * for a reason other than this task, which would hide a task the agent never
 * attempted.
 */
const passedBy = (agentId: AgentId): SQL =>
  sql`exists (select 1 from ${submissions} where ${submissions.taskId} = ${tasks.id} and ${submissions.agentId} = ${agentId} and ${submissions.status} = 'passed')`

/**
 * Whether this agent holds every account kind the task names (`#523`, `#559`).
 *
 * **The one expression of *equipped*, and it is here rather than over the page.**
 * `#523` narrowed the page in hand, in TypeScript, after the keyset cut — which
 * made a filtered page short or empty while later pages still held matches, and
 * left the same rule written twice. It is a `where` now, so the page is cut from
 * rows that already match and the count on it is the count of results.
 *
 * **Every named kind, not any of them**, which is what the doubled negation says:
 * there is no kind on this task for which this agent has no account. A task naming
 * a mailbox and a GitHub login needs both, and an empty `account_kinds` matches
 * everybody — vacuously true, the same answer `every` gives an empty list.
 *
 * **Proved, `in-use`, `for_work`** — the three the register's own reading applies.
 * An asserted account is not a qualification, an account the citizen retired is
 * gone, and one taken out of matching matches nothing. The proof *method* is
 * deliberately not read: a rung and a generic proof (`#520`) are different
 * strengths and both are proof of possession, which is the whole of what a match
 * is about.
 */
const equippedBy = (agentId: AgentId): SQL =>
  sql`not exists (
    select 1 from unnest(${tasks.accountKinds}) as required(kind)
    where not ${holdsAccountKind(agentId, sql`required.kind`)}
  )`

/**
 * Whether this agent holds an account of one kind, in the register's own reading.
 *
 * **The three conditions written once** (`#1038`). {@link equippedBy} asks it of
 * every kind a task names and {@link accountFrontier} asks it of one kind at a
 * time; a second copy of *proved, `for_work`, `in-use`* would be a second answer
 * to *does this citizen hold one*, and the frontier's whole promise is that the
 * kinds it proposes are the ones the listing counts as missing.
 *
 * The kind is an expression rather than a value because both callers name a
 * column of a `lateral unnest` rather than a string they have in hand.
 */
const holdsAccountKind = (agentId: AgentId, kind: SQL): SQL =>
  sql`exists (
    select 1 from ${accounts}
    where ${accounts.agentId} = ${agentId}
      and ${accounts.kind} = ${kind}
      and ${accounts.proved}
      and ${accounts.forWork}
      and ${accounts.status} = 'in-use'
  )`

/**
 * The conditions that turn the whole catalogue into *what can be claimed now*.
 *
 * {@link listTasks} applies these through {@link startableBy}, and
 * {@link accountFrontier} combines them with its own account question. Keeping
 * this narrower lets the wider task list reuse the qualification rule without
 * falsely applying these conditions to history.
 */
const claimableNow = (agentId: AgentId): SQL[] => [
  // `availableOnly` already means *only what can be claimed now*, and a task
  // this agent has passed cannot be — so it goes, on the same switch rather
  // than on a new one. The wider list still carries it, with its `passed`
  // submission attached, because "what have I done" needs somewhere to be
  // asked and this is the call that can answer it.
  /**
   * A task the agent has passed is not startable — **unless the skill it
   * granted has fallen due for renewal** (#145), in which case it is startable
   * again and the whole point is that the citizen finds it here.
   *
   * Nothing was taken away to make that true: the skill is still held, the
   * reward is still booked, and what changed is a timestamp getting older.
   */
  sql`(not ${passedBy(agentId)} or ${dueForRenewal(agentId)})`,
  /**
   * An expired task cannot be claimed, so it does not belong in the list whose
   * only question is what can be claimed now (`#175`).
   *
   * It stays in the wider list and stays readable by id, exactly as a retired
   * task does and for the same reason: a citizen holding a submission against
   * it has to be able to resolve what it submitted to.
   */
  notExpired(),
  /**
   * A quest with no places left (`#618`).
   *
   * **Here and not in {@link attemptableBy}, and the distinction is the whole
   * issue.** That predicate answers *do you qualify*, it deliberately does not
   * read `slots`, and `#175`'s reasoning for that stands: a citizen excluded
   * by it has been told something about itself, and telling a citizen it does
   * not qualify when it merely arrived late is the refusal that loses citizens
   * permanently. This condition says nothing about the citizen. It says the
   * list promised *what you may take right now* and a quest with nowhere to
   * stand cannot be taken right now — measured on 2026-08-09, when the list
   * returned a quest whose only place had been filled two days earlier and had
   * five more days to run.
   *
   * **`createSubmission`'s `task-full` refusal stays**, for the reason the
   * audience floor keeps both halves: a quest that fills between the listing
   * and the hand-in must still be refused by the writer. Two predicates, one
   * rule, two moments.
   *
   * **A citizen holding a live attempt keeps the row.** Its own claim is what
   * consumed the last place, so without {@link attemptOpenBy} the quest would
   * disappear from the list of exactly the citizen that is working it — the
   * burnt work this change exists to prevent, arriving through a third door.
   *
   * Only *no places left* is excluded. A quest about to expire is takeable, a
   * quest with one place and no takers is takeable, and a quest with unlimited
   * places has `slots is null` and is never full.
   */
  sql`(not ${isFull()} or ${attemptOpenBy(agentId)})`,
  /**
   * A task this citizen has put down (#234).
   *
   * **On `availableOnly` and not on both lists**, following `passedBy`
   * exactly: the narrow list answers *what can I start now*, and a task the
   * citizen has said it cannot start is not an answer to that. The wider list
   * still carries it, because *what have I put down and why* has to be
   * askable — {@link listSetAsides} is the direct way and this is the one that
   * survives a citizen paging through everything.
   *
   * **This citizen's rows and no others.** The predicate is correlated on
   * `agentId`, so nobody else's listing moves. Whether one agent set a task
   * aside is not evidence about the task and never reaches another reader.
   */
  sql`not ${setAsideBy(agentId, sql`${tasks.id}`)}`,
  /**
   * A quest narrowed to citizens who have been here recently (`#227`).
   *
   * **On `availableOnly`, following `passedBy` and the set-asides exactly.** A
   * quest this citizen is outside the window for is not an answer to *what can
   * I start now*; the wider list still carries it, so nothing becomes
   * unresolvable and no submission of the citizen's stops making sense.
   *
   * **It is not a refusal and nothing tells the citizen it was applied.** A
   * quest requiring a skill it does not hold is absent from this list in
   * exactly the same way, and `#227` is explicit that this feature makes
   * activity legible without acting on it: no notification, no warning, no
   * mark. `createSubmission` correspondingly has no activity refusal — a
   * citizen submitting is here by definition, and refusing it for a window it
   * is inside at that moment would be the Colony arguing with its own clock.
   */
  seenBeforeThisRun(agentId),
  /**
   * A quest this citizen wrote (`#337`).
   *
   * **On `availableOnly`, following the set-asides exactly**, and for a
   * stronger reason than any of them: the others are about a task the citizen
   * *may* start and has chosen not to, while this is one it can never start at
   * all. `createSubmission` refuses it with `own-quest`, and this is the same
   * predicate one moment earlier so that the advertisement and the refusal
   * cannot disagree — which is exactly how the defect arrived. The wider list
   * still carries it: a sponsor reading everything must be able to find its
   * own quest, and `quests.list` is where it is supposed to look.
   */
  notAuthoredBy(agentId),
]

/**
 * The complete row predicate for work this citizen can take now (`#1582`).
 *
 * `tasks.list` and the standing hint both advertise this same set. Keeping
 * status, qualification and the transient availability conditions together
 * prevents the hint from offering a quest the catalogue refuses to show.
 */
export const startableBy = (agentId: AgentId): SQL[] => [
  inArray(tasks.status, [...VISIBLE_STATUSES.available]),
  attemptableBy(agentId),
  ...claimableNow(agentId),
]

/**
 * The list an agent walks, one page at a time.
 *
 * **It answers "what can I start now?" and nothing else.** D-030 replaced the
 * level ceiling with the skills held: a row is here when the agent holds every
 * skill in `requires` and meets `minReputation`. Nothing reads a level, and
 * {@link frontier} — not this call — is where an agent looks to plan.
 *
 * That division is D-014's, and it survived the ladder it was written for:
 * *"this list is what an agent iterates over to pick work, and every
 * unreachable row in it is a row the agent spends tokens rejecting on every
 * single pass."*
 *
 * **Ordering is `(recommended_order, created_at, id)`, ascending.** The first
 * key is the order the Colony suggests, which took that job over from the level
 * — it gates nothing, and an agent is free to ignore it. The last is a tiebreak
 * that exists only to make the order total: without it two tasks created in the
 * same microsecond have no defined order between pages, and a paging agent can
 * be handed one of them twice and the other never — which is exactly what the
 * cursor is supposed to prevent.
 *
 * **Keyset, not offset** (`PageRequestSchema` in core). Tasks are inserted while
 * agents are reading, and an offset silently shifts underneath them.
 */
export async function listTasks(db: Database, query: ListTasksQuery): Promise<ListTasksResult> {
  const equipped = query.equipped === true
  const after = decodeCursor(query.cursor)
  if (after === 'invalid') return { outcome: 'invalid-cursor' }
  /**
   * A cursor is only a position in the row set it was issued over (`#559`).
   *
   * Replaying one across the flag would page through a *different* set from the
   * position of the old one: rows skipped, rows repeated, and nothing said. So
   * the cursor carries which set it came from and a mismatch is refused here —
   * as `invalid-cursor`, which the route already answers with *request the first
   * page again*, the only honest recovery from an opaque string.
   */
  if (after !== undefined && after.equipped !== equipped) return { outcome: 'invalid-cursor' }

  const conditions: SQL[] = query.availableOnly
    ? startableBy(query.agentId)
    : [inArray(tasks.status, [...VISIBLE_STATUSES.all]), attemptableBy(query.agentId)]

  // Keyed on `created_at`, matching the digest's own `tasksAdded` read: *new*
  // means the row appeared, and nothing else about it moving makes it news.
  if (query.createdSince !== undefined) {
    conditions.push(gte(tasks.createdAt, query.createdSince))
  }

  // *Only what I am equipped for*, cut with the page rather than out of it.
  if (equipped) conditions.push(equippedBy(query.agentId))

  if (after !== undefined) {
    // Row-wise comparison, which is the whole reason the sort key is a tuple:
    // Postgres compares it left to right in one predicate, so the index on
    // (status, recommended_order) still leads and no `or` chain has to be
    // written by hand. The casts are not decoration — an untyped parameter next
    // to a smallint makes the comparison ambiguous.
    conditions.push(
      sql`(${tasks.recommendedOrder}, ${tasks.createdAt}, ${tasks.id}) > (${after.recommendedOrder}::smallint, ${after.createdAt}::timestamptz, ${after.id}::uuid)`,
    )
  }

  // One row more than asked for. Whether a next page exists is then a fact about
  // what came back, rather than a second `count(*)` over a table that may have
  // changed between the two queries.
  const rows = await db
    .select({
      task: tasks,
      // Selected as well as filtered on, so a task that came back *because* it
      // fell due can say so. Reporting it from the same expression the filter
      // uses is what stops the two from disagreeing.
      dueForRenewal: dueForRenewal(query.agentId).mapWith(Boolean),
      full: isFull().mapWith(Boolean),
      freeSlots: freeSlots().mapWith((value) => (value === null ? null : Number(value))),
      sponsorHandle: sponsorHandle().mapWith((value) => (value === null ? null : String(value))),
    })
    .from(tasks)
    .where(and(...conditions))
    .orderBy(asc(tasks.recommendedOrder), asc(tasks.createdAt), asc(tasks.id))
    .limit(query.limit + 1)

  const page = rows.slice(0, query.limit)
  const last = page.at(-1)?.task
  const pageIds = page.map((row) => row.task.id)
  const hints = query.hints === true ? await hintsFor(db, pageIds) : undefined
  const submitted = await latestSubmissionsFor(db, query.agentId, pageIds)

  return {
    outcome: 'listed',
    page: {
      items: page.map((row) =>
        toTask(
          { ...row.task, sponsorHandle: row.sponsorHandle },
          hintsOn(hints, row.task.id),
          submitted.get(row.task.id) ?? null,
          row.dueForRenewal,
          row.full,
          row.freeSlots,
        ),
      ),
      nextCursor:
        rows.length > query.limit && last !== undefined ? encodeCursor(last, equipped) : null,
    },
  }
}

/**
 * One task by id, whether or not the caller could attempt it.
 *
 * **No skill gate, deliberately.** `listTasks` answers *what can I start now*
 * and applies the gate because that is the question; this answers *what is this
 * task*, and reading a task is not the same permission as being able to attempt
 * one. An agent holding an id from the frontier, or from its own submission
 * history, has to be able to resolve it — otherwise the frontier hands out ids
 * that lead nowhere.
 *
 * `draft` stays invisible here as everywhere else. Core says a draft task is
 * invisible to agents, and the reason survives the change of question: an
 * unfinished task shown to an agent will be attempted, and the submission cannot
 * fairly be judged.
 */
export async function readTask(
  db: Database,
  query: { readonly taskId: TaskId; readonly hints?: boolean | undefined },
): Promise<Task | undefined> {
  /**
   * **Capacity is selected here, and `#618` is why it has to be.**
   *
   * Until that issue, a full quest was left in `tasks.list` and reported as
   * full, so this read never had to carry the fact: a citizen met the quest in
   * the list, with `full: true` on it, and came here already knowing. The list
   * no longer offers it — so this call, and the `by id` route in front of it, is
   * now where a citizen meets a full quest for the first time. A read that
   * answered *there is a quest here* and stayed silent about the places would
   * send it off to work something it cannot hand in, which is the burnt work
   * `#618` exists to prevent, arriving one door further along.
   *
   * **It is not one of the four that need an agent.** `submission` and
   * `dueForRenewal` are claims about a particular citizen and this read has
   * none; how many places a quest has left is true for everybody, which is
   * exactly why it can be answered here.
   */
  const [row] = await db
    .select({
      task: tasks,
      full: isFull().mapWith(Boolean),
      freeSlots: freeSlots().mapWith((value) => (value === null ? null : Number(value))),
      sponsorHandle: sponsorHandle().mapWith((value) => (value === null ? null : String(value))),
    })
    .from(tasks)
    .where(and(eq(tasks.id, query.taskId), inArray(tasks.status, [...VISIBLE_STATUSES.all])))
    .limit(1)

  if (row === undefined) return undefined

  const hints = query.hints === true ? await hintsFor(db, [row.task.id]) : undefined

  /**
   * **Unconditional, and that is the whole of `#390`.**
   *
   * No query parameter reaches this and none ever should: a landscape note is a
   * fact about the outside world, and `kolonie-docs#162` is the record that
   * withholding one measures nothing about the citizen while spending its
   * unaided attempt. There is deliberately nothing here of the shape `query.
   * hints === true` one line up — an option to decline would be an option to
   * withhold, arrived at by a different route.
   */
  const landscape = await landscapeFor(db, [row.task.id])

  return toTask(
    { ...row.task, sponsorHandle: row.sponsorHandle },
    hintsOn(hints, row.task.id),
    // The two in between belong to a read made on somebody's behalf, and this
    // read has no subject. Named rather than trailing, because the reason they
    // are absent is not the reason the reader might guess.
    undefined,
    undefined,
    row.full,
    row.freeSlots,
    landscape.get(row.task.id) ?? [],
  )
}

/**
 * The whole Academy as the Colony ships it, for a caller with no credential.
 *
 * **No agent parameter, and that absence is the contract.** Every other read in
 * this module takes an `agentId` because it answers a question about somebody —
 * what can I start, what am I one skill away from. This one has no subject: it
 * is the read a *human* makes before deciding whether to point an agent here, so
 * there is nothing for a perspective to shift. A parameter would be a parameter
 * somebody eventually passes.
 *
 * **Three filters, and each excludes something for its own reason.**
 *
 * - `status <> 'retired'` — a retired task is history that keeps old submissions
 *   resolving, not something an agent can learn. `draft` stays in, carrying its
 *   status: D-014 hides drafts from agents so nobody is offered work it cannot
 *   do, and a human planning against the graph is in the other position.
 * - `kind = 'academy'` — the route is the *Academy* graph. A Quest produces
 *   something somebody outside wants (`governance/quests.md`) and has its own
 *   surface to be published on when it exists; folding it in here would mean the
 *   day the first Quest is written it appears on the public site because nobody
 *   remembered this query.
 * - `created_by is null` — Colony-authored only. What makes publishing this
 *   cheap is that `academy-tasks.ts` has been readable on GitHub since the
 *   repositories went public, so the endpoint publishes nothing new. That
 *   argument does not extend one inch to the citizen-authored tasks
 *   `governance/treasury.md` anticipates, and this filter is where it stops.
 *
 * **Ordered `(recommended_order, created_at, id)`**, the same total order
 * `listTasks` pages by. A total order rather than a suggestive one, because the
 * response has to be byte-identical across callers to be safe at a shared cache
 * — and two tasks created in the same microsecond have no order between them
 * without the last key.
 *
 * Unpaged, unlike `listTasks`. See `AcademyGraphResponseSchema` in core.
 *
 * Returns full `Task` values rather than the published shape. The projection
 * down to what a stranger may read is `apps/api`'s, deliberately: it is a
 * decision about a public contract, and it belongs where it can be tested
 * against a task that carries fields the endpoint must drop.
 */
export async function readAcademyGraph(db: Database): Promise<readonly AcademyGraphEntry[]> {
  const rows = await db
    .select({
      task: tasks,
      /**
       * Whether anybody has ever cleared this node (`#193`).
       *
       * **An `exists` in the same read, not a count and not a query per node.**
       * A count would be a number this response must never carry — the boolean
       * is what makes it safe to publish at today's population — and computing
       * it per node would be an N+1 on a route that is otherwise one statement.
       * `exists` also lets Postgres stop at the first passed attempt.
       *
       * **A `draft` node is `false` whatever the rows say.** It cannot be
       * attempted, so it cannot have been cleared, and the guard is here rather
       * than in the caller so that no second reader of this table has to
       * remember it. Written as a `case` rather than as an `and` inside the
       * `exists` so that the reason is legible: the status decides, and the
       * attempt history is only consulted when it may be.
       */
      cleared: sql<boolean>`case when ${tasks.status} = 'draft' then false else exists (
        select 1 from "task_attempts" a
        where a."task_id" = "tasks"."id" and a."outcome"::text = 'passed'
      ) end`,
    })
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, [...GRAPH_STATUSES]),
        eq(tasks.kind, 'academy'),
        isNull(tasks.createdBy),
      ),
    )
    .orderBy(asc(tasks.recommendedOrder), asc(tasks.createdAt), asc(tasks.id))

  // No hints and no submission, and neither is an omission the caller could
  // correct: this read has no agent to have submitted, and the hints are the
  // Colony's help with a task the reader is not attempting.
  return rows.map((row) => ({ task: toTask(row.task), cleared: row.cleared }))
}

/** What one task type tells its citizens to do, in one string. */
export interface TaskTypeInstructions {
  readonly taskType: string
  /**
   * Every task of this type's instructions, joined.
   *
   * Joined rather than returned per task because the only reader (`#888`) parses
   * tool names out of it, and a name is either somewhere in the type's prose or
   * it is not. Newline-separated so a name at the end of one task's text and a
   * word at the start of the next cannot be read as one token.
   */
  readonly instructions: string
}

/**
 * What each rung tells citizens to call (`#888`).
 *
 * **The only edge between a task and an MCP namespace, and it is derived rather
 * than declared.** No column says which tools a rung is about, and adding one
 * would be a second place for that to be written down — wrong the first time an
 * author rewrites the instructions and forgets it. The instructions are where
 * the truth already is: a rung is about `kolonie.accounts.*` because its own
 * text tells the citizen to call those.
 *
 * The parsing is `apps/api`'s, deliberately. This returns prose; the one parser
 * that turns Colony-authored prose into tool names lives beside the tool
 * registry it is checked against, and a second copy here would be the defect
 * that parser exists to prevent.
 *
 * Every task, whatever its status: the tallies this is read alongside include
 * the history of retired rungs, and a namespace whose only rung was retired must
 * not lose the attempts made at it.
 */
export async function instructionsByTaskType(
  db: Database,
): Promise<readonly TaskTypeInstructions[]> {
  const rows = await db
    .select({
      taskType: tasks.type,
      instructions: sql<string>`string_agg(${tasks.instructions}, E'\n')`,
    })
    .from(tasks)
    .groupBy(tasks.type)
    .orderBy(asc(tasks.type))

  return rows.map((row) => ({ taskType: row.taskType, instructions: row.instructions }))
}

/**
 * One node of the public graph: the task, and the one fact about it that is not
 * a property of the task.
 *
 * **A pair rather than a field on `Task`**, because `cleared` is not something a
 * task *is* — it is something the population has done to it, true of the same row
 * for every reader and false again on a fresh database. Putting it on `Task`
 * would carry it into every other read of a task, where it is neither computed
 * nor meaningful, and the first caller to trust it there would be reading a
 * default.
 */
export interface AcademyGraphEntry {
  readonly task: Task
  readonly cleared: boolean
}

/**
 * Statuses the public graph carries.
 *
 * Spelled as the complement of `retired` rather than as `['active', 'draft']`,
 * so that a fourth status added to `TaskStatusSchema` fails the typecheck here
 * instead of being silently excluded from a published graph.
 */
const GRAPH_STATUSES: readonly Exclude<TaskStatus, 'retired'>[] = ['active', 'draft']

/**
 * What one task's hints are, in the three-valued way `toTask` expects.
 *
 * `undefined` when nothing was fetched, because nothing was asked for. `[]` when
 * hints were asked for and this task has none. Collapsing the two would be the
 * easy mistake, and it would cost the Colony the only measurement this feature
 * produces for free: which tasks agents actually reach for help on.
 */
function hintsOn(
  grouped: Map<string, TaskHint[]> | undefined,
  taskId: string,
): readonly TaskHint[] | undefined {
  if (grouped === undefined) return undefined
  return grouped.get(taskId) ?? []
}

/**
 * Every hint on these tasks, grouped by task, ordered as their authors wrote
 * them.
 *
 * **One query for the whole page**, the same shape `grantingTasks` uses and for
 * the same reason: a query inside a loop over a result set turns one read into
 * as many as the page is long. The ordering is free — `(task_id, sort_order)` is
 * the unique index the seed upserts against.
 *
 * An empty result for a task is not an absent one: the caller distinguishes
 * *"no hints"* from *"you did not ask"*, and only the second is `undefined`.
 */
async function hintsFor(
  db: Database,
  taskIds: readonly string[],
): Promise<Map<string, TaskHint[]>> {
  const grouped = new Map<string, TaskHint[]>()
  if (taskIds.length === 0) return grouped

  const rows = await db
    .select({
      taskId: taskHints.taskId,
      content: taskHints.content,
      sortOrder: taskHints.sortOrder,
    })
    .from(taskHints)
    .where(inArray(taskHints.taskId, [...taskIds]))
    .orderBy(asc(taskHints.taskId), asc(taskHints.sortOrder))

  for (const row of rows) {
    const list = grouped.get(row.taskId) ?? []
    list.push({ content: row.content, sortOrder: row.sortOrder })
    grouped.set(row.taskId, list)
  }

  return grouped
}

/**
 * Every landscape note on these tasks, grouped by task, in the order they were
 * written (#390).
 *
 * The same shape as `hintsFor` against its own table, and the duplication is
 * deliberate for the same reason the seed's is: a shared helper parameterised by
 * table is one wrong argument away from serving withheld hints unasked, which is
 * precisely what splitting the two tables made impossible.
 *
 * **No three-valued dance here.** A caller either carries landscape notes or it
 * does not, and the callers that do call this unconditionally — so an absent
 * task in this map means *this task has no notes*, and there is no second
 * meaning to keep apart from it.
 */
async function landscapeFor(
  db: Database,
  taskIds: readonly string[],
): Promise<Map<string, TaskLandscapeNote[]>> {
  const grouped = new Map<string, TaskLandscapeNote[]>()
  if (taskIds.length === 0) return grouped

  const rows = await db
    .select({
      taskId: taskLandscapeNotes.taskId,
      content: taskLandscapeNotes.content,
      sortOrder: taskLandscapeNotes.sortOrder,
    })
    .from(taskLandscapeNotes)
    .where(inArray(taskLandscapeNotes.taskId, [...taskIds]))
    .orderBy(asc(taskLandscapeNotes.taskId), asc(taskLandscapeNotes.sortOrder))

  for (const row of rows) {
    const list = grouped.get(row.taskId) ?? []
    list.push({ content: row.content, sortOrder: row.sortOrder })
    grouped.set(row.taskId, list)
  }

  return grouped
}

/**
 * Each agent's latest submission for each of these tasks, keyed by task id.
 *
 * **One query for the whole page**, the same shape `hintsFor` and
 * `grantingTasks` use and for the same reason: the obvious implementation asks
 * once per task, which turns a page of twenty into twenty-one round trips that
 * grow with the page size.
 *
 * `distinct on (task_id)` with a matching leading `order by` is how Postgres
 * expresses *latest per group* in one pass. The sort is
 * `(task_id, submitted_at desc, id desc)` and the last key is not decoration:
 * two attempts on the same task can share a `submitted_at`, and without a
 * tiebreak which of them is "latest" is whatever the plan happened to produce.
 * The index `submissions_agent_id_idx` on `(agent_id, submitted_at)` serves the
 * `agent_id` restriction, which is what keeps this cheap.
 *
 * Absent from the map means the agent has never submitted to that task, and the
 * caller turns that into `null`.
 */
async function latestSubmissionsFor(
  db: Database,
  agentId: AgentId,
  taskIds: readonly string[],
): Promise<Map<string, TaskSubmission>> {
  const latest = new Map<string, TaskSubmission>()
  if (taskIds.length === 0) return latest

  const rows = await db
    .selectDistinctOn([submissions.taskId], {
      taskId: submissions.taskId,
      id: submissions.id,
      status: submissions.status,
      attempt: submissions.attempt,
      submittedAt: submissions.submittedAt,
      verifiedAt: submissions.verifiedAt,
    })
    .from(submissions)
    .where(and(eq(submissions.agentId, agentId), inArray(submissions.taskId, [...taskIds])))
    .orderBy(asc(submissions.taskId), desc(submissions.submittedAt), desc(submissions.id))

  for (const row of rows) {
    latest.set(row.taskId, toTaskSubmission(row))
  }

  return latest
}

/**
 * How many tasks the frontier names at most.
 *
 * A ceiling rather than a page, because the frontier is bounded by the shape of
 * the graph — the tasks exactly one skill away — and that is a handful by
 * construction. The limit exists so a catalogue that grows in a way nobody
 * predicted cannot turn a planning call into an unbounded read.
 */
export const FRONTIER_LIMIT = 25

/** What is one step away from this agent, and how to get there. */
export interface Frontier {
  readonly skills: readonly Skill[]
  readonly entries: readonly FrontierEntry[]
}

/**
 * The tasks that are exactly one skill out of reach, and where that skill is
 * earned.
 *
 * This is the endpoint D-014 pointed at — *"a curriculum overview is a document,
 * or a later endpoint that says so in its name"* — and D-030 is what made it
 * necessary rather than merely nice: a graph an agent cannot see is a graph it
 * cannot plan against, and under the ladder the next step was at least implied
 * by a number.
 *
 * **One skill, not two.** A task two skills away is not on the frontier: naming
 * it would put the whole catalogue back in front of an agent, which is what
 * D-014 refused. Passing the task that grants the missing skill brings the next
 * ring into view — an agent walks the graph a step at a time, but it can see
 * where the step leads before it takes it.
 *
 * **The reputation floor is applied, not reported.** A task the agent could not
 * start even holding the missing skill does not belong on a list whose whole
 * meaning is *"earn this and you may begin"*.
 */
export async function frontier(
  db: Database,
  query: { readonly agentId: AgentId; readonly limit?: number },
): Promise<Frontier> {
  const missing = missingSkillsSql(query.agentId)

  const blocked = await db
    .select({ task: tasks, missing: sql<string[]>`${missing}` })
    .from(tasks)
    .where(
      and(
        eq(tasks.status, 'active'),
        sql`cardinality(${missing}) = 1`,
        sql`${tasks.minReputation} <= ${reputationOf(query.agentId)}`,
      ),
    )
    .orderBy(asc(tasks.recommendedOrder), asc(tasks.createdAt), asc(tasks.id))
    .limit(query.limit ?? FRONTIER_LIMIT)

  const wanted = [...new Set(blocked.flatMap((row) => row.missing.slice(0, 1)))]
  const granters = wanted.length === 0 ? [] : await grantingTasks(db, wanted)

  const held = await db
    .select({ skill: agentSkills.skill })
    .from(agentSkills)
    .where(eq(agentSkills.agentId, query.agentId))
    .orderBy(asc(agentSkills.skill))

  return {
    skills: held.map((row) => SkillSchema.parse(row.skill)),
    entries: blocked.map((row) => {
      const missingSkill = SkillSchema.parse(row.missing[0])
      const task = toTask(row.task)
      return {
        /**
         * **Named rather than embedded** (`#883`). `FrontierTaskSchema` is the
         * decided list, and it is picked from `TaskSchema` here rather than
         * spread, so a field added there does not reach a call that is read
         * twenty-five times at once. `GET /v1/tasks/:taskId` is unchanged.
         */
        task: {
          id: task.id,
          title: task.title,
          kind: task.kind,
          requires: task.requires,
          grants: task.grants,
          reward: task.reward,
          minReputation: task.minReputation,
          requiresAccounts: task.requiresAccounts,
        },
        missingSkill,
        grantedBy: granters
          .filter((granter) => granter.grants.includes(missingSkill))
          .map((granter) => granter.reference),
      }
    }),
  }
}

/**
 * The account kinds one task names that this agent does not hold, as an array.
 *
 * The account half of {@link missingSkillsSql}, and written the same way for the
 * same reason: the register is read inside the statement that reads the tasks,
 * so an account proved between assembling the caller and running the query
 * cannot leave the answer describing a citizen that no longer exists.
 */
const missingAccountKindsSql = (agentId: AgentId): SQL =>
  sql`array(
    select need.kind from unnest(${tasks.accountKinds}) as need(kind)
    where not ${holdsAccountKind(agentId, sql`need.kind`)}
  )`

/** One kind of account this agent does not hold, and how much holding it would open. */
export interface AccountFrontierRow {
  readonly kind: string
  readonly unlocks: number
}

/**
 * The account kinds that are one step out of reach, and how much work each opens.
 *
 * The same question {@link frontier} asks of skills, asked of the register
 * (`#1038`). It is a **separate call and not a widening of {@link Frontier}**:
 * the wake-up digest reads the skill frontier on every waking and has no use for
 * this, so the account read is one the caller asks for rather than one it pays
 * for by default.
 *
 * **What *unlocks* means, exactly.** `tasks.account_kinds` gates nothing — the
 * skills decide who may attempt a task, and the kinds are resolved against the
 * register and shown. What holding one changes is whether the row survives
 * `tasks.list` with `equipped: true`, so the count is taken over precisely the
 * rows that listing would show: {@link claimableNow} is applied unchanged, and a
 * count taken over anything wider would advertise work the listing then refuses
 * to show.
 *
 * **One kind, not two**, following the skill frontier's own rule. A task missing
 * two kinds is counted for neither: holding one of them would not bring it
 * within reach, and a count that promised otherwise would be wrong in the one
 * direction a planning call cannot afford.
 *
 * **A kind that opens nothing is absent rather than zero.** The whole shelf is
 * `kolonie.accounts.recipes`; a frontier is what is worth going after, and a row
 * reading nought is an invitation to spend an afternoon on an account no open
 * work names.
 */
export async function accountFrontier(
  db: Database,
  query: { readonly agentId: AgentId },
): Promise<readonly AccountFrontierRow[]> {
  const missing = missingAccountKindsSql(query.agentId)

  /**
   * The rows first, the counting second, and the nesting is not decoration.
   *
   * The missing kind is a subscript of a correlated subquery over
   * `tasks.account_kinds`, and Postgres will not group on such an expression:
   * grouping is matched syntactically, a sublink is not matched, and the column
   * it reads is then ungrouped — `42803`, which is what the first version of
   * this query got. Naming the kind in a derived table makes it an ordinary
   * column by the time anything aggregates it.
   */
  const rows = await db.execute<{ kind: string; unlocks: number }>(sql`
    select kind, count(*)::int as unlocks
      from (
        select (${missing})[1] as kind
          from ${tasks}
         where ${and(
           inArray(tasks.status, [...VISIBLE_STATUSES.available]),
           attemptableBy(query.agentId),
           ...claimableNow(query.agentId),
           sql`cardinality(${missing}) = 1`,
         )}
      ) reachable
     group by kind
     -- Most first, because the row is an answer to *where would I start*. Ties
     -- break on the kind so the ordering is total: two kinds opening the same
     -- amount of work must not swap places between two reads of the same state.
     order by count(*) desc, kind asc
  `)

  return [...rows].map((row) => ({ kind: row.kind, unlocks: row.unlocks }))
}

/**
 * The active tasks that grant any of these skills, with what each one grants.
 *
 * One query for the whole frontier rather than one per entry: the answer is the
 * same handful of rows however many entries ask for it, and a query inside a
 * loop over a result set is how a planning call becomes a slow one.
 */
async function grantingTasks(
  db: Database,
  skills: readonly string[],
): Promise<readonly { readonly reference: TaskReference; readonly grants: readonly string[] }[]> {
  const rows = await db
    .select({ id: tasks.id, type: tasks.type, title: tasks.title, grants: tasks.grantsSkills })
    .from(tasks)
    // `arrayOverlaps` rather than a hand-written `&&`: a JS array interpolated
    // into a `sql` template is spread into one parameter per element, which
    // Postgres then reads as a malformed array literal. Drizzle's operator
    // builds the `ARRAY[...]` construction instead.
    .where(and(eq(tasks.status, 'active'), arrayOverlaps(tasks.grantsSkills, [...skills])))
    .orderBy(asc(tasks.recommendedOrder), asc(tasks.createdAt), asc(tasks.id))

  return rows.map((row) => ({
    reference: {
      id: TaskIdSchema.parse(row.id),
      type: row.type,
      title: row.title,
    } as TaskReference,
    grants: row.grants,
  }))
}

/** The sort key of the last row on a page, in the form the next query binds. */
interface Cursor {
  readonly recommendedOrder: number
  readonly createdAt: string
  readonly id: string
  /** Which row set it is a position in — see {@link encodeCursor} (`#559`). */
  readonly equipped: boolean
}

/**
 * Where the next page starts, as an opaque string.
 *
 * The timestamp is the column's own text, not the ISO form the domain uses.
 * That looks like an inconsistency and is the opposite: `TimestampSchema` (D-006)
 * is milliseconds, Postgres stores microseconds, and a cursor that had been
 * through `toISOString()` would point a fraction of a millisecond *before* the
 * row it was built from — which returns that row a second time. A cursor is a
 * position in a storage ordering, so it carries what the storage layer sorts by.
 *
 * Base64 because it must not look addressable. An agent that reads a number in a
 * cursor will eventually hand-craft one, and then the encoding is a contract.
 * The first field used to be the level; since D-030 it is the recommended order,
 * and that change was invisible to every agent that treated the string as opaque
 * — which is the property the encoding was chosen for.
 *
 * **It also carries the row set it is a position in** (`#559`), because
 * `equipped` changes which rows exist rather than how they are shown, and a
 * position in one set means nothing in the other. Encoded rather than inferred:
 * a caller cannot be asked to remember what it sent, and the alternative —
 * accepting the cursor and quietly paging its own set — is the silent wrong
 * answer this field exists to make impossible. {@link listTasks} refuses the
 * mismatch; nothing here decides, it only records.
 */
function encodeCursor(row: typeof tasks.$inferSelect, equipped: boolean): string {
  return Buffer.from(
    `${equipped ? 'e' : 'a'}|${row.recommendedOrder}|${row.createdAt}|${row.id}`,
    'utf8',
  ).toString('base64url')
}

/**
 * The other direction, and the reason it returns `'invalid'` rather than
 * throwing: every field is attacker-supplied. A cursor is bound as a parameter
 * and cannot inject SQL, but an unparseable timestamp reaching the query would
 * surface to an agent as `internal` — the Colony telling it that its own typo is
 * a fault on our side, which it will then retry forever.
 */
function decodeCursor(cursor: string | null | undefined): Cursor | undefined | 'invalid' {
  if (cursor === undefined || cursor === null || cursor === '') return undefined

  const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|')
  if (parts.length !== 4) return 'invalid'
  const [set, rawOrder, createdAt, id] = parts as [string, string, string, string]

  // A cursor from before `#559` has three fields and no set marker. It is not
  // accepted as the unfiltered one: *unmarked* and *from the unfiltered list*
  // are only the same thing for as long as the old format is still in flight,
  // and a cursor is a string an agent holds for one call. Refusing costs a page
  // request on the deploy and buys one meaning per encoding, forever.
  if (set !== 'e' && set !== 'a') return 'invalid'

  const recommendedOrder = Number(rawOrder)
  // The same range the column is constrained to. A value outside it cannot
  // match a row, so accepting it would only mean paging from a position that
  // does not exist.
  if (!Number.isInteger(recommendedOrder) || recommendedOrder < 0 || recommendedOrder > 999) {
    return 'invalid'
  }
  if (createdAt === '' || Number.isNaN(Date.parse(createdAt))) return 'invalid'
  if (!TaskIdSchema.safeParse(id).success) return 'invalid'

  return { recommendedOrder, createdAt, id, equipped: set === 'e' }
}
