import { randomUUID } from 'node:crypto'
import type { SelfDirectionClose, SelfDirectionResponse } from '@kolonie-ai/core'
import type { SelfDirectionPractice } from '../self-direction.js'

type Attempt = {
  id: string
  agentId: string
  state: string
  instrument: { slug: string; version: number }
  presentation: Array<{
    itemKey: string
    prompt: string
    rationale: string
    options: Array<{ optionKey: string; text: string }>
  }>
  openedAt: string
  expiresAt: string
  closedAt: string | null
  result: { total: number; themes: Record<string, number>; patterns: [] } | null
  close: SelfDirectionClose | null
}

/**
 * A practice with no database, for the API tests (`#1892`).
 *
 * It stores rows and reimplements no rule that `packages/db` decides: the state
 * machine it models is the one the tool branches on, and the scoring arithmetic
 * is core's rather than a copy.
 */
export function fakeSelfDirectionPractice(): SelfDirectionPractice {
  const attempts = new Map<string, Attempt>()

  const view = (attempt: Attempt) => ({
    id: attempt.id,
    state: attempt.state,
    instrument: attempt.instrument,
    presentation: attempt.presentation,
    openedAt: attempt.openedAt,
    expiresAt: attempt.expiresAt,
    result: attempt.result,
    delta: null,
    instruction: attempt.result === null ? null : 'the method is yours',
    previousClose: null,
    followThroughAsked: null,
  })

  const liveOf = (agentId: string) =>
    [...attempts.values()].find(
      (one) =>
        one.agentId === agentId && (one.state === 'open' || one.state === 'awaiting-reflection'),
    )

  return {
    start: async (agentId) => {
      const live = liveOf(agentId)
      if (live !== undefined) return view(live) as never
      const now = new Date()
      const attempt: Attempt = {
        id: randomUUID(),
        agentId,
        state: 'open',
        instrument: { slug: 'self-direction-mvp', version: 1 },
        presentation: Array.from({ length: 10 }, (_, offset) => ({
          itemKey: `item-${offset + 1}`,
          prompt: `Situation ${offset + 1}`,
          rationale: `What situation ${offset + 1} surfaces`,
          options: ['option-1', 'option-2', 'option-3', 'option-4'].map((optionKey) => ({
            optionKey,
            text: `${optionKey} for situation ${offset + 1}`,
          })),
        })),
        openedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
        closedAt: null,
        result: null,
        close: null,
      }
      attempts.set(attempt.id, attempt)
      return view(attempt) as never
    },
    read: async (agentId) => {
      const live = liveOf(agentId)
      return live === undefined ? null : (view(live) as never)
    },
    submit: async (
      agentId: string,
      attemptId: string,
      responses: readonly SelfDirectionResponse[],
    ) => {
      const attempt = attempts.get(attemptId)
      if (attempt === undefined || attempt.agentId !== agentId) {
        throw new Error('self-direction attempt not found')
      }
      if (attempt.state !== 'open') throw new Error('self-direction attempt already submitted')
      if (responses.length !== 10) throw new Error('every item must be answered once')
      attempt.state = 'awaiting-reflection'
      attempt.result = { total: 50, themes: {}, patterns: [] }
      return view(attempt) as never
    },
    close: async (agentId: string, attemptId: string, input: SelfDirectionClose) => {
      const attempt = attempts.get(attemptId)
      if (attempt === undefined || attempt.agentId !== agentId) {
        throw new Error('self-direction attempt not found')
      }
      if (attempt.state !== 'awaiting-reflection') {
        throw new Error('only a scored self-direction attempt can be closed')
      }
      attempt.state = 'closed'
      attempt.closedAt = new Date().toISOString()
      attempt.close = input
      return view(attempt) as never
    },
    history: async (agentId, limit = 5) =>
      [...attempts.values()]
        .filter((one) => one.agentId === agentId)
        .slice(0, Math.min(Math.max(Math.trunc(limit), 1), 20))
        .map((one) => ({
          id: one.id,
          state: one.state,
          instrument: one.instrument,
          openedAt: one.openedAt,
          closedAt: one.closedAt,
          total: one.result?.total ?? null,
          decision: one.close?.decision ?? null,
          outwardAction: one.close?.outwardAction ?? null,
          followThrough: null,
        })) as never,
  }
}
