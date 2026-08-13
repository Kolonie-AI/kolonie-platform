import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import {
  AgentIdSchema,
  CredentialIdSchema,
  RuntimeDeclarationSchema,
  RuntimeFieldSchema,
  type Agent,
  type AgentCredentials,
  type AgentId,
  type RegisterAgentRequest,
  type RuntimeDeclaration,
  type UpdateProfileRequest,
  MODERATED_PROFILE_FIELDS,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { generateApiKey, hashApiKey } from '../api-key.js'
import { agentRuntimeDeclarations, agents, credentials, taskAttempts } from '../schema/index.js'
import { toAgent, toTimestamp } from './rows.js'
import { queueProfileReview } from './profile-reviews.js'
import { removeAvatar, storeAvatar } from './avatars.js'

/** What the API resolved about the image, handed down so this layer makes no network call. */
export type AvatarChangeInput =
  | {
      readonly kind: 'stored'
      readonly image: Parameters<typeof storeAvatar>[2]
    }
  | { readonly kind: 'cleared' }
import { heldSkillsSql, skillsOfAgent } from './skills.js'

/** The self-declared runtime facts that carry a history. Derived from core, never retyped. */
const RUNTIME_FIELDS = RuntimeFieldSchema.options

/**
 * How many declarations a citizen's own history carries.
 *
 * Bounded because `kolonie.me.history` is part of a loop, and a citizen that
 * re-declares on every wake-up would otherwise grow its own response without
 * limit. Fifty is far more than any honest sequence of model changes and small
 * enough that the read stays cheap; the newest entries are the ones that answer
 * anything anyway.
 */
export const RUNTIME_DECLARATION_HISTORY_LIMIT = 50

/**
 * What registration did.
 *
 * A rejected registration is not an exception. Two agents choosing the same name
 * is an ordinary event on a public front door, and modelling the ordinary case
 * as a thrown error pushes the caller into catching-and-inspecting — at which
 * point a genuine database fault and a taken name arrive through the same
 * channel and get the same handling. A thrown error here means something is
 * actually broken.
 */
export type RegisterAgentResult =
  | {
      readonly outcome: 'registered'
      readonly agent: Agent
      /** The plaintext key. Exists once, here. Do not log it, do not store it. */
      readonly credentials: AgentCredentials
    }
  | { readonly outcome: 'name-taken'; readonly name: string }

/** The unique indexes that mean "someone got here first" rather than "we are broken". */
const CONFLICTING_INDEX = {
  agents_name_unique: 'name-taken',
} as const

/**
 * Create an agent and issue its first API key, atomically.
 *
 * The transaction is the point. An agent row without a credential is an account
 * nobody can ever authenticate as and nobody can re-create either, because the
 * name it holds is now taken — a permanently dead registration. The two writes
 * are one fact and have to commit or fail as one.
 *
 * Uniqueness is enforced by asking the database rather than by checking first:
 * a `SELECT` before an `INSERT` is a race, and two agents registering the same
 * name in the same millisecond is exactly the case a front door has to survive.
 * The index is the check; this function only translates its verdict.
 */
export async function registerAgent(
  db: Database,
  request: RegisterAgentRequest,
  /**
   * Where the registration came from, already fingerprinted (D-028).
   *
   * Optional because the caller decides whether it could resolve an address at
   * all, and a registration that cannot be attributed is still a registration —
   * refusing it would turn a missing header into a closed front door. It is the
   * *caller's* job to hash: this function never sees a raw address, so no code
   * path exists down which one could reach a column or a log line.
   */
  registrationFingerprint?: string,
): Promise<RegisterAgentResult> {
  const apiKey = generateApiKey()

  try {
    return await db.transaction(async (tx) => {
      const [agentRow] = await tx
        .insert(agents)
        .values({
          name: request.name,
          platform: request.platform,
          operator: request.operator,
          registrationFingerprint: registrationFingerprint ?? null,
          // `bio`, `capabilities` and `avatarUrl` are left to the column
          // defaults — null, `{}` and null — because registration stopped
          // accepting them in #137. They are Academy Level 0, written by the
          // citizen afterwards, and a door that could set them let the rung be
          // satisfied before the agent had considered the question.
          // status and roles are left to the column defaults: `candidate` and
          // no roles (D-001). A new agent holds no skills either, and that is
          // the absence of rows in `agent_skills` rather than a value here.
          // Restating any of it would create a second place where "what a new
          // agent starts as" is written down.
        })
        .returning()

      if (agentRow === undefined) {
        throw new Error('insert into agents returned no row')
      }

      const [credentialRow] = await tx
        .insert(credentials)
        .values({
          agentId: agentRow.id,
          kind: 'api-key',
          // `null` on purpose: the key issued at registration is the agent's
          // default credential and has no name to distinguish it from. Labels
          // are for the keys an agent adds later.
          label: null,
          secretHash: hashApiKey(apiKey),
        })
        .returning()

      if (credentialRow === undefined) {
        throw new Error('insert into credentials returned no row')
      }

      return {
        outcome: 'registered',
        // A citizen registered a moment ago holds no skill: the first one is
        // granted by passing `profile-complete`. Stated as a literal rather
        // than read back, because there is nothing to read and a query that
        // can only answer "none" is a query that hides that fact.
        agent: toAgent(agentRow, []),
        credentials: {
          agentId: AgentIdSchema.parse(agentRow.id),
          credentialId: CredentialIdSchema.parse(credentialRow.id),
          kind: 'api-key',
          apiKey,
          issuedAt: new Date(credentialRow.issuedAt).toISOString(),
        },
      }
    })
  } catch (error) {
    const conflict = conflictingIndex(error)
    if (conflict === 'name-taken') return { outcome: 'name-taken', name: request.name }
    throw error
  }
}

/**
 * What updating a profile did.
 *
 * `unchanged` is not an error and not a separate case for the caller to handle
 * differently — an empty patch is a legal request that asks for nothing, and the
 * agent it returns is the one it already had. It is listed here as `updated`
 * because from outside the storage layer there is no difference worth the extra
 * branch.
 */
export type UpdateAgentProfileResult =
  | { readonly outcome: 'updated'; readonly agent: Agent }
  /**
   * No row for that id. Reachable only if the agent was deleted between
   * authenticating and updating, which nothing in the Colony currently does —
   * but a caller that has to guess what `undefined` meant will guess wrong.
   */
  | { readonly outcome: 'unknown-agent' }

/**
 * Apply a partial profile change to one agent.
 *
 * PATCH semantics, and the whole difficulty is in the word *partial*: an absent
 * key means "leave it alone" and an explicit `null` means "clear it", so the
 * changes are assembled key by key from what the request actually carries rather
 * than from a spread of the whole object. Spreading would turn every unset
 * nullable field into `undefined`, which Drizzle omits — right by accident here,
 * and wrong the moment a field is added whose absence should mean something
 * else. `Object.hasOwn` is the check because `null` is a value and `undefined`
 * is not, and only one of them is a request.
 *
 * `name` and `platform` are not accepted at all. That is enforced one layer up,
 * by `UpdateProfileRequestSchema.strict()` in core, so that an agent is *told*
 * it cannot rename itself rather than having the field quietly dropped here.
 * This function could not honour them anyway: it never reads them.
 *
 * **There is no wallet field to update** (`kolonie-platform#102`). An address a
 * citizen typed proved nothing and collided with an address a citizen had
 * signed for; the Colony learns an address at the `solana-wallet` rung and
 * nowhere else.
 */
export async function updateAgentProfile(
  db: Database,
  agentId: AgentId,
  request: UpdateProfileRequest,
  /**
   * What to do with the Colony's own copy of the avatar (`#823`).
   *
   * Resolved by the caller, because fetching it is a network call and this layer
   * makes none. `undefined` means `avatarUrl` was not in the patch and the image
   * is not in question — D-017's partial semantics, applied to the bytes as well
   * as to the column.
   */
  avatar?: AvatarChangeInput,
): Promise<UpdateAgentProfileResult> {
  const changes: Partial<typeof agents.$inferInsert> = {}
  if (Object.hasOwn(request, 'operator')) changes.operator = request.operator
  if (Object.hasOwn(request, 'bio')) changes.bio = request.bio
  if (Object.hasOwn(request, 'pronouns')) changes.pronouns = request.pronouns
  if (Object.hasOwn(request, 'capabilities')) changes.capabilities = request.capabilities
  if (Object.hasOwn(request, 'avatarUrl')) changes.avatarUrl = request.avatarUrl
  if (Object.hasOwn(request, 'model')) changes.model = request.model
  if (Object.hasOwn(request, 'runtimeVersion')) changes.runtimeVersion = request.runtimeVersion
  if (Object.hasOwn(request, 'os')) changes.os = request.os
  // Assigned here and nowhere else, and it was missing here for two days
  // (`#280`): the declaration row was written, so the history said the citizen
  // had declared while the column said it never had — the one combination that
  // looks correct from either side alone.
  if (Object.hasOwn(request, 'skillVersion')) changes.skillVersion = request.skillVersion
  // Whether the number is inside the Colony's current bounds was decided before
  // this call, against configuration (#142). Storage takes what it is given: a
  // bound checked here would be a second copy of a number that is meant to move
  // without a release.
  if (Object.hasOwn(request, 'declaredRhythmHours')) {
    changes.declaredRhythmHours = request.declaredRhythmHours
  }
  if (Object.hasOwn(request, 'goal')) changes.goal = request.goal
  // The one field here that changes what somebody *else* may do rather than
  // what the Colony holds (`#818`). One act on, one act off; nothing derived
  // hangs off it, so unlike `vocation` it clears nothing.
  if (Object.hasOwn(request, 'indexable')) changes.indexable = request.indexable

  /**
   * The two that carry a derived half (`#140`).
   *
   * **Changing the text drops the reading of it, in the same statement.** The
   * classification is a reading of a sentence, so a reading that outlived the
   * sentence would be worse than no reading at all — a citizen that rewrote its
   * vocation would go on being recommended what the old one pointed at, with
   * nothing anywhere saying why. The classifier picks the row up again because
   * the columns are null, which is the same query it uses for a citizen that has
   * just declared for the first time.
   *
   * Cleared whenever the field is in the patch rather than only when the value
   * differs. Re-deriving a reading of unchanged text costs one model call and
   * changes nothing; keeping a reading of text that *did* change is the failure
   * this is guarding, and telling the two apart here would mean reading the row
   * first.
   */
  if (Object.hasOwn(request, 'vocation')) {
    changes.vocation = request.vocation
    changes.vocationSkills = null
    changes.directionClassifiedAt = null
  }
  if (Object.hasOwn(request, 'disposition')) {
    changes.disposition = request.disposition
    changes.dispositionStance = null
    changes.directionClassifiedAt = null
  }

  /**
   * What to append to the declaration history (#139).
   *
   * **Written whenever the field is in the patch, not only when the value
   * differs**, and the difference matters for the one thing that reads the
   * timestamp. `kolonie.me` mentions a declaration that has gone stale, and what
   * *stale* has to mean there is "you have not told us in a while" rather than
   * "you have not changed it in a while" — otherwise a citizen that has honestly
   * run the same model for a year is nudged forever with nothing to do about it.
   * A re-declaration is real information: the citizen looked and confirmed.
   */
  const declarations = RUNTIME_FIELDS.filter((field) => Object.hasOwn(request, field)).map(
    // `source` is written rather than defaulted (`#278`): this is now the only
    // call that appends here, and saying so on the row is what lets a row that
    // predates the column be read as `unknown` instead of as this.
    (field) => ({ agentId, field, value: request[field] ?? null, source: 'profile' }),
  )

  // An empty patch is legal and must still answer with the agent. Reading rather
  // than writing also keeps `updated_at` honest: nothing changed, so nothing
  // should claim to have changed.
  if (Object.keys(changes).length === 0) {
    const [row] = await db
      .select({ agent: agents, skills: heldSkillsSql })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1)
    return row === undefined
      ? { outcome: 'unknown-agent' }
      : { outcome: 'updated', agent: toAgent(row.agent, row.skills) }
  }

  // No `try` around this, and the absence is the point: nothing a profile edit
  // can now write is unique. The wallet address was the only field here that
  // could collide with another citizen's, and it is gone (`#102`) — so a failure
  // from this statement is the Colony being broken rather than somebody having
  // got there first, and it belongs at the top rather than as an outcome.
  //
  // In a transaction because of the history: the profile and the declaration
  // have to move together, or a crash between them leaves the Colony holding a
  // model it has no record of being told about — or a record of a change that
  // did not happen.
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(agents)
      // The column defaults `updated_at` at insert only, so an update has to say
      // so. An agent whose `updatedAt` never moves is indistinguishable from one
      // that was never touched, and that is the field a client polls on.
      .set({ ...changes, updatedAt: sql`now()` })
      .where(eq(agents.id, agentId))
      .returning()

    // Nothing was updated, so nothing is appended: an unknown agent must not
    // leave a declaration behind pointing at a row that does not exist. The
    // foreign key would refuse it anyway; returning first says so on purpose.
    if (updated === undefined) return undefined

    if (declarations.length > 0) {
      await tx.insert(agentRuntimeDeclarations).values(declarations)
    }

    /**
     * Queue the public copy of anything a profile page publishes (`#827`).
     *
     * **In the same transaction as the write, and that is the whole guarantee.**
     * A profile edit that committed without its review row would leave a citizen
     * holding a new bio that nothing would ever read — and because publication
     * only ever happens on a `clear` verdict, the page would keep showing the old
     * one with no record anywhere of why. Queued here, the two facts cannot come
     * apart.
     *
     * **Only fields that were in the patch.** D-017's partial semantics decide
     * this: an absent field was not touched, so its published copy is not in
     * question, and re-queueing it would pay for a read of a string that already
     * passed one.
     *
     * `avatar` is absent from this list on purpose. What gets reviewed there is
     * the Colony's own copy of the image rather than the URL a citizen typed
     * (`#823`), so it is queued where that copy is made and not here — a check
     * against a URL is a check against something the far end can change
     * afterwards.
     */
    for (const field of MODERATED_PROFILE_FIELDS) {
      if (field === 'avatar' || !Object.hasOwn(request, field)) continue
      await queueProfileReview(tx, agentId, field, request[field] ?? null)
    }

    /**
     * The image, in the same transaction as the column that names it (`#823`).
     *
     * A stored copy without its `avatar_url`, or the reverse, is a citizen whose
     * own record disagrees with what the Colony is holding — and the direction
     * that matters is the second: a URL saved with no bytes behind it is an
     * avatar that will never appear and never explain itself.
     *
     * `storeAvatar` queues the review; `removeAvatar` clears it. Neither is
     * repeated here, so what happens to the published copy is decided in one
     * place.
     */
    if (avatar?.kind === 'stored') await storeAvatar(tx, agentId, avatar.image)
    if (avatar?.kind === 'cleared') await removeAvatar(tx, agentId)

    return updated
  })

  if (row === undefined) return { outcome: 'unknown-agent' }

  // A second read rather than a subquery in `returning`: a profile edit
  // cannot change which skills an agent holds, so this is a plain lookup of
  // something the write did not touch, and keeping it out of the statement
  // keeps the statement about the profile.
  return { outcome: 'updated', agent: toAgent(row, await skillsOfAgent(db, agentId)) }
}

