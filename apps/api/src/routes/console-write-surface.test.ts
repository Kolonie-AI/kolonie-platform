import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { fakeQuests, type FakeQuestDesk } from '../__fixtures__/quests.js'
import { fakeStore, type FakeStore } from '../__fixtures__/store.js'
import { fakeConsole } from '../__fixtures__/console.js'

const CONSOLE_URL = 'https://console.example'
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

let app: FastifyInstance
let store: FakeStore
let quests: FakeQuestDesk

beforeEach(async () => {
  store = fakeStore()
  quests = fakeQuests()
  app = buildApp({
    ...fakeColony(),
    store,
    quests,
    console: { ...fakeConsole(), consoleUrl: CONSOLE_URL },
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

/**
 * What the console may write, and what may read the Colony's own figures.
 *
 * **This was `steward-pages.test.ts`.** `#943` deleted `/review` and `/numbers`
 * along with the rest of the steward console, so the tests that exercised those
 * two pages went with them. The two below did not: neither is about a page, and
 * both are the kind of check that is cheap to keep and expensive to rediscover.
 */

/**
 * **Measuring is not publishing** (`#511`, `kolonie-docs#216`). A Colony of
 * twenty-seven that publishes counts is showing a self-portrait, because most of
 * them are ours — so these three figures are gated exactly as every other figure
 * on `/backend` is, and the obvious next step is the wrong one.
 *
 * The check is a scan rather than a request, because *no route* is a claim about
 * a set and a request can only test the members somebody thought of. The three
 * fields may be named in the object that computes them, in the gated renderer,
 * and in tests. Anywhere else is a surface.
 */
describe('the Colony’s numbers', () => {
  it('reaches no surface outside the gate', () => {
    const allowed = new Set([
      /**
       * The renderer, which `#943` moved here out of the deleted steward
       * console. It is reached from `/backend` and from nowhere else, and
       * `/backend` resolves a signed-in person holding `maintainer`.
       */
      'apps/api/src/console/backend.ts',
      'packages/db/src/storage/colony-numbers.ts',
      /**
       * **One swarm's figure, and not the Colony's** (`kolonie-website#63`).
       *
       * `swarmPortrait` counts the model families inside *one operator's* swarm,
       * which is precisely what `kolonie-docs#216` leaves open while it gates
       * the Colony's own counts: *"any total is a self-portrait"* is an argument
       * about a total, and one operator's own figures are honest because they
       * say whose they are.
       *
       * **Listed rather than renamed**, which was the other way to make this
       * green. A field called `modelFamiliesInSwarm` would have walked past a
       * guard that cannot read intent, and the next person would have had to
       * work out from scratch whether the exemption was earned. It is written
       * here instead, where the rule is.
       *
       * The scan stays exactly as strict for the three Colony-wide fields: the
       * function this file allows cannot answer about the Colony, because it is
       * never given one — it takes an agent and reads outwards to that agent's
       * operator and no further.
       */
      'packages/db/src/storage/swarm.ts',
    ])

    const found = execFileSync(
      'git',
      [
        'grep',
        '--untracked',
        '-l',
        '-E',
        'agentsByRuntime|modelFamilies|modelsUndeclared',
        '--',
        '*.ts',
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    )
      .split('\n')
      .filter(
        (path) => path !== '' && !path.endsWith('.test.ts') && !path.includes('__fixtures__/'),
      )

    // The scan is the whole basis of the check, so finding nothing would pass it
    // by looking in the wrong place.
    expect(found.length).toBeGreaterThan(0)
    expect(found.filter((path) => !allowed.has(path))).toEqual([])
  })
})

/**
 * **A generic admin surface that can edit any row is a permanent invitation to
 * fix production by hand**, and every such fix is a change nobody reviewed and
 * Git never saw. So the console's write surface is enumerated rather than
 * described: adding a route here is a line in this test, and that is where
 * somebody is asked why.
 */
describe('what the console can write', () => {
  /**
   * Fastify's own route tree, read back as full paths.
   *
   * `printRoutes` is the only enumeration Fastify offers after `ready`, and
   * `profile-indexing.test.ts` parses it the same way for the same reason. With
   * `commonPrefix: false` every node sits on its own line, its depth is the
   * indent, and a line carrying `(METHODS)` is a registered route — so the path
   * is the segments down the stack, concatenated.
   *
   * **The tree is why this cannot be a substring search.** `#943` moved these
   * three form families under `/backend/atlas`, and a nested path is never
   * contiguous on one line of the tree: `backend/`, `atlas/` and
   * `drafts/:kind/:provider/publish` are three lines at three depths. A check
   * that looked for the whole path in the printed text would have found nothing
   * and said the route was gone.
   */
  const posts = (): readonly string[] => {
    const stack: string[] = []
    const found: string[] = []

    for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
      const marker = line.indexOf('── ')
      if (marker === -1) continue

      const depth = (marker - 1) / 4
      const rest = line.slice(marker + 3)
      const methods = /\s\(([A-Z, ]+)\)$/.exec(rest)

      stack[depth] = methods === null ? rest : rest.slice(0, methods.index)
      stack.length = depth + 1

      if (methods !== null && (methods[1] ?? '').includes('POST')) {
        found.push(stack.join(''))
      }
    }

    return found.filter((path) => !path.startsWith('/v1/'))
  }

  /**
   * **The maintainer's own write surface, written out.**
   *
   * The rest of the console writes too — an operator posts to
   * `/agents/:agentId/…` about the agents it holds — and that is a person
   * editing their own rows. This list is the other kind: what the Colony's
   * staff may change about somebody else, which is the surface the docstring
   * above is worried about. It is an allow-list rather than a set of `not`s
   * because a `not` only catches the route somebody thought to forbid.
   */
  const BACKEND_WRITES = [
    // The Atlas decisions, all three families. `#943` moved them here from the
    // steward console, beside the page whose forms post to them — the two used
    // to sit behind different guards, so a maintainer who was not also a
    // steward pressed a button on their own page and got a 404.
    //
    // **Nothing publishes or refuses a quest any more** (`#723`). The walked
    // entry route is deliberately different: it writes the Colony's own route
    // onto a provider citizens have measured, and cannot invent one for an
    // entry nobody has walked (`#808`, `#1032`).
    //
    // **Its own segment, and the list is why.** Under `entries` beside the two
    // proposal routes below it, the router folds the two shapes into one node
    // and prints `entries/:kind|:proposalId/…` — at which point this list stops
    // being readable as what the console can write, which is the whole of what
    // this file checks.
    '/backend/atlas/walked/:kind/:provider/publish',
    '/backend/atlas/walked/:kind/:provider/refuse',
    '/backend/atlas/entries/:proposalId/accept',
    '/backend/atlas/entries/:proposalId/refuse',
    '/backend/atlas/providers/:proposalId/accept',
    '/backend/atlas/providers/:proposalId/refuse',
    '/backend/atlas/providers/:proposalId/merge',
    // Answering somebody, which writes nothing a citizen holds.
    '/backend/tickets/notice',
    '/backend/enquiries/:id/handled',
    // The desk (`#1347`): the two things a maintainer may do with a ticket
    // `#1344` routed to a person. Both write on somebody else's ticket, which
    // is why they belong here — but neither touches anything the citizen holds
    // beyond the words they are owed, and there is no route from here that
    // opens, edits or deletes a ticket.
    '/backend/desk/:ticketId/answer',
    '/backend/desk/:ticketId/promote',
    // Taking a suspension off a walker the threshold suspended (`#1097`). **The
    // only direction there is**: nothing imposes one from here, because the
    // count does that inside the verdict that reaches it — so this list is also
    // where a `/backend/refusals/suspend` appearing one day would be caught.
    '/backend/refusals/lift',
    // One named setting at a time, and never a row.
    '/backend/settings/:name',
    '/backend/settings/:name/clear',
  ]

  it('performs no write outside the Atlas decisions and the sponsor’s own quests', () => {
    const found = posts()

    // **A drift test that matches nothing passes forever.** If `printRoutes`
    // changes shape, or the parser above stops reconstructing paths, every
    // assertion below would be satisfied at once by an empty list.
    expect(found.length).toBeGreaterThan(0)

    expect([...found.filter((path) => path.startsWith('/backend/'))].sort()).toEqual(
      [...BACKEND_WRITES].sort(),
    )

    // And the steward console writes nowhere, because `#943` deleted it.
    const paths = found.join('\n')
    expect(paths).not.toContain('/review')
    expect(paths).not.toContain('/curation/')
    expect(paths).not.toContain('/atlas-proposals/')
    expect(paths).not.toContain('/recipe-drafts/')
    expect(paths).not.toContain('/numbers')
  })
})
