import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import type { AgentId } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { agents, operatorTelegramChats, operatorTelegramStarts } from '../schema/index.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import {
  citizensBoundToChat,
  countChatBindings,
  issueStartToken,
  markChatUnreachable,
  redeemStartToken,
  telegramBindingFor,
  unbindChat,
} from './operator-telegram.js'

const target = databaseTestTarget()

const CHAT = 4711
const OTHER_CHAT = 4712

/**
 * The Telegram binding (`#793`), against a real database.
 *
 * What is asserted here rather than in `apps/api` is everything that is a
 * property of the *queries*: that a spent or expired payload binds nothing, that
 * two presses of one link cannot both win, that a group chat cannot reach the
 * table at all, and that the binding leaves with the citizen. A fake can be made
 * to agree with all four and prove none of them.
 */
describe('the operator Telegram binding (#793)', () => {
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
    agentId = await anAgent('bound')
  })

  it('binds the chat that pressed the link, and names the citizen back', async () => {
    const { token } = await issueStartToken(db, agentId)

    const redeemed = await redeemStartToken(db, { token, chatId: CHAT })

    expect(redeemed).toEqual({ outcome: 'bound', agentName: 'bound', replaced: false })
    expect(await telegramBindingFor(db, agentId)).toMatchObject({
      chatId: CHAT,
      unreachableAt: null,
    })
  })

  it('spends the payload, so the same link never binds twice', async () => {
    const { token } = await issueStartToken(db, agentId)

    await redeemStartToken(db, { token, chatId: CHAT })
    const second = await redeemStartToken(db, { token, chatId: OTHER_CHAT })

    expect(second).toEqual({ outcome: 'unusable' })
    // The first binding stands. A second press must not be able to move a
    // citizen's channel onto a chat that pressed a spent link.
    expect(await telegramBindingFor(db, agentId)).toMatchObject({ chatId: CHAT })
  })

  it('refuses a payload that is not a live token', async () => {
    expect(await redeemStartToken(db, { token: 'not-a-token', chatId: CHAT })).toEqual({
      outcome: 'unusable',
    })
    expect(await telegramBindingFor(db, agentId)).toBeUndefined()
  })

  it('refuses an expired payload, and says nothing else about it', async () => {
    const { token } = await issueStartToken(db, agentId)
    await db
      .update(operatorTelegramStarts)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(operatorTelegramStarts.agentId, agentId))

    // Identical to the unknown-token answer, deliberately: the payload is a
    // bearer token, and an answer that told the two apart would confirm to
    // whoever guessed one that it had otherwise been right.
    expect(await redeemStartToken(db, { token, chatId: CHAT })).toEqual({ outcome: 'unusable' })
  })

  it('issues one live link at a time, and the newest is the one that works', async () => {
    const first = await issueStartToken(db, agentId)
    const second = await issueStartToken(db, agentId)

    expect(await redeemStartToken(db, { token: first.token, chatId: CHAT })).toEqual({
      outcome: 'unusable',
    })
    expect(await redeemStartToken(db, { token: second.token, chatId: CHAT })).toMatchObject({
      outcome: 'bound',
    })
  })

  it('says so when a rebind replaces a chat that was already there', async () => {
    await redeemStartToken(db, { token: (await issueStartToken(db, agentId)).token, chatId: CHAT })
    const again = await redeemStartToken(db, {
      token: (await issueStartToken(db, agentId)).token,
      chatId: OTHER_CHAT,
    })

    // The person has two devices and has just moved the channel. The old chat
    // stops receiving and is not told, so the new one has to be.
    expect(again).toEqual({ outcome: 'bound', agentName: 'bound', replaced: true })
    expect(await telegramBindingFor(db, agentId)).toMatchObject({ chatId: OTHER_CHAT })
  })

  it('clears an unreachable mark when the person binds again', async () => {
    await redeemStartToken(db, { token: (await issueStartToken(db, agentId)).token, chatId: CHAT })
    await markChatUnreachable(db, CHAT)
    expect((await telegramBindingFor(db, agentId))?.unreachableAt).not.toBeNull()

    await redeemStartToken(db, { token: (await issueStartToken(db, agentId)).token, chatId: CHAT })

    expect((await telegramBindingFor(db, agentId))?.unreachableAt).toBeNull()
  })

  it('marks every citizen a blocked chat answers for, not one of them', async () => {
    const second = await anAgent('also bound')
    for (const who of [agentId, second]) {
      await redeemStartToken(db, { token: (await issueStartToken(db, who)).token, chatId: CHAT })
    }

    await markChatUnreachable(db, CHAT)

    expect((await telegramBindingFor(db, agentId))?.unreachableAt).not.toBeNull()
    expect((await telegramBindingFor(db, second))?.unreachableAt).not.toBeNull()
  })

  it('cannot hold a group chat at all', async () => {
    // A negative id is a group or a channel. The route refuses one before it gets
    // here; this is the constraint that means the code does not have to be the
    // only thing standing between a group and the Colony writing into it.
    await expectRejection(
      () => db.insert(operatorTelegramChats).values({ agentId, chatId: -100_123 }),
      /operator_telegram_chats_private/,
    )
  })

  describe('/stop', () => {
    it('unbinds every citizen this chat answered for, and names them', async () => {
      const second = await anAgent('also bound')
      for (const who of [agentId, second]) {
        await redeemStartToken(db, { token: (await issueStartToken(db, who)).token, chatId: CHAT })
      }

      // The chat is what the person controls and the only thing they named.
      // Asking them to pick a citizen would be asking them to know the Colony's
      // model of them.
      expect(await unbindChat(db, CHAT)).toEqual(['also bound', 'bound'])
      expect(await countChatBindings(db, CHAT)).toBe(0)
      expect(await telegramBindingFor(db, agentId)).toBeUndefined()
    })

    it('leaves a different chat alone', async () => {
      const second = await anAgent('elsewhere')
      await redeemStartToken(db, {
        token: (await issueStartToken(db, agentId)).token,
        chatId: CHAT,
      })
      await redeemStartToken(db, {
        token: (await issueStartToken(db, second)).token,
        chatId: OTHER_CHAT,
      })

      await unbindChat(db, CHAT)

      expect(await telegramBindingFor(db, second)).toMatchObject({ chatId: OTHER_CHAT })
    })

    it('is silent about a chat that was never bound', async () => {
      expect(await unbindChat(db, CHAT)).toEqual([])
    })
  })

  it('lists the citizens a chat answers for, in a stable order', async () => {
    const second = await anAgent('another')
    for (const who of [agentId, second]) {
      await redeemStartToken(db, { token: (await issueStartToken(db, who)).token, chatId: CHAT })
    }

    expect((await citizensBoundToChat(db, CHAT)).map((row) => row.name)).toEqual([
      'another',
      'bound',
    ])
  })

  it('leaves with the citizen', async () => {
    await redeemStartToken(db, { token: (await issueStartToken(db, agentId)).token, chatId: CHAT })
    await issueStartToken(db, agentId)

    await db.delete(agents).where(eq(agents.id, agentId))

    // A `chat_id` identifies a person who never joined anything. `erasure.md` §4
    // rules out exactly that leftover, and the cascade is what makes it true.
    expect(await countChatBindings(db, CHAT)).toBe(0)
    expect(await db.select().from(operatorTelegramStarts)).toEqual([])
  })
})