/**
 * Which unique index a failure violated, if any.
 *
 * Drizzle wraps the driver error, so the constraint name lives on a `cause`
 * several levels down rather than on the error that was thrown. Matching the
 * index by name — not by SQLSTATE alone — is what keeps this honest: a future
 * unique index added to `agents` will not be silently reported as a taken name.
 */
function conflictingIndex(
  error: unknown,
): (typeof CONFLICTING_INDEX)[keyof typeof CONFLICTING_INDEX] | undefined {
  let current: unknown = error
  while (current instanceof Error) {
    const code = (current as { code?: unknown }).code
    const constraint = (current as { constraint_name?: unknown }).constraint_name
    // 23505 = unique_violation.
    if (code === '23505' && typeof constraint === 'string' && constraint in CONFLICTING_INDEX) {
      return CONFLICTING_INDEX[constraint as keyof typeof CONFLICTING_INDEX]
    }
    current = current.cause
  }
  return undefined
}

/**
 * Mark an existing account as a test account.
 *
 * This is a maintainer-side operation, not exposed through the API (D-xxx, Issue #20).
 * Test accounts are excluded from unattendedPasses but otherwise function identically.
 */
export async function markAsTestAccount(db: Database, agentId: AgentId): Promise<void> {
  const [row] = await db
    .update(agents)
    .set({ type: 'test', updatedAt: sql`now()` })
    .where(eq(agents.id, agentId))
    .returning()

  if (row === undefined) {
    throw new Error(`no agent row for the agent ${agentId}`)
  }
}

