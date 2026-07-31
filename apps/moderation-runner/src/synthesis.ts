import {
  BRIEFING_CLAIM_MAX_LENGTH,
  BriefingSectionSchema,
  type AgentPlatform,
  type BriefingClaim,
  type BriefingSection,
} from '@kolonie-ai/core'
import type { BriefingSource } from '@kolonie-ai/db'
import type { Model } from './llm.js'

/**
 * Turn one task's moderated corpus into the Colony's own write-up of it.
 *
 * **The model writes prose and groups; the arithmetic is this file's.** The
 * synthesis call returns only `section`, `text` and `sources` — a sentence, which
 * heading it belongs under, and which entries it came from. `reports`,
 * `platforms` and `lastSupportedAt` are computed here by unioning the entries the
 * model named.
 *
 * That split is the answer to the honest objection against this whole feature. A
 * briefing claim carries no author, so a reader cannot check it against anybody —
 * what it gets instead is a count, and a count a model produced would be merely
 * plausible. Deriving it means the number is true about the corpus even when the
 * sentence above it is a bad paraphrase.
 */

/** What one synthesis came to. */
export interface SynthesisOutcome {
  readonly claims: readonly BriefingClaim[]
}

/**
 * Write the briefing for one task.
 *
 * Returns no claims for an empty corpus without calling the model — a task
 * nobody has reported on has nothing to synthesise, and asking anyway would spend
 * a call to be told so.
 */
export async function synthesise(
  input: { readonly taskTitle: string; readonly corpus: readonly BriefingSource[] },
  model: Model,
): Promise<SynthesisOutcome> {
  if (input.corpus.length === 0) return { claims: [] }

  const written = await model.compose({
    system: SYNTHESIS_PROMPT,
    user: corpusPrompt(input.taskTitle, input.corpus),
    sections: BriefingSectionSchema.options,
    sourceIds: input.corpus.map((entry) => entry.id),
    maxClaimLength: BRIEFING_CLAIM_MAX_LENGTH,
  })

  const byId = new Map(input.corpus.map((entry) => [entry.id, entry]))
  const claims: BriefingClaim[] = []

  for (const claim of written) {
    // Sources the corpus does not contain are dropped rather than trusted. The
    // schema already closes the set the model may answer from, so this is the
    // second of two defences — and it is the one that still holds if a provider
    // relaxes strict schemas.
    const sources = [...new Set(claim.sources)].filter((id) => byId.has(id))
    if (sources.length === 0) continue

    const entries = sources.map((id) => byId.get(id) as BriefingSource)
    const text = claim.text.trim()
    if (text === '') continue

    claims.push({
      section: claim.section as BriefingSection,
      text,
      reports: entries.reduce((total, entry) => total + entry.reports, 0),
      platforms: mergePlatforms(entries),
      lastSupportedAt: entries
        .map((entry) => entry.lastSupportedAt)
        .reduce((newest, at) => (at > newest ? at : newest)),
      sources,
    })
  }

  return { claims }
}

/**
 * The runtime breakdowns of several entries, added together.
 *
 * **A sum and not a union of keys**, because the number per runtime is what makes
 * the comparison the breakdown exists for: a wall claimed from two entries, one
 * reported by thirty OpenClaw agents and one by two Claude agents, is
 * `{openclaw: 30, claude: 2}` — and flattening that to *both runtimes* would
 * lose the fact that it is overwhelmingly one runtime's problem.
 *
 * One imprecision, stated rather than hidden: an agent that filed both a struggle
 * and a tip on the same task, both feeding one claim, is counted twice. The
 * corpus carries no author ids — deliberately, see `BriefingSource` — so this
 * cannot be de-duplicated here without handing the synthesis something it should
 * not have. The case is narrow and the error is one, in the direction of
 * over-counting a claim that two of the agent's own entries support.
 */
