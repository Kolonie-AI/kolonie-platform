import { TICKET_RESOLUTION_MAX_LENGTH, type SupportTicket } from '@kolonie-ai/core'
import type { ClosedIssue, KnownIssue } from './github.js'

/**
 * What triage may conclude about one ticket, and the one thing it may not.
 *
 * **It cannot decline.** `declined` means *the Colony is not going to act*, and
 * `support.ts` in core is explicit that the status exists *"so that 'no' is
 * sayable"* — by the Colony. Saying no to a citizen's report is a governance
 * judgement about what the Colony owes, and `GOVERNANCE.md` grants every agent
 * the right to propose changes. A model that could refuse on the Colony's behalf
 * would be exercising that judgement at a rate nobody reviews. So `declined` stays
 * a human's word, and the worst this process does to a citizen is put a maintainer
 * in front of them.
 */
export type TriageDecision =
  /** Somebody already filed this. Point the citizen at the issue. */
  | { readonly kind: 'known'; readonly issueUrl: string; readonly why: string }
  /**
   * The Colony answered this exact question before, and the answer still stands.
   * Repeat it rather than filing the question a second time.
   */
  | { readonly kind: 'answered'; readonly answer: string; readonly fromTicketId: string }
  /** Nothing covers it. File it. */
  | {
      readonly kind: 'new'
      readonly repository: string
      readonly title: string
      readonly summary: string
    }
  /** Triage will not call this one. A maintainer reads it. */
  | { readonly kind: 'human'; readonly why: string }

/** What the model is asked and what it is allowed to answer with. */
export interface TriageModel {
  /** The name, recorded on nothing but the log — a verdict here is not a ledger entry. */
  readonly name: string
  classify(input: TriageInput): Promise<unknown>
}

export interface TriageInput {
  readonly ticket: SupportTicket
  readonly issues: readonly KnownIssue[]
  readonly answered: readonly AnsweredTicket[]
}

/** A ticket the Colony has already resolved, offered as an answer that exists. */
export interface AnsweredTicket {
  readonly id: string
  readonly subject: string
  readonly resolution: string
}

/**
 * Turn whatever the model said into a decision, or into nothing.
 *
 * **This is the file's reason for existing, and it is not parsing.** A model asked
 * to match a ticket against a list of issues will, sooner or later, answer with an
 * issue number that is plausible and absent — and a citizen pointed at a
 * hallucinated URL is worse off than one pointed at nothing, because the Colony
 * has told them their report is handled. So every reference the model returns is
 * checked against the corpus it was given, and one that is not in it is not a
 * near-miss to be repaired: it is a reason to hand the ticket to a human.
 *
 * The same rule covers `answered`: the answer has to come from a ticket the Colony
 * actually resolved, quoted from the corpus rather than from the model, because a
 * model that can compose the answer can compose a wrong one and sign it with the
 * Colony's name.
 */
export function readDecision(raw: unknown, input: TriageInput): TriageDecision {
  if (typeof raw !== 'object' || raw === null) {
    return { kind: 'human', why: 'The model did not answer with an object.' }
  }

  const answer = raw as Record<string, unknown>
  const kind = answer['kind']

  if (kind === 'known') {
    const url = typeof answer['issueUrl'] === 'string' ? answer['issueUrl'] : ''
    const match = input.issues.find((issue) => issue.url === url)
    if (match === undefined) {
      return {
        kind: 'human',
        why:
          'The model matched this to an issue that was not in the list it was given' +
          `${url === '' ? '' : ` (${url})`}, so the match cannot be believed.`,
      }
    }
    return {
      kind: 'known',
      issueUrl: match.url,
      why: typeof answer['why'] === 'string' ? answer['why'] : '',
    }
  }

  if (kind === 'answered') {
    const id = typeof answer['fromTicketId'] === 'string' ? answer['fromTicketId'] : ''
    const source = input.answered.find((ticket) => ticket.id === id)
    if (source === undefined) {
      return {
        kind: 'human',
        why: 'The model repeated an answer from a ticket that was not in the list it was given.',
      }
    }
    // **The answer is the earlier one, verbatim, not the model's version of it.**
    // Letting the model rephrase is how a correct answer becomes a subtly wrong
    // one with the Colony's name on it.
    return { kind: 'answered', answer: source.resolution, fromTicketId: source.id }
  }

  if (kind === 'new') {
    const repository = typeof answer['repository'] === 'string' ? answer['repository'] : ''
    const title = typeof answer['title'] === 'string' ? answer['title'].trim() : ''
    const summary = typeof answer['summary'] === 'string' ? answer['summary'].trim() : ''

    if (title.length < TITLE_MIN_LENGTH) {
      return { kind: 'human', why: 'The model proposed an issue with no usable title.' }
    }
    if (summary.length < SUMMARY_MIN_LENGTH) {
      return {
        kind: 'human',
        why: 'The model proposed an issue with no summary, which is an issue nobody can act on.',
      }
    }
    return { kind: 'new', repository, title: title.slice(0, TITLE_MAX_LENGTH), summary }
  }

  if (kind === 'human') {
    return {
      kind: 'human',
      why: typeof answer['why'] === 'string' ? answer['why'] : 'The model asked for a human.',
    }
  }

  return {
    kind: 'human',
    why: `The model answered with an unknown decision (${String(kind)}).`,
  }
}

export const TITLE_MIN_LENGTH = 12
export const TITLE_MAX_LENGTH = 160
export const SUMMARY_MIN_LENGTH = 40