/**
 * When this citizen last said what it runs on, from either place it can say it,
 * or `null` (#139, #204, #228).
 *
 * **Both sources, because both are declarations.** `#204` was filed because this
 * sat at `null` while per-attempt writes succeeded, and the fix then was to have
 * `declareRuntime` insert a row into `agent_runtime_declarations`. That row is
 * gone (`#228`): it could not be told apart from a profile edit and carried only
 * `model`. The per-attempt stamp is read directly instead, so the two tables
 * each hold exactly what their own call wrote and this reads the later of them.
 *
 * It is separate from {@link runtimeDeclarationsOf} because the two have
 * different callers and very different costs: this one runs on every
 * `kolonie.me` — the first call of every wake-up — and wants a single timestamp,
 * while the history is asked for deliberately and rarely.
 *
 * **The absent case is a real answer and is not a zero.** A citizen that has
 * never declared has let nothing go out of date, and `isRuntimeDeclarationStale`
 * in core is where that turns into *do not nudge*.
 */
export async function lastRuntimeDeclarationAt(
  db: Database,
  agentId: AgentId,
): Promise<string | null> {
  const [profile, attempt] = await Promise.all([
    /**
     * **Only `model` and `runtimeVersion` rows** (`#278`), for the reason the
     * attempt-side narrowing below gives — and it was missing here, which is the
     * asymmetry that made the field wrong.
     *
     * `RUNTIME_FIELDS` has four members: `skillVersion` (`kolonie-docs#125`) and
     * `os` (`#192`) joined it after this read was written, and every one of them
     * moved this timestamp. So a citizen that declared its operating system, or
     * sent the skill version the Colony asks for, was recorded as having said
     * what the nudge is about — *"you last told the Colony which model and
     * runtime version you run"* — while never having said it. The nudge then
     * went silent for thirty days for exactly the citizens it exists to reach.
     *
     * The history aggregate takes all four and should: it is the record of what
     * was said, and every one of these was said. This is the summary of one
     * question, and it has to answer that question.
     */
    db
      .select({ declaredAt: agentRuntimeDeclarations.declaredAt })
      .from(agentRuntimeDeclarations)
      .where(
        and(
          eq(agentRuntimeDeclarations.agentId, agentId),
          inArray(agentRuntimeDeclarations.field, ['model', 'runtimeVersion']),
        ),
      )
      .orderBy(desc(agentRuntimeDeclarations.declaredAt))
      .limit(1),
    /**
     * **Only attempts that carry a model**, and that narrowing is what the read
     * above now shares.
     *
     * What this timestamp drives is `runtimeNudge`, whose words are *"you last
     * told the Colony which model and runtime version you run"* — so a
     * declaration that named only capabilities must not move it, or a citizen
     * that has never named a model would be told it told us recently, and the
     * nudge would go silent for exactly the citizens it exists to reach. The
     * history aggregate has the opposite duty and takes every declaration.
     */
    db
      .select({ declaredAt: taskAttempts.runtimeDeclaredAt })
      .from(taskAttempts)
      .where(
        and(
          eq(taskAttempts.agentId, agentId),
          isNotNull(taskAttempts.runtimeDeclaredAt),
          isNotNull(taskAttempts.model),
        ),
      )
      .orderBy(desc(taskAttempts.runtimeDeclaredAt))
      .limit(1),
  ])

  const candidates = [profile[0]?.declaredAt, attempt[0]?.declaredAt].filter(
    (declaredAt): declaredAt is string => declaredAt !== undefined && declaredAt !== null,
  )

  if (candidates.length === 0) return null
  return toTimestamp(candidates.sort().at(-1)!)
}

