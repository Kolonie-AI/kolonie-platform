import { randomBytes } from 'node:crypto'
import type { AgentId } from '@kolonie-ai/core'
import type { TelegramBinding } from '@kolonie-ai/db'
import type { TelegramBot, TelegramDesk, TelegramStore } from '../operator-telegram.js'
import { fakeOperatorPages, type FakeOperatorPages } from './autonomy.js'

export interface FakeTelegramBot extends TelegramBot {
  /** Everything the Colony said, in order. */
  readonly sent: readonly { readonly chatId: number; readonly text: string }[]
  /** Make the next sends fail the way a blocked bot fails. */
  readonly block: () => void
}

export interface FakeTelegramStore extends TelegramStore {
  /** Bind without pressing anything, for a test that starts from bound. */
  readonly bind: (agentId: AgentId, chatId: number) => void
  readonly boundChatFor: (agentId: AgentId) => number | undefined
  /**
   * What the chat is told a citizen is called.
   *
   * Its own map rather than a read of `fakeOperatorPages`, whose `nameFor` is a
   * setter — and a citizen with no name set here is `the agent`, which is what
   * every assertion that does not care about names sees.
   */
  readonly named: (agentId: AgentId, name: string) => void
}

/**
 * The desk, in memory (`#793`).
 *
 * **The invariants the database holds are held here too**, for the reason every
 * other fixture in this directory states: a fake more permissive than PostgreSQL
 * lets a test pass against behaviour the real store refuses. Here that means a
 * payload being spent on first use, an expired one being indistinguishable from
 * an unknown one, and `/stop` reaching every citizen the chat answers for.
 */
export function fakeTelegramStore(
  /**
   * The durable pages, shared rather than duplicated — the same argument
   * `fakeOperatorNoteStore` makes. The page token is what the button resolves
   * through in production, so an independent token map here would let a test mint
   * a deep link through a page the revoke path had never heard of.
   */
  pages: FakeOperatorPages = fakeOperatorPages(),
): FakeTelegramStore {
  const chats = new Map<
    AgentId,
    { chatId: number; boundAt: string; unreachableAt: string | null }
  >()
  const starts = new Map<string, { agentId: AgentId; spent: boolean; expired: boolean }>()
  const names = new Map<AgentId, string>()
  const nameOf = (agentId: AgentId): string => names.get(agentId) ?? 'the agent'

  const at = (): string => new Date().toISOString()

  const bindingOf = (agentId: AgentId): TelegramBinding | undefined => {
    const row = chats.get(agentId)
    if (row === undefined) return undefined
    return {
      chatId: row.chatId,
      boundAt: row.boundAt,
      unreachableAt: row.unreachableAt,
    } as TelegramBinding
  }

  const issue = (agentId: AgentId) => {
    // One live payload per citizen, as the partial unique index enforces.
    for (const [token, row] of starts) {
      if (row.agentId === agentId && !row.spent) starts.delete(token)
    }
    const token = randomBytes(18).toString('base64url')
    starts.set(token, { agentId, spent: false, expired: false })
    return { token, expiresAt: at() as never }
  }

  return {
    issueStart: async (agentId) => issue(agentId),
    issueStartForPage: async (token) => {
      const agentId = pages.agentForToken(token)
      return agentId === null ? undefined : issue(agentId)
    },
    redeemStart: async ({ token, chatId }) => {
      const row = starts.get(token)
      if (row === undefined || row.spent || row.expired) return { outcome: 'unusable' }
      row.spent = true

      const existing = chats.get(row.agentId)
      chats.set(row.agentId, { chatId, boundAt: at(), unreachableAt: null })

      return {
        outcome: 'bound',
        agentName: nameOf(row.agentId),
        replaced: existing !== undefined && existing.chatId !== chatId,
      }
    },
    bindingFor: async (agentId) => bindingOf(agentId),
    bindingForPageToken: async (token) => {
      const agentId = pages.agentForToken(token)
      return agentId === null ? undefined : bindingOf(agentId)
    },
    citizensFor: async (chatId) =>
      [...chats.entries()]
        .filter(([, row]) => row.chatId === chatId)
        .map(([agentId]) => ({ agentId, name: nameOf(agentId) })),
    unbind: async (chatId) => {
      const going = [...chats.entries()].filter(([, row]) => row.chatId === chatId)
      for (const [agentId] of going) chats.delete(agentId)
      return going.map(([agentId]) => nameOf(agentId))
    },
    markUnreachable: async (chatId) => {
      for (const row of chats.values()) {
        if (row.chatId === chatId && row.unreachableAt === null) row.unreachableAt = at()
      }
    },
    bind: (agentId, chatId) => {
      chats.set(agentId, { chatId, boundAt: at(), unreachableAt: null })
    },
    boundChatFor: (agentId) => chats.get(agentId)?.chatId,
    named: (agentId, name) => {
      names.set(agentId, name)
    },
  }
}

export function fakeTelegramBot(username = 'KolonieDeskBot'): FakeTelegramBot {
  const sent: { chatId: number; text: string }[] = []
  let blocked = false

  return {
    username,
    sent,
    block: () => {
      blocked = true
    },
    send: async (message) => {
      if (blocked) return { delivered: false, blocked: true, reason: 'status 403' }
      sent.push({ ...message })
      return { delivered: true, blocked: false }
    },
  }
}

/** The whole desk, wired the way `server.ts` wires it. */
export function fakeTelegramDesk(
  pages: FakeOperatorPages = fakeOperatorPages(),
): TelegramDesk & { store: FakeTelegramStore; bot: FakeTelegramBot } {
  return {
    store: fakeTelegramStore(pages),
    bot: fakeTelegramBot(),
    webhookSecret: 'a-webhook-secret-for-tests',
  }
}
