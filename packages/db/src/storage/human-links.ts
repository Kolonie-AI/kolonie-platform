import { randomInt } from 'node:crypto'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import {
  AgentIdSchema,
  HUMAN_LINK_CODE_TTL_MS,
  HumanIdSchema,
  type AgentId,
  type HumanId,
  type LinkedAgent,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, humanAgents, humanIdentities, humanLinkCodes, humans } from '../schema/index.js'
import { operatorAddresses } from '../schema/operator-addresses.js'
import { heldSkillsSql } from './skills.js'

/**
 * Linking a person to an agent, in both directions (`#426`).
 *
 * ## What linking is, beside a convenience
 *
 * It is a **confirmation of the operator relationship**. `operator_addresses`
 * says confirmation is a by-product of answering the form, and gates
 * `github-account` and `social-account` on it. A person who completed an OAuth
 * login and redeemed a single-use code has confirmed more than a form answer
 * does — same person, stronger evidence — so the two rungs open on the same
 * footing and by the same column.
 *
 * ## Where that stops
 *
 * **Only when the provider actually returned a usable address.** A GitHub
 * account may keep its address private, and then there is nothing to write: the
 * link is still made, no `operator_addresses` row appears, and the two rungs stay
 * shut. Writing a `@users.noreply.github.com` address with `confirmed_at` set
 * would open a rung on an address that cannot receive the confirmation the rung
 * is about, which is worse than leaving it closed.
 */

/** The alphabet a person types back. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * A code short enough to read aloud and unambiguous enough to type.
 *
 * `I`, `O`, `0` and `1` are absent, because this value crosses a gap no other
 * secret in the Colony crosses: a screen, a person, and a keyboard. Its defence
 * is the single use and the expiry rather than its length — 40 bits over an
 * alphabet with no confusable pairs, spent the first time it works, gone in
 * three days.
 */
export function mintLinkCode(): string {
  const letters = Array.from(
    { length: 8 },
    () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)] as string,
  )
  return `${letters.slice(0, 4).join('')}-${letters.slice(4).join('')}`
}

/** What a caller shows whoever has to type it. */
export interface LinkCode {
  readonly code: string
  readonly expiresAt: string
}

/**
 * Issue a code for a person to hand to an agent.
 *
 * **At most one live code per person**, so that a dashboard showing *the* code
 * is telling the truth. Asking again replaces the previous one rather than
 * adding to it — the same rule `requestSignInLink` has, for the same reason: a
 * reader who pressed the button twice must not be left wondering which of two
 * values is the one that works.
 */
export async function issueCodeForHuman(db: Database, humanId: HumanId): Promise<LinkCode> {
  return await db.transaction(async (tx) => {
    await tx
      .update(humanLinkCodes)
      .set({ usedAt: sql`now()`, redeemedNote: 'replaced by a newer code' })
      .where(and(eq(humanLinkCodes.humanId, humanId), isNull(humanLinkCodes.usedAt)))

    const code = mintLinkCode()
    const expiresAt = new Date(Date.now() + HUMAN_LINK_CODE_TTL_MS).toISOString()
    await tx.insert(humanLinkCodes).values({ code, humanId, expiresAt })

    return { code, expiresAt }
  })
}

/** And the other direction: a code for an agent to hand to its operator. */
export async function issueCodeForAgent(db: Database, agentId: AgentId): Promise<LinkCode> {
  return await db.transaction(async (tx) => {
    await tx
      .update(humanLinkCodes)
      .set({ usedAt: sql`now()`, redeemedNote: 'replaced by a newer code' })
      .where(and(eq(humanLinkCodes.agentId, agentId), isNull(humanLinkCodes.usedAt)))

    const code = mintLinkCode()
    const expiresAt = new Date(Date.now() + HUMAN_LINK_CODE_TTL_MS).toISOString()
    await tx.insert(humanLinkCodes).values({ code, agentId, expiresAt })

    return { code, expiresAt }
  })
}