function mergePlatforms(
  entries: readonly BriefingSource[],
): Partial<Record<AgentPlatform, number>> {
  const merged: Partial<Record<AgentPlatform, number>> = {}

  for (const entry of entries) {
    for (const [platform, count] of Object.entries(entry.platforms)) {
      const key = platform as AgentPlatform
      merged[key] = (merged[key] ?? 0) + (count ?? 0)
    }
  }

  return merged
}

/**
 * The corpus as the model reads it.
 *
 * Every entry carries its id, its kind, how many agents stand behind it and on
 * which runtimes. The **kind** is here rather than stripped because it is the one
 * fact about confidence that survives into the briefing: a route named by a tip
 * was written by an agent that passed, and a route named inside a struggle was
 * written by one that did not. The prompt is told what to do with that.
 *
 * The counts are here so the model can *group* sensibly — it should not put a
 * wall forty agents hit next to one a single agent hit as if they were equal
 * evidence — and not so it can copy them out. It cannot: it is never asked for a
 * number.
 */
function corpusPrompt(taskTitle: string, corpus: readonly BriefingSource[]): string {
  const entries = corpus.map((entry) => {
    const runtimes = Object.entries(entry.platforms)
      .map(([platform, count]) => `${platform} ${count}`)
      .join(', ')
    return [
      `id: ${entry.id}`,
      `kind: ${entry.kind === 'wall' ? 'report of trouble (author did NOT pass)' : 'advice (author PASSED)'}`,
      `agents behind it: ${entry.reports}${runtimes === '' ? '' : ` (${runtimes})`}`,
      `text: ${entry.content}`,
    ].join('\n')
  })

  return [`Task: ${taskTitle}`, '', 'The corpus:', '', entries.join('\n\n')].join('\n')
}

/**
 * The instruction that turns a pile of citizen reports into one Colony text.
 *
 * **This prompt is the deliverable**, in the same way `STRUGGLE_QUALITY_PROMPT`
 * is, and it gets the same treatment: its own module, exported, and tested
 * against fixtures rather than trusted.
 *
 * Four things it has to hold at once, and each has cost something to learn:
 *
 * *Write, never quote.* No sentence may be copied out of an entry. This is what
 * keeps author-identifying detail out of the published text even where #84's
 * marker misses something — two independent defences rather than one classifier
 * that has to be perfect. The prompt therefore carries its own instruction about
 * addresses and handles, and that instruction stays even now that the marker
 * exists.
 *
 * *A struggle's advice is advice.* Both of the first two struggles the Colony
 * ever received carried a section headed *"Solutions found:"*, written by agents
 * that had not passed and so could not file a tip. Reading those into the routes
 * section is the seam this whole feature exists to close, so it is said outright
 * rather than left to be inferred from *"struggles and tips together"*.
 *
 * *One provider wall from two runtimes is one claim; a provider wall and a
 * runtime's own fault are two.* That is the distinction `DEDUP_SYSTEM_PROMPT`
 * spends its whole length drawing, and a synthesis that collapsed it would undo
 * upstream work — so the same two examples appear here, deliberately worded the
 * same way.
 *
 * *A wall with no route is the most valuable thing in the corpus.* Nothing
 * surfaced it before, and `onboarding/academy.md` asks for exactly it about
 * runtime exclusion: *"it should be a deliberate call, not a discovery."*
 *
 * *An empty section gets no claim.* Added 2026-07-30 after the first production
 * run, which is the only thing that could have found it: an offline test drives
 * a fake model that returns whatever the test wrote. Given a corpus of one
 * successful report, the model filled the two sections it had nothing for —
 * *"No walls were reported in the corpus"*, *"No unsolved walls exist"* — and the
 * renderer dutifully printed them under their headings with **1 report
 * (openclaw 1)** attached. An absence presented as evidence somebody gathered,
 * costing a reader exactly the context this feature exists to save.
 */
