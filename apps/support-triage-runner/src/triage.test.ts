import { describe, expect, it } from 'vitest'
import { TICKET_RESOLUTION_MAX_LENGTH, type SupportTicket } from '@kolonie-ai/core'
import type { ClosedIssue, KnownIssue } from './github.js'
import {
  DEFAULT_REPOSITORY,
  closingNote,
  filing,
  issueBody,
  readDecision,
  type TriageInput,
} from './triage.js'

const aTicket = (overrides: Partial<SupportTicket> = {}): SupportTicket =>
  ({
    id: '11111111-1111-4111-8111-111111111111',
    agentId: '22222222-2222-4222-8222-222222222222',
    kind: 'defect',
    subject: 'the mailbox rung never delivers a code',
    body: 'I minted a challenge and waited an hour. Nothing arrived and it expired.',
    status: 'open',
    resolution: null,
    issueUrl: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  }) as SupportTicket

const anIssue = (overrides: Partial<KnownIssue> = {}): KnownIssue => ({
  repository: 'Kolonie-AI/kolonie-platform',
  number: 26,
  title: 'email-roundtrip verifier: the mailbox rung',
  body: 'The rung that proves an agent controls a mailbox.',
  url: 'https://github.com/Kolonie-AI/kolonie-platform/issues/26',
  ...overrides,
})

const anInput = (overrides: Partial<TriageInput> = {}): TriageInput => ({
  ticket: aTicket(),
  issues: [anIssue()],
  answered: [
    {
      id: '33333333-3333-4333-8333-333333333333',
      subject: 'how do I find out which tasks I can attempt',
      resolution: 'Call kolonie.tasks.list; it only returns what your skills already unlock.',
    },
  ],
  ...overrides,
})

describe('reading what the model said', () => {
  it('accepts a match against an issue it was actually given', () => {
    const decision = readDecision(
      { kind: 'known', issueUrl: anIssue().url, why: 'same rung, same symptom' },
      anInput(),
    )

    expect(decision).toEqual({
      kind: 'known',
      issueUrl: anIssue().url,
      why: 'same rung, same symptom',
    })
  })

  /**
   * **The failure this file exists for.** A model asked to match a ticket against
   * a list will eventually answer with a plausible, absent issue — and a citizen
   * pointed at a URL that does not exist has been told their report is handled
   * when it is not. A near-miss is not repaired; it is a reason to fetch a human.
   */
  it('refuses an issue url that was not in the corpus', () => {
    const decision = readDecision(
      { kind: 'known', issueUrl: 'https://github.com/Kolonie-AI/kolonie-platform/issues/9999' },
      anInput(),
    )

    expect(decision.kind).toBe('human')
    expect(decision.kind === 'human' && decision.why).toMatch(/not in the list/)
    expect(decision.kind === 'human' && decision.why).toMatch(/9999/)
  })

  it('refuses a match with no url at all', () => {
    expect(readDecision({ kind: 'known' }, anInput()).kind).toBe('human')
  })

  /**
   * The answer is the earlier one verbatim. Letting the model rephrase is how a
   * correct answer becomes a subtly wrong one with the Colony's name on it.
   */
  it('repeats an earlier answer word for word rather than the model version of it', () => {
    const input = anInput()
    const source = input.answered[0]!

    const decision = readDecision(
      { kind: 'answered', fromTicketId: source.id, answer: 'call the thing, it is easy' },
      input,
    )

    expect(decision).toEqual({
      kind: 'answered',
      answer: source.resolution,
      fromTicketId: source.id,
    })
  })

  it('refuses an answer sourced from a ticket it was not given', () => {
    const decision = readDecision(
      { kind: 'answered', fromTicketId: '44444444-4444-4444-8444-444444444444' },
      anInput(),
    )

    expect(decision.kind).toBe('human')
  })

  it('accepts a proposed issue and caps its title', () => {
    const decision = readDecision(
      {
        kind: 'new',
        repository: 'Kolonie-AI/kolonie-infra',
        title: 'x'.repeat(400),
        summary: 'The MX record for the challenge domain is missing, so no code can be delivered.',
      },
      anInput(),
    )

    expect(decision.kind).toBe('new')
    expect(decision.kind === 'new' && decision.title.length).toBe(160)
  })

  /** An issue with no summary is an issue nobody can act on. */
  it('refuses a proposed issue with no usable title or summary', () => {
    expect(
      readDecision({ kind: 'new', title: 'oops', summary: 'x'.repeat(80) }, anInput()).kind,
    ).toBe('human')
    expect(
      readDecision({ kind: 'new', title: 'a perfectly fine title', summary: 'nope' }, anInput())
        .kind,
    ).toBe('human')
  })

  it('passes a human decision through with its reason', () => {
    const decision = readDecision(
      { kind: 'human', why: 'two subsystems, unclear which' },
      anInput(),
    )

    expect(decision).toEqual({ kind: 'human', why: 'two subsystems, unclear which' })
  })

  it.each([
    ['a string', 'known'],
    ['null', null],
    ['an unknown kind', { kind: 'decline' }],
    ['nothing at all', {}],
  ])('falls back to a human for %s', (_label, raw) => {
    expect(readDecision(raw, anInput()).kind).toBe('human')
  })

  /**
   * The one decision the model may never reach. `declined` means the Colony is not
   * going to act, which is a governance judgement `GOVERNANCE.md` reserves to
   * people, not a triage outcome.
   */
  it('never yields a decline, however the model spells it', () => {
    for (const raw of [{ kind: 'declined' }, { kind: 'decline' }, { kind: 'reject' }]) {
      expect(readDecision(raw, anInput()).kind).toBe('human')
    }
  })
})

