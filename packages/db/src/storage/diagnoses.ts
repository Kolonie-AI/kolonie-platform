import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm'
import {
  DIAGNOSIS_RETENTION_DAYS,
  DOCTOR_TELLING_COOLING_HOURS,
  DOCTOR_TELLING_GRACE_MINUTES,
  DiagnosisSchema,
  EvidenceSchema,
  type AgentId,
  type Diagnosis,
  type DiagnosisState,
  type Finding,
} from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { diagnoses } from '../schema/diagnoses.js'
import { toTimestamp } from './rows.js'

/**
 * What recording a finding did (`#838`).
 *
 * Four outcomes rather than a boolean, because each is a different sentence in a
 * runner's log and the difference is the thing a pass is reporting: *this is
 * new*, *this is the fourteenth time*, *this got worse*, *this could not be
 * stored*.
 */
export type DiagnosisOutcome =
  /** No open diagnosis matched, so one was opened. */
  | 'opened'
  /** One matched and its evidence, stamp and count were updated. */
  | 'observed'
  /** One matched and its severity moved — worth a separate word, because `#842` re-announces on it. */
  | 'escalated'
  /** The write was refused. The finding was not storable, and the reason is in the message. */
  | 'refused'

/** What `record` did, and the row it did it to where there is one. */
export interface RecordedDiagnosis {
  readonly outcome: DiagnosisOutcome
  readonly diagnosis: Diagnosis | null
  /** Why a refusal was refused. `null` on every other outcome. */
  readonly refusal: string | null
}

/**
 * Store a finding, or update the open diagnosis it matches (`#838`).
 *
 * **The dedupe happens in Postgres, on a partial unique index over
 * `(scope, subject, kind, policy_version)` where the state is open.** A read
 * followed by a decision would be two round trips and a race between them, and
 * the race matters here: a runner pass and a re-evaluation can be looking at the
 * same subject, and two open rows for one problem is the state this table exists
 * to prevent.
 *
 * **It refuses rather than swallowing, and that is the opposite of
 * `recordCall`.** The rollup sits on a citizen's request path, where a failed
 * write must never become a failed request. This sits in a runner, where a
 * finding that silently failed to store is a finding nobody will ever act on and
 * a pass that reports success it did not have. Different position, different
 * rule — and the refusals are values rather than throws so that one bad finding
 * does not cost a pass the rest of its citizens.
 *
 * **Two refusals are checked here rather than left to the database**, because a
 * constraint violation arrives as a message nobody can branch on:
 *
 * - **Evidence that is not the rules' own numbers-only structure.** Parsed
 *   through core's `EvidenceSchema` before it is written, so free text, an
 *   address or a request path cannot reach the column through any path. This is
 *   load-bearing rather than tidy: `#840` builds a model prompt from a finding,
 *   and stored evidence that could carry text would be a prompt with an author
 *   other than the Colony.
 * - **A missing policy version.** An unattributable diagnosis is not storable
 *   because it is not auditable.
 *
 * **A severity change updates the open row rather than opening a second**, and
 * says so in the outcome. `#842` re-announces on an increase and stays quiet on
 * a decrease, and that decision needs to be made by something that can see both
 * the old value and the new one — which is only ever this function, because
 * `returning()` hands back the row as it is after the update and the previous
 * value exists nowhere else.
 */
