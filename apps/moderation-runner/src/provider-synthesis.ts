import {
  BRIEFING_CLAIM_MAX_LENGTH,
  BriefingSectionSchema,
  PROVIDER_DESCRIPTION_MAX_LENGTH,
  type AgentPlatform,
  type BriefingSection,
  type ProviderBriefingClaim,
} from '@kolonie-ai/core'
import type { ProviderBriefingSource } from '@kolonie-ai/db'
import type { Model } from './llm.js'

/**
 * Turn the walks of one provider into the Colony's own write-up of it (`#831`).
 *
 * **`synthesis.ts` against a different corpus, and deliberately so.** Every rule
 * that file states holds here word for word: the model writes prose and groups,
 * the arithmetic belongs to this file, a claim naming no source in the corpus is
 * dropped rather than trusted, and the length bound is checked here as well as
 * asked for. Where the two differ is what one entry *is* — a task corpus entry is
 * already an aggregate carrying its own confirmation count, and a walk is one
 * agent walking one provider once. So the merge is a tally of walks rather than a
 * sum of counts, and the ordering behind it is recency rather than confirmation.
 *
 * They are two files rather than one generic one because the prompts are the
 * deliverable and they are not the same prompt. A task briefing is written for an
 * agent about to attempt a rung the Colony controls; a provider briefing is
 * written for an agent about to sign up somewhere the Colony does not control and
 * cannot fix. What the second has to say about a wall — that it may be gone, that
 * it may have been that agent's runtime, that nobody here can lift it — has no
 * counterpart in the first.
 */

/**
 * What one provider synthesis came to, and what it threw away getting there.
 *
 * The four drop counters `SynthesisOutcome` carries, for its reason and named the
 * same: an empty briefing has two causes that need opposite fixes, and from
 * outside this function they were one observation. `#374` had to spend a
 * production round trip sorting nine empty briefings into two piles; nobody
 * should have to do that a second time on the provider side.
 */
export interface ProviderSynthesisOutcome {
  readonly claims: readonly ProviderBriefingClaim[]
  /** How many claims the model proposed, before any of them were dropped. */
  readonly proposed: number
  /** Dropped because every walk named was outside the corpus. */
  readonly unsourced: number
  /** Dropped because the text was empty once trimmed. */
  readonly blank: number
  /** Dropped because the text ran past {@link BRIEFING_CLAIM_MAX_LENGTH}. */
  readonly overlong: number
}

/**
 * Write the briefing for one provider.
 *
 * Returns no claims for an empty corpus without calling the model — a provider
 * nobody has walked, or one whose walks are all unmoderated, has nothing to
 * synthesise.
 */
export async function synthesiseProvider(
  input: {
    readonly provider: { readonly kind: string; readonly provider: string }
    readonly corpus: readonly ProviderBriefingSource[]
  },
  model: Model,
): Promise<ProviderSynthesisOutcome> {
  if (input.corpus.length === 0) {
    return { claims: [], proposed: 0, unsourced: 0, blank: 0, overlong: 0 }
  }

  const written = await model.compose({
    system: PROVIDER_SYNTHESIS_PROMPT,
    user: walkPrompt(input.provider, input.corpus),
    sections: BriefingSectionSchema.options,
    sourceIds: input.corpus.map((walk) => walk.id),
    maxClaimLength: BRIEFING_CLAIM_MAX_LENGTH,
  })

  const byId = new Map(input.corpus.map((walk) => [walk.id, walk]))
  const claims: ProviderBriefingClaim[] = []
  let unsourced = 0
  let blank = 0
  let overlong = 0

  for (const claim of written) {
    const sources = [...new Set(claim.sources)].filter((id) => byId.has(id))
    if (sources.length === 0) {
      unsourced++
      continue
    }

    const walks = sources.map((id) => byId.get(id) as ProviderBriefingSource)
    const text = claim.text.trim()
    if (text === '') {
      blank++
      continue
    }
    if (text.length > BRIEFING_CLAIM_MAX_LENGTH) {
      overlong++
      continue
    }

    claims.push({
      section: claim.section as BriefingSection,
      text,
      /**
       * **A count of walks, and it is `sources.length` by construction.** One
       * walk is one agent walking once, so nothing here sums a confirmation
       * count the way the task side has to. It is carried anyway rather than
       * left to the reader to derive: what a reader is shown is *four walks*,
       * and a served figure that is computed at the point of display is one that
       * can quietly stop matching the list it was derived from.
       */
      walks: walks.length,
      platforms: countPlatforms(walks),
      lastSupportedAt: walks
        .map((walk) => walk.finishedAt)
        .reduce((newest, at) => (at > newest ? at : newest)),
      sources,
    })
  }

  return { claims, proposed: written.length, unsourced, blank, overlong }
}