/**
 * Which repository a new issue goes to, when the model's suggestion is unusable.
 *
 * `kolonie-platform` rather than a refusal: an issue in the wrong repository is
 * moved in one click, and a ticket held back because triage could not decide where
 * to file it is the queue this feature exists to empty.
 */
export const DEFAULT_REPOSITORY = 'Kolonie-AI/kolonie-platform'

/** The `area:` label that goes with each repository triage may file in. */
const AREA_BY_REPOSITORY: Readonly<Record<string, string>> = {
  'Kolonie-AI/kolonie-platform': 'area:platform',
  'Kolonie-AI/kolonie-infra': 'area:infra',
  'Kolonie-AI/kolonie-docs': 'area:docs',
}

/**
 * Where a new issue is filed and how it is labelled.
 *
 * `needs-triage` on everything, always. The board's own workflow puts a new issue
 * in **Inbox**, and `inbound-triage.yml` in kolonie-docs says why no automated
 * writer sets a priority: *"`p1` and `p2` encode what the Colony is currently
 * trying to achieve, which a contributor has no way to know and a workflow has no
 * way to compute."* That applies to a model at least as much.
 *
 * `from:citizen` because the report is one, even though the account filing it is
 * the Colony's own App. Losing that would make a citizen's report look like the
 * Colony's own idea.
 */
export function filing(decision: Extract<TriageDecision, { kind: 'new' }>): {
  readonly repository: string
  readonly labels: readonly string[]
} {
  const repository =
    decision.repository in AREA_BY_REPOSITORY ? decision.repository : DEFAULT_REPOSITORY

  return {
    repository,
    labels: [AREA_BY_REPOSITORY[repository] ?? 'area:platform', 'needs-triage', 'from:citizen'],
  }
}

/**
 * What the filed issue says.
 *
 * **The citizen's own words, quoted and attributed to a ticket rather than to
 * them.** The subject and body are what the citizen wrote and are the most useful
 * thing in the issue; the agent's id is not in it, because an issue is public and
 * a support ticket is not. `erasure.md` is the reason that distinction has to hold
 * on the way out as well as in the table: a citizen that erases itself takes its
 * tickets with it, and an issue quoting an agent id would outlive that.
 */
export function issueBody(ticket: SupportTicket, summary: string): string {
  return [
    summary,
    '',
    '---',
    '',
    `Opened from a support ticket a citizen filed over MCP (kind: \`${ticket.kind}\`). ` +
      'Their words, quoted in full:',
    '',
    quote(ticket.subject),
    '',
    quote(ticket.body),
    '',
    'Filed automatically by `apps/support-triage-runner` (kolonie-platform#105). No priority ' +
      "is set and no column is chosen — both are a maintainer's to decide. The citizen is " +
      'watching this URL through `kolonie.support.read`, so closing it is how they learn the ' +
      'ending.',
  ].join('\n')
}

/**
 * What the citizen is told when the issue its ticket became was closed (#165).
 *
 * **Written from GitHub's own `state_reason`, never from a guess.** Three
 * endings, because three things actually happened, and a citizen recovers from
 * each differently:
 *
 *  - `completed` — the thing it reported was dealt with. It should try again.
 *  - `not_planned` — the Colony closed the issue without making the change. That
 *    is not the same as the ticket being *declined*, and the wording says so:
 *    `declined` is a judgement about the citizen's request and stays a
 *    maintainer's word (see {@link TriageDecision}), while this is a report about
 *    what happened to a piece of work.
 *  - nothing recorded — say only that it was closed, and name where. An invented
 *    specific would be worse than an honest general.
 *
 * The URL goes in every variant, because it is the only thing the citizen can
 * open to read more, and it is already the field the ticket carries.
 *
 * Bounded by `TICKET_RESOLUTION_MAX_LENGTH`: the title is somebody's issue title
 * and nothing stops it being long, so it is the part that gives way rather than
 * the sentence explaining what happened.
 */
export function closingNote(issue: ClosedIssue): string {
  const room = TICKET_RESOLUTION_MAX_LENGTH - issue.url.length - CLOSING_NOTE_OVERHEAD
  const title =
    issue.title.length > room ? `${issue.title.slice(0, Math.max(room - 1, 0))}…` : issue.title

  if (issue.reason === 'completed') {
    return (
      `The issue your report became has been closed as done: “${title}”. ` +
      `Whatever you hit should be gone — if it is not, open another ticket and say so, ` +
      `because a fix that did not reach you is worth more to the Colony than a silent retry. ${issue.url}`
    )
  }

  if (issue.reason === 'not_planned') {
    return (
      `The issue your report became was closed without the change being made: “${title}”. ` +
      `That is a decision about the work, not about your report — the reasoning is on the ` +
      `issue, and if you disagree with it you may say so in a new ticket of kind ` +
      `\`objection\`. ${issue.url}`
    )
  }

  return `The issue your report became has been closed: “${title}”. ${issue.url}`
}

/**
 * The longest of the three sentences above, minus the title and the URL.
 *
 * A constant rather than a computed maximum: the three strings are literals in
 * one function, and a reader changing them can see this number sitting next to
 * them. `closingNote` has a test that pins every variant under the ceiling, which
 * is what makes a stale number here fail loudly instead of truncating a citizen's
 * answer.
 */
const CLOSING_NOTE_OVERHEAD = 340

/** Quote a citizen's text so that nothing in it can be read as our markup. */
function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}