export async function recordDiagnosis(
  db: Database | Transaction,
  finding: Finding,
  policyVersion: string,
  now: Date,
): Promise<RecordedDiagnosis> {
  const refuse = (refusal: string): RecordedDiagnosis => ({
    outcome: 'refused',
    diagnosis: null,
    refusal,
  })

  if (policyVersion.trim() === '')
    return refuse('a diagnosis without a policy version is not auditable')

  const evidence = EvidenceSchema.safeParse(finding.evidence)
  if (!evidence.success) return refuse('evidence must be the rules’ own numbers and route keys')
  // `safeParse` accepts a number-valued record; a value that is not finite would
  // survive it and mean nothing in a figure, so it is refused by name.
  for (const [figure, value] of Object.entries(evidence.data.figures)) {
    if (!Number.isFinite(value)) return refuse(`the figure ${figure} is not a number`)
  }

  const stamp = now.toISOString()
  const agentId = finding.scope === 'agent' ? (finding.subject as AgentId) : null

  try {
    /**
     * What the open row said before this pass, read for the outcome and for
     * nothing else.
     *
     * **This is not the read-then-decide the paragraph above refuses.** The
     * decision — insert or update — is still Postgres's, taken atomically on the
     * partial unique index; a stale answer here costs a wrong *word* in a log
     * line and never a second row. The read is here because `returning()` hands
     * back the row as it is *after* the update, so the only place the previous
     * severity exists is before the statement runs.
     */
    const before = await openDiagnosisFor(
      db,
      finding.scope,
      finding.subject,
      finding.kind,
      policyVersion,
    )

    const [written] = await db
      .insert(diagnoses)
      .values({
        scope: finding.scope,
        agentId,
        subject: finding.subject,
        kind: finding.kind,
        severity: finding.severity,
        confidence: finding.confidence,
        evidence: evidence.data,
        policyVersion,
        state: 'open',
        firstSeenAt: stamp,
        lastSeenAt: stamp,
        observations: 1,
      })
      .onConflictDoUpdate({
        target: [diagnoses.scope, diagnoses.subject, diagnoses.kind, diagnoses.policyVersion],
        targetWhere: sql`${diagnoses.state} = 'open'`,
        set: {
          severity: finding.severity,
          confidence: finding.confidence,
          // Replaced rather than merged: the evidence is what is true *now*, and
          // a union of two windows would describe a window that never happened.
          evidence: evidence.data,
          lastSeenAt: stamp,
          observations: sql`${diagnoses.observations} + 1`,
        },
      })
      .returning()

    if (written === undefined) return refuse('the diagnosis could not be written')

    return {
      outcome:
        written.observations === 1
          ? 'opened'
          : before !== null && before.severity !== written.severity
            ? 'escalated'
            : 'observed',
      diagnosis: rowToDiagnosis(written),
      refusal: null,
    }
  } catch (thrown) {
    // The schema's own checks land here — a colony-scoped finding carrying a
    // citizen, a blank policy version that got past the guard above. A message
    // rather than a throw, on this function's stated rule: one bad finding must
    // not cost a pass the rest of its citizens.
    return refuse(thrown instanceof Error ? thrown.message : 'the diagnosis was refused')
  }
}

/**
 * The severity a matching open diagnosis carried before this pass, if any.
 *
 * **Read before `recordDiagnosis`, by a caller that needs to know what changed.**
 * `recordDiagnosis` reports *that* a severity moved; this says what it moved
 * from, which is what `#842` needs to decide whether an increase is worth
 * re-announcing.
 */
export async function openDiagnosisFor(
  db: Database | Transaction,
  scope: Finding['scope'],
  subject: string,
  kind: Finding['kind'],
  policyVersion: string,
): Promise<Diagnosis | null> {
  const [row] = await db
    .select()
    .from(diagnoses)
    .where(
      and(
        eq(diagnoses.scope, scope),
        eq(diagnoses.subject, subject),
        eq(diagnoses.kind, kind),
        eq(diagnoses.policyVersion, policyVersion),
        eq(diagnoses.state, 'open'),
      ),
    )
    .limit(1)

  return row === undefined ? null : rowToDiagnosis(row)
}

/**
 * Every open diagnosis about one subject, most serious first (`#838`).
 *
 * **Only ever one subject.** There is no read here that answers *which citizens
 * have open diagnoses of this kind* — the console's list (`#841`) reads by state
 * rather than by subject, and nothing gives a citizen a subject other than its
 * own.
 */
