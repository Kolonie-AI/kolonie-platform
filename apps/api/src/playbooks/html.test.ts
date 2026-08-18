import { describe, expect, it } from 'vitest'
import {
  emptyPlaybookSignalsTally,
  now as currentTime,
  PLAYBOOK_SIGNALS_UNVERIFIED_LABEL,
  type Playbook,
  type PlaybookRunOutcome,
  type ServedPlaybookBriefingClaim,
} from '@kolonie-ai/core'
import {
  PLAYBOOK_NOTES_SHOWN,
  playbookEntryPage,
  playbookIndexPage,
  type PlaybookPageLife,
  type PlaybookPageNote,
  type PlaybookPageRuns,
} from './html.js'

/**
 * The public playbook page, below the steps (`#1257`).
 *
 * **Written against the renderer rather than the route**, because every rule
 * `#1257` closed is a rule about what reaches the HTML: a demoted claim that
 * never renders cannot be indexed, and a handle a citizen declined cannot be
 * printed. The route test beside this one asserts the wiring — that the page is
 * handed the corpus at all — and these assert what the page does with it.
 */
describe('the public playbook page', () => {
  const CANONICAL = 'https://site.test/playbooks/weekly-triage'

  const aPlaybook = (over: Partial<Playbook> = {}): Playbook => ({
    id: '11111111-1111-4111-8111-111111111111',
    slug: 'weekly-triage',
    status: 'open',
    title: 'The weekly triage pipeline',
    summary: 'What weekly triage is for, in one line.',
    authorAgentId: '22222222-2222-4222-8222-222222222222',
    parentPlaybookId: null,
    version: 3,
    requiredAccounts: [],
    steps: [
      { title: 'Open the console' },
      { title: 'File the report', detail: 'One line per finding.' },
    ],
    inspiration: [],
    refusalReason: null,
    statusReason: null,
    statusChangedAt: null,
    statusChangedBy: null,
    createdAt: currentTime(),
    updatedAt: currentTime(),
    publishedAt: currentTime(),
    ...over,
  })

  const aClaim = (
    over: Partial<ServedPlaybookBriefingClaim> = {},
  ): ServedPlaybookBriefingClaim => ({
    section: 'route',
    text: 'Signing up with the OAuth button skips the captcha.',
    reports: 4,
    platforms: { claude: 4 },
    lastSupportedAt: currentTime(),
    sources: ['note-1', 'note-2'],
    current: true,
    ...over,
  })

  const runs = (over: Partial<PlaybookPageRuns> = {}): PlaybookPageRuns => ({
    total: 0,
    byOutcome: { completed: 0, blocked: 0, abandoned: 0, 'operator-needed': 0 },
    ...over,
  })

  const aLife = (over: Partial<PlaybookPageLife> = {}): PlaybookPageLife => ({
    claims: [],
    runs: runs(),
    signals: emptyPlaybookSignalsTally(0),
    contributors: [],
    notes: [],
    revision: { revision: 3, cutAt: '2026-08-12T09:00:00.000Z' },
    ...over,
  })

  const entry = (life?: PlaybookPageLife, playbook: Playbook = aPlaybook()): string =>
    playbookEntryPage({ playbook, canonical: CANONICAL, ...(life === undefined ? {} : { life }) })

  describe('the excerpt', () => {
    it('groups current claims by section and says how many reports back each', () => {
      const html = entry(
        aLife({
          claims: [
            aClaim({ section: 'route', text: 'The OAuth button skips the captcha.', reports: 4 }),
            aClaim({
              section: 'step',
              text: 'The console refuses a fresh mailbox here.',
              reports: 1,
              stepPosition: 2,
            }),
            aClaim({ section: 'yield', text: 'Two runners reported replies.', reports: 2 }),
            aClaim({ section: 'unsolved', text: 'Nobody has got past the review queue.' }),
          ],
        }),
      )

      expect(html).toContain('What has got through')
      expect(html).toContain('What goes wrong, step by step')
      expect(html).toContain('What running it returned')
      expect(html).toContain('What nobody has solved')
      expect(html).toContain('The OAuth button skips the captcha.')
      expect(html).toContain('4 reports')
      expect(html).toContain('1 report.')
      expect(html).toContain('Step 2:')
    })

    /**
     * The decision `#1257` made and this file exists to keep: a search engine
     * indexes what it is shown, and a superseded claim outlives its correction
     * once it is indexed. Demoted claims stay in the MCP with their age.
     */
    it('renders no demoted claim, even when handed one', () => {
      const html = entry(
        aLife({
          claims: [
            aClaim({ text: 'This one still stands.', current: true }),
            aClaim({ text: 'This one was superseded in June.', current: false }),
          ],
        }),
      )

      expect(html).toContain('This one still stands.')
      expect(html).not.toContain('superseded in June')
    })

    it('says the write-up is the Colony’s own and points at the rest of it', () => {
      const html = entry(aLife({ claims: [aClaim()] }))

      expect(html).toContain('No sentence above is a citizen')
      expect(html).toContain('kolonie.playbooks.reports')
    })

    it('says nothing is written up yet rather than printing an empty heading', () => {
      const html = entry(aLife())

      expect(html).toContain('That is an absence and not a poor result.')
    })

    /** `yield` is the one section a reader could mistake for the Colony measuring money. */
    it('labels the yield section unverified', () => {
      const html = entry(
        aLife({ claims: [aClaim({ section: 'yield', text: 'Replies came in.' })] }),
      )

      expect(html).toContain(PLAYBOOK_SIGNALS_UNVERIFIED_LABEL)
    })
  })

  describe('the numbers', () => {
    it('prints the run total, the outcome split and the signals tally', () => {
      const html = entry(
        aLife({
          runs: runs({
            total: 9,
            byOutcome: { completed: 5, blocked: 3, abandoned: 1, 'operator-needed': 0 },
          }),
          signals: { ...emptyPlaybookSignalsTally(9), traffic: 3, ban: 1 },
        }),
      )

      expect(html).toContain('9 runs reported.')
      expect(html).toContain('5 completed, 3 blocked, 1 abandoned')
      expect(html).toContain('1 said the provider suspended or refused the account')
      expect(html).toContain('3 said it produced reach or replies')
      expect(html).toContain(PLAYBOOK_SIGNALS_UNVERIFIED_LABEL)
    })

    /** A closed vocabulary means every key is present; a printed zero is a measurement nobody made. */
    it('leaves an outcome nobody reported out of the split', () => {
      const html = entry(
        aLife({
          runs: runs({
            total: 2,
            byOutcome: { completed: 2, blocked: 0, abandoned: 0, 'operator-needed': 0 },
          }),
        }),
      )

      expect(html).toContain('2 completed.')
      expect(html).not.toContain('0 blocked')
    })

    it('says nobody has run it rather than printing zeros', () => {
      const html = entry(aLife())

      expect(html).toContain('Nobody has reported running this yet')
      expect(html).not.toContain('0 runs reported')
    })
  })

  describe('the revision line', () => {
    it('names the revision, when it was cut, and where the history is', () => {
      const html = entry(aLife({ revision: { revision: 4, cutAt: '2026-08-12T09:00:00.000Z' } }))

      expect(html).toContain('Revision 4')
      expect(html).toContain('2026-08-12')
      expect(html).toContain('kolonie.playbooks.history')
    })

    it('names the revision without a date when no cut was recorded', () => {
      const html = entry(aLife({ revision: { revision: 1, cutAt: null } }))

      expect(html).toContain('Revision 1')
      expect(html).not.toContain('cut on')
    })
  })

  describe('the contributors', () => {
    it('links every handle to its citizen and counts what each contributed', () => {
      const html = entry(
        aLife({
          contributors: [
            { handle: 'first-author', contributions: 1, isCreator: true },
            { handle: 'a-proposer', contributions: 2, isCreator: false },
          ],
        }),
      )

      expect(html).toContain('<a href="/@first-author">first-author</a>')
      expect(html).toContain('wrote it')
      expect(html).toContain('<a href="/@a-proposer">a-proposer</a>')
      expect(html).toContain('2 accepted changes')
    })

    /**
     * `attributed: false` — the opt-out that already exists. The contribution
     * stands; the citizen is not named, and there is no link to follow to one.
     */
    it('keeps an unattributed contribution and prints no handle for it', () => {
      const html = entry(
        aLife({
          contributors: [
            { handle: 'first-author', contributions: 1, isCreator: true },
            { handle: null, contributions: 3, isCreator: false },
          ],
        }),
      )

      expect(html).toContain('A citizen who is not named here — 3 accepted changes')
      expect(html).not.toContain('/@null')
      expect(html).not.toContain('<a href="/@">')
    })
  })

  describe('the notes', () => {
    const aNote = (at: number, over: Partial<PlaybookPageNote> = {}): PlaybookPageNote => ({
      note: `What runner ${at} found.`,
      outcome: 'completed' as PlaybookRunOutcome,
      by: `runner-${at}`,
      filedAt: `2026-08-${String(20 - at).padStart(2, '0')}T09:00:00.000Z`,
      ...over,
    })

    it('prints at most five, in the order it was given them', () => {
      const html = entry(aLife({ notes: [1, 2, 3, 4, 5, 6, 7].map((at) => aNote(at)) }))

      for (const at of [1, 2, 3, 4, 5]) expect(html).toContain(`What runner ${at} found.`)
      expect(html).not.toContain('What runner 6 found.')
      expect(html).not.toContain('What runner 7 found.')
      expect(html.indexOf('What runner 1 found.')).toBeLessThan(
        html.indexOf('What runner 5 found.'),
      )
      expect(PLAYBOOK_NOTES_SHOWN).toBe(5)
    })

    it('says where the rest of them are', () => {
      const html = entry(aLife({ notes: [1, 2, 3, 4, 5, 6].map((at) => aNote(at)) }))

      expect(html).toContain('The rest of them')
      expect(html).toContain('kolonie.playbooks.reports')
    })

    it('prints a note whose author declined attribution without naming anybody', () => {
      const html = entry(aLife({ notes: [aNote(1, { by: null })] }))

      expect(html).toContain('What runner 1 found.')
      expect(html).toContain('A citizen who is not named here')
      expect(html).not.toContain('/@null')
    })
  })

  describe('what the page carries whatever the corpus says', () => {
    it('carries the standfirst saying what a playbook is', () => {
      expect(entry(aLife())).toContain('A playbook is a recipe for a piece of real work')
    })

    /**
     * A deployment that wires no run log serves the page `#1220` served, rather
     * than a page claiming nobody has ever run anything.
     */
    it('renders no living sections at all when nothing was handed to it', () => {
      const html = entry()

      expect(html).toContain('The steps')
      expect(html).not.toContain('The numbers')
      expect(html).not.toContain('Who wrote it')
      expect(html).not.toContain('Revision')
    })
  })

  describe('the structured data', () => {
    it('describes the steps it printed, with the revision and the contributors', () => {
      const html = entry(
        aLife({
          runs: runs({
            total: 4,
            byOutcome: { completed: 4, blocked: 0, abandoned: 0, 'operator-needed': 0 },
          }),
          contributors: [
            { handle: 'first-author', contributions: 1, isCreator: true },
            { handle: null, contributions: 1, isCreator: false },
          ],
        }),
      )

      const block = html.slice(html.indexOf('"@type":"HowTo"'))
      expect(html).toContain('application/ld+json')
      expect(block).toContain('"HowToStep"')
      expect(block).toContain('Open the console')
      expect(block).toContain('"version":3')
      expect(block).toContain('"userInteractionCount":4')
      expect(block).toContain('first-author')
      // The unattributed contributor is counted on the page and named nowhere.
      expect(block).not.toContain('"contributor"')
    })

    /** A blocked page must not arrive in a search result as the answer to *how do I do this*. */
    it('emits no HowTo for a blocked playbook', () => {
      const html = entry(aLife(), aPlaybook({ status: 'blocked' }))

      expect(html).toContain('BreadcrumbList')
      expect(html).not.toContain('HowTo')
    })
  })
})

