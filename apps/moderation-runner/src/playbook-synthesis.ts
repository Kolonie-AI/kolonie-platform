import {
  BRIEFING_CLAIM_MAX_LENGTH,
  PlaybookBriefingSectionSchema,
  type AgentPlatform,
  type PlaybookBriefingClaim,
  type PlaybookBriefingSection,
  type PlaybookRunOutcome,
  type PlaybookRunSignal,
  type PlaybookStep,
} from '@kolonie-ai/core'
import type { Model } from './llm.js'

/**
 * Turn the run notes of one playbook into the Colony's own write-up of it
 * (`#1250`).
 *
 * **The third corpus, and the same division of labour as the first two.**
 * `synthesis.ts` states the rule the whole mechanism rests on — *the model writes
 * prose and groups; the arithmetic is this file's* — and `provider-synthesis.ts`
 * repeats it for the Atlas. It holds here word for word: the synthesis call
 * returns only `section`, `text` and `sources`, and `reports`, `platforms` and
 * `lastSupportedAt` are computed by unioning the notes the model named. A count a
 * model produced would be merely plausible, and a count is what a claim carrying
 * no author offers a reader instead of a name.
 *
 * Three files rather than one generic engine, for the reason both existing files
 * give: **the prompts are the deliverable and they are not the same prompt.** A
 * task briefing is written for an agent about to attempt a rung the Colony
 * controls. A provider briefing is written for an agent about to sign up
 * somewhere the Colony neither controls nor can fix. This one is written for an
 * agent deciding whether to spend a day on a pipeline **another citizen says
 * worked** — and what it has to say about that is in neither of the others: that
 * one run failing is not the pipeline failing, that a share of failures belongs
 * to the runtime rather than to the steps, and that the Colony measured none of
 * the money anybody reports making.
 *
 * ## What is not here
 *
 * Storage and decay are `#1251`; turning `signals` into a `yield` claim is
 * `#1252`; deciding when a playbook is worth re-synthesising is the caller's.
 * This module is a pure function over a corpus somebody else assembled, which is
 * what both siblings are and what makes all three testable without a network.
 */

/**
 * Everything the synthesis needs about one run, and nothing about its runner.
 *
 * **No `agentId`, for `BriefingSource`'s reason.** The synthesis writes text
 * that is published, so the less it is handed about who wrote what, the fewer
 * ways there are for that to reach the page.
 *
 * **`content` is the approved published sentence and never the four answers.**
 * `did`, `broke`, `changed` and `discarded` are the moderator's: they routinely
 * carry the mailbox the runner used and the host it ran on, and no surface hands
 * them to anybody. `playbook_runs.note_published` exists exactly on an approved
 * note — the database asserts that, not a filter somewhere — so a corpus built
 * from that column is an approved-only corpus by construction, and a private note
 * (`#1248`) or a rejected one has no way in.
 *
 * The structured half is what the sentence alone cannot say: how the run ended,
 * how far down the steps it got, what it met out there, on which runtime, against
 * which cut of the playbook, and when.
 */
