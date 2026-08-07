import { and, eq, sql } from 'drizzle-orm'
import { AgentIdSchema, type Agent, type AgentId, type HumanId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { accounts, agents } from '../schema/index.js'
import { humanAgents } from '../schema/human-links.js'
import { toAgent } from './rows.js'
import { heldSkillsSql, toSkills } from './skills.js'

/**
 * The sponsor identity a person holds, and the one way to open one (`#430`).
 *
 * ## What this closes
 *
 * `kolonie.ai/sponsors` step 5 said the deposit address is *"handed over the API
 * rather than shown in the console, so this is the one step a sponsor with no
 * agent cannot finish alone"* and pointed at `#400` for a route from a browser
 * session to a key. **A human account is that route, arrived at from the other
 * side**: once a person is a real authenticated subject rather than a mail
 * token, the console acts for them without minting a bearer key at all — which
 * is a better answer than `#400` asked for, because a long-lived key handed to a
 * browser has a worse lifetime than the session it came from.
 *
 * ## It is still an ordinary `agents` row, and `#108` is not reopened
 *
 * One identity table and several ways in. `registration_path = 'web'`,
 * `platform = 'other'`, exactly as `registerWebIdentity` writes them and for the
 * reasons that function gives. {@link outsideQuestAudienceSql} is untouched and
 * keeps working unchanged; nothing here adds a flag, a status or a second table.
 *
 * ## Why resolution does **not** use the audience predicate
 *
 * `outsideQuestAudienceSql` is *arrived by web* **and** *holds no skill*, and
 * the second half is deliberate: it lapses the moment the identity climbs
 * anything, so an identity that arrived by web cannot become a caste. That is
 * right for the two questions it answers — the audience a quest's author is
 * shown, and the gate a claim passes — and **wrong for this one.** An identity
 * that climbed a rung would stop being found by its own console and would lose
 * the deposit address it was using, which is a demotion by achievement.
 *
 * So resolution asks the durable half only: the linked identity that arrived by
 * `web`. The predicate stays exactly as it is and is not widened to serve a
 * third caller with a different question — the mistake `console-identity.ts`
 * warns about in the other direction, and the one `#458` finally undid by
 * splitting the deletion guard out into a predicate of its own.
 */
export interface SponsorIdentity {
  readonly id: AgentId
  readonly name: string
}

/** The one this person holds, or `undefined`. */
export async function sponsorIdentityOf(
  db: Database,
  humanId: HumanId,
): Promise<SponsorIdentity | undefined> {
  const [row] = await db
    .select({ id: agents.id, name: agents.name })
    .from(humanAgents)
    .innerJoin(agents, eq(agents.id, humanAgents.agentId))
    .where(and(eq(humanAgents.humanId, humanId), eq(agents.registrationPath, 'web')))
    .orderBy(humanAgents.linkedAt)
    .limit(1)

  return row === undefined ? undefined : { id: AgentIdSchema.parse(row.id), name: row.name }
}

export type OpenSponsorOutcome =
  | { readonly outcome: 'opened'; readonly identity: SponsorIdentity }
  /** They already hold one. Idempotent by answer rather than by silence. */
  | { readonly outcome: 'already-held'; readonly identity: SponsorIdentity }
  /** The name they asked for belongs to somebody else. */
  | { readonly outcome: 'name-taken'; readonly name: string }

/**
 * Open the sponsor identity this person does not have yet.
 *
 * **One, and never two.** *One is the thing being paid for; two is an org
 * feature, and organisations are not in this design.* Enforced by reading
 * inside the transaction that writes, so two clicks on one button cannot both
 * find nothing and both insert.
 *
 * **The address is the provider's and is recorded `proved`**, which is the one
 * place this differs from `registerWebIdentity` and the difference is the whole
 * point. That function writes an unproved mailbox because somebody typed an
 * address into a public form and *"it may be a stranger's"* — and
 * `sponsorAddressUnconfirmedSql` then holds funding until mail sent there has
 * been read. Here the address arrived from the identity provider the person
 * just authenticated against, which is a stronger proof than reading mail, not
 * a weaker one. Holding funding for a confirmation mail would be asking a person
 * to prove by a worse method what they have already proved by a better one.
 *
 * **A person whose provider returned no address gets no mailbox row at all**,
 * which is an ordinary state — GitHub may keep an address private or return a
 * `noreply` one, and `governance/privacy.md` §3 already names that as the
 * ordinary answer. `sponsorAddressUnconfirmedSql` asks whether an *unproved*
 * account exists, so no row means no hold, which is correct: this identity never
 * made an unverified claim to be held against.
 */
export async function openSponsorIdentity(
  db: Database,
  request: {
    readonly humanId: HumanId
    readonly name: string
    /** Whatever the provider returned, or `undefined` if it returned nothing. */
    readonly address?: string | undefined
  },
): Promise<OpenSponsorOutcome> {
  const held = await sponsorIdentityOf(db, request.humanId)
  if (held !== undefined) return { outcome: 'already-held', identity: held }

  try {
    return await db.transaction(async (tx) => {
      // Re-read inside the transaction: the check above is the cheap answer for
      // the ordinary case, and this is the one that holds against two clicks.
      const [existing] = await tx
        .select({ id: agents.id, name: agents.name })
        .from(humanAgents)
        .innerJoin(agents, eq(agents.id, humanAgents.agentId))
        .where(and(eq(humanAgents.humanId, request.humanId), eq(agents.registrationPath, 'web')))
        .limit(1)

      if (existing !== undefined) {
        return {
          outcome: 'already-held' as const,
          identity: { id: AgentIdSchema.parse(existing.id), name: existing.name },
        }
      }

      const [agentRow] = await tx
        .insert(agents)
        .values({
          name: request.name,
          platform: 'other',
          registrationPath: 'web',
          // Everything else is left to the column defaults, for the reason
          // `registerWebIdentity` gives: restating what a new identity starts as
          // would create a second place where that is written down.
        })
        .returning({ id: agents.id })

      if (agentRow === undefined) throw new Error('insert into agents returned no row')

      await tx.insert(humanAgents).values({ agentId: agentRow.id, humanId: request.humanId })

      /**
       * Bound to a const before the branch, not read off `request` inside it.
       * The insert below sits in a closure, and TypeScript drops the narrowing
       * of a property across that boundary — the value is still `string`, but
       * only a local binding says so.
       */
      const address = request.address
      if (address !== undefined && address.trim() !== '') {
        /**
         * **An address already proved elsewhere gets no row, and the identity
         * opens anyway (`#491`).**
         *
         * `accounts_proved_identifier_unique` is unique on
         * `(kind, lower(identifier))` across **every agent in the Colony**, so
         * an address any citizen has already proved raises `23505` here. That
         * error was reaching the console as an unhandled 500, identically on
         * every retry, and there is no other route to a funding address — so a
         * person who had ever proved that address on an agent could never open a
         * sponsor identity. Observed on `console.kolonie.ai/funding/identity` on
         * 2026-08-07, on the population most likely to press the button.
         *
         * Skipping the row is not a workaround. It lands the identity in the
         * state this function already documents above as ordinary: no row, no
         * unproved claim, nothing held against it. `sponsorAddressUnconfirmedSql`
         * asks whether an *unproved* account exists, so a missing row is not a
         * hold and funding proceeds.
         *
         * **The read is what makes the ordinary case deterministic; the catch
         * below is what holds the race between this read and the insert.** A
         * read alone leaves the race open, and a catch alone would make the
         * ordinary case depend on an exception.
         */
        const [alreadyProved] = await tx
          .select({ id: accounts.id })
          .from(accounts)
          .where(
            and(
              eq(accounts.kind, 'mailbox'),
              eq(accounts.proved, true),
              sql`lower(${accounts.identifier}) = lower(${address})`,
            ),
          )
          .limit(1)

        if (alreadyProved === undefined) {
          /**
           * **The catch is a savepoint, and it has to be.** A `23505` raised
           * inside a transaction aborts that transaction: every later statement
           * answers `25P02`, and the `agents` and `human_agents` rows written
           * above would roll back with it. Catching the error at the outer
           * `try` and returning `opened` would then be a lie — the identity it
           * claims to have opened does not exist.
           *
           * A nested `transaction()` is a `SAVEPOINT` on postgres, so the
           * rollback reaches the failed insert and stops there. The identity
           * survives, which is the outcome this whole branch is protecting.
           */
          try {
            await tx.transaction(async (savepoint) => {
              await savepoint.insert(accounts).values({
                agentId: agentRow.id,
                kind: 'mailbox',
                identifier: address,
                proved: true,
                provedAt: sql`now()`,
                provenance: 'self-acquired',
              })
            })
          } catch (error) {
            /**
             * Matched by constraint name, not by SQLSTATE alone, for the reason
             * `isNameTakenError` gives: a unique index added to `accounts`
             * later must not be silently swallowed here. Anything else raises
             * and reaches the outer handler unchanged.
             */
            if (!isProvedIdentifierTakenError(error)) throw error
          }
        }
      }

      return {
        outcome: 'opened' as const,
        identity: { id: AgentIdSchema.parse(agentRow.id), name: request.name },
      }
    })
  } catch (error) {
    if (isNameTakenError(error)) return { outcome: 'name-taken', name: request.name }
    throw error
  }
}

/** The unique violation on `agents_name_unique`, told apart from every other one. */
function isNameTakenError(error: unknown): boolean {
  return isUniqueViolationOn(error, 'agents_name_unique')
}

/**
 * The unique violation on `accounts_proved_identifier_unique` (`#491`).
 *
 * Its own named predicate rather than a second argument threaded through the
 * call site, so that the two constraints this file knows about are two readable
 * names and the difference between them is not a string literal in a condition.
 */
function isProvedIdentifierTakenError(error: unknown): boolean {
  return isUniqueViolationOn(error, 'accounts_proved_identifier_unique')
}

/**
 * A `23505` on one named constraint, told apart from every other one.
 *
 * **Walked down the `cause` chain**, which is not optional here: Drizzle wraps
 * the driver error and the transaction wraps that again, so the constraint name
 * is several levels below the error that was thrown. `conflictingIndex` in
 * `agents.ts` learned this first and this is the same walk — and like that one it
 * matches the index **by name** rather than by SQLSTATE alone, so a unique index
 * added later is not silently reported as one of these two.
 */
function isUniqueViolationOn(error: unknown, constraintName: string): boolean {
  let current: unknown = error
  while (current instanceof Error) {
    const code = (current as { code?: unknown }).code
    const constraint = (current as { constraint_name?: unknown }).constraint_name
    // 23505 = unique_violation.
    if (code === '23505' && constraint === constraintName) return true
    current = current.cause
  }
  return false
}

/**
 * The same identity, as the whole `Agent` an authenticated route expects
 * (`#430`).
 *
 * **Its own read rather than `sponsorIdentityOf` plus a lookup**, because this
 * is on the request path of every console call a person makes and the skills
 * come back with the row for the reason `authenticateCredential` gives: what a
 * caller may attempt is decided by them (D-030), and a second round trip to
 * learn it would be a second round trip on a hot path.
 *
 * A person with no sponsor identity answers `undefined`, which the route turns
 * into the ordinary refusal. It is not an error: most people signed in to the
 * console operate agents and have never opened one.
 */
export async function sponsorAgentOf(db: Database, humanId: HumanId): Promise<Agent | undefined> {
  const [row] = await db
    .select({ agent: agents, skills: heldSkillsSql })
    .from(humanAgents)
    .innerJoin(agents, eq(agents.id, humanAgents.agentId))
    .where(and(eq(humanAgents.humanId, humanId), eq(agents.registrationPath, 'web')))
    .orderBy(humanAgents.linkedAt)
    .limit(1)

  return row === undefined ? undefined : toAgent(row.agent, toSkills(row.skills))
}
