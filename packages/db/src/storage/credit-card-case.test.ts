import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { AgentIdSchema, HumanIdSchema, type AgentId, type HumanId } from '@kolonie-ai/core'
import { generateApiKey } from '../api-key.js'
import type { Database } from '../client.js'
import {
  accounts,
  agents,
  humanAgents,
  humans,
  messages,
  operatorPages,
  vaultShares,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  attachShareToConversation,
  listConversations,
  openOperatorHelpConversation,
  readOperatorConversation,
} from './messaging.js'
import { operatorThreadsForPageToken } from './operator-threads.js'
import { setVaultEntry, getVaultEntry, listVaultEntries } from './vault.js'
import {
  handBackShare,
  movedThreadFor,
  recordShareRead,
  shareVaultEntry,
  unshareVaultEntry,
  vaultSharesWakeupDelta,
  writeShareAddition,
} from './vault-shares.js'

const target = databaseTestTarget()

/**
 * The credit-card case, end to end (`#1442`, epic `#1437`).
 *
 * **This is what the epic is judged on.** `#1439`–`#1441` build the parts; the
 * failure they are correcting is not that any part was missing but that a
 * secret and the reason for it lived in different places — 42 handovers opened
 * and 0 read, 7 drops opened and 0 filled. So the test that matters is the one
 * that walks the seven steps in order and asserts a person could have done it
 * without leaving the thread.
 */
