import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, humanAgents, humanIdentities, humans } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import { issueCodeForAgent } from './human-links.js'
import { mintOperatorClaim, recordOperatorClaim } from './operator-claims.js'
import { issueOperatorPage, openOperatorPage, revokeOperatorPage } from './operator-pages.js'
import { operatorStandingOf } from './operator-standing.js'

const target = databaseTestTarget()

/**
 * The one read behind `kolonie.me`'s and `kolonie.wakeup`'s operator section
 * (`#1013`).
 *
 * Every case here is a state that was previously invisible to the citizen it was
 * about. The reporter had a redeemed console link and no field saying so, so it
 * minted codes at a person who had already answered — which is the first
 * assertion below, from the other side.
 */
describe('where a citizen stands with the person behind it', () => {
  let db: Database
  let agentId: AgentId

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  const aPerson = async (email: string | null): Promise<string> => {
    const [person] = await db.insert(humans).values({}).returning({ id: humans.id })
    if (person === undefined) throw new Error('inserting a person returned no row')

    await db.insert(humanIdentities).values({
      humanId: person.id,
      provider: 'github',
      // Unique per person, which is all this file asks of it.
      subject: person.id,
      email,
    })

    return person.id
  }

  const operates = async (humanId: string): Promise<void> => {
    await db.insert(humanAgents).values({ humanId, agentId })
  }

  beforeEach(async () => {
    await truncateAll(db)
    const [row] = await db
      .insert(agents)
      .values({ name: 'canary', platform: 'openclaw' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    agentId = row.id as AgentId
  })

  it('answers "nobody" for a citizen nobody stands behind, which is most of them', async () => {
    const standing = await operatorStandingOf(db, agentId)

    expect(standing).toEqual({
      consoleLink: { status: 'none', linkedAt: null, reachable: false },
      publicClaim: { status: 'none', handle: null, claimedAt: null },
      pages: { live: 0, lastIssuedAt: null, lastOpenedAt: null },
    })
  })

  it('reports a code nobody has redeemed, which is when minting a second one hurts', async () => {
    await issueCodeForAgent(db, agentId)

    const standing = await operatorStandingOf(db, agentId)

    expect(standing.consoleLink.status).toBe('pending_code')
    expect(standing.consoleLink.linkedAt).toBeNull()
  })

  it('reports the link once it is redeemed, and stops reporting a pending code', async () => {
    await issueCodeForAgent(db, agentId)
    await operates(await aPerson('operator@example.org'))

    const standing = await operatorStandingOf(db, agentId)

    // The state the reporter could not read. An unspent code is still in the
    // table beside it, and saying `pending_code` here is what sent a citizen
    // back to a person who had already finished.
    expect(standing.consoleLink.status).toBe('linked')
    expect(standing.consoleLink.reachable).toBe(true)
    expect(standing.consoleLink.linkedAt).not.toBeNull()
  })

  it('says a linked operator is unreachable when the provider handed over no address', async () => {
    await operates(await aPerson(null))

    const standing = await operatorStandingOf(db, agentId)

    // Linked, signed in, and nothing the Colony mails will arrive — the state
    // in which every symptom looks like an operator who is ignoring the citizen.
    expect(standing.consoleLink).toMatchObject({ status: 'linked', reachable: false })
  })

  it('keeps the two relationships apart: a public claim is not a link', async () => {
    const { claim } = await mintOperatorClaim(db, agentId)
    await recordOperatorClaim(db, agentId, {
      handle: 'someone',
      postUrl: 'https://x.com/someone/status/1',
      claim,
    })

    const standing = await operatorStandingOf(db, agentId)

    expect(standing.publicClaim).toMatchObject({ status: 'claimed', handle: 'someone' })
    expect(standing.publicClaim.claimedAt).not.toBeNull()
    // The post grants no channel, so nothing about the link may move.
    expect(standing.consoleLink.status).toBe('none')
  })

  it('reports a claim string that was minted and never posted', async () => {
    await mintOperatorClaim(db, agentId)

    const standing = await operatorStandingOf(db, agentId)

    expect(standing.publicClaim).toMatchObject({ status: 'pending', handle: null })
  })

  it('counts live pages and says when one was last opened', async () => {
    await issueOperatorPage(db, agentId, 'first@example.org')
    const second = await issueOperatorPage(db, agentId, 'second@example.org')

    const unopened = await operatorStandingOf(db, agentId)
    expect(unopened.pages.live).toBe(2)
    expect(unopened.pages.lastIssuedAt).not.toBeNull()
    // The difference between an answer that is late and one that is not coming.
    expect(unopened.pages.lastOpenedAt).toBeNull()

    await openOperatorPage(db, second)

    const opened = await operatorStandingOf(db, agentId)
    expect(opened.pages.lastOpenedAt).not.toBeNull()
  })

  it('stops counting a page once it is revoked', async () => {
    await issueOperatorPage(db, agentId, 'first@example.org')
    await revokeOperatorPage(db, agentId, 'first@example.org')

    const standing = await operatorStandingOf(db, agentId)

    expect(standing.pages).toEqual({ live: 0, lastIssuedAt: null, lastOpenedAt: null })
  })

  it('carries no address, no token and no code — only what the citizen may act on', async () => {
    await operates(await aPerson('operator@example.org'))
    await issueOperatorPage(db, agentId, 'operator@example.org')

    const standing = await operatorStandingOf(db, agentId)

    // `operator-pages.ts` states the rule: a payload that says what is true and
    // what to do next carries no inbox. Asserted on the serialised whole rather
    // than field by field, so a field added later cannot smuggle one back in.
    expect(JSON.stringify(standing)).not.toContain('operator@example.org')
  })
})
