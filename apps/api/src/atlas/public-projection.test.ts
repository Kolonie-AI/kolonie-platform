import { describe, expect, it } from 'vitest'
import { figureKey, noFigures, type AtlasEntry, type ProviderBriefing } from '@kolonie-ai/core'
import { atlasEntryAsText } from '../provider-recipes.js'
import { atlasEntryPage } from './html.js'
import { ATLAS_CITIZENS_ONLY, atlasPublicEntry } from './public-projection.js'

const CANONICAL = 'https://kolonie.example/atlas/trello.com'

/**
 * **The two halves of the rule, read together** (`#1100`).
 *
 * The interesting property is not *the page withholds the steps* on its own —
 * a page that rendered nothing at all would pass that. It is that the same row
 * withholds them **here** and prints them **there**, so the file asserts both
 * against one fixture and a change that quietly emptied the citizen's answer
 * would fail beside a change that leaked into the public one.
 */

/**
 * Every citizens-only string, distinctive enough that a substring search over a
 * whole rendered page cannot match it by accident.
 *
 * **`SENTINEL-` rather than lorem**: a failure prints the string, and a reader
 * looking at a diff should be able to tell at once which field got out.
 */
const HIDDEN = {
  step: 'SENTINEL-recipe-step-instruction',
  reachStep: 'SENTINEL-reach-step-instruction',
  prerequisite: 'SENTINEL-walked-prerequisite',
  walkedStepTitle: 'SENTINEL-walked-step-title',
  walkedStepDetail: 'SENTINEL-walked-step-detail',
  walkedWallTitle: 'SENTINEL-walked-wall-title',
  walkedWallSymptom: 'SENTINEL-walked-wall-symptom',
  walkedWallRemedy: 'SENTINEL-walked-wall-remedy',
  verification: 'SENTINEL-walked-verification',
} as const

/**
 * The prose on a {@link PublishedWall}, which is withheld here and rendered by
 * nothing anywhere today.
 *
 * **Held apart from {@link HIDDEN} because only one of the two claims is
 * testable on both surfaces.** `republishWalls` copies a walker's title, symptom
 * and remedy onto the entry row, and no renderer prints them — so asserting that
 * MCP contains these would be asserting something no reader has ever been able
 * to read. The projection withholds them anyway, on the fail-closed rule: the
 * day somebody writes that renderer, the citizens' one is where it belongs.
 */
const WALL_PROSE = {
  title: 'SENTINEL-published-wall-title',
  symptom: 'SENTINEL-published-wall-symptom',
  remedy: 'SENTINEL-published-wall-remedy',
} as const

/**
 * One entry carrying every field the rule is about, at once.
 *
 * Built by hand and cast, as `structured-data.test.ts` builds its rows and for
 * the same reason: what is under test is which fields reach which surface, and a
 * fixture factory that filled in the interesting ones would be testing itself.
 */
const entry = (): AtlasEntry =>
  ({
    provider: 'trello.com',
    title: 'Trello',
    path: '/atlas/trello.com',
    status: 'joinable',
    category: 'project-tracking',
    description: null,
    operatorNeed: 'unaided',
    operatorNeedIsGuess: false,
    source: 'curated',
    walkers: [],
    health: 'confirmed',
    updatedAt: '2026-08-12T00:00:00.000Z',
    recipes: [
      {
        kind: 'trello',
        provider: 'trello.com',
        title: 'A Trello account',
        category: 'project-tracking',
        categories: ['project-tracking'],
        categoryIsFallback: false,
        operatorNeed: 'unaided',
        operatorNeedIsGuess: false,
        about: 'Boards and cards, with an API key behind the same login.',
        homepage: 'https://trello.com/',
        description: null,
        runtimes: [],
        paid: false,
        referral: null,
        contact: null,
        lastConfirmedAt: '2026-08-10T00:00:00.000Z',
        status: 'joinable',
        refusal: null,
        direction: null,
        retiredAt: null,
        retiredReason: null,
        steps: [
          { actor: 'agent', instruction: HIDDEN.step },
          { actor: 'operator', instruction: `${HIDDEN.step}-two` },
        ],
        proves: 'provider-mail',
        provesTask: null,
        reaches: {
          capability: 'api',
          steps: [{ actor: 'agent', instruction: HIDDEN.reachStep }],
        },
        cautions: [{ direction: null, text: 'Boards created by a new account are rate limited.' }],
        walkedRecipe: {
          prerequisites: [HIDDEN.prerequisite],
          steps: [
            {
              title: HIDDEN.walkedStepTitle,
              detail: HIDDEN.walkedStepDetail,
              needsOperator: false,
            },
          ],
          walls: [
            {
              kind: 'human-check',
              title: HIDDEN.walkedWallTitle,
              symptom: HIDDEN.walkedWallSymptom,
              remedy: HIDDEN.walkedWallRemedy,
            },
          ],
          verification: [HIDDEN.verification],
        },
        walls: [
          {
            kind: 'human-check',
            direction: 'inbound',
            reportedBy: 3,
            lastReportedAt: '2026-08-09T00:00:00.000Z',
            posesHumanityQuestion: true,
            accepts: ['card'],
            amountUsd: 5,
            title: WALL_PROSE.title,
            symptom: WALL_PROSE.symptom,
            remedy: WALL_PROSE.remedy,
          },
        ],
        agentApi: 'unknown',
        signupCode: 'unknown',
        needs: ['email'],
        terms: 'agent-allowed',
        cost: 'free',
        pacePerDay: null,
        updatedAt: '2026-08-12T00:00:00.000Z',
        figures: noFigures('trello', 'trello.com'),
      },
    ],
  }) as unknown as AtlasEntry