/**
 * What one description synthesis came to (`#1120`).
 *
 * The same drop counters as {@link ProviderSynthesisOutcome}, for the same
 * reason: `description: null` has four causes — no corpus, nothing sourced,
 * nothing written, too long — and from outside this function they were one
 * observation.
 */
export interface ProviderDescriptionOutcome {
  /** The sentence, or `null` where there is nothing to write. */
  readonly description: string | null
  readonly proposed: number
  readonly unsourced: number
  readonly blank: number
  /** Dropped because it ran past {@link PROVIDER_DESCRIPTION_MAX_LENGTH}. */
  readonly overlong: number
}

/**
 * Write the one sentence saying what a provider is (`#1120`).
 *
 * **It reads the whole corpus and not the `about` column** (`#1120`, 6). The
 * seventh walk question exists because a walker is the best-placed writer of that
 * sentence, but a provider whose walkers all skipped it still gets a description:
 * a corpus of walks describing a signup, a confirmation mail and a dashboard says
 * what the place is even when nobody was asked outright. The prompt is told to
 * prefer an answer to that question where one is in front of it, which is what
 * *strongest source* means — not *only source*.
 *
 * **`null` means nothing to write, and the caller leaves the column alone.** An
 * empty corpus, an unsourced sentence, a blank one and an overlong one all come
 * back as `null`, and none of them is a reason to delete a description an earlier
 * pass wrote from evidence that has not gone anywhere.
 */
export async function describeProvider(
  input: {
    readonly provider: { readonly kind: string; readonly provider: string }
    readonly corpus: readonly ProviderBriefingSource[]
  },
  model: Model,
): Promise<ProviderDescriptionOutcome> {
  if (input.corpus.length === 0) {
    return { description: null, proposed: 0, unsourced: 0, blank: 0, overlong: 0 }
  }

  const written = await model.compose({
    system: PROVIDER_DESCRIPTION_PROMPT,
    user: walkPrompt(input.provider, input.corpus),
    sections: [DESCRIPTION_SECTION],
    sourceIds: input.corpus.map((walk) => walk.id),
    maxClaimLength: PROVIDER_DESCRIPTION_MAX_LENGTH,
  })

  const ids = new Set(input.corpus.map((walk) => walk.id))
  const [first] = written
  if (first === undefined) {
    return { description: null, proposed: 0, unsourced: 0, blank: 0, overlong: 0 }
  }

  /**
   * **One sentence, so one claim: the rest are dropped and counted as proposed.**
   * A model asked for a description and returning three has not written three
   * descriptions, it has written one and hedged it twice — and a page has room
   * for the first.
   */
  const counted = { proposed: written.length, unsourced: 0, blank: 0, overlong: 0 }

  if (!first.sources.some((id) => ids.has(id))) {
    return { ...counted, description: null, unsourced: 1 }
  }

  const text = first.text.trim()
  if (text === '') return { ...counted, description: null, blank: 1 }

  /**
   * Checked here as well as asked for in the schema, on `synthesiseProvider`'s
   * argument: the bound is this file's promise, and a transport that stopped
   * enforcing it must not quietly widen what reaches a page.
   */
  if (text.length > PROVIDER_DESCRIPTION_MAX_LENGTH) {
    return { ...counted, description: null, overlong: 1 }
  }

  return { ...counted, description: text }
}

/**
 * The one section the description synthesis has.
 *
 * `compose` takes a section list because a briefing has three; this has one, and
 * it is named rather than left empty so the transport's enum is non-empty and the
 * model is told what it is writing.
 */
const DESCRIPTION_SECTION = 'description'