export async function openDiagnosesFor(
  db: Database | Transaction,
  subject: string,
): Promise<readonly Diagnosis[]> {
  const rows = await db
    .select()
    .from(diagnoses)
    .where(and(eq(diagnoses.subject, subject), eq(diagnoses.state, 'open')))
    .orderBy(
      // `serious` before `concern` before `notice`, spelled out rather than left
      // to the enum's storage order: a reader of this query should not have to
      // open `enums.ts` to know what "most serious first" resolved to.
      sql`case ${diagnoses.severity} when 'serious' then 0 when 'concern' then 1 else 2 end`,
      desc(diagnoses.confidence),
      desc(diagnoses.lastSeenAt),
    )

  return rows.map(rowToDiagnosis)
}

/**
 * Close every open diagnosis about a subject that this pass did not find again
 * (`#838`).
 *
 * **A finding that stops being true stops being open on its own**, with the pass
 * that noticed recorded in `resolved_at`. Nobody closes a diagnosis, and there
 * is no surface that could — `#841` is read-only for exactly this reason.
 *
 * **The caller passes what it *did* find, and this closes the rest.** The
 * alternative — a caller closing what it decided had gone — puts the same
 * comparison in every caller, and a caller that computed it differently would
 * silently resolve findings that are still true.
 *
 * Returns how many closed, so a pass can log a number.
 */
export async function resolveDisappeared(
  db: Database | Transaction,
  subject: string,
  stillFound: readonly Finding['kind'][],
  now: Date,
): Promise<number> {
  const closed = await db
    .update(diagnoses)
    .set({ state: 'resolved', resolvedAt: now.toISOString() })
    .where(
      and(
        eq(diagnoses.subject, subject),
        eq(diagnoses.state, 'open'),
        stillFound.length === 0 ? sql`true` : sql`${diagnoses.kind} not in ${stillFound}`,
      ),
    )
    .returning({ id: diagnoses.id })

  return closed.length
}

/**
 * Mark every open diagnosis made under an older rule set as superseded (`#838`).
 *
 * **A rule change is a different judgement, not a correction of the old one.**
 * The old row keeps its evidence, its window and the version that produced it,
 * and the new arithmetic opens its own — so a reader months later can see that
 * the verdict changed *because the rules did*, which is a fact that vanishes if
 * the row is mutated in place.
 */
export async function supersedeOlderPolicies(
  db: Database | Transaction,
  currentPolicyVersion: string,
  now: Date,
): Promise<number> {
  const marked = await db
    .update(diagnoses)
    .set({ state: 'superseded', resolvedAt: now.toISOString() })
    .where(
      and(eq(diagnoses.state, 'open'), sql`${diagnoses.policyVersion} <> ${currentPolicyVersion}`),
    )
    .returning({ id: diagnoses.id })

  return marked.length
}

/**
 * Attach the ticket a diagnosis caused (`#838`).
 *
 * Separate from `recordDiagnosis` because the ticket is opened *after* the
 * diagnosis exists and by something that knows about tickets — which this module
 * deliberately does not.
 */
export async function recordConsequence(
  db: Database | Transaction,
  diagnosisId: string,
  supportTicketId: string,
): Promise<void> {
  await db.update(diagnoses).set({ supportTicketId }).where(eq(diagnoses.id, diagnosisId))
}

/** One colony-scoped diagnosis, as the escalation reads it (`#869`). */
export interface EscalatableDiagnosis {
  readonly id: string
  readonly kind: string
  readonly severity: string
  readonly subject: string
  readonly policyVersion: string
  readonly firstSeenAt: string
  readonly lastSeenAt: string
  readonly observations: number
  /** What a model wrote about it, or null. Never parsed — see {@link attachProse}. */
  readonly prose: string | null
}