describe('the credit-card case', () => {
  let db: Database
  let agentId: AgentId
  let humanId: HumanId
  let accountId: string
  let token: string
  let pageToken: string
  let seeded = 0

  const sealingKey = 'a-colony-sealing-key-long-enough-to-be-usable'

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db.$client.end()
  })

  beforeEach(async () => {
    await truncateAll(db)
    token = String(generateApiKey())
    pageToken = `page-${++seeded}`

    const [agent] = await db
      .insert(agents)
      .values({ name: `keeper-${seeded}`, platform: 'openclaw' })
      .returning({ id: agents.id })
    agentId = AgentIdSchema.parse(agent!.id)

    const [person] = await db.insert(humans).values({}).returning({ id: humans.id })
    humanId = HumanIdSchema.parse(person!.id)
    await db.insert(humanAgents).values({ agentId, humanId })
    await db
      .insert(operatorPages)
      .values({ agentId, operatorAddress: `op-${seeded}@example.test`, token: pageToken })

    const [account] = await db
      .insert(accounts)
      .values({ agentId, kind: 'github', identifier: 'octocat', provider: 'github.com' })
      .returning({ id: accounts.id })
    accountId = account!.id
  })

  it('walks all seven steps, and the person never leaves the thread', async () => {
    // 1. The agent writes into its operator thread, with the account linked.
    const opened = await openOperatorHelpConversation(db, agentId, {
      body: 'please put a card on the GitHub account',
      provenance: { accountId },
    })
    if (opened.outcome !== 'delivered') throw new Error(opened.outcome)
    const conversation = opened.conversationId

    // 2. It shares the entry that opens that account, attached to that thread.
    await setVaultEntry(db, token, agentId, 'github/octocat', 'hunter2', 'the login')
    const shared = await shareVaultEntry(db, {
      token,
      agentId,
      key: 'github/octocat',
      purpose: 'the login, so you can add the card',
      sealingKey,
    })
    if (shared.outcome !== 'shared') throw new Error(shared.outcome)
    await attachShareToConversation(db, agentId, conversation, shared.shareId)

    // 3. The operator opens the thread from the durable page and sees, in one
    //    object: which account, which entry, and the citizen's purpose line.
    const [thread] = await operatorThreadsForPageToken(db, pageToken, sealingKey)

    expect(thread?.accountIdentifier).toBe('octocat')
    expect(thread?.messages[0]?.body).toBe('please put a card on the GitHub account')
    expect(thread?.shares).toHaveLength(1)
    expect(thread?.shares[0]).toMatchObject({
      vaultKey: 'github/octocat',
      purpose: 'the login, so you can add the card',
      description: 'the login',
    })

    // 4. They read the login. This is the reversal: it is on the page, not
    //    behind a console session they do not have.
    expect(thread?.shares[0]?.value).toBe('hunter2')
    await recordShareRead(db, shared.shareId)

    // 5. They write the new billing PIN into the same entry.
    expect(
      await writeShareAddition(db, { pageToken }, shared.shareId, 'billing PIN 4417', sealingKey),
    ).toEqual({ outcome: 'written' })

    // 6. They answer "done" in the same thread — the ordinary operator reply,
    //    unchanged by any of this.
    await db.execute(
      // A person's answer goes through the page route in production; what this
      // step is asserting is that the thread is still an ordinary thread, so
      // the message is written the ordinary way.
      (await import('drizzle-orm')).sql`
        insert into messages (conversation_id, sender_participant_id, sender_party, sender_label, body)
        select ${conversation}::uuid, p.id, 'operator-human', 'your operator', 'done'
          from message_participants p
         where p.conversation_id = ${conversation}::uuid and p.party = 'operator-human'`,
    )

    // 7. The agent wakes. One line tells it the thread moved, and taking the
    //    entry back hands it the PIN.
    const moved = await movedThreadFor(db, agentId)
    expect(moved).toMatchObject({ conversationId: conversation, about: 'octocat' })

    const counts = await vaultSharesWakeupDelta(db, agentId)
    expect(counts).toMatchObject({ open: 1, read: 1, written: 1 })

    const collected = await unshareVaultEntry(db, agentId, 'github/octocat', sealingKey)
    expect(collected).toMatchObject({
      outcome: 'unshared',
      operatorAddition: 'billing PIN 4417',
      reads: 1,
    })

    // And afterwards: the entry is the citizen's alone again, untouched.
    const entry = await getVaultEntry(db, token, agentId, 'github/octocat')
    expect(entry).toMatchObject({ outcome: 'found', value: 'hunter2' })
    expect(entry.outcome === 'found' && entry.entry.share).toBeNull()
  })

  it('renders the share’s life as a sequence, in order', async () => {
    const opened = await openOperatorHelpConversation(db, agentId, {
      body: 'please put a card on the GitHub account',
      provenance: { accountId },
    })
    if (opened.outcome !== 'delivered') throw new Error(opened.outcome)

    await setVaultEntry(db, token, agentId, 'github/octocat', 'hunter2')
    const shared = await shareVaultEntry(db, {
      token,
      agentId,
      key: 'github/octocat',
      purpose: 'the login',
      sealingKey,
    })
    if (shared.outcome !== 'shared') throw new Error(shared.outcome)
    await attachShareToConversation(db, agentId, opened.conversationId, shared.shareId)

    await recordShareRead(db, shared.shareId)
    await writeShareAddition(db, { pageToken }, shared.shareId, 'billing PIN 4417', sealingKey)
    await handBackShare(db, { pageToken }, shared.shareId)

    const [thread] = await operatorThreadsForPageToken(db, pageToken, sealingKey)

    expect(thread?.shareEvents.map((event) => event.kind)).toEqual([
      'shared',
      'read',
      'written',
      'handed-back',
    ])

    // A handed-back share is a sequence and no longer a box: there is nothing
    // to render, because `handBackShare` cleared the value.
    expect(thread?.shares).toEqual([])
  })

  it('breaks tied event timestamps by lifecycle before share identity', async () => {
    const opened = await openOperatorHelpConversation(db, agentId, {
      body: 'please put a card on the GitHub account',
      provenance: { accountId },
    })
    if (opened.outcome !== 'delivered') throw new Error(opened.outcome)

    const shares: { readonly id: string; readonly key: string }[] = []
    for (const key of ['github/first', 'github/second']) {
      await setVaultEntry(db, token, agentId, key, 'non-sensitive regression fixture')
      const shared = await shareVaultEntry(db, {
        token,
        agentId,
        key,
        purpose: 'regression fixture',
        sealingKey,
      })
      if (shared.outcome !== 'shared') throw new Error(shared.outcome)
      shares.push({ id: shared.shareId, key })
      await attachShareToConversation(db, agentId, opened.conversationId, shared.shareId)
      await recordShareRead(db, shared.shareId)
      await writeShareAddition(
        db,
        { pageToken },
        shared.shareId,
        'non-sensitive regression addition fixture',
        sealingKey,
      )
      await handBackShare(db, { pageToken }, shared.shareId)
    }

    const tiedAt = '2026-08-24T12:00:00.000Z'
    await db
      .update(vaultShares)
      .set({
        sharedAt: tiedAt,
        lastReadAt: tiedAt,
        additionWrittenAt: tiedAt,
        takenBackAt: tiedAt,
      })
      .where(eq(vaultShares.agentId, agentId))

    const [thread] = await operatorThreadsForPageToken(db, pageToken, sealingKey)
    const inboxThread = await readOperatorConversation(db, humanId, opened.conversationId)
    if (inboxThread.outcome !== 'read') throw new Error(inboxThread.refusal)

    const stableShareOrder = shares.toSorted((left, right) => left.id.localeCompare(right.id))
    const expectedEvents = ['shared', 'read', 'written', 'handed-back'].flatMap((kind) =>
      stableShareOrder.map((share) => ({ key: share.key, kind })),
    )

    expect(thread?.shareEvents.map((event) => ({ key: event.vaultKey, kind: event.kind }))).toEqual(
      expectedEvents,
    )
    expect(
      inboxThread.shareEvents.map((event) => ({ key: event.vaultKey, kind: event.kind })),
    ).toEqual(expectedEvents)
    expect(inboxThread.shareEvents).toEqual(thread?.shareEvents)
  })

  it('never turns a share into a message', async () => {
    const opened = await openOperatorHelpConversation(db, agentId, {
      body: 'please put a card on the GitHub account',
      provenance: { accountId },
    })
    if (opened.outcome !== 'delivered') throw new Error(opened.outcome)

    await setVaultEntry(db, token, agentId, 'github/octocat', 'hunter2')
    const shared = await shareVaultEntry(db, {
      token,
      agentId,
      key: 'github/octocat',
      purpose: 'the login',
      sealingKey,
    })
    if (shared.outcome !== 'shared') throw new Error(shared.outcome)
    await attachShareToConversation(db, agentId, opened.conversationId, shared.shareId)
    await recordShareRead(db, shared.shareId)
    await writeShareAddition(db, { pageToken }, shared.shareId, 'billing PIN 4417', sealingKey)

    /**
     * **The thing `#1442` says to get right.** A share is state on the
     * conversation with one lifecycle, visible to both parties — not a chat
     * attachment. Nothing writes it into `messages`, so there is nothing to
     * send, quote or forward: the events are derived from `vault_shares` on
     * every render and stored nowhere.
     */
    const written = await db
      .select({ body: messages.body })
      .from(messages)
      .where(eq(messages.conversationId, opened.conversationId))

    expect(written.map((row) => row.body)).toEqual(['please put a card on the GitHub account'])
    expect(JSON.stringify(written)).not.toContain('hunter2')
    expect(JSON.stringify(written)).not.toContain('4417')

    // And no read of the conversation carries either value.
    const listed = await listConversations(db, agentId)
    expect(JSON.stringify(listed)).not.toContain('hunter2')
    expect(JSON.stringify(listed)).not.toContain('4417')

    const vault = await listVaultEntries(db, token, agentId)
    expect(JSON.stringify(vault)).not.toContain('4417')
  })

  it('says the entry was handed back, when the person finished first', async () => {
    const opened = await openOperatorHelpConversation(db, agentId, {
      body: 'please put a card on the GitHub account',
      provenance: { accountId },
    })
    if (opened.outcome !== 'delivered') throw new Error(opened.outcome)

    await setVaultEntry(db, token, agentId, 'github/octocat', 'hunter2')
    const shared = await shareVaultEntry(db, {
      token,
      agentId,
      key: 'github/octocat',
      purpose: 'the login',
      sealingKey,
    })
    if (shared.outcome !== 'shared') throw new Error(shared.outcome)
    await attachShareToConversation(db, agentId, opened.conversationId, shared.shareId)

    await writeShareAddition(db, { pageToken }, shared.shareId, 'billing PIN 4417', sealingKey)
    await handBackShare(db, { pageToken }, shared.shareId)

    expect(await movedThreadFor(db, agentId)).toMatchObject({
      conversationId: opened.conversationId,
      moved: 'handed-back',
    })

    const [row] = await db.select().from(vaultShares).where(eq(vaultShares.agentId, agentId))
    expect(row?.takenBackBy).toBe('operator')
  })
})