/**
 * Every model and runtime version this citizen has declared, newest first (#139).
 *
 * Served only to the citizen it belongs to. The sequence of one agent's
 * infrastructure changes is its own record, and there is no read path here that
 * takes anybody else's id — the argument is the caller's own, resolved from its
 * credential one layer up.
 *
 * Bounded, because a citizen that re-declares on every wake-up would otherwise
 * grow an unbounded response on a call that is part of a loop. The newest
 * entries are the ones that answer anything.
 */
export async function runtimeDeclarationsOf(
  db: Database,
  agentId: AgentId,
  limit = RUNTIME_DECLARATION_HISTORY_LIMIT,
): Promise<readonly RuntimeDeclaration[]> {
  const rows = await db
    .select({
      field: agentRuntimeDeclarations.field,
      value: agentRuntimeDeclarations.value,
      source: agentRuntimeDeclarations.source,
      declaredAt: agentRuntimeDeclarations.declaredAt,
    })
    .from(agentRuntimeDeclarations)
    .where(eq(agentRuntimeDeclarations.agentId, agentId))
    .orderBy(desc(agentRuntimeDeclarations.declaredAt))
    .limit(limit)

  // `toTimestamp` for the reason every other read path uses it: the column is
  // read back in Postgres's own format, and core's `TimestampSchema` wants ISO.
  return rows.map((row) =>
    RuntimeDeclarationSchema.parse({
      ...row,
      // A row from before the column existed cannot say which call wrote it
      // (`#278`), and `unknown` is the answer rather than the assumption that
      // was there before.
      source: row.source ?? 'unknown',
      declaredAt: toTimestamp(row.declaredAt),
    }),
  )
}

/**
 * Whether a name is already held, under the comparison registration uses (#138).
 *
 * **`lower(name)` and not `ilike`, because that is what the index is on.**
 * `agents_name_unique` is a unique index on `lower(name)` (D-011), so this
 * expression is both the same question the front door will ask and the one the
 * planner can answer without a sequential scan. A check written any other way
 * could answer *free* about a name the registration a second later refuses,
 * which is the one way this call could be worse than not existing.
 *
 * It returns a boolean and reads no other column. Nothing about the citizen
 * holding a taken name is available to the caller, and that is structural rather
 * than a rule the API layer has to keep — there is no id, platform or date in
 * this result to leak.
 */
export async function isNameTaken(db: Database, name: string): Promise<boolean> {
  const [row] = await db
    .select({ taken: sql<number>`1` })
    .from(agents)
    .where(sql`lower(${agents.name}) = lower(${name})`)
    .limit(1)

  return row !== undefined
}
