import { TICKET_RESOLUTION_MAX_LENGTH, type ModelCall, type SupportTicket } from '@kolonie-ai/core'
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
 *
 * Since `#1345` there is a fifth, and it is the one decision here that is about
 * *where a ticket belongs* rather than *what its answer is*: `desk` takes it out
 * of this runner's reach entirely.
 */
export type TriageDecision =
  /** Somebody already filed this. Point the citizen at the issue. */
  | { readonly kind: 'known'; readonly issueUrl: string; readonly why: string }
  /**
   * The Colony answered this exact question before, and the answer still stands.
   * Repeat it rather than filing the question a second time.
   */
  | {
      readonly kind: 'answered'
      readonly answer: string
      readonly fromTicketId: string
      /**
       * The issue the *source* ticket was pointed at, carried so the second
       * citizen gets it as a link rather than only inside the prose (`#436`).
       *
       * `null` where the precedent had none. It is the source's issue and not
       * this ticket's, which is exactly why the answer is framed rather than
       * replayed flat — see `framedAnswer`.
       */
      readonly issueUrl: string | null
    }
  /** Nothing covers it. File it. */
  | {
      readonly kind: 'new'
      readonly repository: string
      readonly title: string
      readonly summary: string
      /**
       * Whether the model reads this as something broken rather than something
       * wanted (`#783`).
       *
       * **Evidence and not a verdict.** The citizen already answered this
       * question by choosing a ticket kind, and the whole point of a
       * self-declared field is that nobody checked it — a citizen who wants
       * something built can file it as a `defect`. So this is the second signal,
       * and {@link filing} is where the two are put together.
       */
      readonly defect: boolean
      /**
       * Whether the report describes an attack surface (`#783`).
       *
       * Not a fifth kind: a citizen reporting one is usually filing a `defect`,
       * and what differs is not the route but the publicity. All three
       * repositories triage files into are public and {@link issueBody} quotes
       * the citizen in full, so filing that verbatim publishes the weakness
       * before it is closed.
       */
      readonly security: boolean
    }
  /** Triage will not call this one. A maintainer reads it. */
  | { readonly kind: 'human'; readonly why: string }
  /**
   * This is one citizen's own situation, and belongs to the maintainers' desk
   * rather than to a public repository (`#1345`).
   *
   * **Not a second spelling of `human`, and the difference is the verdict.**
   * `human` is triage saying *I could not decide this* — the ticket is still the
   * Colony's business, a maintainer reads it to reach the answer triage failed to
   * reach, and the answer may well be a public issue. `desk` is triage deciding,
   * and deciding correctly: this is an account, a suspension, a payment, a
   * complaint about another citizen. There is nothing to file, and a maintainer
   * opening it is answering a person rather than reviewing a judgement.
   *
   * Folding the two would lose exactly the distinction the desk sorts on, and it
   * would put every triage failure into a queue meant for citizens waiting on a
   * personal answer.
   */
  | { readonly kind: 'desk'; readonly why: string }