/**
 * Open colony-scoped diagnoses that have never been escalated (`#869`).
 *
 * ## Three conditions, and each is one of the issue's three decisions
 *
 * **`scope = 'colony'`** — `kolonie-docs#324` point 3: an agent-scoped diagnosis
 * is never escalated to anything, because an inefficient loop is not an
 * incident. The check constraint refuses one on the row as well, so this
 * condition is the read agreeing with the table rather than the only defence.
 *
 * **`state = 'open'`** — a diagnosis whose evidence stopped matching resolved
 * itself, and filing an issue about it would be filing a condition that has
 * ended.
 *
 * **`escalated_issue_url is null`** — one escalation per diagnosis, ever. The
 * fact is on the row rather than in a process, so a restart cannot reset it and
 * two passes cannot race into two issues.
 *
 * **`limit` is the cap, applied in SQL.** `#839` asked for a hard cap per pass
 * with one summary over it, so that a rule regression cannot open two hundred
 * issues before anybody notices. Reading `limit + 1` is how the caller learns
 * there was more without reading it all — see the runner.
 *
 * Oldest first: a finding that has stood longest is the one that has waited.
 */
export async function escalatableDiagnoses(
  db: Database,
  limit: number,
): Promise<readonly EscalatableDiagnosis[]> {
  return db
    .select({
      id: diagnoses.id,
      kind: diagnoses.kind,
      severity: diagnoses.severity,
      subject: diagnoses.subject,
      policyVersion: diagnoses.policyVersion,
      firstSeenAt: diagnoses.firstSeenAt,
      lastSeenAt: diagnoses.lastSeenAt,
      observations: diagnoses.observations,
      prose: diagnoses.prose,
    })
    .from(diagnoses)
    .where(
      and(
        eq(diagnoses.scope, 'colony'),
        eq(diagnoses.state, 'open'),
        isNull(diagnoses.escalatedIssueUrl),
      ),
    )
    .orderBy(asc(diagnoses.firstSeenAt), asc(diagnoses.id))
    .limit(limit)
}

/**
 * Record the issue a diagnosis was escalated as (`#869`).
 *
 * **Conditional on the column still being null**, so that two passes racing
 * produce one escalation rather than two — the second write finds nothing to
 * update and the caller learns it lost. `recordConsequence` above does not need
 * this because a ticket was only ever written once by construction; an
 * escalation is written by a loop that runs every half hour.
 *
 * Returns whether this call is the one that recorded it.
 */
export async function recordEscalation(
  db: Database,
  diagnosisId: string,
  issueUrl: string,
): Promise<boolean> {
  const rows = await db
    .update(diagnoses)
    .set({ escalatedIssueUrl: issueUrl })
    .where(and(eq(diagnoses.id, diagnosisId), isNull(diagnoses.escalatedIssueUrl)))
    .returning({ id: diagnoses.id })

  return rows.length > 0
}

/**
 * Attach a model's sentence to a diagnosis (`#840`'s seam, defined here because
 * the column is).
 *
 * **Stored verbatim and parsed back into nothing.** Nothing in this function
 * reads the text, and no other function writes a structured field from it — the
 * whole of the *the model only writes* rule is that this is the only column a
 * model can reach.
 */
export async function attachProse(
  db: Database | Transaction,
  diagnosisId: string,
  prose: string,
  proseModel: string,
): Promise<void> {
  await db.update(diagnoses).set({ prose, proseModel }).where(eq(diagnoses.id, diagnosisId))
}

/**
 * Delete resolved agent-scoped diagnoses older than the retention window
 * (`#838`).
 *
 * **Agent-scoped only, and colony-scoped rows are kept.** A resolved finding
 * about a citizen is a record of a mistake it has already fixed, and keeping
 * those forever is the thing ninety days is set against. A colony-scoped row
 * names nobody, and *this route did this before* is exactly what an operator
 * wants when a signature returns.
 *
 * The clock is an argument, for the reason `sweepCallHours` gives: a retention
 * boundary that cannot be tested without waiting for one is not tested.
 */
