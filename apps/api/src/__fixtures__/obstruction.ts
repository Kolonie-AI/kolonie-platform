import type { AgentId } from '@kolonie-ai/core'
import type { RecordObstruction } from '../obstruction.js'

/** What a mint surface asked the Colony to record. */
export interface Obstruction {
  readonly taskType: string
  readonly agentId: AgentId
}

export interface FakeObstruction {
  readonly record: RecordObstruction
  /** Everything recorded, in order. For assertions only. */
  readonly recorded: () => readonly Obstruction[]
}

/**
 * A stand-in for the recorder every mint surface holds (#170).
 *
 * **It keeps what it was told rather than counting calls**, because the two
 * things worth asserting are both about content: that the task type is the rung
 * the citizen was actually standing on, and that a *successful* mint recorded
 * nothing at all. A counter answers the second and not the first, and the first
 * is where a copy-paste between eleven near-identical modules goes wrong.
 */
export function fakeObstruction(): FakeObstruction {
  const recorded: Obstruction[] = []

  return {
    record: async (taskType, agentId) => {
      recorded.push({ taskType, agentId })
      return true
    },
    recorded: () => recorded,
  }
}

/** The recorder alone, for the many fixtures that never assert on it. */
export const noObstruction: RecordObstruction = async () => true
