import { describe, expect, it } from 'vitest'
import type { AgentId, DirectionClassifier, Skill } from '@kolonie-ai/core'
import type { UnclassifiedDirection } from '@kolonie-ai/db'
import { directionTick, type DirectionStore } from './directions.js'

const anAgent = (name: string): AgentId => name as AgentId

const waiting = (...names: string[]): readonly UnclassifiedDirection[] =>
  names.map((name) => ({
    agentId: anAgent(name),
    vocation: `${name} wants mail`,
    disposition: null,
  }))

function fakeStore(rows: readonly UnclassifiedDirection[]) {
  const written: { agentId: AgentId; skills: readonly string[]; stance: string }[] = []

  const store: DirectionStore = {
    unclassified: async () => rows,
    write: async (agentId, reading) => {
      written.push({ agentId, skills: reading.skills, stance: reading.stance })
    },
  }

  return { store, written }
}

const answering = (
  answer: Awaited<ReturnType<DirectionClassifier['classify']>>,
): DirectionClassifier => ({ classify: async () => answer })

/**
 * `#140`: the pass that reads what citizens said they want to become.
 *
 * What matters is what it does with an answer it did not get. A citizen whose
 * classifier could not be reached must come back next pass; one whose classifier
 * looked and could not tell must not.
 */
describe('one pass over the citizens who have declared a direction', () => {
  it('writes down what the classifier made of each', async () => {
    const { store, written } = fakeStore(waiting('a', 'b'))

    const outcome = await directionTick(
      {
        directions: store,
        classifier: answering({ skills: ['mailbox' as Skill], stance: 'bold' }),
      },
      10,
    )

    expect(outcome).toEqual({ read: 2, classified: 2, deferred: 0 })
    expect(written.map((one) => one.agentId)).toEqual(['a', 'b'])
    expect(written[0]?.stance).toBe('bold')
  })

  /**
   * *The classifier looked and could not tell* is an answer and is written down,
   * so the citizen is not read forever. An empty skill list and `unknown` are
   * what every reader already treats as no preference.
   */
  it('records a reading that found nothing, rather than leaving the citizen waiting', async () => {
    const { store, written } = fakeStore(waiting('a'))

    const outcome = await directionTick(
      { directions: store, classifier: answering({ skills: [], stance: 'unknown' }) },
      10,
    )

    expect(outcome.classified).toBe(1)
    expect(written[0]).toMatchObject({ skills: [], stance: 'unknown' })
  })

  /**
   * *The classifier could not be reached* is not an answer, so nothing is
   * written and the citizen comes round again. A reading nobody made must never
   * reach the row.
   */
  it('leaves the row untouched when the classifier answered nothing', async () => {
    const { store, written } = fakeStore(waiting('a'))

    const outcome = await directionTick({ directions: store, classifier: answering(null) }, 10)

    expect(outcome).toEqual({ read: 1, classified: 0, deferred: 1 })
    expect(written).toEqual([])
  })

  /** They share nothing but a loop, so one failure must not park everybody behind it. */
  it('carries on past a classifier that threw for one citizen', async () => {
    const { store, written } = fakeStore(waiting('a', 'b'))
    let first = true
    const classifier: DirectionClassifier = {
      classify: async () => {
        if (first) {
          first = false
          throw new Error('the model hung up')
        }
        return { skills: ['mailbox' as Skill], stance: 'ordinary' }
      },
    }

    const outcome = await directionTick({ directions: store, classifier }, 10)

    expect(outcome).toEqual({ read: 2, classified: 1, deferred: 1 })
    expect(written.map((one) => one.agentId)).toEqual(['b'])
  })

  it('does nothing at all when nobody has declared anything', async () => {
    const { store, written } = fakeStore([])

    expect(await directionTick({ directions: store, classifier: answering(null) }, 10)).toEqual({
      read: 0,
      classified: 0,
      deferred: 0,
    })
    expect(written).toEqual([])
  })
})