export async function sweepDiagnoses(
  db: Database | Transaction,
  now: Date,
  retentionDays: number = DIAGNOSIS_RETENTION_DAYS,
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString()

  const deleted = await db
    .delete(diagnoses)
    .where(
      and(
        eq(diagnoses.scope, 'agent'),
        inArray(diagnoses.state, ['resolved', 'superseded'] as DiagnosisState[]),
        lt(diagnoses.resolvedAt, cutoff),
      ),
    )
    .returning({ id: diagnoses.id })

  return deleted.length
}

/**
 * A row as core publishes it.
 *
 * Parsed rather than cast, for the reason every read in this package is: a column
 * that drifts from the shape core publishes fails here rather than in somebody's
 * client.
 */
function rowToDiagnosis(row: typeof diagnoses.$inferSelect): Diagnosis {
  // `agent_id` is the cascade's column and `subject` is the dedupe key's. The
  // published shape carries only the second, so a reader cannot come to think
  // there are two identities here — and the schema is `.strict()`, so dropping
  // the key is the difference between a parse and a refusal.
  const { agentId: _cascadeColumn, ...published } = row

  return DiagnosisSchema.parse({
    ...published,
    firstSeenAt: toTimestamp(row.firstSeenAt),
    lastSeenAt: toTimestamp(row.lastSeenAt),
    resolvedAt: row.resolvedAt === null ? null : toTimestamp(row.resolvedAt),
    announcedAt: row.announcedAt === null ? null : toTimestamp(row.announcedAt),
  })
}

/**
 * The one finding worth telling this citizen about on this waking, or `null`
 * (`#842`).
 *
 * **At most one, ever.** The `open` list holds five things and a Doctor that
 * took three of them would have made the Colony worse — so the most serious open
 * finding is the answer and the rest wait. That is a rule about the channel
 * rather than about the findings: a citizen with three problems has one it should
 * look at first, and telling it about all three is telling it about none.
 *
 * **Agent-scoped only.** A colony-scoped diagnosis is about a route and reaches
 * the people who run the Colony; announcing one to a citizen would be telling
 * somebody about a defect that is not theirs and that they cannot act on.
 *
 * ## When a finding is tellable
 *
 * Four cases, and the third is the one that keeps `kolonie.wakeup` honest:
 *
 * 1. **Never announced.** It opens and the citizen hears about it.
 * 2. **Announced, and it has since got worse.** A severity that rose is new
 *    information. One that fell is not — the citizen was already told, and
 *    telling it again to say *slightly better* would spend an entry on nothing.
 * 3. **Announced within the grace window.** The same telling, re-read. This is
 *    what makes a second `wakeup` in one waking return the same list rather than
 *    a shorter one, which that call promises and which an entry that vanished
 *    would quietly break.
 * 4. **Announced, unchanged, and the cooling period has passed.** A citizen that
 *    was told and did not change is told again eventually — but not hourly,
 *    because nagging is how a channel gets ignored.
 *
 * **One indexed read.** This rides on `kolonie.wakeup`, which every citizen calls
 * on every waking, so it is a single scan of `(subject, state)` and never a rule
 * evaluation — the rules ran when the runner passed, and re-running them here
 * would put the whole Doctor on the hottest read in the Colony.
 */
