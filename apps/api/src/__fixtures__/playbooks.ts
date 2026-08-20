import { randomUUID } from 'node:crypto'
import {
  playbookRunSignalsWith,
  type PlaybookJournal,
  now as currentTime,
  PLAYBOOK_EDITABLE_STATUSES,
  PLAYBOOK_FORKABLE_STATUSES,
  emptyPlaybookSignalsTally,
  PLAYBOOK_RUN_OUTCOMES,
  tallyPlaybookSignals,
  type Account,
  type AgentId,
  type Playbook,
  type PlaybookBriefingSplit,
  type PlaybookNoteEntry,
  type PlaybookRun,
  type PlaybookRunOutcome,
  type PlaybookStatus,
  type PlaybookStepProposal,
  type ServedPlaybookBriefingClaim,
} from '@kolonie-ai/core'
import type { PlaybookDependencies, PlaybookPublishedNote } from '../playbooks.js'

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
  /** Seed the briefing split a playbook's `reports` / `get` will serve (`#1251`). */
  readonly setBriefing: (playbookId: string, split: PlaybookBriefingSplit) => void
  /**
   * Seed the approved notes a playbook serves, with the handles they carry
   * (`#1257`).
   *
   * The map of filed runs cannot express one: a note only becomes approved when
   * the moderator writes `notePublished`, and nothing on this fixture moderates.
   * Seeding them directly is what lets a test assert that a handle a citizen
   * declined is absent from a public page.
   */
  readonly setNotes: (playbookId: string, notes: readonly PlaybookPublishedNote[]) => void
  /** Seed the contributors a playbook names, handles and all (`#1255`, `#1257`). */
  readonly setContributors: (
    playbookId: string,
    contributors: readonly {
      readonly handle: string | null
      readonly agentId: AgentId
      readonly contributions: number
      readonly isCreator: boolean
    }[],
  ) => void
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
  /** The run journal (`#1422`) — appended to, never rewritten. */
  const journal: PlaybookJournal[] = []
  /** Pending proposals, keyed by id. Rate limits counted off status === pending. */
  const proposals = new Map<string, PlaybookStepProposal>()
  /** Briefing claims per playbook (`#1251`). Empty until a test seeds one. */
  const briefings = new Map<string, PlaybookBriefingSplit>()
  const emptyBriefing = (): PlaybookBriefingSplit => ({ current: [], demoted: [] })
  /** Approved notes and contributors, seeded rather than derived (`#1257`). */
  const published = new Map<string, readonly PlaybookPublishedNote[]>()
  const contributed = new Map<
    string,
    readonly {
      readonly handle: string | null
      readonly agentId: AgentId
      readonly contributions: number
      readonly isCreator: boolean
    }[]
  >()
  /**
   * Private notes, keyed the way the primary key is (`#1248`).
   *
   * The key is `agentId:playbookId` and not a list, because *one note per
   * citizen × playbook* is the rule the tool is asserted against — a fixture
   * that appended would let a test pass while the real upsert was inserting
   * twice. The agent is in the key rather than a filter afterwards, which is
   * the whole property the privacy assertion rests on: a fixture that scanned
   * for a playbook id and returned the first match would hand one citizen
   * another's words.
   */
  const privateNotes = new Map<string, PlaybookNoteEntry>()

  return {
    setBriefing(playbookId, split) {
      briefings.set(playbookId, split)
    },

    setNotes(playbookId, notes) {
      published.set(playbookId, notes)
    },

    setContributors(playbookId, contributors) {
      contributed.set(playbookId, contributors)
    },

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
        statusReason: playbook.statusReason ?? null,
        statusChangedAt: playbook.statusChangedAt ?? null,
        statusChangedBy: playbook.statusChangedBy ?? null,
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
      /**
       * The run journal (`#1422`), kept in a map keyed the way the real one is
       * indexed. **Appended and never rewritten**, which is the property under
       * test: a fake that replaced would let an append-only assertion pass over
       * a store that does not append.
       */
      async journal(playbookId, limit) {
        return journal
          .filter((one) => one.playbookId === playbookId && one.status === 'approved')
          .slice(-limit)
          .reverse()
          .map((one) => ({
            entryId: one.id,
            entry: one.published ?? '',
            by: null,
            writtenAt: one.writtenAt,
            playbookRevision: one.playbookRevision,
          }))
      },

      async ownJournal(agentId, playbookId) {
        return journal
          .filter((one) => one.agentId === agentId && one.playbookId === playbookId)
          .slice()
          .reverse()
      },

      async writeJournal({ agentId, playbookId, entry }) {
        const written: PlaybookJournal = {
          id: randomUUID(),
          playbookId,
          agentId,
          entry,
          status: 'pending',
          rejectionReason: null,
          published: null,
          playbookRevision: catalogue.find((one) => one.id === playbookId)?.version ?? null,
          writtenAt: currentTime(),
        }
        journal.push(written)
        return written
      },

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
          // `earned` speaks for the signal, so the fixture must not answer differently (`#1419`).
          signals: [...playbookRunSignalsWith(report.signals, report.earned)],
          // The published sentence arrives unjudged, and a replacement replaces it (`#1245`).
          note: report.note ?? null,
          noteStatus: report.note ? 'pending' : null,
          noteRejectionReason: null,
          notePublished: null,
          // Cleared by a report that omits it, exactly as the storage clears it (`#1419`).
          earned: report.earned ?? null,
          playbookRevision: catalogue.find((one) => one.id === playbookId)?.version ?? null,
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

      async activity(playbookId) {
        const runs = [...filed.values()].filter((run) => run.playbookId === playbookId)
        const byOutcome = Object.fromEntries(
          PLAYBOOK_RUN_OUTCOMES.map((outcome) => [outcome, 0]),
        ) as Record<PlaybookRunOutcome, number>
        for (const run of runs) byOutcome[run.outcome] += 1
        return {
          total: runs.length,
          byOutcome,
          byRuntime: {},
          stepFailures: [],
        }
      },

      async signals(playbookId) {
        const runs = [...filed.values()].filter((run) => run.playbookId === playbookId)
        return runs.length === 0 ? emptyPlaybookSignalsTally(0) : tallyPlaybookSignals(runs)
      },

      /**
       * The listing's counts, off the same map (`#1257`).
       *
       * **A playbook nobody has run is absent from the map**, exactly as storage
       * leaves it out: a fixture that returned a zero-filled row would let the
       * index render *0 runs* while the real page renders nothing at all.
       */
      async counts(playbookIds) {
        const wanted = new Set(playbookIds)
        const counted = new Map<
          string,
          { total: number; byOutcome: Record<PlaybookRunOutcome, number> }
        >()
        for (const run of filed.values()) {
          if (!wanted.has(run.playbookId)) continue
          const standing = counted.get(run.playbookId) ?? {
            total: 0,
            byOutcome: Object.fromEntries(
              PLAYBOOK_RUN_OUTCOMES.map((outcome) => [outcome, 0]),
            ) as Record<PlaybookRunOutcome, number>,
          }
          standing.byOutcome[run.outcome] += 1
          standing.total += 1
          counted.set(run.playbookId, standing)
        }
        return counted
      },

      async notes({ playbookId, outcome, cursor, limit = 50 }) {
        if (cursor !== undefined && cursor !== '') {
          // The fixture does not page: any cursor is refused the same way storage
          // refuses one it did not mint, so a test that wants the error path can
          // send one without standing up a previous page.
          return 'invalid-cursor'
        }
        const seeded = published.get(playbookId)
        if (seeded !== undefined) {
          return {
            notes: seeded
              .filter((one) => outcome === undefined || one.outcome === outcome)
              .slice(0, limit),
            nextCursor: null,
          }
        }
        const notes = [...filed.values()]
          .filter(
            (run) =>
              run.playbookId === playbookId &&
              run.noteStatus === 'approved' &&
              run.notePublished !== null &&
              (outcome === undefined || run.outcome === outcome),
          )
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
          .slice(0, limit)
          .map((run) => ({
            noteId: run.id,
            note: run.notePublished as string,
            outcome: run.outcome,
            by: null as string | null,
            filedAt: run.updatedAt,
          }))
        return { notes, nextCursor: null }
      },
    },

    proposals: {
      async propose(input) {
        const openForPlaybook = [...proposals.values()].filter(
          (one) =>
            one.agentId === input.agentId &&
            one.playbookId === input.playbookId &&
            one.status === 'pending',
        ).length
        if (openForPlaybook >= 3)
          return { outcome: 'rate-limited' as const, scope: 'playbook' as const }
        const openTotal = [...proposals.values()].filter(
          (one) => one.agentId === input.agentId && one.status === 'pending',
        ).length
        if (openTotal >= 10) return { outcome: 'rate-limited' as const, scope: 'total' as const }
        const proposal: PlaybookStepProposal = {
          id: randomUUID(),
          playbookId: input.playbookId,
          agentId: input.agentId,
          kind: input.kind,
          position: input.position,
          title: input.title,
          detail: input.detail,
          why: input.why,
          againstVersion: input.againstVersion,
          status: 'pending',
          rejectionReason: null,
          foldedAt: null,
          foldRefusalReason: null,
          createdAt: currentTime(),
          updatedAt: currentTime(),
        }
        proposals.set(proposal.id, proposal)
        return { outcome: 'written' as const, proposal }
      },
      async countOpen(playbookId) {
        return [...proposals.values()].filter(
          (one) => one.playbookId === playbookId && one.status === 'pending',
        ).length
      },
    },

    /**
     * Revisions and contributors (`#1255`).
     *
     * The fixture keeps no revision history of its own — authoring bumps
     * `version` in place. Contributors are the creator alone until a real
     * fold lands in a storage test.
     */
    revisions: {
      async contributors(playbookId) {
        const seeded = contributed.get(playbookId)
        if (seeded !== undefined) return seeded
        const playbook = catalogue.find((one) => one.id === playbookId)
        if (playbook === undefined) return []
        // Playbook.authorAgentId is a plain uuid string; the port brands it.
        const agentId = playbook.authorAgentId as AgentId
        return [
          {
            handle: 'author',
            agentId,
            contributions: 1,
            isCreator: true,
          },
        ]
      },
      async history(playbookId) {
        const playbook = catalogue.find((one) => one.id === playbookId)
        if (playbook === undefined) return []
        const agentId = playbook.authorAgentId as AgentId
        return [
          {
            revision: playbook.version,
            cutAt: playbook.updatedAt,
            proposalIds: [],
            changes: [],
            contributors: [
              {
                handle: 'author',
                agentId,
                contributions: 1,
                isCreator: true,
              },
            ],
          },
        ]
      },
    },

    briefing: {
      async split(playbookId) {
        return briefings.get(playbookId) ?? emptyBriefing()
      },
      async summary(playbookId) {
        const split = briefings.get(playbookId) ?? emptyBriefing()
        return split.current.slice(0, 6) as readonly ServedPlaybookBriefingClaim[]
      },
    },

    /**
     * A citizen's own private note on a playbook (`#1248`).
     *
     * **The agent is in the key and not in a filter afterwards**, which is the
     * whole property the privacy assertion rests on — see the map above. A
     * write with `null` deletes; a write with a string upserts. Nothing here
     * reaches a synthesis or another citizen's read of anything.
     */
    notes: {
      async read(agentId, playbookId, _slug) {
        return privateNotes.get(`${agentId}:${playbookId}`) ?? null
      },
      async write(agentId, playbookId, slug, note) {
        const key = `${agentId}:${playbookId}`
        if (note === null) {
          privateNotes.delete(key)
          return null
        }
        const entry: PlaybookNoteEntry = {
          playbook: slug,
          note,
          writtenAt: currentTime(),
        }
        privateNotes.set(key, entry)
        return entry
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
          statusReason: null,
          statusChangedAt: null,
          statusChangedBy: null,
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
          statusReason: null,
          statusChangedAt: null,
          statusChangedBy: null,
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