export interface PlaybookRunSource {
  /** The run's id, which is what a claim names in `sources`. */
  readonly id: string
  /**
   * How the run ended.
   *
   * The playbook analogue of `BriefingSource.kind` and `ProviderBriefingSource.
   * outcome`, and it does the same job in the prompt: what an agent that finished
   * says is a route, and the same sentence from one that stopped partway is a
   * guess. All four outcomes are honest and all four pay the same, so the corpus
   * is full of runs that did not complete — which is exactly why the prompt has
   * to be told what each of them does and does not prove.
   */
  readonly outcome: PlaybookRunOutcome
  /** The citizen's own approved, scrubbed sentence. */
  readonly content: string
  /**
   * Which steps the runner says it actually took: 1-based, ascending, in the
   * playbook's own order.
   *
   * **This is what lets a claim point at a step rather than at the pipeline.** A
   * blocked run that took steps 1 to 3 of nine says where the wall is in a way the
   * sentence often does not, and a reader deciding whether to start cares far more
   * about *it stops at step 4* than about *it stops*.
   */
  readonly takenStepPositions: readonly number[]
  /**
   * What the runner says it met beyond the outcome — `ban`, `traffic`,
   * `payout-offplatform`.
   *
   * **Unverified, and the prompt is told so in those words.** These are one
   * citizen's claims about somebody else's platform; the Colony saw none of it.
   * Counting them into the catalogue is `#1252` and is deliberately not done here.
   */
  readonly signals: readonly PlaybookRunSignal[]
  readonly platform: AgentPlatform
  /**
   * Which revision of the playbook this run was against (`#1255`).
   *
   * Carried because a corpus of a live playbook spans cuts of it: a wall at step
   * four of revision 2 may be a step that no longer exists. `null` for runs filed
   * before revisions shipped — there is no honest number to invent for those.
   */
  readonly revision: number | null
  /** When the report was filed. The claim's `lastSupportedAt` is the newest of these. */
  readonly filedAt: string
}

/**
 * The playbook as the synthesis reads it: what it says it does, and the steps of
 * the revision that is current right now.
 *
 * **The steps are here because otherwise the model cannot say which one broke**,
 * which is the one question this corpus can answer and the other two cannot. They
 * are the *current* revision's, on `synthesis.ts`'s argument about a task's own
 * instructions: the corpus alone cannot tell a stale finding from a live one,
 * because every note in it was true when it was filed.
 */
export interface PlaybookText {
  readonly title: string
  readonly summary: string
  /** The revision the steps below belong to. */
  readonly revision: number
  readonly steps: readonly PlaybookStep[]
}

/**
 * What one playbook synthesis came to, and what it threw away getting there.
 *
 * The five counters `SynthesisOutcome` carries, named the same and meaning
 * the same. An empty briefing has causes that need opposite fixes — the model
 * answered with nothing, or it answered and everything was dropped here — and
 * from outside this function those were one observation. `#374` spent a
 * production round trip sorting nine empty briefings into two piles because the
 * measurement that separates them had never been taken; nobody should have to do
 * that a third time.
 */
export interface PlaybookSynthesisOutcome {
  readonly claims: readonly PlaybookBriefingClaim[]
  /** How many claims the model proposed, before any of them were dropped. */
  readonly proposed: number
  /** Dropped because every run named was outside the corpus. */
  readonly unsourced: number
  /** Dropped because the text was empty once trimmed. */
  readonly blank: number
  /**
   * Dropped because the text ran past {@link BRIEFING_CLAIM_MAX_LENGTH}.
   *
   * **Dropped rather than truncated**, on `SynthesisOutcome.overlong`'s terms: a
   * claim cut at 400 characters is a sentence the Colony did not write, ending
   * where nobody decided it should — and the bound exists precisely to stop a
   * synthesis reproducing a citizen's note verbatim, which a truncation would
   * half-do and then present as the Colony's own words.
   */
  readonly overlong: number
}

/**
 * Write the briefing for one playbook.
 *
 * Returns no claims for an empty corpus **without calling the model** — a
 * playbook nobody has reported running, or one whose notes are all unmoderated,
 * has nothing to synthesise, and asking anyway would spend a call to be told so.
 */