export async function doctorTellingFor(
  db: Database | Transaction,
  agentId: AgentId,
  now: Date,
): Promise<Diagnosis | null> {
  const coolingBefore = new Date(
    now.getTime() - DOCTOR_TELLING_COOLING_HOURS * 60 * 60 * 1000,
  ).toISOString()
  const graceAfter = new Date(
    now.getTime() - DOCTOR_TELLING_GRACE_MINUTES * 60 * 1000,
  ).toISOString()

  const [row] = await db
    .select()
    .from(diagnoses)
    .where(
      and(
        eq(diagnoses.subject, agentId),
        eq(diagnoses.scope, 'agent'),
        eq(diagnoses.state, 'open'),
        sql`(
          ${diagnoses.announcedAt} is null
          or ${diagnoses.announcedAt} >= ${graceAfter}
          or ${diagnoses.announcedAt} < ${coolingBefore}
          or ${severityRank(diagnoses.severity)} < ${severityRank(diagnoses.announcedSeverity)}
        )`,
      ),
    )
    .orderBy(
      severityRank(diagnoses.severity),
      desc(diagnoses.confidence),
      desc(diagnoses.lastSeenAt),
    )
    .limit(1)

  return row === undefined ? null : rowToDiagnosis(row)
}

/**
 * Record that the citizen was told (`#842`).
 *
 * **Idempotent inside one waking, which is the point.** A second call with the
 * same severity inside the grace window leaves the row exactly as it was, so
 * reading `wakeup` twice is one telling and not two. Outside the window, or at a
 * different severity, the stamp moves and the cooling period starts again.
 *
 * **A write on a read path, and it is the one this channel needs.** `wakeup` is
 * documented as consuming nothing and being safe to call twice, and both stay
 * true — nothing here is spent, and the grace window is what makes the repeat
 * identical. What it buys is the property `#842` is built on: the telling is
 * recorded on the diagnosis, so a restarted process cannot forget it and a
 * citizen that was told is not told again by something with no memory.
 */
export async function recordTelling(
  db: Database | Transaction,
  diagnosisId: string,
  severity: Diagnosis['severity'],
  now: Date,
): Promise<void> {
  await db
    .update(diagnoses)
    .set({ announcedAt: now.toISOString(), announcedSeverity: severity })
    .where(
      and(
        eq(diagnoses.id, diagnosisId),
        // Only when this is a new telling. A repeat inside the grace window is
        // the same one, and moving the stamp would let a citizen that calls
        // `wakeup` every ten minutes hold the cooling period open forever.
        sql`(${diagnoses.announcedAt} is null
             or ${diagnoses.announcedSeverity} is distinct from ${severity})`,
      ),
    )
}

/**
 * `serious` before `concern` before `notice`, as a number a query can compare.
 *
 * Spelled out rather than left to the enum's storage order, for the reason
 * `openDiagnosesFor` gives: a reader of the query should not have to open
 * `enums.ts` to know what *most serious* resolved to. `null` sorts last, which is
 * what makes an unannounced severity compare as *less serious than anything* in
 * the tellable condition above.
 */
function severityRank(column: unknown): SQL<number> {
  return sql<number>`case ${column} when 'serious' then 0 when 'concern' then 1 when 'notice' then 2 else 3 end`
}

/**
 * What a model wrote about this citizen's open findings, by kind (`#840`).
 *
 * **Keyed by kind because that is what the dedupe key means.** A diagnosis is
 * unique per `(scope, subject, kind, policy_version)` while it is open, so a
 * finding computed live and a diagnosis stored earlier are the same finding when
 * their kinds match — and the live surface has no stored id in hand to match on
 * instead.
 *
 * **Only rows that have one.** A citizen whose findings all predate the runner
 * gets an empty map, which the surface renders as `prose: null` on every finding
 * — complete, and indistinguishable from a Colony that wired no gateway. That is
 * the intended shape rather than a degradation.
 */
export async function proseForOpenDiagnoses(
  db: Database | Transaction,
  agentId: AgentId,
): Promise<Readonly<Record<string, string>>> {
  const rows = await db
    .select({ kind: diagnoses.kind, prose: diagnoses.prose })
    .from(diagnoses)
    .where(
      and(
        eq(diagnoses.subject, agentId),
        eq(diagnoses.scope, 'agent'),
        eq(diagnoses.state, 'open'),
        isNotNull(diagnoses.prose),
      ),
    )

  return Object.fromEntries(rows.map((row) => [row.kind, row.prose ?? '']))
}

