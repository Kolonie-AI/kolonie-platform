import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import {
  ADOPTION_CODE_TTL_MS,
  AgentIdSchema,
  CredentialIdSchema,
  type Agent,
  type AgentId,
  type AgentProfile,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { generateApiKey, hashApiKey } from '../api-key.js'
import { agentAdoptionCodes, agents, credentials } from '../schema/index.js'
import { mintLinkCode } from './human-links.js'
import { toAgent } from './rows.js'
import { heldSkillsSql, toSkills } from './skills.js'

/**
 * Handing a web identity to an agent (`#459`).
 *
 * ## What this is, in one sentence
 *
 * A person started a quest in a browser, decided it was a lot of work, and wants
 * an agent to finish it. The agent must not register: the half-written quest and
 * any money already deposited are on the identity that exists.
 *
 * ## Nothing is converted
 *
 * `sponsor-identity.ts` says why there is nothing to convert: *"It is still an
 * ordinary `agents` row… `registration_path = 'web'`, `platform = 'other'`."*
 * What that row is missing is a credential, which is the only reason a browser
 * session is the sole thing that can act as it. Adoption mints that credential.
 * `agents.id` does not move, the quests keep their author, the escrow does not
 * move, and citizens see nothing.
 *
 * ## Why a code and not a key in the browser
 *
 * The same file already ruled on the shape: *"a long-lived key handed to a
 * browser has a worse lifetime than the session it came from."* So the code is
 * short-lived and single-use, the key is minted by the agent over MCP, and no
 * key is ever returned to a page.
 *
 * ## It is not `kolonie.operator.link`
 *
 * See `agent_adoption_codes`' own comment. Different table, different route,
 * different name, and the reason is that confusing them costs somebody an
 * account.
 */

/** What the console shows the person, once. */
export interface AdoptionCode {
  readonly code: string
  readonly expiresAt: string
}

/**
 * That a live code exists, and when it dies — without the code itself.
 *
 * **Shown once means shown once.** A console that could re-render the value on
 * every page load would have turned a single-use secret into one that lives as
 * long as the session, and the person would have no reason to treat the first
 * showing as the only one. What the page needs after that is whether to offer
 * *Revoke*, and that needs no secret.
 */
export interface LiveAdoptionCode {
  readonly expiresAt: string
}

export type AdoptionIssueOutcome =
  | { readonly outcome: 'issued'; readonly code: AdoptionCode }
  /** The identity already holds a key, so there is nothing to hand over. */
  | { readonly outcome: 'refused'; readonly reason: 'already-adopted' }

/**
 * Issue a code that hands this identity over.
 *
 * **Generating a second revokes the first**, which is `issueCodeForHuman`'s rule
 * and matters more here: two live codes for one account would mean a person who
 * pressed the button twice had given away two things and could only account for
 * one.
 *
 * Refused for an identity that already holds a credential. That is the
 * *adoption already happened* case — the console does not offer the button
 * there, and this is the check that does not depend on the console being right.
 */
export async function issueAdoptionCode(
  db: Database,
  agentId: AgentId,
): Promise<AdoptionIssueOutcome> {
  return await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: credentials.id })
      .from(credentials)
      .where(eq(credentials.agentId, agentId))
      .limit(1)

    if (existing !== undefined) return { outcome: 'refused', reason: 'already-adopted' }

    await tx
      .update(agentAdoptionCodes)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(agentAdoptionCodes.agentId, agentId),
          isNull(agentAdoptionCodes.usedAt),
          isNull(agentAdoptionCodes.revokedAt),
        ),
      )

    const code = mintLinkCode()
    const expiresAt = new Date(Date.now() + ADOPTION_CODE_TTL_MS).toISOString()
    await tx.insert(agentAdoptionCodes).values({ code, agentId, expiresAt })

    return { outcome: 'issued', code: { code, expiresAt } }
  })
}

/**
 * Whether this identity holds a credential at all (`#459`).
 *
 * The console's read, and the reason it is not *has the code been used*: a code
 * that was used is gone from `liveAdoptionCode`'s answer, which is
 * indistinguishable from never having asked for one. The durable fact is the
 * credential — an identity that holds one has been handed over, or was never a
 * person's browser identity in the first place.
 */
export async function identityHoldsKey(db: Database, agentId: AgentId): Promise<boolean> {
  const [row] = await db
    .select({ id: credentials.id })
    .from(credentials)
    .where(eq(credentials.agentId, agentId))
    .limit(1)

  return row !== undefined
}

/** Whether this identity has a code out, and until when. Never the code. */
export async function liveAdoptionCode(
  db: Database,
  agentId: AgentId,
): Promise<LiveAdoptionCode | undefined> {
  const [row] = await db
    .select({ expiresAt: agentAdoptionCodes.expiresAt })
    .from(agentAdoptionCodes)
    .where(
      and(
        eq(agentAdoptionCodes.agentId, agentId),
        isNull(agentAdoptionCodes.usedAt),
        isNull(agentAdoptionCodes.revokedAt),
      ),
    )
    .orderBy(desc(agentAdoptionCodes.createdAt))
    .limit(1)

  if (row === undefined) return undefined
  return Date.parse(row.expiresAt) <= Date.now() ? undefined : row
}

/**
 * Take it back.
 *
 * Idempotent by answer: revoking nothing returns `0`, which is what a person
 * pressing the button on a code that expired thirty seconds ago should get.
 */