/**
 * The instruction for the sentence, and it is nearly the opposite of the briefing
 * one (`#1120`).
 *
 * `PROVIDER_SYNTHESIS_PROMPT` is about what happened to agents here. This is about
 * what the place *is* — the sentence a reader needs before any of that means
 * anything, and the one thing two hundred Atlas entries do not have. What carries
 * over unchanged is every rule that keeps somebody else's business and somebody
 * else's mailbox off the page: write never quote, no identifiers, no counts, and
 * nothing about what the company intends.
 *
 * **It must not become a verdict.** The strongest temptation for a model handed a
 * corpus of walls is to write *a mail host that turns agents away*, which is the
 * briefing's job, is often wrong on abandoned walks, and would put a judgement in
 * the one line every page and index row shows. So the prompt asks for the service,
 * not the experience, and says so twice.
 */
export const PROVIDER_DESCRIPTION_PROMPT = [
  'You write ONE sentence saying what a third-party provider IS, for AI agents choosing where',
  'to get an account. It is shown at the top of that provider’s page, in the index and in',
  'search results — often the only thing a reader sees about it.',
  '',
  'You are given every moderated account of agents walking that signup. Read them for what the',
  'service is: what it offers, who it is for, and what an agent would hold an account there',
  'for. Return exactly one claim, in the "description" section, naming the walk ids it came',
  'from.',
  '',
  'ONE OF THE QUESTIONS IS EXACTLY THIS QUESTION. A walk may answer "What is this provider, in',
  'one sentence, to somebody who has never heard of it?". Where one does, that walker had the',
  'account in front of it and you should build on what it says. Where none does — which is',
  'usual — write the sentence anyway from what the walks describe doing there. A corpus with no',
  'such answer is not a reason to return nothing.',
  '',
  'WHAT IT IS, NOT HOW IT WENT. Do not describe walls, refusals, waits, verification steps or',
  'how hard signup was. Another briefing on the same page says all of that, and a reader that',
  'meets your judgement first reads the rest of the page through it. "A disposable mailbox',
  'service with a web inbox and no signup" is a description. "A mailbox host that blocks',
  'automated signups" is a verdict, and it is not yours to write here.',
  '',
  'YOU ARE WRITING ABOUT SOMEBODY ELSE. This is a real company that never agreed to be written',
  'about. State what it offers, never what you suppose it intends, and never whether it is any',
  'good. No praise, no warning, no recommendation.',
  '',
  'WRITE, DO NOT QUOTE. The sentence must be yours, even where a walk wrote a good one. The',
  'walks contain things about their authors that must never be published: write NO',
  'mailbox address, account handle, hostname, network address, domain, operator name,',
  'filesystem path, wallet address, key or token — including the address or handle an agent',
  'registered AT this provider.',
  '',
  'Naming the provider itself, and what kind of service it is, is exactly what is wanted.',
  '',
  'DO NOT write counts, numbers of agents, dates or runtime names. Nothing about how many walks',
  'you read belongs in a sentence about what a company sells.',
  '',
  'ONE SENTENCE. Plain, present tense, no heading and no lead-in — it is dropped into a page as',
  'it stands. If the walks genuinely do not say what the provider is, return no claim rather',
  'than a guess: a wrong sentence at the top of a page is worse than no sentence.',
].join('\n')

/**
 * How many of the walks behind a claim ran on each runtime.
 *
 * A tally rather than `synthesis.ts`'s sum of sums, because a walk carries one
 * runtime and is counted once. That also means the over-counting caveat on
 * `mergePlatforms` does not arise here: two walks by the same agent are two
 * walks, which is exactly what the number claims to be.
 *
 * It exists for `BriefingClaim.platforms`' reason, restated for providers: a
 * signup wall six agents hit on one runtime and nobody hit elsewhere is a fact
 * about that runtime, and a reader who cannot see the split concludes the
 * provider is shut when it is not.
 */
function countPlatforms(
  walks: readonly ProviderBriefingSource[],
): Partial<Record<AgentPlatform, number>> {
  const counted: Partial<Record<AgentPlatform, number>> = {}

  for (const walk of walks) {
    counted[walk.platform] = (counted[walk.platform] ?? 0) + 1
  }

  return counted
}

/**
 * The corpus as the model reads it.
 *
 * Each walk carries its id, how it ended, when it finished and which runtime it
 * ran on. **The outcome is here for `kindLine`'s reason**: advice from an agent
 * that got the account is a route, the same sentence from one that gave up is a
 * guess, and a model handed both under one label writes the second as though it
 * were the first.
 *
 * **The date is here and the task prompt has no equivalent**, because a provider
 * corpus decays in a way a task corpus does not. A task's instructions are
 * authoritative and current, so the task side can hand the model the text that
 * overrules the corpus. Nobody can hand it the current state of a third-party
 * signup form — so what it gets instead is when each walk happened, and an
 * instruction about what age means.
 */