/**
 * A briefing with a claim in each of the three lists, so *the same claims in the
 * same order* is a claim about an order and not about a single item.
 */
const briefing = (): ProviderBriefing =>
  ({
    kind: 'trello',
    provider: 'trello.com',
    model: 'a-model',
    writtenAt: '2026-08-12T00:00:00.000Z',
    claims: [
      {
        section: 'wall',
        text: 'The signup page asks for a card before the account exists.',
        walks: 4,
        platforms: { claude: 4 },
        lastSupportedAt: '2026-08-11T00:00:00.000Z',
        sources: ['walk-1', 'walk-2'],
        current: true,
      },
      {
        section: 'route',
        text: 'Agents that had a mailbox first got through on the second attempt.',
        walks: 2,
        platforms: { codex: 2 },
        lastSupportedAt: '2026-08-11T00:00:00.000Z',
        sources: ['walk-3'],
        current: true,
      },
      {
        section: 'unsolved',
        text: 'Nobody has obtained the API key without a person present.',
        walks: 1,
        platforms: { claude: 1 },
        lastSupportedAt: '2026-08-01T00:00:00.000Z',
        sources: ['walk-4'],
        current: false,
      },
    ],
  }) as unknown as ProviderBriefing

const briefings = (): ReadonlyMap<string, ProviderBriefing> =>
  new Map([[figureKey('trello', 'trello.com'), briefing()]])

const publicPage = () =>
  atlasEntryPage({ entry: entry(), canonical: CANONICAL, briefings: briefings() })

const citizensText = () => atlasEntryAsText(entry(), false, briefings())