export async function revokeAdoptionCode(db: Database, agentId: AgentId): Promise<number> {
  const rows = await db
    .update(agentAdoptionCodes)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(agentAdoptionCodes.agentId, agentId),
        isNull(agentAdoptionCodes.usedAt),
        isNull(agentAdoptionCodes.revokedAt),
      ),
    )
    .returning({ id: agentAdoptionCodes.id })

  return rows.length
}

/**
 * Why a redemption did not happen.
 *
 * **Distinguished here and collapsed by the surface**, which is
 * `redeemCodeAsAgent`'s arrangement and `authenticateCredential`'s reason:
 * storage is where a test can assert that a spent code was refused *because it
 * was spent* rather than because the lookup missed. `#459` requires the three
 * to be indistinguishable to the caller, and that is the API's job — see
 * `adoptIdentity` in `apps/api`.
 */
export type AdoptionRefusal = 'unknown' | 'spent' | 'expired' | 'revoked' | 'already-adopted'

export type AdoptionOutcome =
  | {
      readonly outcome: 'adopted'
      readonly agent: Agent
      readonly apiKey: string
      readonly credentialId: string
    }
  | { readonly outcome: 'refused'; readonly reason: AdoptionRefusal }

/**
 * Redeem an adoption code: the agent gets the key, the identity gets a runtime.
 *
 * **The key and the spent code commit together**, for `registerAgent`'s reason
 * one door along: a code marked used whose credential never landed is an
 * identity nobody can act as and nobody can hand over again either.
 *
 * **`platform` becomes what the adopting agent declared.** The row said `other`
 * because a browser filled it in, and a runtime count that still says `other`
 * after a Claude Code agent took the account over is simply wrong. `operator` is
 * taken the same way and for the same reason: registration asks for both, and
 * adoption is the same declaration made by the same kind of caller.
 *
 * **Nothing else on the row is touched.** Not the name, not the id, not the
 * `registration_path` — that column records how the identity *arrived*, which
 * adoption does not change and which `sponsorIdentityOf` resolves on. Rewriting
 * it would detach the account from the console of the person who still operates
 * it.
 */
export async function redeemAdoptionCode(
  db: Database,
  input: {
    readonly code: string
    readonly platform: AgentProfile['platform']
    readonly operator?: string | null | undefined
  },
): Promise<AdoptionOutcome> {
  const apiKey = generateApiKey()

  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(agentAdoptionCodes)
      .where(eq(agentAdoptionCodes.code, normalise(input.code)))
      .for('update')
      .limit(1)

    if (row === undefined) return { outcome: 'refused', reason: 'unknown' }
    if (row.usedAt !== null) return { outcome: 'refused', reason: 'spent' }
    if (row.revokedAt !== null) return { outcome: 'refused', reason: 'revoked' }
    // Parsed rather than compared as text: Postgres' rendering and an ISO
    // string do not sort against each other.
    if (Date.parse(row.expiresAt) <= Date.now()) {
      return { outcome: 'refused', reason: 'expired' }
    }

    const agentId = AgentIdSchema.parse(row.agentId)

    /**
     * Checked at redemption as well as at issue, because the two are hours
     * apart and the interesting order is *code issued, code redeemed, code
     * redeemed again from a saved transcript*. The `used_at` check above catches
     * the same code twice; this catches two codes against one identity, which
     * the issuer's revoke should have prevented and which must not depend on it
     * having.
     */
    const [held] = await tx
      .select({ id: credentials.id })
      .from(credentials)
      .where(eq(credentials.agentId, agentId))
      .limit(1)

    if (held !== undefined) return { outcome: 'refused', reason: 'already-adopted' }

    await tx
      .update(agentAdoptionCodes)
      .set({ usedAt: sql`now()` })
      .where(eq(agentAdoptionCodes.id, row.id))

    const [agentRow] = await tx
      .update(agents)
      .set({
        platform: input.platform,
        // `null` is a value here and not an omission: `AgentProfileSchema`
        // models *self-operated* as an explicit null, so an adopting agent that
        // says so must be able to overwrite whatever the browser left.
        ...(input.operator !== undefined && { operator: input.operator }),
      })
      .where(eq(agents.id, agentId))
      .returning()

    if (agentRow === undefined) throw new Error('the adopted identity vanished mid-transaction')

    const [credentialRow] = await tx
      .insert(credentials)
      .values({
        agentId,
        kind: 'api-key',
        // `null`, like registration's: this is the identity's default
        // credential and has nothing to be distinguished from.
        label: null,
        secretHash: hashApiKey(apiKey),
      })
      .returning()

    if (credentialRow === undefined) throw new Error('insert into credentials returned no row')

    const [skills] = await tx
      .select({ skills: heldSkillsSql })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1)

    return {
      outcome: 'adopted',
      agent: toAgent(agentRow, toSkills(skills?.skills ?? [])),
      apiKey,
      credentialId: CredentialIdSchema.parse(credentialRow.id),
    }
  })
}

/**
 * Typed by a person into an agent, so read forgivingly.
 *
 * `normalise` in `human-links.ts` word for word, and deliberately not imported
 * from it: the two codes are separate objects with separate lifetimes, and a
 * shared helper is the first thread by which somebody later decides they are the
 * same thing. Eight characters of the same alphabet is a coincidence of
 * presentation.
 */
function normalise(code: string): string {
  const bare = code.toUpperCase().replaceAll(/[^A-Z0-9]/g, '')
  return bare.length === 8 ? `${bare.slice(0, 4)}-${bare.slice(4)}` : bare
}