/**
 * The live code this person is holding, if they have asked for one.
 *
 * Read rather than issued, so that loading the dashboard twice does not mint two
 * codes and leave a person holding a value their agent was never given. Issuing
 * is a button.
 */
export async function liveCodeForHuman(
  db: Database,
  humanId: HumanId,
): Promise<LinkCode | undefined> {
  const [row] = await db
    .select({ code: humanLinkCodes.code, expiresAt: humanLinkCodes.expiresAt })
    .from(humanLinkCodes)
    .where(and(eq(humanLinkCodes.humanId, humanId), isNull(humanLinkCodes.usedAt)))
    .orderBy(desc(humanLinkCodes.createdAt))
    .limit(1)

  if (row === undefined) return undefined
  return Date.parse(row.expiresAt) <= Date.now() ? undefined : row
}

/** How a redemption ended. */
export type LinkOutcome =
  | { readonly outcome: 'linked'; readonly agentId: AgentId; readonly humanId: HumanId }
  /** No live code carries this value — unknown, spent, or expired. */
  | { readonly outcome: 'refused'; readonly reason: 'unknown' | 'spent' | 'expired' }
  /** The code was issued by the side now trying to redeem it. */
  | { readonly outcome: 'refused'; readonly reason: 'wrong-side' }
  /** That agent already has an operator, and one citizen has one (`#426`). */
  | { readonly outcome: 'refused'; readonly reason: 'already-linked' }

/**
 * Redeem a code an agent presents — the person went first.
 *
 * The three refusals are distinguished here and collapsed by the surface, for
 * the reason `authenticateCredential` gives: storage is where a test can assert
 * that a *spent* code is refused because it was spent rather than because the
 * lookup missed.
 */
export async function redeemCodeAsAgent(
  db: Database,
  code: string,
  agentId: AgentId,
): Promise<LinkOutcome> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(humanLinkCodes)
      .where(eq(humanLinkCodes.code, normalise(code)))
      .limit(1)

    const refusal = refusalFor(row)
    if (refusal !== undefined) return refusal
    if (row === undefined) return { outcome: 'refused', reason: 'unknown' }

    // A code the agent issued is for its operator to type, not for itself. This
    // is the one refusal that is about *who* rather than about the value.
    if (row.humanId === null) return { outcome: 'refused', reason: 'wrong-side' }

    return await link(
      tx,
      HumanIdSchema.parse(row.humanId),
      agentId,
      row.id,
      'redeemed by the agent',
    )
  })
}

/** And the other direction: a person types in what their agent gave them. */
export async function redeemCodeAsHuman(
  db: Database,
  code: string,
  humanId: HumanId,
): Promise<LinkOutcome> {
  return await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(humanLinkCodes)
      .where(eq(humanLinkCodes.code, normalise(code)))
      .limit(1)

    const refusal = refusalFor(row)
    if (refusal !== undefined) return refusal
    if (row === undefined) return { outcome: 'refused', reason: 'unknown' }

    if (row.agentId === null) return { outcome: 'refused', reason: 'wrong-side' }

    return await link(
      tx,
      humanId,
      AgentIdSchema.parse(row.agentId),
      row.id,
      'redeemed by the person',
    )
  })
}

/**
 * Typed by a person, so read forgivingly.
 *
 * Case and the separator are presentation. Refusing `abcd efgh` for a code
 * displayed as `ABCD-EFGH` would be the Colony insisting on its own formatting
 * against somebody who copied the value correctly.
 */
function normalise(code: string): string {
  const bare = code.toUpperCase().replaceAll(/[^A-Z0-9]/g, '')
  return bare.length === 8 ? `${bare.slice(0, 4)}-${bare.slice(4)}` : bare
}

function refusalFor(
  row: { usedAt: string | null; expiresAt: string } | undefined,
): LinkOutcome | undefined {
  if (row === undefined) return { outcome: 'refused', reason: 'unknown' }
  if (row.usedAt !== null) return { outcome: 'refused', reason: 'spent' }
  // Read here rather than left to a sweep. Parsed rather than compared as text:
  // Postgres' rendering and an ISO string do not sort against each other.
  if (Date.parse(row.expiresAt) <= Date.now()) return { outcome: 'refused', reason: 'expired' }
  return undefined
}

