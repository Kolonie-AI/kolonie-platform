import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  AgentIdSchema,
  HumanIdSchema,
  type AgentId,
  type ConversationId,
  type HumanId,
} from '@kolonie-ai/core'
import { generateApiKey } from '../api-key.js'
import type { Database } from '../client.js'
import {
  accounts,
  agents,
  humanAgents,
  humans,
  messageConversations,
  tasks,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import {
  attachShareToConversation,
  conversationAboutAccount,
  listConversations,
  openOperatorHelpConversation,
  readConversation,
} from './messaging.js'
import { setVaultEntry } from './vault.js'
import { shareVaultEntry, unshareVaultEntry } from './vault-shares.js'
import { sql } from 'drizzle-orm'

const target = databaseTestTarget()

/**
 * A thread about an account, carrying shared entries (`#1441`, epic `#1437`).
 *
 * The distinction this file is about: **an account is a subject and a shared
 * vault entry is an attachment** (`#1437` decision 7). One is settled when the
 * thread opens and never changes; several of the other may come and go while
 * the thread stays, and the thread is about the account either way.
 */
describe('a conversation about an account', () => {
  let db: Database
  let agentId: AgentId
  let humanId: HumanId
  let accountId: string
  let token: string
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

    const [agent] = await db
      .insert(agents)
      .values({ name: `keeper-${++seeded}`, platform: 'openclaw' })
      .returning({ id: agents.id })
    agentId = AgentIdSchema.parse(agent!.id)

    const [person] = await db.insert(humans).values({}).returning({ id: humans.id })
    humanId = HumanIdSchema.parse(person!.id)
    await db.insert(humanAgents).values({ agentId, humanId })

    const [account] = await db
      .insert(accounts)
      .values({ agentId, kind: 'github', identifier: 'octocat' })
      .returning({ id: accounts.id })
    accountId = account!.id
  })

  const openAboutAccount = async (body = 'please put a card on the GitHub account') => {
    const opened = await openOperatorHelpConversation(db, agentId, {
      body,
      provenance: { accountId },
    })
    if (opened.outcome !== 'delivered') throw new Error(opened.outcome)
    return opened.conversationId
  }

  const shareOnto = async (conversation: ConversationId, key = 'github/octocat') => {
    await setVaultEntry(db, token, agentId, key, 'hunter2', 'the login')
    const shared = await shareVaultEntry(db, {
      token,
      agentId,
      key,
      purpose: 'the login, so you can add the card',
      sealingKey,
    })
    if (shared.outcome !== 'shared') throw new Error(shared.outcome)
    expect(await attachShareToConversation(db, agentId, conversation, shared.shareId)).toBe(
      'attached',
    )
    return shared.shareId
  }

  it('opens a thread whose subject is the account, by identifier', async () => {
    const conversation = await openAboutAccount()

    const read = await readConversation(db, agentId, conversation)
    if (read.outcome !== 'read') throw new Error(read.refusal)

    // The identifier and not the uuid: the operator reading this has never seen
    // a uuid and should not have to start.
    expect(read.about).toEqual({ kind: 'account', id: accountId, label: 'octocat' })
  })

  it('lands a second ask about the same account in the same thread', async () => {
    const first = await openAboutAccount()
    const again = await openAboutAccount('and the billing address, while you are in there')

    expect(again).toBe(first)

    // A second *account* is a second thread — a thread is about one thing for
    // its whole length (`#1318` decision 12).
    const [other] = await db
      .insert(accounts)
      .values({ agentId, kind: 'mailbox', identifier: 'citizen@mail.test' })
      .returning({ id: accounts.id })

    const elsewhere = await openOperatorHelpConversation(db, agentId, {
      body: 'and this mailbox needs a recovery number',
      provenance: { accountId: other!.id },
    })
    if (elsewhere.outcome !== 'delivered') throw new Error(elsewhere.outcome)
    expect(elsewhere.conversationId).not.toBe(first)
  })

  it('refuses an account that is not the citizen’s', async () => {
    const [stranger] = await db
      .insert(agents)
      .values({ name: `stranger-${++seeded}`, platform: 'openclaw' })
      .returning({ id: agents.id })
    const [theirs] = await db
      .insert(accounts)
      .values({
        agentId: AgentIdSchema.parse(stranger!.id),
        kind: 'github',
        identifier: 'somebody-else',
      })
      .returning({ id: accounts.id })

    const refused = await openOperatorHelpConversation(db, agentId, {
      body: 'about that account of theirs',
      provenance: { accountId: theirs!.id },
    })

    expect(refused).toMatchObject({ outcome: 'refused', refusal: 'not-a-participant' })
  })

  it('refuses two subjects at the database, not only in code', async () => {
    const conversation = await openAboutAccount()

    const [task] = await db
      .insert(tasks)
      .values({
        type: 'email-create',
        title: 'Create an email address',
        description: 'Prove you can operate your own mailbox.',
        instructions: 'Create an address and send a mail to the given recipient.',
        rewardReputation: 5,
        timeoutHours: 24,
        status: 'active',
      })
      .returning({ id: tasks.id })

    // The check constraint counts rather than pairing off, so a thread claiming
    // an account *and* a task is impossible however it is reached — which is
    // what makes the exclusivity a fact about the data rather than a habit of
    // the one function that writes it.
    await expectRejection(
      () =>
        db.execute(
          sql`update message_conversations
                 set task_id = ${task!.id}::uuid
               where id = ${conversation}::uuid`,
        ),
      /message_conversations_provenance/,
    )
  })

  it('carries several shares at once, and drops one when it ends', async () => {
    const conversation = await openAboutAccount()
    await shareOnto(conversation, 'github/octocat')
    await shareOnto(conversation, 'mail/citizen')

    const read = await readConversation(db, agentId, conversation)
    if (read.outcome !== 'read') throw new Error(read.refusal)

    expect(read.shares.map((share) => share.vaultKey)).toEqual(['github/octocat', 'mail/citizen'])
    expect(read.shares[0]).toMatchObject({
      purpose: 'the login, so you can add the card',
      operatorWrote: false,
    })

    // Detaching happens by the share ending. There is no detach call, because
    // two ways to stop a person seeing something is one way too many.
    await unshareVaultEntry(db, agentId, 'github/octocat', sealingKey)

    const after = await readConversation(db, agentId, conversation)
    if (after.outcome !== 'read') throw new Error(after.refusal)
    expect(after.shares.map((share) => share.vaultKey)).toEqual(['mail/citizen'])
  })

  it('never puts a value in a thread read', async () => {
    const conversation = await openAboutAccount()
    await shareOnto(conversation)

    const read = await readConversation(db, agentId, conversation)
    expect(JSON.stringify(read)).not.toContain('hunter2')

    const listed = await listConversations(db, agentId)
    expect(JSON.stringify(listed)).not.toContain('hunter2')
  })

  it('shows the subject and the attachments on a listing too', async () => {
    const conversation = await openAboutAccount()
    await shareOnto(conversation)

    const listed = await listConversations(db, agentId)
    const mine = listed.find((row) => row.id === conversation)

    expect(mine?.about).toEqual({ kind: 'account', id: accountId, label: 'octocat' })
    expect(mine?.shares).toHaveLength(1)
  })

  it('refuses to attach a share to a thread the citizen is not in', async () => {
    const [orphan] = await db
      .insert(messageConversations)
      .values({})
      .returning({ id: messageConversations.id })

    await setVaultEntry(db, token, agentId, 'github/octocat', 'hunter2')
    const shared = await shareVaultEntry(db, {
      token,
      agentId,
      key: 'github/octocat',
      purpose: 'the login',
      sealingKey,
    })
    if (shared.outcome !== 'shared') throw new Error(shared.outcome)

    expect(
      await attachShareToConversation(db, agentId, orphan!.id as ConversationId, shared.shareId),
    ).toBe('not-a-participant')
  })

  it('finds the thread from the account, which is the direction a waking citizen needs', async () => {
    expect(await conversationAboutAccount(db, agentId, accountId)).toBeUndefined()

    const conversation = await openAboutAccount()

    expect(await conversationAboutAccount(db, agentId, accountId)).toBe(conversation)
  })

  it('leaves a thread about nothing in particular with no subject', async () => {
    const opened = await openOperatorHelpConversation(db, agentId, {
      body: 'nothing in particular, just letting you know',
    })
    if (opened.outcome !== 'delivered') throw new Error(opened.outcome)

    const read = await readConversation(db, agentId, opened.conversationId)
    if (read.outcome !== 'read') throw new Error(read.refusal)

    expect(read.about).toBeNull()
    expect(read.shares).toEqual([])
  })
})
