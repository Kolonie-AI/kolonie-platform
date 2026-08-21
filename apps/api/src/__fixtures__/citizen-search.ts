import {
  CITIZEN_SEARCH_LIMIT,
  PLAYBOOK_CONTRIBUTION_FORMS,
  type CitizenSearchQuery,
  type PlaybookContributionForm,
  type Skill,
} from '@kolonie-ai/core'
import type { CitizenSearch } from '../citizen-search.js'

export interface FakeCitizenSearch extends CitizenSearch {
  /**
   * Put a citizen in the Colony, with its switch, its skills and its published
   * capabilities.
   *
   * The switch is a parameter rather than a separate call, so a test cannot
   * write a citizen and forget to say which side of the line it is on — the
   * fake has no default for the one thing this surface is about.
   */
  readonly citizen: (citizen: {
    handle: string
    discoverable: boolean
    skills?: readonly string[]
    capabilities?: readonly string[]
    /**
     * The playbooks this citizen contributed to, and how (`#1258`).
     *
     * Keyed by slug, valued by the forms — which is the shape the answer carries.
     * How the three forms are gathered out of three tables is `packages/db`'s
     * decision and is tested there.
     */
    playbooks?: Readonly<Record<string, readonly PlaybookContributionForm[]>>
  }) => void
  /** Flip the switch on a citizen already here, which is what makes *off is immediate* testable. */
  readonly setDiscoverable: (handle: string, discoverable: boolean) => void
  /** What was asked, in order, so a test can assert nothing else was. */
  readonly queries: () => readonly CitizenSearchQuery[]
}

interface Row {
  handle: string
  discoverable: boolean
  skills: readonly string[]
  capabilities: readonly string[]
  playbooks: Readonly<Record<string, readonly PlaybookContributionForm[]>>
}

/**
 * The search, in memory (`#1067`).
 *
 * **It reproduces the switch and the ceiling and nothing else**, because those
 * are the two properties `apps/api` decides. Whether the SQL reads the published
 * capability rather than the pending one is `packages/db`'s decision and is
 * tested there against a real PostgreSQL — a fake that mimicked the review split
 * would be asserting a copy of the rule rather than the rule.
 */
export function fakeCitizenSearch(): FakeCitizenSearch {
  const rows = new Map<string, Row>()
  const asked: CitizenSearchQuery[] = []

  /** The forms this citizen contributed to the asked-for playbook in, if any. */
  const contributedTo = (row: Row, slug: string): readonly PlaybookContributionForm[] =>
    row.playbooks[slug] ?? []

  const matches = (row: Row, query: CitizenSearchQuery): boolean =>
    query.skill !== undefined
      ? row.skills.includes(query.skill)
      : query.playbook !== undefined
        ? contributedTo(row, query.playbook).length > 0
        : row.capabilities.some(
            (tag) => tag.toLowerCase() === (query.capability ?? '').toLowerCase(),
          )

  return {
    citizen({ handle, discoverable, skills = [], capabilities = [], playbooks = {} }) {
      rows.set(handle, { handle, discoverable, skills, capabilities, playbooks })
    },
    setDiscoverable(handle, discoverable) {
      const row = rows.get(handle)
      if (row !== undefined) rows.set(handle, { ...row, discoverable })
    },
    queries: () => asked,
    async find(query) {
      asked.push(query)

      const found = [...rows.values()]
        .filter((row) => row.discoverable && matches(row, query))
        .sort((left, right) => left.handle.toLowerCase().localeCompare(right.handle.toLowerCase()))
        .map((row) => {
          if (query.skill !== undefined) {
            return {
              handle: row.handle,
              matched: { on: 'skill' as const, skill: query.skill as Skill },
            }
          }
          if (query.playbook !== undefined) {
            const slug = query.playbook
            return {
              handle: row.handle,
              matched: {
                on: 'playbook' as const,
                playbook: slug,
                // Always in the declared order, exactly as the storage answers.
                as: PLAYBOOK_CONTRIBUTION_FORMS.filter((form) =>
                  contributedTo(row, slug).includes(form),
                ),
              },
            }
          }
          return {
            handle: row.handle,
            matched: {
              on: 'capability' as const,
              capability: {
                declared:
                  row.capabilities.find(
                    (tag) => tag.toLowerCase() === (query.capability ?? '').toLowerCase(),
                  ) ?? '',
              },
            },
          }
        })

      const shown = found.slice(0, CITIZEN_SEARCH_LIMIT)

      /**
       * **The size of the room, on the same terms the storage computes it**
       * (`#1495`): every discoverable row, whatever was asked. The fake holds no
       * suspended or test rows, so `discoverable` is the whole of `findable()`
       * here.
       */
      const eligible = [...rows.values()].filter((row) => row.discoverable).length

      /**
       * The fake answers *the Academy mints it* for any skill a row in this
       * colony holds, which is the only claim a test with no task table can
       * make honestly. A test about the unknown-slug case says so by asking for
       * a slug nobody holds.
       */
      const skillInAcademy =
        query.skill !== undefined && shown.length === 0
          ? {
              skillInAcademy: [...rows.values()].some((row) =>
                row.skills.includes(query.skill as Skill),
              ),
            }
          : {}

      return {
        found: shown,
        truncated: found.length > CITIZEN_SEARCH_LIMIT,
        eligible,
        ...skillInAcademy,
      }
    },
  }
}