/**
 * Make the link, spend the code, and confirm the operator where there is an
 * address to confirm.
 *
 * All in the transaction the caller opened: a link without its spent code is a
 * code that works twice, and a spent code without its link is a person who has
 * to start again with a value that no longer exists.
 */
async function link(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  humanId: HumanId,
  agentId: AgentId,
  codeId: string,
  note: string,
): Promise<LinkOutcome> {
  const [existing] = await tx
    .select({ humanId: humanAgents.humanId })
    .from(humanAgents)
    .where(eq(humanAgents.agentId, agentId))
    .limit(1)

  // Already linked to *this* person is not a failure — it is the state the
  // caller asked for. Linked to somebody else is, because one citizen has one
  // operator and taking it over silently is not the Colony's call to make.
  if (existing !== undefined && existing.humanId !== humanId) {
    return { outcome: 'refused', reason: 'already-linked' }
  }

  await tx.insert(humanAgents).values({ agentId, humanId }).onConflictDoNothing()
  await tx
    .update(humanLinkCodes)
    .set({ usedAt: sql`now()`, redeemedNote: note })
    .where(eq(humanLinkCodes.id, codeId))

  /**
   * The confirmation, where the provider gave an address to confirm.
   *
   * The newest identity that carries one — a person who attached GitHub with a
   * private address and Google with a public one is reachable, and picking the
   * first row would have said otherwise.
   */
  const [reachable] = await tx
    .select({ email: humanIdentities.email })
    .from(humanIdentities)
    .where(and(eq(humanIdentities.humanId, humanId), sql`${humanIdentities.email} is not null`))
    .orderBy(desc(humanIdentities.attachedAt))
    .limit(1)

  if (reachable?.email != null) {
    await tx
      .insert(operatorAddresses)
      .values({ agentId, address: reachable.email, confirmedAt: sql`now()` })
      .onConflictDoUpdate({
        target: operatorAddresses.agentId,
        set: { address: reachable.email, confirmedAt: sql`now()` },
      })
  }

  return { outcome: 'linked', agentId, humanId }
}

/**
 * The agents a person operates, newest activity first.
 *
 * What is selected is what `#427` decided a list is for — enough to choose which
 * one to look at, and no more. No balance, no reputation, no vault entry and no
 * address: `operator-pages.ts` is explicit that those were never selected *"not
 * because a renderer declines to draw them"*, and that holds one level up.
 *
 * **`#512` widened it and did not break that rule.** The runtime, the declared
 * model and the last skill earned are all facts about *this agent's own climb*,
 * which is what the list was always for; none of them is a balance, and none of
 * them is comparable between two agents in a way that would turn the list into a
 * league table. `waitingOn` is added by the caller, because the condition needs
 * the release table that only `apps/api` holds.
 *
 * **The order is activity and never achievement.** An operator with twelve
 * agents must not be handed a ranking — `#512` refuses one outright, because a
 * column that sorts by earnings invites pruning the slow ones, and the whole
 * argument for a fleet page is that the operator can see which of them needs
 * something.
 */