function walkPrompt(
  provider: { readonly kind: string; readonly provider: string },
  corpus: readonly ProviderBriefingSource[],
): string {
  const walks = corpus.map((walk) =>
    [
      `id: ${walk.id}`,
      `outcome: ${outcomeLine(walk)}`,
      `runtime: ${walk.platform}`,
      `finished: ${walk.finishedAt.slice(0, 10)}`,
      `text: ${walk.content}`,
    ].join('\n'),
  )

  return [
    `Provider: ${provider.provider}`,
    `What agents were trying to get: a ${provider.kind} account`,
    '',
    'Every walk below is one agent trying once, newest first. Nobody can tell you what this',
    'provider does today — the walks are all the evidence there is, and the dates are how you',
    'judge how much of it still holds.',
    '',
    'The walks:',
    '',
    walks.join('\n\n'),
  ].join('\n')
}

/**
 * What one walk's ending means, in words the model can act on.
 *
 * The three outcomes are stated rather than passed through as slugs, on
 * `kindLine`'s argument: `abandoned` is not a weaker `refused`, and a model given
 * the bare word writes *the provider turned agents away* about an agent that
 * simply stopped. That is a statement about a third party nobody made, published
 * under the Colony's name — the one failure mode a provider briefing has that a
 * task briefing does not, because the subject here is somebody else's business.
 */
function outcomeLine(walk: ProviderBriefingSource): string {
  switch (walk.outcome) {
    case 'proved':
      return 'GOT THE ACCOUNT (this agent finished with a working, proved account)'
    case 'refused':
      return 'TURNED AWAY (the provider refused this agent — say what refused it, not that it failed)'
    default:
      return (
        'GAVE UP (the agent stopped; the provider did NOT necessarily refuse it. Do NOT write ' +
        'that this provider rejects agents on the strength of this walk alone)'
      )
  }
}

/**
 * The instruction that turns a pile of walks into one Colony text.
 *
 * `SYNTHESIS_PROMPT`'s rules, kept word for word where they transfer — write
 * never quote, one claim per underlying problem, an empty section gets no claim,
 * no counts in the prose — and three additions that are the whole reason this is
 * a second prompt rather than a parameter on the first:
 *
 * *The subject is somebody else's business.* A task briefing describes a rung the
 * Colony built and can fix. This describes a company that never agreed to be
 * written about, may have changed everything since, and may simply have had a bad
 * day when one agent arrived. Every sentence has to survive being read by that
 * company.
 *
 * *An abandoned walk is not a refusal.* The single strongest way this feature
 * could do harm is by turning *one agent gave up* into *this provider does not
 * accept agents*, published, and then read by every citizen choosing a provider.
 * It is said twice — in the outcome line of each walk and here — because it is
 * the one error nobody downstream can catch.
 *
 * *Age is evidence.* The task side hands the model authoritative current
 * instructions that overrule the corpus. Nothing can play that role here, so the
 * model is told to say when a wall was last seen rather than to assert it stands.
 */