describe('the public playbook index', () => {
  const CANONICAL = 'https://site.test/playbooks'

  const aPlaybook = (slug: string, id: string): Playbook => ({
    id,
    slug,
    status: 'open',
    title: `The ${slug} pipeline`,
    summary: `What ${slug} is for.`,
    authorAgentId: '22222222-2222-4222-8222-222222222222',
    parentPlaybookId: null,
    version: 1,
    requiredAccounts: [],
    steps: [{ title: 'Do the thing' }],
    inspiration: [],
    refusalReason: null,
    statusReason: null,
    statusChangedAt: null,
    statusChangedBy: null,
    createdAt: currentTime(),
    updatedAt: currentTime(),
    publishedAt: currentTime(),
  })

  it('carries a run count and an outcome split beside each entry', () => {
    const one = aPlaybook('weekly-triage', '11111111-1111-4111-8111-111111111111')
    const two = aPlaybook('inbox-sweep', '33333333-3333-4333-8333-333333333333')

    const html = playbookIndexPage({
      playbooks: [one, two],
      canonical: CANONICAL,
      runs: new Map([
        [
          one.id,
          {
            total: 3,
            byOutcome: { completed: 2, blocked: 1, abandoned: 0, 'operator-needed': 0 },
          },
        ],
      ]),
    })

    expect(html).toContain('3 runs · 2 completed, 1 blocked')
    // The second was never run, and says so rather than reading as a failure.
    expect(html).toContain('not run yet')
    expect(html).not.toContain('0 runs')
  })

  it('says nothing about runs it was handed nothing about', () => {
    const one = aPlaybook('weekly-triage', '11111111-1111-4111-8111-111111111111')

    const html = playbookIndexPage({ playbooks: [one], canonical: CANONICAL })

    expect(html).toContain('not run yet')
  })
})
