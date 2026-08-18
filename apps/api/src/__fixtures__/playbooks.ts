import { randomUUID } from 'node:crypto'
import {
  now as currentTime,
  PLAYBOOK_EDITABLE_STATUSES,
  PLAYBOOK_FORKABLE_STATUSES,
  type Account,
  type AgentId,
  type Playbook,
  type PlaybookRun,
  type PlaybookStatus,
} from '@kolonie-ai/core'
import type { PlaybookDependencies } from '../playbooks.js'

/** The one rule both writes share, read from core rather than restated here. */
const editable = (status: PlaybookStatus): boolean =>
  (PLAYBOOK_EDITABLE_STATUSES as readonly PlaybookStatus[]).includes(status)

/** The other list, and the reason it is a second one: a fork starts from what is published. */
const forkable = (status: PlaybookStatus): boolean =>
  (PLAYBOOK_FORKABLE_STATUSES as readonly PlaybookStatus[]).includes(status)

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
  /**
   * Run reports, keyed the way the unique index is (`#1176`).
   *
   * The key is `agentId:playbookId` and not a list, because *one report per
   * citizen × playbook* is the rule the tool is asserted against — a fixture that
   * appended would let a test pass while the real upsert was inserting twice.
   * `id`, `createdAt` and `rewardedAt` survive a replacement here for the same
   * reason they survive it in the database: the row is updated, not remade, and
   * `#1177` pays against `rewardedAt`. It is stamped on the first write and
   * never on a replacement, because that is when the real storage pays — in the
   * write's own transaction rather than in a sweep afterwards.
   */
  const filed = new Map<string, PlaybookRun>()

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
        refusalReason: playbook.refusalReason ?? null,
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

    runs: {
      async record({ playbookId, agentId, report }) {
        const key = `${agentId}:${playbookId}`
        const standing = filed.get(key)
        const run: PlaybookRun = {
          id: standing?.id ?? randomUUID(),
          playbookId,
          agentId,
          outcome: report.outcome,
          did: report.did,
          broke: report.broke ?? null,
          changed: report.changed ?? null,
          discarded: report.discarded ?? null,
          takenStepPositions: report.takenStepPositions ? [...report.takenStepPositions] : null,
          signals: report.signals ? [...report.signals] : [],
          // The published sentence arrives unjudged, and a replacement replaces it (`#1245`).
          note: report.note ?? null,
          noteStatus: report.note ? 'pending' : null,
          noteRejectionReason: null,
          notePublished: null,
          rewardedAt: standing?.rewardedAt ?? currentTime(),
          createdAt: standing?.createdAt ?? currentTime(),
          updatedAt: currentTime(),
        }
        filed.set(key, run)
        return { run, replaced: standing !== undefined }
      },

      /**
       * The same map, read by the same key (`#1178`).
       *
       * **The citizen is in the key and not in a filter afterwards**, which is
       * the whole property the readback is asserted for: a fixture that scanned
       * for a playbook id and returned the first match would let a test pass
       * while the real port handed one citizen another's words.
       */
      async mine(agentId, playbookId) {
        return filed.get(`${agentId}:${playbookId}`) ?? null
      },
    },

    /**
     * The four writes, against the same array the reads see (`#1179`, `#1180`).
     *
     * **The four refusals are reproduced and the ordering between them is too**,
     * because the ordering is the security property: a playbook that is not the
     * caller's answers `not-yours` *before* anything about its status is looked
     * at, so a stranger cannot learn from a refusal which shelf somebody else's
     * draft is on. `apps/api` folds `not-yours` and `unknown-playbook` into one
     * message, and a fixture that decided status first would let that fold pass
     * while the real transaction leaked the difference through timing.
     *
     * What it does not reproduce is the re-parse: storage merges a patch onto
     * the row and hands the whole thing back to `PlaybookDraftSchema`, and that
     * cross-field rule is asserted in `packages/db` against a real database. Here
     * the merge is a spread, so a test that wants the refusal writes the whole
     * `steps` and asserts against the port instead.
     */
    authoring: {
      async draft({ authorAgentId, slug, draft }) {
        if (catalogue.some((playbook) => playbook.slug === slug)) {
          return { outcome: 'slug-taken' }
        }
        const written: Playbook = {
          id: randomUUID(),
          slug,
          status: 'draft',
          refusalReason: null,
          authorAgentId,
          parentPlaybookId: null,
          version: 1,
          title: draft.title,
          summary: draft.summary,
          requiredAccounts: draft.requiredAccounts,
          steps: draft.steps,
          inspiration: draft.inspiration ?? [],
          createdAt: currentTime(),
          updatedAt: currentTime(),
          publishedAt: null,
        }
        catalogue.push(written)
        return { outcome: 'written', playbook: written }
      },

      async update({ authorAgentId, playbookId, patch }) {
        const standing = catalogue.find((playbook) => playbook.id === playbookId)
        if (standing === undefined) return { outcome: 'unknown-playbook' }
        if (standing.authorAgentId !== authorAgentId) return { outcome: 'not-yours' }
        if (!editable(standing.status)) {
          return { outcome: 'not-editable', status: standing.status }
        }

        const written: Playbook = {
          ...standing,
          ...(patch.title === undefined ? {} : { title: patch.title }),
          ...(patch.summary === undefined ? {} : { summary: patch.summary }),
          ...(patch.requiredAccounts === undefined
            ? {}
            : { requiredAccounts: patch.requiredAccounts }),
          ...(patch.steps === undefined ? {} : { steps: patch.steps }),
          ...(patch.inspiration === undefined ? {} : { inspiration: patch.inspiration }),
          version: standing.version + 1,
          updatedAt: currentTime(),
        }
        catalogue.splice(catalogue.indexOf(standing), 1, written)
        return { outcome: 'written', playbook: written }
      },

      async submit({ authorAgentId, playbookId }) {
        const standing = catalogue.find((playbook) => playbook.id === playbookId)
        if (standing === undefined) return { outcome: 'unknown-playbook' }
        if (standing.authorAgentId !== authorAgentId) return { outcome: 'not-yours' }
        if (!editable(standing.status)) {
          return { outcome: 'not-editable', status: standing.status }
        }

        /**
         * `review`, and nothing else (`#1219`).
         *
         * **A submit stopped publishing when a judge arrived**, and this fake
         * has to stop with it: a fixture that publishes in the same call would
         * let every API test assert a catalogue entry the real store no longer
         * writes. `refusalReason` is cleared here because a reason about text
         * the author has since rewritten is a reason about nothing.
         */
        const written: Playbook = {
          ...standing,
          status: 'review',
          refusalReason: null,
          updatedAt: currentTime(),
        }
        catalogue.splice(catalogue.indexOf(standing), 1, written)
        return { outcome: 'written', playbook: written }
      },

      /**
       * Forking, and the one refusal order that differs (`#1180`).
       *
       * **Status is decided before ownership here, and that is not the slip the
       * paragraph above warns about.** A fork reads a playbook the caller did
       * not write — that is the point of it — so there is no ownership check to
       * come first. What stands in for it is that only `open` may be forked, and
       * `open` is on the shelf: a refusal about a published playbook discloses
       * nothing that `kolonie.playbooks.list` does not.
       */
      async fork({ authorAgentId, sourcePlaybookId, slug }) {
        const source = catalogue.find((playbook) => playbook.id === sourcePlaybookId)
        if (source === undefined) return { outcome: 'unknown-playbook' }
        if (!forkable(source.status)) return { outcome: 'not-forkable', status: source.status }
        if (catalogue.some((playbook) => playbook.slug === slug)) {
          return { outcome: 'slug-taken' }
        }

        const written: Playbook = {
          id: randomUUID(),
          slug,
          status: 'draft',
          refusalReason: null,
          authorAgentId,
          parentPlaybookId: source.id,
          version: 1,
          title: source.title,
          summary: source.summary,
          requiredAccounts: source.requiredAccounts.map((account) => ({ ...account })),
          steps: source.steps.map((step) => ({ ...step })),
          inspiration: source.inspiration.map((entry) => ({ ...entry })),
          createdAt: currentTime(),
          updatedAt: currentTime(),
          publishedAt: null,
        }
        catalogue.push(written)
        return { outcome: 'written', playbook: written }
      },
    },
  }
}