/**
 * How many diagnoses one page of the console lists (`#841`).
 *
 * **Paginated rather than complete**, because a Colony with many citizens has
 * many findings and a page that grew with the Colony would be a page nobody
 * opens twice. Fifty is more than a person reads in one sitting and few enough
 * that the query stays a range scan over an index rather than a sort of the
 * table.
 */
export const DIAGNOSES_PAGE = 50

/** What the console asks for. Every field narrows; none of them widens. */
export interface DiagnosisQuery {
  /** `agent` or `colony`. Absent means both, which is deliberately not the default view. */
  readonly scope?: Finding['scope']
  /** Which states to show. Absent means `open` alone — *what is wrong now*. */
  readonly states?: readonly DiagnosisState[]
  readonly limit?: number
  /** How many to skip. A page number the caller has already multiplied out. */
  readonly offset?: number
}

/** One page of diagnoses, and whether there is another. */
export interface DiagnosisPage {
  readonly rows: readonly Diagnosis[]
  /** `true` when a further page exists — read by asking for one more than the page. */
  readonly more: boolean
}

/**
 * Diagnoses for the console, most serious first (`#841`).
 *
 * **The default is open diagnoses**, because the question a person opens this to
 * answer is *what is wrong now*. Resolved and superseded ones are reachable by
 * asking, and are never deleted from view — the history is the point, and
 * `kolonie-platform#814` is the complaint about verdicts nobody can read back.
 *
 * **Most serious first, then most recently seen.** The same order
 * `openDiagnosesFor` uses and spelled out the same way, so a reader of either
 * query does not have to open `enums.ts` to know what it resolved to.
 *
 * **One more row than the page is fetched**, which is how *is there another page*
 * is answered without a second count over a table that is growing. The extra row
 * is dropped before it is returned.
 */
export async function listDiagnoses(
  db: Database | Transaction,
  query: DiagnosisQuery = {},
): Promise<DiagnosisPage> {
  const limit = query.limit ?? DIAGNOSES_PAGE
  const states = query.states ?? (['open'] as const)

  const rows = await db
    .select()
    .from(diagnoses)
    .where(
      and(
        inArray(diagnoses.state, [...states]),
        ...(query.scope === undefined ? [] : [eq(diagnoses.scope, query.scope)]),
      ),
    )
    .orderBy(severityRank(diagnoses.severity), desc(diagnoses.lastSeenAt))
    .limit(limit + 1)
    .offset(query.offset ?? 0)

  return {
    rows: rows.slice(0, limit).map(rowToDiagnosis),
    more: rows.length > limit,
  }
}

/**
 * One diagnosis, read to the end (`#841`).
 *
 * `null` for an id that names nothing, which the route turns into a 404 — the
 * same refusal it makes for a reader who is not a maintainer, so this surface
 * tells a stranger nothing about which ids are real.
 */
export async function diagnosisById(
  db: Database | Transaction,
  id: string,
): Promise<Diagnosis | null> {
  const [row] = await db.select().from(diagnoses).where(eq(diagnoses.id, id)).limit(1)

  return row === undefined ? null : rowToDiagnosis(row)
}

/**
 * How many diagnoses stand in each state, for the one line that says whether
 * this page is worth opening (`#841`).
 *
 * **Counted rather than derived from a page.** A page shows fifty; *there are
 * two hundred and eleven open* is a different fact and the one that says whether
 * something has gone wrong at scale.
 */
export async function diagnosisCounts(
  db: Database | Transaction,
): Promise<Readonly<Record<string, number>>> {
  const rows = await db
    .select({ scope: diagnoses.scope, state: diagnoses.state, total: sql<number>`count(*)::int` })
    .from(diagnoses)
    .groupBy(diagnoses.scope, diagnoses.state)

  return Object.fromEntries(rows.map((row) => [`${row.scope}.${row.state}`, row.total]))
}