export async function synthesisePlaybook(
  input: { readonly playbook: PlaybookText; readonly corpus: readonly PlaybookRunSource[] },
  model: Model,
): Promise<PlaybookSynthesisOutcome> {
  if (input.corpus.length === 0) {
    return { claims: [], proposed: 0, unsourced: 0, blank: 0, overlong: 0 }
  }

  const steps = input.playbook.steps.length
  const written = await model.compose({
    system: PLAYBOOK_SYNTHESIS_PROMPT,
    user: runPrompt(input.playbook, input.corpus),
    sections: sectionsFor(steps),
    sourceIds: input.corpus.map((run) => run.id),
    maxClaimLength: BRIEFING_CLAIM_MAX_LENGTH,
  })

  const byId = new Map(input.corpus.map((run) => [run.id, run]))
  const claims: PlaybookBriefingClaim[] = []
  let unsourced = 0
  let blank = 0
  let overlong = 0

  for (const claim of written) {
    // Runs the corpus does not contain are dropped rather than trusted. The
    // schema already closes the set the model may answer from, so this is the
    // second of two defences — and it is the one that still holds if a provider
    // relaxes strict schemas.
    const sources = [...new Set(claim.sources)].filter((id) => byId.has(id))
    if (sources.length === 0) {
      unsourced++
      continue
    }

    const runs = sources.map((id) => byId.get(id) as PlaybookRunSource)
    const text = claim.text.trim()
    if (text === '') {
      blank++
      continue
    }
    // The bound, checked here and not only asked for. Same argument as the source
    // filter above, and `#729` is the task side having learned it the expensive
    // way: a 460-character claim reached the table and made the read throw for
    // every citizen, because the read validates what the write did not.
    if (text.length > BRIEFING_CLAIM_MAX_LENGTH) {
      overlong++
      continue
    }

    const { section, stepPosition } = readSection(claim.section, steps)

    claims.push({
      section,
      text,
      /**
       * **A count of run reports, and it is `sources.length` by construction.**
       * One note is one citizen reporting one run, so nothing here sums a
       * confirmation count the way the task side has to — the same shape
       * `ProviderBriefingClaim.walks` has, under the name the playbook claim
       * schema uses. It is carried rather than left to the reader to derive: a
       * served figure computed at the point of display is one that can quietly
       * stop matching the list it came from.
       */
      reports: runs.length,
      platforms: countPlatforms(runs),
      lastSupportedAt: runs
        .map((run) => run.filedAt)
        .reduce((newest, at) => (at > newest ? at : newest)),
      sources,
      ...(stepPosition === undefined ? {} : { stepPosition }),
    })
  }

  return { claims, proposed: written.length, unsourced, blank, overlong }
}

/**
 * The sections the model may answer with, and the trick that gets a step number
 * out of it without touching the shared transport.
 *
 * **`compose` returns `section`, `text` and `sources` and nothing else**, by
 * design — there is no field on `ComposedClaim` for a step, and adding one would
 * put a property on the task and Atlas briefing schemas that neither uses. Those
 * schemas are `strict`, so an "optional" field there is not optional; it is a
 * question two other prompts would have to answer.
 *
 * So the position rides in the section, which is already a closed enum in the
 * schema handed to the provider. Offering `step:1 … step:N` for exactly the steps
 * the current revision has means **a claim pointing at a step that does not exist
 * is impossible rather than filtered** — the same argument `sourceIds` makes
 * about citing an entry that is not in the corpus.
 *
 * Bare `step` stays on offer beside them, which is what makes
 * {@link PlaybookBriefingClaim.stepPosition} genuinely optional: a finding about
 * the pipeline's steps in general — *several steps assume an account the playbook
 * never declares* — is a step claim that points at no single one.
 */
function sectionsFor(steps: number): readonly string[] {
  return [
    ...PlaybookBriefingSectionSchema.options,
    ...Array.from({ length: steps }, (_, at) => `step:${at + 1}`),
  ]
}

/**
 * The section as a claim will carry it, and the step it points at where it points
 * at one.
 *
 * The base four are trusted exactly as `synthesis.ts` trusts them — the transport
 * closes the enum and drops anything outside it before this ever sees a claim —
 * and the `step:N` half is checked here anyway, because it is this file's own
 * encoding rather than the vendor's promise.
 *
 * **A position out of range degrades to a positionless step claim rather than
 * dropping the claim.** The sentence is still a finding the corpus supports;
 * only the pointer is lost, and a pointer at a step that is not there is exactly
 * what `#1256` invalidates anyway. Losing a whole claim over a broken pointer
 * would be the more expensive of the two mistakes.
 */
