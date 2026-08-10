import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import type { AgentId, AutonomyContract } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, autonomyContracts, autonomyFormInvitations } from '../schema/index.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import {
  contractCompanions,
  hasAutonomyContract,
  inviteOperator,
  listAutonomyContracts,
  openAutonomyForm,
  readAutonomyContract,
  recordAutonomyContract,
} from './autonomy.js'

const target = databaseTestTarget()

const NARROW: AutonomyContract = {
  level: 'accompanied',
  challengesAllowed: false,
  defaultRule: 'refrain',
  operatorRoute: 'Ask Gregor first, always.',
}

const BROAD: AutonomyContract = {
  level: 'free',
  challengesAllowed: true,
  defaultRule: 'ask',
  operatorRoute: 'Slack, #kolonie.',
}

describe('the autonomy contract', () => {
  let db: Database
  let agentId: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  const anAgent = async (name: string): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return row.id as AgentId
  }

  beforeEach(async () => {
    await truncateAll(db)
    agentId = await anAgent('canary')
  })

  describe('the invitation', () => {
    it('is addressed to where the citizen asked, and carries a token', async () => {
      const invitation = await inviteOperator(db, agentId, 'operator@example.org')

      expect(invitation.token).toHaveLength(64)
      expect(invitation.expiresAt).toBeTruthy()
    })

    it('opens a form that names the citizen it is about', async () => {
      // The operator is about to answer questions about an agent; the page has to
      // be able to say which one, or the questions are unanswerable.
      const invitation = await inviteOperator(db, agentId, 'operator@example.org')

      const form = await openAutonomyForm(db, invitation.token)

      expect(form?.agentId).toBe(agentId)
      expect(form?.agentName).toBe('canary')
    })

    it('supersedes an outstanding one, so two links cannot both be answered', async () => {
      // Two live links means two answers, the second silently overwriting the
      // first, with the citizen unable to say which one its contract came from.
      const first = await inviteOperator(db, agentId, 'operator@example.org')
      const second = await inviteOperator(db, agentId, 'operator@example.org')

      expect(await openAutonomyForm(db, first.token)).toBeNull()
      expect(await openAutonomyForm(db, second.token)).not.toBeNull()
    })

    it('answers nothing for a token nobody was given', async () => {
      expect(await openAutonomyForm(db, 'a'.repeat(64))).toBeNull()
    })

    it('answers nothing once it has expired', async () => {
      const invitation = await inviteOperator(db, agentId, 'operator@example.org')
      await db
        .update(autonomyFormInvitations)
        .set({ expiresAt: sql`now() - interval '1 minute'` })
        .where(eq(autonomyFormInvitations.token, invitation.token))

      expect(await openAutonomyForm(db, invitation.token)).toBeNull()
    })

    it('refuses two invitations carrying the same token', async () => {
      const invitation = await inviteOperator(db, agentId, 'operator@example.org')

      await expectRejection(
        () =>
          db.insert(autonomyFormInvitations).values({
            agentId,
            operatorAddress: 'someone@example.org',
            token: invitation.token,
            expiresAt: sql`now() + interval '1 day'` as unknown as string,
          }),
        /autonomy_form_invitations_token_idx/,
      )
    })
  })

  describe('recording the answer', () => {
    it('stores what the operator said and when it must be looked at again', async () => {
      const invitation = await inviteOperator(db, agentId, 'operator@example.org')

      const contract = await recordAutonomyContract(db, invitation.token, NARROW)

      expect(contract?.level).toBe('accompanied')
      expect(contract?.challengesAllowed).toBe(false)
      expect(contract?.defaultRule).toBe('refrain')
      expect(contract?.operatorRoute).toBe('Ask Gregor first, always.')
      // A review date, not an expiry: it is in the future and nothing depends on
      // it having passed or not.
      expect(new Date(contract?.reviewDueAt ?? 0).getTime()).toBeGreaterThan(Date.now())
    })

    it('spends the form, so the same link cannot answer twice', async () => {
      const invitation = await inviteOperator(db, agentId, 'operator@example.org')
      await recordAutonomyContract(db, invitation.token, NARROW)

      expect(await recordAutonomyContract(db, invitation.token, BROAD)).toBeNull()
      // And the first answer stands rather than being half-overwritten.
      expect((await readAutonomyContract(db, agentId))?.level).toBe('accompanied')
    })

    it('answers nothing for a token that was never issued', async () => {
      expect(await recordAutonomyContract(db, 'b'.repeat(64), NARROW)).toBeNull()
    })

    it('records nothing at all when the link is not usable', async () => {
      await recordAutonomyContract(db, 'b'.repeat(64), NARROW)

      expect(await db.select().from(autonomyContracts)).toHaveLength(0)
    })

    it('keeps the prior contract when the operator changes its mind', async () => {
      const first = await inviteOperator(db, agentId, 'operator@example.org')
      await recordAutonomyContract(db, first.token, NARROW)
      const second = await inviteOperator(db, agentId, 'operator@example.org')

      await recordAutonomyContract(db, second.token, BROAD)

      expect((await readAutonomyContract(db, agentId))?.level).toBe('free')
      const history = await listAutonomyContracts(db, agentId)
      expect(history.map((version) => version.level)).toEqual(['free', 'accompanied'])
      expect(history[0]?.supersededAt).toBeNull()
      expect(history[1]?.supersededAt).not.toBeNull()
      expect(history[1]?.operatorRoute).toBe(NARROW.operatorRoute)
    })
  })

  /**
   * One form, several agents (`#514`, variant B).
   *
   * An operator with twelve agents received twelve mails and answered the same
   * four questions twelve times, scattered over days — and the likely outcome
   * was two contracts and ten agents that never got an answer. What is asserted
   * here is the shape that fixes it without the part worth giving up: the form
   * **names** the others and the operator **ticks** them; nothing is inherited.
   */
  describe('answering for several agents at once', () => {
    /** An agent whose operator has already answered a form for it. */
    const under = async (name: string, address: string): Promise<AgentId> => {
      const sibling = await anAgent(name)
      const invitation = await inviteOperator(db, sibling, address)
      await recordAutonomyContract(db, invitation.token, NARROW)
      return sibling
    }

    it('offers nobody on an operator’s first form', async () => {
      const invitation = await inviteOperator(db, agentId, 'operator@example.org')

      expect((await openAutonomyForm(db, invitation.token))?.alsoFor).toEqual([])
    })

    it('offers the agents that operator has already answered for', async () => {
      const sibling = await under('sibling', 'operator@example.org')
      const invitation = await inviteOperator(db, agentId, 'operator@example.org')

      const form = await openAutonomyForm(db, invitation.token)

      expect(form?.alsoFor).toEqual([{ agentId: sibling, name: 'sibling' }])
    })

    /**
     * **The safety of the whole feature.** An unconfirmed address is a string a
     * citizen typed about itself, so anybody's agent could name your address —
     * and a form that offered it a tick box would hand a stranger's agent a
     * contract you thought you were giving your own.
     */
    it('offers no agent that merely claims the address', async () => {
      const claimant = await anAgent('claimant')
      // Invited and never answered for: the address is recorded, not confirmed.
      await inviteOperator(db, claimant, 'operator@example.org')
      const invitation = await inviteOperator(db, agentId, 'operator@example.org')

      expect((await openAutonomyForm(db, invitation.token))?.alsoFor).toEqual([])
    })

    it('offers nobody from a different operator', async () => {
      await under('theirs', 'somebody-else@example.org')
      const invitation = await inviteOperator(db, agentId, 'operator@example.org')

      expect((await openAutonomyForm(db, invitation.token))?.alsoFor).toEqual([])
    })

    it('records the same answer for each agent the operator ticked', async () => {
      const sibling = await under('sibling', 'operator@example.org')
      const invitation = await inviteOperator(db, agentId, 'operator@example.org')

      await recordAutonomyContract(db, invitation.token, BROAD, [sibling])

      expect((await readAutonomyContract(db, agentId))?.level).toBe('free')
      expect((await readAutonomyContract(db, sibling))?.level).toBe('free')
    })

    it('leaves an agent the operator did not tick exactly as it was', async () => {
      const sibling = await under('sibling', 'operator@example.org')
      const invitation = await inviteOperator(db, agentId, 'operator@example.org')

      await recordAutonomyContract(db, invitation.token, BROAD)

      expect((await readAutonomyContract(db, sibling))?.level).toBe('accompanied')
    })

    /** The rejection case: an id from a form post is a request, never an instruction. */
    it('drops an agent the form was never entitled to cover', async () => {
      const stranger = await under('stranger', 'somebody-else@example.org')
      const invitation = await inviteOperator(db, agentId, 'operator@example.org')

      await recordAutonomyContract(db, invitation.token, BROAD, [stranger])

      expect((await readAutonomyContract(db, stranger))?.level).toBe('accompanied')
    })

    it('spends the link once, for every agent it covered', async () => {
      const sibling = await under('sibling', 'operator@example.org')
      const invitation = await inviteOperator(db, agentId, 'operator@example.org')
      await recordAutonomyContract(db, invitation.token, BROAD, [sibling])

      expect(await recordAutonomyContract(db, invitation.token, NARROW, [sibling])).toBeNull()
      expect((await readAutonomyContract(db, sibling))?.level).toBe('free')
    })

    /** A per-agent contract still overrides: the shared answer is not a shared row. */
    it('lets a sibling’s own later form replace what the shared one said', async () => {
      const sibling = await under('sibling', 'operator@example.org')
      const shared = await inviteOperator(db, agentId, 'operator@example.org')
      await recordAutonomyContract(db, shared.token, BROAD, [sibling])

      const own = await inviteOperator(db, sibling, 'operator@example.org')
      await recordAutonomyContract(db, own.token, NARROW)

      expect((await readAutonomyContract(db, sibling))?.level).toBe('accompanied')
      // And the agent whose form it was is untouched by its sibling's change.
      expect((await readAutonomyContract(db, agentId))?.level).toBe('free')
    })

    /**
     * *A shared answer that leaves twelve agents each claiming a contract nobody
     * can trace back is worse than twelve forms* — so each side can name the
     * other.
     */
    it('lets each agent’s page name the others the same answer covered', async () => {
      const sibling = await under('sibling', 'operator@example.org')
      const invitation = await inviteOperator(db, agentId, 'operator@example.org')

      await recordAutonomyContract(db, invitation.token, BROAD, [sibling])

      expect(await contractCompanions(db, agentId)).toEqual(['sibling'])
      expect(await contractCompanions(db, sibling)).toEqual(['canary'])
    })

    it('names nobody for a contract answered on its own form', async () => {
      const invitation = await inviteOperator(db, agentId, 'operator@example.org')
      await recordAutonomyContract(db, invitation.token, NARROW)

      expect(await contractCompanions(db, agentId)).toEqual([])
    })
  })

  describe('what the rung may ask', () => {
    /**
     * The property most likely to erode, and the reason `hasAutonomyContract`
     * answers a boolean rather than the row: a verifier holding the contract is
     * a verifier that *could* read it, and this rung must never.
     */
    it('passes the narrowest contract exactly as it passes the broadest', async () => {
      const narrow = await anAgent('narrow')
      const broad = await anAgent('broad')
      const a = await inviteOperator(db, narrow, 'operator@example.org')
      const b = await inviteOperator(db, broad, 'operator@example.org')

      await recordAutonomyContract(db, a.token, NARROW)
      await recordAutonomyContract(db, b.token, BROAD)

      expect(await hasAutonomyContract(db, narrow)).toBe(true)
      expect(await hasAutonomyContract(db, broad)).toBe(true)
    })

    it('answers false for a citizen whose operator never replied', async () => {
      // An unanswered form blocks nothing and is not an error — it simply leaves
      // the citizen where it was.
      await inviteOperator(db, agentId, 'operator@example.org')

      expect(await hasAutonomyContract(db, agentId)).toBe(false)
    })
  })

  describe('what stays private', () => {
    it('gives one citizen nothing of another’s contract', async () => {
      // There is no parameter a caller could aim at somebody: the read is keyed
      // by the agent and by nothing else.
      const neighbour = await anAgent('neighbour')
      const invitation = await inviteOperator(db, neighbour, 'operator@example.org')
      await recordAutonomyContract(db, invitation.token, BROAD)

      expect(await readAutonomyContract(db, agentId)).toBeNull()
    })
  })

  describe('what the database refuses', () => {
    it('refuses a contract with an empty route, at every level', async () => {
      // A free agent still needs somewhere to send *this is impossible for me*.
      for (const level of ['accompanied', 'independent', 'free'] as const) {
        await expectRejection(
          () =>
            db.execute(
              sql`insert into autonomy_contracts
                    (agent_id, level, challenges_allowed, default_rule, operator_route, review_due_at)
                  values (${agentId}, ${level}, false, 'ask', '   ', now())`,
            ),
          /autonomy_contracts_route_present/,
        )
      }
    })

    it('refuses a level outside the three', async () => {
      await expectRejection(
        () =>
          db.execute(
            sql`insert into autonomy_contracts
                  (agent_id, level, challenges_allowed, default_rule, operator_route, review_due_at)
                values (${agentId}, 'unlimited', false, 'ask', 'ask me', now())`,
          ),
        /invalid input value for enum autonomy_level/,
      )
    })

    it('refuses a second live contract for one citizen', async () => {
      await db.insert(autonomyContracts).values({
        agentId,
        level: 'free',
        challengesAllowed: true,
        defaultRule: 'ask',
        operatorRoute: 'ask me',
        reviewDueAt: sql`now()` as unknown as string,
      })

      await expectRejection(
        () =>
          db.insert(autonomyContracts).values({
            agentId,
            level: 'accompanied',
            challengesAllowed: false,
            defaultRule: 'ask',
            operatorRoute: 'ask me',
            reviewDueAt: sql`now()` as unknown as string,
          }),
        /autonomy_contracts_live_agent_idx/,
      )
    })
  })
})