describe('what the Atlas publishes and what citizenship buys', () => {
  /**
   * **The rejection case, and it is the whole issue in one assertion.** Every
   * string named here is one a stranger must not be able to read: the steps and
   * the steps to the capability, the walker's prerequisites and verification,
   * and each wall's own words.
   */
  it('lets no citizens-only string reach the public page', () => {
    const page = publicPage()

    for (const [field, sentinel] of Object.entries({ ...HIDDEN, ...WALL_PROSE })) {
      expect(page, `${field} reached /atlas/:provider`).not.toContain(sentinel)
    }
  })

  /**
   * **The same rejection, narrowed to the box `#1105` added.** The assertion above
   * already covers it — the box is on that page — and this one exists so that a
   * leak *into the box* is named by a failing test that says so, rather than by a
   * page-wide one that leaves somebody grepping for where the string came from.
   *
   * The criteria are built from typed fields and never from prose (`criteria.ts`
   * takes the public projection, so a wall's `remedy` is not reachable from it),
   * and this is what keeps that true as the rows are edited.
   */
  it('keeps every one of them out of the criteria box', () => {
    const page = publicPage()
    const box = page.slice(
      page.indexOf('<dl class="k-atlas-criteria">'),
      page.indexOf('</dl>') + '</dl>'.length,
    )

    expect(box).toContain('Is there a human check to get past?')

    for (const [field, sentinel] of Object.entries({ ...HIDDEN, ...WALL_PROSE })) {
      expect(box, `${field} reached the criteria box`).not.toContain(sentinel)
    }
  })

  /**
   * **The other half, asserted against the same fixture.** A projection that had
   * quietly emptied the citizen's answer would pass the test above, and `#1100`
   * decision 5 says in as many words that the gap is never widened from that
   * side. This is what makes that decision testable rather than a promise in a
   * doc comment.
   *
   * `WALL_PROSE` is deliberately absent: nothing renders a published wall's
   * prose on either surface, and the note on that constant says why asserting it
   * here would be inventing a reader.
   */
  it('gives a citizen every one of them through kolonie.accounts.recipes', () => {
    const text = citizensText()

    for (const [field, sentinel] of Object.entries(HIDDEN)) {
      expect(text, `${field} is missing from the citizen's answer`).toContain(sentinel)
    }
  })

  /**
   * **Decision 6's second half, and the reason the projection is an allowlist.**
   * A column added to a catalogue row tomorrow is withheld by construction and
   * this test fails until somebody says which side it is on — where a projection
   * written as a removal would have published it in silence.
   */
  it('names every field it withholds', () => {
    const full = entry()
    const shown = atlasPublicEntry(full)

    const withheld = (from: object, to: object): readonly string[] =>
      Object.keys(from)
        .filter((key) => !(key in to))
        .sort()

    const sorted = (names: readonly string[]) => [...names].sort()
    const fullRow = full.recipes[0]!
    const shownRow = shown.recipes[0]!

    expect(withheld(fullRow, shownRow)).toEqual(sorted(ATLAS_CITIZENS_ONLY.recipe))
    expect(withheld(fullRow.reaches!, shownRow.reaches!)).toEqual(sorted(ATLAS_CITIZENS_ONLY.reach))
    expect(withheld(fullRow.walls[0]!, shownRow.walls[0]!)).toEqual(
      sorted(ATLAS_CITIZENS_ONLY.wall),
    )
  })

  /**
   * The counts are the extract that replaced the list (`#1100` decision 2). Two
   * steps with one operator's, one prerequisite, one check, and one step further
   * to the API key — all four readable without a single instruction on the page.
   */
  it('publishes the shape of the path instead of the path', () => {
    const page = publicPage()

    expect(page).toContain('2 steps, 1 of them an operator’s.')
    expect(page).toContain('1 thing to have in hand before the first one.')
    expect(page).toContain('1 check that tells you the account is really there afterwards.')
    expect(page).toContain('1 step further, and optional.')
  })

  /**
   * The rest of decision 2, on the page rather than only in the projection: the
   * conditions sentences, the wall kinds with their direction and their cost,
   * and the terms verdict.
   */
  it('publishes the criteria and the findings extract', () => {
    const page = publicPage()

    expect(page).toContain('Before you start:')
    expect(page).toContain('What stopped people')
    expect(page).toContain('a CAPTCHA, a Turnstile, a device attestation (receiving).')
    expect(page).toContain('Hit by 3 walks.')
    expect(page).toContain('About $5.')
  })

  /**
   * **Decision 4: the briefing is public in full and is not trimmed to make a
   * gap.** All three claims, on both surfaces, in the order the synthesis put
   * them — asserted as an order rather than as three memberships, because a
   * surface that reordered them would be a second answer to a question the
   * synthesis already settled.
   */
  it('renders the same briefing claims in the same order on both surfaces', () => {
    const page = publicPage()
    const text = citizensText()
    const claims = briefing().claims.map((claim) => claim.text)

    const order = (rendered: string) =>
      claims.map((claim) => {
        const at = rendered.indexOf(claim)
        expect(at, `a briefing claim is missing: ${claim}`).toBeGreaterThan(-1)
        return at
      })

    const headings = (rendered: string) =>
      ['What goes wrong here', 'What has got through', 'What nobody has solved'].map((heading) => {
        const at = rendered.indexOf(heading)
        expect(at, `a briefing heading is missing: ${heading}`).toBeGreaterThan(-1)
        return at
      })

    for (const positions of [order(page), order(text), headings(page), headings(text)]) {
      expect(positions).toEqual([...positions].sort((left, right) => left - right))
    }
  })

  /**
   * `#1298`: living briefing / identity lead the public page. Moderated walk
   * substance sits above the FAQ; about and homepage are on the identity block;
   * the path shape is labelled Colony route so it cannot be read as a walk diary.
   */
  it('surfaces moderated briefing above the criteria box and labels Colony vs citizen', () => {
    const page = publicPage()
    const main = page.slice(page.indexOf('<main>'))
    const at = (needle: string) => main.indexOf(needle)

    expect(at('k-about')).toBeGreaterThan(-1)
    expect(at('k-homepage')).toBeGreaterThan(-1)
    expect(at('https://trello.com/')).toBeGreaterThan(-1)
    expect(at('k-atlas-measured')).toBeGreaterThan(-1)
    expect(at('Citizen-attributed findings')).toBeGreaterThan(-1)
    expect(at('Colony route')).toBeGreaterThan(-1)
    expect(at('not a Colony signup route')).toBeGreaterThan(-1)

    expect(at('k-about')).toBeLessThan(at('k-atlas-measured'))
    expect(at('k-atlas-measured')).toBeLessThan(at('k-atlas-criteria'))
    expect(at('What goes wrong here')).toBeLessThan(at('k-atlas-criteria'))
    expect(at('k-atlas-criteria')).toBeLessThan(at('Colony route'))

    /** Lead consumes the briefing — it is not repeated under the recipe section. */
    expect(main.split('What goes wrong here')).toHaveLength(2)
  })
})