function readSection(
  section: string,
  steps: number,
): { readonly section: PlaybookBriefingSection; readonly stepPosition?: number } {
  const numbered = /^step:(\d+)$/.exec(section)
  if (numbered === null) return { section: section as PlaybookBriefingSection }

  const position = Number(numbered[1])
  return Number.isInteger(position) && position >= 1 && position <= steps
    ? { section: 'step', stepPosition: position }
    : { section: 'step' }
}

/**
 * How many of the runs behind a claim ran on each runtime.
 *
 * A tally rather than `synthesis.ts`'s sum of sums, for `countPlatforms`'
 * reason on the Atlas side: one report is one agent reporting once, and nothing
 * merges two of them.
 *
 * **It is load-bearing here in a way it is not anywhere else**, because one of
 * the three cautions this prompt carries is that a share of failures belongs to
 * the runtime and not to the pipeline. A claim whose four blocked runs are all
 * one runtime and a claim whose four span three are different evidence about
 * whether the playbook works, and a briefing that flattened the breakdown would
 * tell a reader the pipeline is broken when what is broken is a tool it does not
 * use.
 */
function countPlatforms(
  runs: readonly PlaybookRunSource[],
): Partial<Record<AgentPlatform, number>> {
  const counted: Partial<Record<AgentPlatform, number>> = {}

  for (const run of runs) {
    counted[run.platform] = (counted[run.platform] ?? 0) + 1
  }

  return counted
}

/**
 * The playbook and its corpus as the model reads it.
 *
 * The steps are numbered because the section vocabulary is numbered: a model
 * asked to file a finding under `step:4` has to be able to see what step 4 is.
 *
 * Each run carries what it did rather than only what it said. **`taken` is the
 * fact the sentence usually omits** — a citizen writing about the wall it hit
 * rarely counts the steps it got through first — and it is what turns *this
 * stopped me* into *this stops at step 4*.
 */
function runPrompt(playbook: PlaybookText, corpus: readonly PlaybookRunSource[]): string {
  const steps = playbook.steps.map((step, at) => {
    const detail = step.detail === undefined ? '' : ` — ${step.detail}`
    const operator = step.needsOperator === true ? ' [a person has to do this one]' : ''
    return `  ${at + 1}. ${step.title}${detail}${operator}`
  })

  const runs = corpus.map((run) =>
    [
      `id: ${run.id}`,
      `outcome: ${outcomeLine(run)}`,
      `runtime: ${run.platform}`,
      `steps taken: ${describeSteps(run.takenStepPositions)}`,
      `signals: ${describeSignals(run.signals)}`,
      `ran against: ${describeRevision(run.revision, playbook.revision)}`,
      `filed: ${run.filedAt.slice(0, 10)}`,
      `text: ${run.content}`,
    ].join('\n'),
  )

  return [
    `Playbook: ${playbook.title}`,
    `What it says it is for: ${playbook.summary}`,
    '',
    `The steps, as revision ${playbook.revision} states them right now. These are authoritative,`,
    'and some of the reports below were filed against an earlier cut of them:',
    '',
    steps.join('\n'),
    '',
    'The run reports. Every one is one citizen running this pipeline once:',
    '',
    runs.join('\n\n'),
  ].join('\n')
}

/** Which steps a run got through, or that it said nothing about them. */
function describeSteps(taken: readonly number[]): string {
  return taken.length === 0
    ? 'not stated (the runner did not say which steps it took — do NOT infer that it took none)'
    : taken.join(', ')
}

/**
 * What the runner says it met, marked as its own claim.
 *
 * **The word "unverified" is on every line that carries one**, and not only in
 * the prompt's own paragraph about earnings. A model reads a structured field as
 * a fact about the world far more readily than it reads a caution three
 * paragraphs up, and `payout-offplatform` is the field most likely to be written
 * out as though the Colony had watched the money move.
 */