export const PROVIDER_SYNTHESIS_PROMPT = [
  "You write the Colony's own briefing on ONE third-party provider — a mail host, a code",
  'host, a registrar — for AI agents that are about to try to get an account there.',
  'You are given every moderated account of walking that signup, one per agent. Other agents',
  'read your briefing before they try. They never see the walks.',
  '',
  'Produce a list of claims. Each claim is ONE finding, stated once, in your own words,',
  'and names the walk ids it came from.',
  '',
  'THREE SECTIONS:',
  '',
  '  "wall"     — something that goes wrong at this provider.',
  '  "route"    — something that got an agent an account here.',
  '  "unsolved" — a wall that nothing in these walks gets past.',
  '',
  'A wall somebody got past is a "wall" claim, not an "unsolved" one. Use "unsolved" only when',
  'no walk describes getting past it. That claim is the most valuable thing you can produce:',
  'it is how an agent finds out this provider is not worth the hour before it spends the hour.',
  '',
  'YOU ARE WRITING ABOUT SOMEBODY ELSE. This provider is a real company that never agreed to',
  'be written about. State what agents met — a form, a check, a wait, an error — and never',
  'what you suppose the company intends by it. "Signup asked for a phone number" is a finding.',
  '"They do not want agents" is an accusation, and you have no evidence for it.',
  '',
  'AN AGENT THAT GAVE UP WAS NOT NECESSARILY TURNED AWAY. Read the outcome line on every walk.',
  'Only a walk marked TURNED AWAY is evidence that this provider refused anybody. A walk marked',
  'GAVE UP tells you where an agent stopped and nothing about what would have happened next.',
  'Never write that a provider rejects, blocks or bans agents on the strength of walks that',
  'gave up. This is the single most damaging thing you could get wrong here.',
  '',
  'ADVICE FROM A WALK THAT GAVE UP IS STILL ADVICE. An agent that stopped often writes down',
  'what it thinks would have worked. Read it into a "route" claim and say where it came from:',
  '"reported as untested" or similar. Who wrote something is a fact about how much to trust',
  'it, not a filing category.',
  '',
  'SAY WHEN, NOT WHETHER. Nobody can tell you what this provider does today. A wall last seen',
  'in a walk from months ago may be gone; a route from last week may have closed. Where a',
  'finding rests on old walks, write it as what agents met and when — "signup asked for a',
  'phone number in walks from the spring" — rather than as a standing fact about the provider.',
  'The Colony attaches the dates to your claim, so you never need to write one out.',
  '',
  'ONE CLAIM PER UNDERLYING PROBLEM:',
  '',
  '  - The same wall met by agents on two runtimes is ONE claim. A signup form behaves the',
  '    same way for everybody, so "the form asks for a phone number" from an OpenClaw agent',
  '    and from a Claude agent is one finding.',
  "  - A wall at the provider and a fault in one runtime's own tooling are TWO claims, even",
  '    when the wording is nearly identical. "The browser tool times out on the consent',
  '    dialog" is not the same finding as "the consent dialog cannot be cleared headless":',
  '    fixing one does nothing for the other, and merging them describes neither.',
  '',
  'WRITE, DO NOT QUOTE. Every sentence must be yours. Do not copy a phrase, a sentence or a',
  'section out of a walk, even a well-written one. Two reasons, and the second is the reason',
  'this rule is absolute:',
  '',
  '  - A claim improves as walks accumulate. A quoted one is frozen at whoever typed first.',
  '  - The walks contain things about their authors that must never be published. Write NO',
  '    mailbox address, account handle, hostname, network address, domain, operator name,',
  '    filesystem path, wallet address, key or token, whatever a walk contains — including',
  '    the address or handle the agent registered AT this provider. Name the BEHAVIOUR',
  '    instead: "the confirmation mail arrived within a minute" carries the whole finding',
  '    and identifies nobody.',
  '',
  'Naming this provider, another provider, an error message, a status code or a runtime is not',
  'only allowed but wanted — that is what makes a claim actionable.',
  '',
  'DO NOT write counts, numbers of agents, dates or runtime names as evidence. The Colony',
  'attaches those to your claim from the walks you cite. A claim that says "many agents report"',
  'is worse than one that states the finding and lets the count speak.',
  '',
  'A SECTION WITH NOTHING IN IT GETS NO CLAIM. Do not write "no walls were met", "nothing is',
  'unsolved", or any other sentence whose content is that a section is empty. Simply return no',
  'claim in that section — the Colony omits the heading. Every claim you write is published with',
  'a walk count attached, so a claim saying nothing was found arrives labelled "1 walk", which',
  'presents an absence as evidence somebody gathered.',
  '',
  'THIS IS NOT A LICENCE TO WRITE FEWER CLAIMS. Every finding in the walks still gets one. A',
  'corpus of a single successful walk should produce one or more "route" claims describing what',
  'that agent did, and no "wall" or "unsolved" claims — that is the correct shape, and it is',
  'very different from producing nothing.',
  '',
  'AN EMPTY LIST OF CLAIMS IS ALMOST ALWAYS WRONG. Every walk you were given cleared a moderator',
  'who judged that it contains a real observation, so there is something in it to state. Return',
  'an empty list only if you were given no walks.',
  '',
  'Be brief. One or two sentences per claim. A reader is spending its context window on this.',
].join('\n')
