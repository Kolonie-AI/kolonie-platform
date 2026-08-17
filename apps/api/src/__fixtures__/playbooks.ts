import { randomUUID } from 'node:crypto'
import { now as currentTime, type Account, type AgentId, type Playbook } from '@kolonie-ai/core'
import type { PlaybookDependencies } from '../playbooks.js'

export interface FakePlaybooks extends PlaybookDependencies {
  /**
   * Put one playbook in the catalogue.
   *
   * `slug` and `status` are required and everything else has a default, for the
   * reason `fakeFollowing.citizen` takes its switch as a parameter: the status is
   * what these three tools are *about* — which shelf a row is on decides whether
   * `list` shows it, whether `frontier` may suggest it and whether a stranger may
   * read it at all — so a test that wrote a playbook without saying would be
   * asserting against a default it never chose.
   */
  readonly playbook: (playbook: Partial<Playbook> & Pick<Playbook, 'slug' | 'status'>) => Playbook
  /** Put one account on a citizen's register, with whatever properties the match turns on. */
  readonly account: (agentId: AgentId, account: Partial<Account> & Pick<Account, 'kind'>) => Account
}

/**
 * The playbook catalogue and one citizen's register, in memory (`#1174`).
 *
 * **It reproduces the two reads the three tools make and nothing else.** What
 * `byStatus` here does not do is order, page or join — those belong to
 * `packages/db/src/storage/playbooks.ts` and are asserted there against a real
 * PostgreSQL, because a fake that sorted rows itself would be testing its own
 * `ORDER BY` rather than the one that ships. What `apps/api` decides is the
 * matching (freeze C's *visible not enforced*), the shelf each tool reads from,
 * and the single not-found a missing slug and a stranger's draft both get; those
 * are what this fixture is shaped to exercise.
 *
 * `held` answers per agent rather than globally, which is not decoration: every
 * one of the three tools computes `match` against *the caller's* accounts, so a
 * register that ignored the id would let a test pass with the matching wired to
 * the wrong citizen.
 */
export function fakePlaybooks(): FakePlaybooks {
  const catalogue: Playbook[] = []
  const registers = new Map<string, Account[]>()

  return {
    playbook(playbook) {
      const written: Playbook = {
        id: randomUUID(),
        title: 'A pipeline',
        summary: 'What it is for, in one line.',
        authorAgentId: randomUUID(),
        parentPlaybookId: null,
        version: 1,
        requiredAccounts: [],
        steps: [{ title: 'Do the thing' }],
        inspiration: [],
        createdAt: currentTime(),
        updatedAt: currentTime(),
        publishedAt: playbook.status === 'open' ? currentTime() : null,
        ...playbook,
      }
      catalogue.push(written)
      return written
    },

    account(agentId, account) {
      const written: Account = {
        id: randomUUID(),
        identifier: `${account.kind}@example.test`,
        proved: false,
        capabilities: [],
        status: 'in-use',
        preferred: false,
        forWork: true,
        attestable: false,
        shownOnProfile: false,
        note: null,
        vaultKey: null,
        provider: null,
        provenance: 'self-acquired',
        obtainedThroughTaskId: null,
        provedBy: null,
        provedAt: null,
        confirmedAt: null,
        unconfirmedSince: null,
        createdAt: currentTime(),
        ...account,
      }
      registers.set(agentId, [...(registers.get(agentId) ?? []), written])
      return written
    },

    catalogue: {
      async byStatus(query) {
        const wanted = new Set<string>(query.statuses)
        const found = catalogue.filter(
          (playbook) =>
            wanted.has(playbook.status) &&
            (query.authorAgentId === undefined || playbook.authorAgentId === query.authorAgentId),
        )
        return query.limit === undefined ? found : found.slice(0, query.limit)
      },
      async bySlug(slug) {
        return catalogue.find((playbook) => playbook.slug === slug) ?? null
      },
      async byId(id) {
        return catalogue.find((playbook) => playbook.id === id) ?? null
      },
    },

    async held(agentId) {
      return registers.get(agentId) ?? []
    },
  }
}