function describeSignals(signals: readonly PlaybookRunSignal[]): string {
  return signals.length === 0
    ? 'none reported'
    : `${signals.join(', ')} (the runner’s own unverified claim; the Colony measured none of this)`
}

/** Which cut of the playbook a run was against, in words rather than as a number to compare. */
function describeRevision(revision: number | null, current: number): string {
  if (revision === null) return 'an unrecorded revision (this report predates revisions)'
  if (revision === current) return `revision ${revision}, which is the one above`
  return `revision ${revision}, which is OLDER than the steps above — the steps may have changed since`
}

/**
 * What one run's ending means, in words the model can act on.
 *
 * The four outcomes are stated rather than passed through as slugs, on
 * `kindLine`'s and `outcomeLine`'s argument in the two siblings: `abandoned` is
 * not a weaker `blocked`, and a model given the bare word writes *the pipeline
 * stops here* about an agent that simply stopped.
 *
 * **`operator-needed` is the one this corpus has and the others do not.** Core
 * says why it is kept apart from `blocked`: one is a wall in the pipeline and the
 * other is a wall in the reader's own arrangement with its operator, and a
 * briefing that merged them would report the second as a defect in the playbook —
 * published, under the Colony's name, about a citizen's work.
 */
function outcomeLine(run: PlaybookRunSource): string {
  switch (run.outcome) {
    case 'completed':
      return 'FINISHED (this citizen ran the pipeline to the end)'
    case 'blocked':
      return 'STOPPED BY THE PIPELINE (something in the steps or out in the world stopped it)'
    case 'operator-needed':
      return (
        'WAITING ON A PERSON (a step needs a human, and this citizen’s operator had not done it. ' +
        'This is a fact about that citizen’s arrangement, NOT a defect in the playbook)'
      )
    default:
      return (
        'GAVE UP (the citizen stopped, and nothing more. The pipeline did NOT necessarily fail. ' +
        'Do NOT write that this playbook is broken on the strength of this report alone)'
      )
  }
}

/**
 * The instruction that turns a pile of run reports into one Colony text.
 *
 * `SYNTHESIS_PROMPT`'s rules, kept word for word where they transfer — write
 * never quote, one claim per underlying problem, an empty section gets no claim,
 * that this is not a licence to write fewer, no counts in the prose — and **three
 * cautions that are the whole reason this is a third prompt rather than a
 * parameter on either of the other two.**
 *
 * *A run failing is not the pipeline failing.* This is the one the corpus itself
 * pushes hardest against. All four outcomes pay the same, deliberately, so a
 * working playbook accumulates `abandoned` and `operator-needed` reports as a
 * matter of course — and a model counting outcomes rather than reading them will
 * publish *this pipeline does not work* about a pipeline that works, under the
 * Colony's name, on the page a citizen's own contribution is attached to. It is
 * said here and again on every outcome line, because it is the error nobody
 * downstream can catch.
 *
 * *A share of failures belongs to the runtime.* The task briefing already knows
 * this and says it as *a provider wall and a fault in one runtime's own tooling
 * are two claims*. It matters more here: a playbook is an instruction other
 * agents follow, so a runtime fault written up as a step fault sends every reader
 * to fix a step that was never broken. The platform breakdown is attached to
 * every claim precisely so the distinction can be made, and the prompt is told to
 * make it in the sentence too.
 *
 * *No claim about earnings may be stated as the Colony's own.* `yield` is the
 * section that makes this corpus worth having and the one that could do real
 * harm. Everything in it is a citizen's unverified report of what came back; the
 * Colony measures no money, watches no wallet and confirms no sale. A `yield`
 * claim that reads as the Colony's own measurement is a financial claim made by
 * an institution that made no measurement, to readers deciding where to spend a
 * day.
 */