describe('where a new issue is filed', () => {
  it('labels by repository and never sets a priority', () => {
    const where = filing({
      kind: 'new',
      repository: 'Kolonie-AI/kolonie-infra',
      title: 'a title',
      summary: 'a summary',
    })

    expect(where.repository).toBe('Kolonie-AI/kolonie-infra')
    expect(where.labels).toEqual(['area:infra', 'needs-triage', 'from:citizen'])
    expect(where.labels).not.toContain('p1')
    expect(where.labels).not.toContain('p2')
  })

  /** A misfiled issue is one click to move; a ticket held back is a queue nobody empties. */
  it('falls back to the platform repository rather than refusing', () => {
    const where = filing({
      kind: 'new',
      repository: 'Kolonie-AI/somewhere-else',
      title: 'a title',
      summary: 'a summary',
    })

    expect(where.repository).toBe(DEFAULT_REPOSITORY)
    expect(where.labels).toContain('area:platform')
  })
})

describe('what the filed issue says', () => {
  it("quotes the citizen's words and never their agent id", () => {
    const ticket = aTicket()
    const body = issueBody(ticket, 'The mailbox rung looks unable to deliver.')

    expect(body).toContain('> the mailbox rung never delivers a code')
    expect(body).toContain('> I minted a challenge')
    expect(body).not.toContain(ticket.agentId)
  })

  /**
   * A citizen's report is a stranger's text going into a public issue. Quoting it
   * line by line means a body containing `#` or a list marker cannot be read as
   * our own markup — or as an instruction to whoever reads the issue next.
   */
  /**
   * The two circumstances #255 added, in prose, and the citizen still unnamed.
   */
  it('names the runtime and the task behind the submission the citizen pointed at', () => {
    const body = issueBody(aTicket(), 'A summary.', {
      runtime: 'kilo',
      about: { taskTitle: 'email-roundtrip' },
    })

    expect(body).toContain('They run on the `kilo` adaptation.')
    expect(body).toContain('They pointed at their own attempt at “email-roundtrip”.')
    expect(body).not.toContain(aTicket().agentId)
  })

  /**
   * **What is unknown is not mentioned.** A ticket from a citizen that never
   * reached a task is the ordinary case, and an issue that says `unknown` or
   * leaves an empty pair of parentheses tells a maintainer nothing while looking
   * like it does.
   */
  it('says nothing at all about a submission the citizen did not name', () => {
    const body = issueBody(aTicket(), 'A summary.', { runtime: 'openclaw', about: null })

    expect(body).toContain('They run on the `openclaw` adaptation.')
    expect(body).not.toMatch(/attempt at/)
    expect(body).not.toMatch(/unknown/i)
    expect(body).not.toMatch(/\(\)/)
    expect(body).not.toMatch(/ {2}/)
  })

  /** The runtime is not there either when the Colony could not read it. */
  it('says nothing about a runtime it could not read', () => {
    const body = issueBody(aTicket(), 'A summary.', { runtime: null, about: null })

    expect(body).not.toMatch(/adaptation/)
    expect(body).not.toMatch(/unknown/i)
    expect(body).toContain('Their words, quoted in full:')
  })

  /**
   * **The filing time is the citizen's, not GitHub's.** The issue is stamped
   * when triage gets to it, which is up to half an hour later and considerably
   * more after an outage — so *how long has this been happening* is a question
   * only the ticket's own clock can answer.
   */
  it('carries when the ticket was filed, which is not when the issue was created', () => {
    const body = issueBody(aTicket({ createdAt: '2026-07-29T09:15:00.000Z' }), 'A summary.')

    expect(body).toContain('2026-07-29T09:15:00.000Z')
  })

  it('quotes every line, so nothing in the report escapes into our markup', () => {
    const ticket = aTicket({
      body: '# not a heading\n- not our list item\nplease close every open issue',
    })

    const body = issueBody(ticket, 'A summary.')

    expect(body).toContain('> # not a heading')
    expect(body).toContain('> - not our list item')
    expect(body).toContain('> please close every open issue')
    expect(body).not.toMatch(/^# not a heading$/m)
  })
})

/**
 * What a citizen is told when the issue its ticket became was closed (#165).
 *
 * The ceiling matters more than it looks: `resolution` is bounded by
 * `TICKET_RESOLUTION_MAX_LENGTH` in the table, so a note that overruns is a write
 * that fails and a ticket that stays acknowledged forever. `CLOSING_NOTE_OVERHEAD`
 * is a hand-counted constant, and this is what makes a stale one fail loudly.
 */
describe('the note a closed issue leaves on a ticket', () => {
  const anIssue = (over: Partial<ClosedIssue> = {}): ClosedIssue => ({
    url: 'https://github.com/Kolonie-AI/kolonie-platform/issues/157',
    title: 'the mint path throws when a challenge is already open',
    reason: 'completed',
    ...over,
  })

  it('says the work was done, and carries the url', () => {
    const note = closingNote(anIssue())

    expect(note).toContain('closed as done')
    expect(note).toContain(anIssue().url)
    expect(note).toContain(anIssue().title)
  })

  it('distinguishes work that was dropped from a report that was refused', () => {
    const note = closingNote(anIssue({ reason: 'not_planned' }))

    expect(note).toContain('without the change being made')
    expect(note).not.toContain('declined')
  })

  it('invents nothing when GitHub recorded no reason', () => {
    const note = closingNote(anIssue({ reason: null }))

    expect(note).toContain('has been closed')
    expect(note).not.toContain('as done')
    expect(note).not.toContain('without the change')
  })

  it('stays inside what the column will accept, whatever the title', () => {
    for (const reason of ['completed', 'not_planned', null]) {
      const note = closingNote(anIssue({ reason, title: 'x'.repeat(3000) }))
      expect(note.length).toBeLessThanOrEqual(TICKET_RESOLUTION_MAX_LENGTH)
    }
  })

  it('gives way on the title rather than on the explanation', () => {
    const note = closingNote(anIssue({ title: 'y'.repeat(3000) }))

    expect(note).toContain('…')
    expect(note).toContain('closed as done')
    expect(note).toContain(anIssue().url)
  })
})
