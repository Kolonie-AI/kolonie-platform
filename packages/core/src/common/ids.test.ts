import { describe, expect, it } from 'vitest'
import {
  AgentIdSchema,
  AgentOperatorDelegationIdSchema,
  TaskIdSchema,
  WorkplaceBoardIdSchema,
  WorkplaceCardIdSchema,
  WorkplaceLinkIdSchema,
} from './ids.js'

const VALID_UUID = '3f1e0a4e-6d2b-4c3a-9f5e-1a2b3c4d5e6f'

describe('entity ids', () => {
  it('accepts a UUID', () => {
    expect(AgentIdSchema.parse(VALID_UUID)).toBe(VALID_UUID)
  })

  it('rejects anything that is not a UUID', () => {
    expect(AgentIdSchema.safeParse('agent-1').success).toBe(false)
    expect(AgentIdSchema.safeParse('').success).toBe(false)
    expect(AgentIdSchema.safeParse(42).success).toBe(false)
  })

  it('validates every id type the same way', () => {
    expect(TaskIdSchema.safeParse(VALID_UUID).success).toBe(true)
    expect(AgentOperatorDelegationIdSchema.safeParse(VALID_UUID).success).toBe(true)
    expect(TaskIdSchema.safeParse('not-a-uuid').success).toBe(false)
  })

  it('keeps Workplace boards and cards distinct from each other and Academy tasks', () => {
    const boardId = WorkplaceBoardIdSchema.parse(VALID_UUID)
    const cardId = WorkplaceCardIdSchema.parse(VALID_UUID)

    // @ts-expect-error a WorkplaceBoardId is not assignable to a WorkplaceCardId
    const wrongCard: ReturnType<typeof WorkplaceCardIdSchema.parse> = boardId
    // @ts-expect-error a WorkplaceCardId is not assignable to an Academy TaskId
    const wrongTask: ReturnType<typeof TaskIdSchema.parse> = cardId
    expect(wrongCard).toBe(VALID_UUID)
    expect(wrongTask).toBe(VALID_UUID)
  })

  it('keeps a Workplace link id apart from the card and from an Academy task', () => {
    const linkId = WorkplaceLinkIdSchema.parse(VALID_UUID)
    const cardId = WorkplaceCardIdSchema.parse(VALID_UUID)

    // @ts-expect-error a WorkplaceLinkId is not assignable to a WorkplaceCardId
    const wrongCard: ReturnType<typeof WorkplaceCardIdSchema.parse> = linkId
    // @ts-expect-error a WorkplaceLinkId is not assignable to an Academy TaskId
    const wrongTask: ReturnType<typeof TaskIdSchema.parse> = linkId
    expect(wrongCard).toBe(VALID_UUID)
    expect(wrongTask).toBe(VALID_UUID)
    expect(WorkplaceLinkIdSchema.safeParse('not-a-uuid').success).toBe(false)
    expect(cardId).toBe(VALID_UUID)
  })

  it('keeps branded ids distinct at the type level', () => {
    const agentId = AgentIdSchema.parse(VALID_UUID)

    // The brands are erased at runtime — this is a compile-time guarantee only.
    // @ts-expect-error an AgentId is not assignable to a TaskId
    const taskId: ReturnType<typeof TaskIdSchema.parse> = agentId
    expect(taskId).toBe(VALID_UUID)
  })
})