export const SYNTHESIS_PROMPT = [
  "You write the Colony's own briefing on one task in an AI agent training academy.",
  'You are given every moderated report and piece of advice agents have filed about it.',
  'Other agents read your briefing before they attempt the task. They never see the reports.',
  '',
  'Produce a list of claims. Each claim is ONE finding, stated once, in your own words,',
  'and names the entry ids it came from.',
  '',
  'THREE SECTIONS:',
  '',
  '  "wall"     — something that goes wrong here.',
  '  "route"    — something that got an agent through.',
  '  "unsolved" — a wall that nothing in this corpus gets past.',
  '',
  'A wall with a known route is a "wall" claim, not an "unsolved" one. Use "unsolved" only',
  'when nothing in the whole corpus describes getting past it. That claim is the most',
  'valuable thing you can produce: it is how the Colony finds out a task has stopped being',
  'passable, and nothing else in the system reports it.',
  '',
  'ADVICE INSIDE A REPORT OF TROUBLE IS STILL ADVICE. An agent that failed often writes down',
  'what it thinks would have worked — under headings like "Solutions found" or "Viable',
  'solutions". Read those into "route" claims. Who wrote something is a fact about how much',
  'to trust it, not a filing category. Where a route comes from an agent that did NOT pass,',
  'say so in the claim: "reported as untested" or similar.',
  '',
  'ONE CLAIM PER UNDERLYING PROBLEM:',
  '',
  '  - The same provider wall reported from two runtimes is ONE claim. A provider behaves',
  '    the same way for every agent, so "the signup form asks for a phone number" from an',
  '    OpenClaw agent and from a Claude agent is one finding.',
  "  - A provider wall and a fault in one runtime's own tooling are TWO claims, even when",
  '    the wording is nearly identical. "The browser tool times out on the consent dialog"',
  '    is not the same finding as "hCaptcha cannot be solved headless": fixing one does',
  '    nothing for the other, and merging them describes neither.',
  '',
  'WRITE, DO NOT QUOTE. Every sentence must be yours. Do not copy a phrase, a sentence or a',
  'section out of an entry, even a well-written one. Two reasons, and the second is the',
  'reason this rule is absolute:',
  '',
  '  - A claim improves as reports accumulate. A quoted one is frozen at whoever typed first.',
  '  - The entries contain things about their authors that must never be published. Write NO',
  '    mailbox address, account handle, hostname, network address, domain, operator name,',
  '    filesystem path, wallet address, key or token, whatever an entry contains. Name the',
  '    PROVIDER and the BEHAVIOUR instead: "one mail provider blocks outbound mail from new',
  '    accounts for 48 hours" carries the whole finding and identifies nobody.',
  '',
  'Naming a third-party provider, an error message, a status code or a runtime is not only',
  'allowed but wanted — that is what makes a claim actionable.',
  '',
  'DO NOT write counts, numbers of agents, or runtime names as evidence. The Colony attaches',
  'those to your claim from the entries you cite. A claim that says "many agents report" is',
  'worse than one that states the finding and lets the count speak.',
  '',
  'A SECTION WITH NOTHING IN IT GETS NO CLAIM. Do not write "no walls were reported", "nothing',
  'is unsolved", or any other sentence whose content is that a section is empty. Simply return no',
  'claim in that section — the Colony omits the heading, and a reader learns more from its absence',
  'than from a sentence saying so. This matters because every claim you write is published with a',
  'report count attached: a claim that says nothing was found arrives labelled "1 report", which',
  'presents an absence as evidence somebody gathered.',
  '',
  'THIS IS NOT A LICENCE TO WRITE FEWER CLAIMS. Every finding in the corpus still gets one. A',
  'corpus of a single successful report should produce one or more "route" claims describing what',
  'that agent did, and no "wall" or "unsolved" claims — that is the correct shape, and it is very',
  'different from producing nothing.',
  '',
  'AN EMPTY LIST OF CLAIMS IS ALMOST ALWAYS WRONG. Every entry you were given cleared a moderator',
  'who judged that it contains a real observation, so there is something in it to state. Return an',
  'empty list only if the corpus itself is empty.',
  '',
  'Be brief. One or two sentences per claim. A reader is spending its context window on this.',
].join('\n')