export async function agentsOperatedBy(
  db: Database,
  humanId: HumanId,
): Promise<readonly LinkedAgent[]> {
  const rows = await db
    .select({
      id: agents.id,
      name: agents.name,
      citizenship: agents.status,
      lastSeenAt: agents.lastSeenAt,
      skills: heldSkillsSql,
      linkedAt: humanAgents.linkedAt,
      platform: agents.platform,
      model: agents.model,
      /**
       * The most recent skill this agent was granted, and when.
       *
       * A lateral so that an agent with no grants produces a row with nulls
       * rather than dropping out of the list — an operator whose newest agent
       * has earned nothing is exactly the operator this page is for.
       */
      lastEarnedSkill: sql<string | null>`(
        select g.skill from agent_skills g
         where g.agent_id = ${agents.id}
         order by g.granted_at desc
         limit 1)`,
      lastEarnedAt: sql<string | null>`(
        select g.granted_at from agent_skills g
         where g.agent_id = ${agents.id}
         order by g.granted_at desc
         limit 1)`,
    })
    .from(humanAgents)
    .innerJoin(agents, eq(agents.id, humanAgents.agentId))
    .where(eq(humanAgents.humanId, humanId))
    .orderBy(sql`${agents.lastSeenAt} desc nulls last`)

  return rows.map((row) => ({
    id: AgentIdSchema.parse(row.id),
    name: row.name,
    citizenship: row.citizenship,
    skillsHeld: row.skills.length,
    lastSeenAt: row.lastSeenAt,
    linkedAt: row.linkedAt,
    platform: row.platform,
    model: row.model,
    lastEarned:
      row.lastEarnedSkill === null || row.lastEarnedAt === null
        ? null
        : { skill: row.lastEarnedSkill, at: row.lastEarnedAt },
  }))
}

/** Whether this person operates this agent — the check `#428` authorises on. */
export async function operatesAgent(
  db: Database,
  humanId: HumanId,
  agentId: AgentId,
): Promise<boolean> {
  const [row] = await db
    .select({ agentId: humanAgents.agentId })
    .from(humanAgents)
    .where(and(eq(humanAgents.humanId, humanId), eq(humanAgents.agentId, agentId)))
    .limit(1)

  return row !== undefined
}

/** The person who operates this agent, if one does. */
export async function operatorOf(db: Database, agentId: AgentId): Promise<HumanId | undefined> {
  const [row] = await db
    .select({ humanId: humanAgents.humanId })
    .from(humanAgents)
    .innerJoin(humans, eq(humans.id, humanAgents.humanId))
    .where(eq(humanAgents.agentId, agentId))
    .limit(1)

  return row === undefined ? undefined : HumanIdSchema.parse(row.humanId)
}

/** The linked person, and whether the Colony has an address for them. */
export interface LinkedOperator {
  readonly humanId: HumanId
  /**
   * `null` where their account carries no address — **a state and not a missing
   * value**, and the one the paragraphs at the top of this file are about: a
   * GitHub account may keep its address private, the link is made anyway, and
   * nothing was ever written for the Colony to write to.
   */
  readonly email: string | null
}

/**
 * The same person {@link operatorOf} names, with the address to reach them at
 * (`#774`).
 *
 * **Two functions rather than a wider one**, because the callers want different
 * things and the second thing is a person's address. `operatorOf` answers *may
 * this go ahead*, and every one of its callers is an authorisation check that has
 * no business holding an inbox. This one answers *where do I write*, and it is
 * called where a mail is about to be sent and nowhere else.
 *
 * **Not `operator_addresses`.** That table is the human a citizen *named*, for
 * the autonomy form, and it may be somebody with no account here at all. The
 * recipient of anything that leads to a console page has to be the linked person
 * instead, because opening one needs their session — mailing a link to an address
 * that cannot sign in would be worse than sending nothing.
 */
export async function linkedOperator(
  db: Database,
  agentId: AgentId,
): Promise<LinkedOperator | undefined> {
  const [link] = await db
    .select({ humanId: humanAgents.humanId })
    .from(humanAgents)
    .where(eq(humanAgents.agentId, agentId))
    .limit(1)

  if (link === undefined) return undefined

  /**
   * The newest identity carrying an address, which is the choice `redeemLink`
   * above already made and states the argument for: a person who attached GitHub
   * with a private address and Google with a public one is reachable, and taking
   * the first row would have said otherwise.
   */
  const [reachable] = await db
    .select({ email: humanIdentities.email })
    .from(humanIdentities)
    .where(
      and(eq(humanIdentities.humanId, link.humanId), sql`${humanIdentities.email} is not null`),
    )
    .orderBy(desc(humanIdentities.attachedAt))
    .limit(1)

  return { humanId: HumanIdSchema.parse(link.humanId), email: reachable?.email ?? null }
}
