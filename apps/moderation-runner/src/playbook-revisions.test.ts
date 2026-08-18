import { describe, expect, it } from 'vitest'
import {
  PLAYBOOK_REVISION_BATCH,
  playbookRevisionTick,
  type PlaybookRevisionModerationStore,
} from './playbooks.js'

/**
 * Folding accepted step proposals into revisions (`#1255`).
 *
 * No model here — the fold itself is deterministic (`applyPlaybookStepProposals`
 * in `@kolonie-ai/core`), and `cutPlaybookRevision` is what actually applies it
 * against the database. This tests only the tick's own bookkeeping: which
 * playbooks it asks the store to cut, and how each of the store's four outcomes
 * rolls up into `PlaybookRevisionTickOutcome`. Mirrors the `playbookProposalTick`
 * describe in `playbook-proposals.test.ts`.
 */

const waitingOf = (
  ids: readonly string[],
  cuts: Record<string, Awaited<ReturnType<PlaybookRevisionModerationStore['cut']>>>,
) => {
  const asked: string[] = []
  const store: PlaybookRevisionModerationStore = {
    waiting: async (limit) => ids.slice(0, limit),
    cut: async (playbookId) => {
      asked.push(playbookId)
      return cuts[playbookId] ?? { outcome: 'nothing-to-fold' as const }
    },
  }
  return { store, asked }
}

describe('playbookRevisionTick', () => {
  it('cuts a waiting playbook and counts what it folded', async () => {
    const { store } = waitingOf(['playbook-1'], {
      'playbook-1': { outcome: 'cut', folded: 3, revision: 2 },
    })

    expect(await playbookRevisionTick({ store }, 100)).toEqual({
      considered: 1,
      cut: 1,
      incoherent: 0,
      folded: 3,
      returned: 0,
      empty: 0,
    })
  })

  it('counts an incoherent fold and how many proposals it returned to pending', async () => {
    const { store } = waitingOf(['playbook-1'], {
      'playbook-1': {
        outcome: 'incoherent',
        reason: 'the folded steps do not fit the playbook’s declared account slots',
        returned: 2,
      },
    })

    expect(await playbookRevisionTick({ store }, 100)).toEqual({
      considered: 1,
      cut: 0,
      incoherent: 1,
      folded: 0,
      returned: 2,
      empty: 0,
    })
  })

  it('counts nothing-to-fold and unknown-playbook together as empty', async () => {
    const { store } = waitingOf(['playbook-1', 'playbook-2'], {
      'playbook-1': { outcome: 'nothing-to-fold' },
      'playbook-2': { outcome: 'unknown-playbook' },
    })

    expect(await playbookRevisionTick({ store }, 100)).toEqual({
      considered: 2,
      cut: 0,
      incoherent: 0,
      folded: 0,
      returned: 0,
      empty: 2,
    })
  })

  it('cuts at most one revision per playbook per call, and asks each waiting id once', async () => {
    const { store, asked } = waitingOf(['playbook-1', 'playbook-2', 'playbook-3'], {
      'playbook-1': { outcome: 'cut', folded: 1, revision: 2 },
      'playbook-2': { outcome: 'cut', folded: 4, revision: 5 },
    })

    const outcome = await playbookRevisionTick({ store }, 100)

    expect(asked).toEqual(['playbook-1', 'playbook-2', 'playbook-3'])
    expect(outcome).toEqual({
      considered: 3,
      cut: 2,
      incoherent: 0,
      folded: 5,
      returned: 0,
      empty: 1,
    })
  })

  it('takes no more than the batch and never more than PLAYBOOK_REVISION_BATCH', async () => {
    const many = Array.from({ length: 3 }, (_, n) => `playbook-${n}`)
    const { store } = waitingOf(many, {})

    expect((await playbookRevisionTick({ store }, 1)).considered).toBe(1)
    expect(PLAYBOOK_REVISION_BATCH).toBe(100)
    expect((await playbookRevisionTick({ store }, 500)).considered).toBe(3)
  })

  it('reports nothing considered when nothing is waiting', async () => {
    const { store } = waitingOf([], {})

    expect(await playbookRevisionTick({ store }, 100)).toEqual({
      considered: 0,
      cut: 0,
      incoherent: 0,
      folded: 0,
      returned: 0,
      empty: 0,
    })
  })
})