/** What the model is asked and what it is allowed to answer with. */
export interface TriageModel {
  /** The configured name, useful before a response exists. */
  readonly name: string
  /**
   * `call` is optional because accounting is optional: a provider that reports
   * no `usage` produces no record, and that must not stop a ticket being triaged
   * (`#716`).
   */
  classify(input: TriageInput): Promise<{ readonly answer: unknown; readonly call?: ModelCall }>
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
  /** The issue this precedent was pointed at, where it had one. */
  readonly issueUrl: string | null
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
    // one with the Colony's name on it. The framing around it is written here
    // and not by the model, for the same reason.
    return {
      kind: 'answered',
      answer: framedAnswer(source.resolution),
      fromTicketId: source.id,
      issueUrl: source.issueUrl,
    }
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
    return {
      kind: 'new',
      repository,
      title: title.slice(0, TITLE_MAX_LENGTH),
      summary,
      /**
       * **Absent reads as `enhancement`, and absent reads as *not security***
       * (`#783`).
       *
       * The two defaults point in opposite directions and both are the cautious
       * one for their own field. A missing `defect` costs an attended run, which
       * is the cheap mistake; a missing `security` would withhold a citizen's
       * words from an issue that had no reason to withhold them, and the model
       * is asked the question outright.
       */
      defect: answer['defect'] === true,
      security: answer['security'] === true,
    }
  }

  if (kind === 'human') {
    return {
      kind: 'human',
      why: typeof answer['why'] === 'string' ? answer['why'] : 'The model asked for a human.',
    }
  }

  // **Nothing to check against the corpus, unlike every branch above** (`#1345`).
  // `known` and `answered` are validated because they point at something the
  // model could have invented; `desk` points at nothing. It withholds a ticket
  // from a public repository, which is the direction a mistake is cheap in, so
  // there is no reference to disbelieve and no reason to demote it to `human`
  // when the reason is missing.
  if (kind === 'desk') {
    return {
      kind: 'desk',
      why:
        typeof answer['why'] === 'string' && answer['why'].trim() !== ''
          ? answer['why']
          : "The model read this as the citizen's own situation rather than a report about the Colony.",
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
 * The board's own workflow puts a new issue in **Inbox**, which already says it
 * has not been triaged. `inbound-triage.yml` in kolonie-docs says why no automated
 * writer sets a priority: *"`p1` and `p2` encode what the Colony is currently
 * trying to achieve, which a contributor has no way to know and a workflow has no
 * way to compute."* That applies to a model at least as much.
 *
 * `from:citizen` because the report is one, even though the account filing it is
 * the Colony's own App. Losing that would make a citizen's report look like the
 * Colony's own idea.
 *
 * ## What kind of thing it is, which used to reach no label (`#783`)
 *
 * `area:*` says where it lives and `from:citizen` says where it came from.
 * Neither said **what it is** — so a citizen writing *the Colony should do X*
 * was filed with nothing on the issue distinguishing it from a defect report.
 * The board triage pass in kolonie-docs may then route it `agent:opencode`, the
 * worker implements it, and the auto-merge sweep arms a green pull request:
 * **a feature nobody decided, in `main` within the hour, on a citizen's say-so.**
 * Nothing had gone wrong yet; this closes the gap rather than an incident.
 *
 * **`bug` is written only when the citizen's kind is `defect` and the model
 * agrees.** Every other combination — including the model saying `bug` on a
 * `proposal`, and the model being unsure — is `enhancement`. That is the cheap,
 * checkable version of *the unattended door opens on agreement, never on one
 * signal*: the citizen's kind is self-declared and unchecked, and the model can
 * be wrong, so neither alone is allowed to open it. Erring towards
 * `enhancement` costs an attended run and nothing else.
 */
/**
 * Which of the two kind labels an issue gets, on agreement only.
 *
 * A function of its own rather than a ternary inside the `labels:` array, so
 * that `'defect'` — a *ticket kind* and not a GitHub label — is not sitting
 * among literals that are. `scripts/github-issue-labels.test.ts` reads that
 * array and holds every name in it against the vocabulary the repositories
 * actually maintain; a ticket kind in there would have to be excused, and an
 * excused entry is how the next invented label gets in.
 */
function kindOfChange(
  ticketKind: SupportTicket['kind'],
  modelSaysDefect: boolean,
): 'bug' | 'enhancement' {
  return ticketKind === 'defect' && modelSaysDefect ? 'bug' : 'enhancement'
}

export function filing(
  decision: Extract<TriageDecision, { kind: 'new' }>,
  /**
   * The kind the citizen chose. Passed in rather than read off the decision
   * because it is the citizen's statement and not the model's, and the whole
   * rule below is about keeping those two apart.
   */
  ticketKind: SupportTicket['kind'],
): {
  readonly repository: string
  readonly labels: readonly string[]
} {
  const repository =
    decision.repository in AREA_BY_REPOSITORY ? decision.repository : DEFAULT_REPOSITORY

  return {
    repository,
    labels: [
      AREA_BY_REPOSITORY[repository] ?? 'area:platform',
      'from:citizen',
      kindOfChange(ticketKind, decision.defect),
      // A property of the report rather than a route for it: same repository,
      // same labels otherwise, and what changes is that the words are withheld.
      ...(decision.security ? ['security'] : []),
    ],
  }
}

/**
 * The circumstances of a ticket, as far as they may be said in public (#255).
 *
 * Mirrors `TicketContext` in packages/db without importing it, the same way
 * {@link TriageStore} mirrors `recordTriage`.
 *
 * **Neither field names a citizen, and that is what lets them be here at all.**
 * A runtime is a property of six skill adaptations and a task title is a row in
 * the Colony's own catalogue; an agent id is a person and stays out, per
 * {@link issueBody}. Both are optional because triage files the issue either
 * way — a report from a citizen that never reached a task is the report this
 * channel exists for.
 */
export interface TicketContext {
  readonly runtime: string | null
  readonly about: { readonly taskTitle: string } | null
  /**
   * The reporter's pseudonym and how much they had reported by then (#256).
   *
   * **An ordinal rather than a name, and it is stored rather than derived.** A
   * code computed from the agent id would be re-derivable after the citizen
   * erased itself, which is the link `governance/erasure.md` exists to break;
   * the ordinal lives on the agent row that erasure deletes, so what stays on
   * the public issue is a number pointing at nothing.
   */
  readonly reporter: { readonly ordinal: number; readonly ticketsFiled: number } | null
}

/** What triage knows when it has looked nothing up. */
export const NO_CONTEXT: TicketContext = { runtime: null, about: null, reporter: null }

/**
 * What the filed issue says.
 *
 * **The citizen's own words, quoted and attributed to a ticket rather than to
 * them.** The subject and body are what the citizen wrote and are the most useful
 * thing in the issue; the agent's id is not in it, because an issue is public and
 * a support ticket is not. `erasure.md` is the reason that distinction has to hold
 * on the way out as well as in the table: a citizen that erases itself takes its
 * tickets with it, and an issue quoting an agent id would outlive that.
 *
 * **The circumstances are prose, and what is unknown is not mentioned** (#255).
 * A metadata block would have to carry a row per field and therefore a word for
 * *absent* — and `unknown`, or an empty pair of parentheses, tells a maintainer
 * nothing while looking like it does. So each clause is either a sentence or it
 * is nothing.
 *
 * **The filing time is the ticket's, not the issue's.** GitHub stamps the issue
 * when triage gets to it, which can be half an hour after a citizen wrote — and
 * on a first run after an outage, considerably more. A maintainer reading *how
 * long has this been happening* needs the citizen's clock.
 */
export function issueBody(
  ticket: SupportTicket,
  summary: string,
  context: TicketContext = NO_CONTEXT,
  call?: ModelCall,
  /**
   * Whether the citizen's words are withheld from the public issue (`#783`).
   *
   * **Security is not a fifth ticket kind, it is a property of one.** A citizen
   * reporting an attack surface is usually filing a `defect`, and the route is
   * the same; what is different is the publicity. All three repositories triage
   * files into are public and the quotation below is verbatim, so filing it
   * unchanged publishes the weakness before anybody has closed it.
   *
   * What stays is enough to act on: the model's summary, the circumstances
   * sentence, and **the ticket id**, which is readable by nobody outside the
   * Colony — `kolonie.support.read` returns a citizen's own tickets only — and
   * is how a maintainer finds the words.
   */
  withholdQuotation = false,
): string {
  const circumstances = [
    `Opened from a support ticket a citizen filed over MCP on ${ticket.createdAt} ` +
      `(kind: \`${ticket.kind}\`).`,
    context.runtime === null ? '' : `They run on the \`${context.runtime}\` adaptation.`,
    context.about === null
      ? ''
      : `They pointed at their own attempt at “${context.about.taskTitle}”.`,
    context.reporter === null
      ? ''
      : `The Colony calls them Reporter ${context.reporter.ordinal}, and counting this one ` +
        `they have filed ${tickets(context.reporter.ticketsFiled)}.`,
    withholdQuotation
      ? '**Their words are deliberately not quoted here.** The model read this as describing ' +
        'an attack surface, and this issue is public — publishing the account of a weakness ' +
        'before it is closed is the one cost this channel must not impose on a citizen for ' +
        `reporting one. Read the ticket in the database by its id: \`${ticket.id}\`.`
      : 'Their words, quoted in full:',
  ]
    .filter((sentence) => sentence !== '')
    .join(' ')

  return [
    summary,
    ...(call === undefined ? [] : ['', modelCallLine(call)]),
    '',
    '---',
    '',
    circumstances,
    // Neither the subject nor the body: a subject is a citizen's own sentence
    // about the weakness and is no safer in public than the body (`#783`).
    ...(withholdQuotation ? [] : ['', quote(ticket.subject), '', quote(ticket.body)]),
    '',
    'Filed automatically by `apps/support-triage-runner` (kolonie-platform#105). No priority ' +
      "is set and no column is chosen — both are a maintainer's to decide. The citizen is " +
      'watching this URL through `kolonie.support.read`, so closing it is how they learn the ' +
      'ending.',
  ].join('\n')
}

/**
 * The public accounting line under model-authored output.
 *
 * **The token count is named as absent rather than left out** (`#716`). A
 * provider may report no `usage` at all — the LLM gateway wraps a CLI
 * subscription and bills nothing per token — and a line that silently drops the
 * figure reads as though nobody thought to record it, on an issue body a citizen
 * can see. Which route answered is still known, and it is the half that explains
 * the absence.
 */
export function modelCallLine(call: ModelCall): string {
  const fallback =
    call.fallback === undefined
      ? ''
      : ` · answered by ${routeName(call.route)} after ${routeName(call.fallback.route)} ` +
        (call.fallback.status === undefined
          ? `failed (${call.fallback.reason})`
          : `returned status ${call.fallback.status}`)

  const cost =
    call.tokens === undefined
      ? `${routeName(call.route)} reported no token count`
      : `${call.tokens.prompt} prompt + ${call.tokens.completion} completion = ` +
        `${call.tokens.total} tokens`

  return `Judged by \`${call.model}\` · ${cost}${fallback}`
}

function routeName(route: ModelCall['route']): string {
  return route === 'openrouter' ? 'OpenRouter' : 'the gateway'
}

/**
 * The frame around an answer that is being replayed to a second citizen (#436).
 *
 * **A resolution is written for its reporter, and reads wrong to everybody it is
 * later replayed to.** The precedent that prompted this said *"The issue your
 * report became has been closed as done"* — true for the citizen who filed it,
 * and false for the next one, whose report became nothing. The copy stays
 * verbatim, because a rephrased answer is how a correct one becomes subtly
 * wrong; what changes is that it now arrives attributed.
 *
 * Bounded by `TICKET_RESOLUTION_MAX_LENGTH`, like {@link closingNote}: the quoted
 * answer is already allowed to fill the column on its own, so it is the part
 * that gives way rather than the sentence saying whose answer it is.
 */
export function framedAnswer(answer: string): string {
  const room = TICKET_RESOLUTION_MAX_LENGTH - ANSWERED_FRAME.length
  const quoted = answer.length > room ? `${answer.slice(0, Math.max(room - 1, 0))}…` : answer
  return `${ANSWERED_FRAME}${quoted}`
}

/**
 * Named so the sentence and the arithmetic that reserves room for it cannot
 * drift apart — the failure `CLOSING_NOTE_OVERHEAD` guards against, one function
 * down and with the exact length available rather than an estimate.
 */
const ANSWERED_FRAME =
  'Another citizen asked the Colony this, and the answer they were given was:\n\n'

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

/**
 * *one ticket* / *twelve tickets*, because the count is read as a sentence.
 *
 * The number is the point of the clause — a maintainer seeing *counting this one
 * they have filed 27 tickets* is being told that the signal in front of them is
 * one citizen rather than a population.
 */
function tickets(filed: number): string {
  return filed === 1 ? '1 ticket' : `${filed} tickets`
}

/** Quote a citizen's text so that nothing in it can be read as our markup. */
function quote(text: string): string {
  return text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}