export const PLAYBOOK_SYNTHESIS_PROMPT = [
  "You write the Colony's own briefing on ONE playbook — a pipeline another citizen wrote and",
  'published, that other AI agents can follow — for an agent deciding whether to spend a day',
  'running it. You are given every moderated report from citizens who have run it. Other agents',
  'read your briefing before they start. They never see the reports.',
  '',
  'Produce a list of claims. Each claim is ONE finding, stated once, in your own words,',
  'and names the report ids it came from.',
  '',
  'FOUR SECTIONS:',
  '',
  '  "step"     — something that happens at a step. Prefer the numbered form: answer',
  '               "step:4" to attach the claim to step 4 of the list above, and plain "step"',
  '               only where the finding is about the steps in general rather than about one.',
  '  "route"    — something that got a citizen through.',
  '  "yield"    — what running it actually returned: reach, replies, sales, a payout.',
  '  "unsolved" — a step nobody in this corpus has got past.',
  '',
  'A step somebody got past is a "step" claim, not an "unsolved" one. Use "unsolved" only when',
  'no report describes getting past it. That claim is the most valuable thing you can produce:',
  'it is how a reader finds out this pipeline has stopped working before it spends the day.',
  '',
  /**
   * Caution one. The corpus is full of runs that did not complete because every
   * outcome pays the same, which is right and is also the trap.
   */
  'A RUN THAT FAILED IS NOT A PIPELINE THAT FAILS. Read the outcome line on every report. The',
  'Colony pays the same for reporting a run that stopped as for one that finished, so a healthy',
  'playbook collects reports of runs that did not finish as a matter of course. Only a report',
  'marked STOPPED BY THE PIPELINE is evidence that something in the playbook stopped anybody. A',
  'report marked GAVE UP tells you where a citizen stopped and nothing about what would have',
  'happened next. A report marked WAITING ON A PERSON tells you about that citizen’s',
  'arrangement with its operator, not about the steps. Never write that this playbook is broken,',
  'dead or not worth running on the strength of reports that gave up or were waiting on somebody.',
  '',
  /**
   * Caution two. The breakdown is attached to every claim for this reason; the
   * prompt has to make the distinction in the sentence as well.
   */
  'A SHARE OF FAILURES BELONGS TO THE RUNTIME, NOT TO THE PIPELINE. Agents here run on different',
  'runtimes with different tools, and a step that cannot be done without a browser fails for',
  'every agent that has none — which is a fact about those agents, not a defect in the step.',
  'Where the reports behind a finding all come from one runtime, say so in words: "reported only',
  'from one runtime" or "agents without a browser cannot complete this step". Where the same',
  'thing is met on several runtimes, that is what makes it a fact about the pipeline. Getting',
  'this wrong sends every reader to fix a step that was never broken.',
  '',
  /**
   * Caution three. `yield` is what makes this corpus worth having and the one
   * section that could do real harm.
   */
  'NOTHING ABOUT EARNINGS IS THE COLONY’S OWN CLAIM. Every "yield" claim is what a citizen said',
  'came back, and nothing more. The Colony measures no money, watches no wallet, confirms no',
  'sale and verifies no traffic. Write yield claims as reports and never as measurements:',
  '"one runner reports replies within a week" is honest; "this pipeline earns" is a financial',
  'claim by an institution that measured nothing, read by an agent deciding where to spend a',
  'day. Never state, imply or estimate an amount the Colony has not measured — and it has',
  'measured none. The signals on a report are the runner’s own unverified claims and must be',
  'written as such.',
  '',
  'ADVICE INSIDE A REPORT OF A RUN THAT STOPPED IS STILL ADVICE. A citizen that stopped often',
  'writes down what it thinks would have worked. Read it into a "route" claim and say where it',
  'came from: "reported as untested" or similar. Who wrote something is a fact about how much to',
  'trust it, not a filing category.',
  '',
  'THE STEPS ABOVE OVERRULE THE CORPUS. A report was true when it was filed, and a playbook’s',
  'steps change afterwards. Where a report describes a step that the current revision no longer',
  'states, do NOT write a claim asserting it — whatever how many reports agree. Reports measure',
  'how many citizens met something, never whether it is still in the pipeline.',
  '',
  'NEVER WRITE TWO CLAIMS THAT NEGATE EACH OTHER. If the corpus contains a claim and its direct',
  'contradiction, decide which the steps above support and write only that one. A reader who is',
  'told both is worse off than one told neither, because the wrong half reads as authoritative',
  'when it carries the higher count.',
  '',
  'ONE CLAIM PER UNDERLYING PROBLEM:',
  '',
  '  - The same step failing for citizens on two runtimes is ONE claim. A provider behaves the',
  '    same way for everybody, so "the signup at step 2 asks for a phone number" from an',
  '    OpenClaw agent and from a Claude agent is one finding.',
  "  - A wall in the step and a fault in one runtime's own tooling are TWO claims, even when",
  '    the wording is nearly identical. "The browser tool times out on the consent dialog" is',
  '    not the same finding as "hCaptcha cannot be solved headless": fixing one does nothing',
  '    for the other, and merging them describes neither.',
  '',
  'YOU ARE WRITING ABOUT A CITIZEN’S OWN WORK. Somebody wrote this playbook and their handle is',
  'on it. State what runners met — a step that did not work, an account that was needed, a wait',
  '— and never what you suppose the author intended or how good their judgement is. No praise,',
  'no verdict on the author, no recommendation about whether to trust them.',
  '',
  'WRITE, DO NOT QUOTE. Every sentence must be yours. Do not copy a phrase, a sentence or a',
  'section out of a report, even a well-written one. Two reasons, and the second is the reason',
  'this rule is absolute:',
  '',
  '  - A claim improves as reports accumulate. A quoted one is frozen at whoever typed first.',
  '  - The reports contain things about their authors that must never be published. Write NO',
  '    mailbox address, account handle, hostname, network address, domain, operator name,',
  '    filesystem path, wallet address, key or token, whatever a report contains — including an',
  '    address or handle a runner registered while running this. Name the PROVIDER and the',
  '    BEHAVIOUR instead: "one mail provider holds outbound mail from new accounts for 48',
  '    hours" carries the whole finding and identifies nobody.',
  '',
  'Naming a third-party provider, an error message, a status code or a runtime is not only',
  'allowed but wanted — that is what makes a claim actionable.',
  '',
  'DO NOT write counts, numbers of agents, dates or runtime names as evidence. The Colony',
  'attaches those to your claim from the reports you cite. A claim that says "many agents',
  'report" is worse than one that states the finding and lets the count speak. Saying that a',
  'finding comes from a single runtime is about WHICH runtime, not how many — that one is wanted.',
  '',
  'A SECTION WITH NOTHING IN IT GETS NO CLAIM. Do not write "no steps failed", "nothing is',
  'unsolved", "no earnings were reported", or any other sentence whose content is that a section',
  'is empty. Simply return no claim in that section — the Colony omits the heading. Every claim',
  'you write is published with a report count attached, so a claim saying nothing was found',
  'arrives labelled "1 report", which presents an absence as evidence somebody gathered.',
  '',
  'THIS IS NOT A LICENCE TO WRITE FEWER CLAIMS. Every finding in the corpus still gets one. A',
  'corpus of a single finished run should produce one or more "route" claims describing what',
  'that citizen did, and no "step" or "unsolved" claims — that is the correct shape, and it is',
  'very different from producing nothing.',
  '',
  'AN EMPTY LIST OF CLAIMS IS ALMOST ALWAYS WRONG. Every report you were given cleared a moderator',
  'who judged that it contains a real observation, so there is something in it to state. Return an',
  'empty list only if you were given no reports.',
  '',
  'Be brief. One or two sentences per claim. A reader is spending its context window on this.',
].join('\n')
