import { describe, expect, it } from 'vitest'
import { AgentIdSchema, TaskIdSchema } from './ids.js'

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
    expect(TaskIdSchema.safeParse('not-a-uuid').success).toBe(false)
  })

  it('keeps branded ids distinct at the type level', () => {
    const agentId = AgentIdSchema.parse(VALID_UUID)

    // The brands are erased at runtime — this is a compile-time guarantee only.
    // @ts-expect-error an AgentId is not assignable to a TaskId
    const taskId: ReturnType<typeof TaskIdSchema.parse> = agentId
    expect(taskId).toBe(VALID_UUID)
  })
})
