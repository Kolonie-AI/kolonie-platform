import {
  ATLAS_CATEGORY_PROPOSAL_WHY_MAX_LENGTH,
  ATLAS_CATEGORY_STANDFIRST_MAX_LENGTH,
  ATLAS_CATEGORY_TITLE_MAX_LENGTH,
  atlasCategoryProposalSections,
  atlasCategoryProposalTarget,
  atlasCategorySlugFromTitle,
  type AtlasCategoryProposalDraft,
  type AtlasCategoryRow,
} from '@kolonie-ai/core'
import type { ProviderBriefingSource } from '@kolonie-ai/db'
import type { Log } from './loop.js'
import type { Model } from './llm.js'

/**
 * The pass that reads walks and says where a provider belongs (`#1106`).
 *
 * **A proposal and never a write.** Everything below produces a row in
 * `atlas_category_proposals` that a maintainer accepts or declines; nothing here
 * moves an entry, adds a shelf or touches the taxonomy. That is decision 1, and it
 * is the whole difference between this and `atlas.ts`: the admission pass judges a
 * provider against three written questions and its verdict is the decision,
 * because *is this a real service an agent can hold an account at* has an answer
 * anybody can check afterwards. *Which shelf does this belong on* does not — the
 * taxonomy is fifteen shelves somebody chose, and a model that could add to them
 * unattended would be reshaping the map between two readings of it.
 *
 * **The population is `#1096`'s fallback**: pairs whose kind reaches no shelf, so
 * the entry a reader sees today was defaulted rather than classified. A kind
 * `atlasCategoryForKind` already answers for produces nothing here, which is what
 * keeps this from proposing a shelf for `mailbox` once a month forever.
 *
 * **Every drop is counted rather than logged and forgotten**, on
 * `ProviderSynthesisOutcome`'s argument: *nothing was proposed* has four causes
 * that need opposite fixes — no corpus, nothing left to propose, a claim citing no
 * walk, a shelf the model would not name — and from outside this function they
 * were one observation.
 */

/** Where this pass reads and writes. Injected, so the decision is testable without a database. */
export interface AtlasCategoryProposalStore {
  /** Pairs whose kind reaches no shelf and which have no open proposal, newest walk first. */
  queue(limit: number): Promise<readonly AtlasCategoryPair[]>
  /** The taxonomy as it stands, which a maintainer may have added to since the release. */
  categories(): Promise<readonly AtlasCategoryRow[]>
  /** The moderated walks behind one pair — the only evidence a proposal may cite. */
  corpus(pair: AtlasCategoryPair): Promise<readonly ProviderBriefingSource[]>
  /** Slugs already proposed for this pair, whatever a maintainer decided. */
  settled(pair: AtlasCategoryPair): Promise<readonly string[]>
  /** Slugs the pair's entry already sits on, its primary among them. */
  held(pair: AtlasCategoryPair): Promise<readonly string[]>
  raise(input: {
    readonly kind: string
    readonly provider: string
    readonly draft: AtlasCategoryProposalDraft
    readonly model: string
  }): Promise<{ readonly outcome: 'raised' | 'already-open' | 'already-proposed' }>
}

/** One account kind at one provider, which is what a proposal is about. */
export interface AtlasCategoryPair {
  readonly kind: string
  readonly provider: string
}

export interface AtlasCategoryProposalDependencies {
  readonly store: AtlasCategoryProposalStore
  readonly model: Model
  readonly log?: Log
}

const silentLog: Log = { info: () => {}, warn: () => {}, error: () => {} }

/**
 * What one pair came to, and what it threw away getting there.
 *
 * `proposed` counts what the model wrote before any rule was applied, so a pass
 * that proposes nothing can be read: `proposed: 0` is a model with nothing to say,
 * and `proposed: 3, unsourced: 3` is a model guessing from the provider's name.
 */
export interface CategoryProposalOutcome {
  /** The draft, or `null` where nothing survived. */
  readonly draft: AtlasCategoryProposalDraft | null
  readonly proposed: number
  /** Dropped because every walk it named was outside the corpus. */
  readonly unsourced: number
  /** Dropped because the reason was empty once trimmed. */
  readonly blank: number
  /** Dropped because a new shelf arrived without a usable title or standfirst. */
  readonly unnamed: number
}

const NOTHING: CategoryProposalOutcome = {
  draft: null,
  proposed: 0,
  unsourced: 0,
  blank: 0,
  unnamed: 0,
}

/**
 * Read one pair's walks and write at most one proposal.
 *
 * **At most one, and the rest are counted as proposed.** A model handed a
 * provider and fifteen shelves will happily name three of them; three shelves is
 * not three findings, it is one finding hedged twice, and a maintainer asked to
 * decide all three has been handed the model's uncertainty rather than its answer.
 *
 * **A shelf the pair already sits on is never in the section list**, so decision 7
 * costs no call: a slug a maintainer declined last month, and the shelf the entry
 * is filed under, are both left out of what the model may choose from. A pair with
 * nothing left to propose returns without paying for an answer.
 */
export async function proposeCategory(
  pair: AtlasCategoryPair,
  deps: AtlasCategoryProposalDependencies,
): Promise<CategoryProposalOutcome> {
  const { store, model } = deps

  const corpus = await store.corpus(pair)
  if (corpus.length === 0) return NOTHING

  const [categories, settled, held] = await Promise.all([
    store.categories(),
    store.settled(pair),
    store.held(pair),
  ])

  const sections = atlasCategoryProposalSections({ categories, settled, held })
  if (sections.length === 0) return NOTHING

  const sourceIds = corpus.map((walk) => walk.id)
  const written = await model.compose({
    system: ATLAS_CATEGORY_PROPOSAL_PROMPT,
    user: corpusPrompt(pair, corpus, categories),
    sections,
    sourceIds,
    maxClaimLength: ATLAS_CATEGORY_PROPOSAL_WHY_MAX_LENGTH,
  })

  const [first] = written
  if (first === undefined) return NOTHING

  const counted = { proposed: written.length, unsourced: 0, blank: 0, unnamed: 0 }

  const ids = new Set(sourceIds)
  const walks = [...new Set(first.sources)].filter((id) => ids.has(id))
  if (walks.length === 0) return { ...counted, draft: null, unsourced: 1 }

  const why = first.text.trim()
  if (why === '') return { ...counted, draft: null, blank: 1 }
  /**
   * Checked here as well as asked for in the schema, on `describeProvider`'s
   * argument: the bound is this file's promise, and a transport that stopped
   * enforcing it must not quietly widen what reaches the table.
   */
  if (why.length > ATLAS_CATEGORY_PROPOSAL_WHY_MAX_LENGTH) {
    return { ...counted, draft: null, blank: 1 }
  }

  const target = atlasCategoryProposalTarget(first.section)
  if (target === null) return { ...counted, draft: null, unnamed: 1 }

  if ('add' in target) {
    return { ...counted, draft: { shape: 'existing', category: target.add, why, walks } }
  }

  const named = await nameShelf(pair, corpus, target.under, model)
  if (named === null) return { ...counted, draft: null, unnamed: 1 }

  return { ...counted, draft: { shape: 'new-sub', parent: target.under, why, walks, ...named } }
}

/**
 * Ask for the title and the standfirst of a shelf that does not exist yet.
 *
 * **A second call rather than two more fields on the first**, because the first
 * call's answer is what decides whether these are wanted at all: a model asked for
 * a heading and a sentence alongside a shelf it may not propose writes them
 * anyway, and a maintainer then reads a name for something nobody suggested. It
 * also keeps the shape of the first answer identical whichever section wins, which
 * is what lets the drop rules above run before anything reaches this.
 *
 * **The slug is derived from the title and never asked for.** A model asked for an
 * address answers with prose about half the time, and a title that yields no slug
 * is a proposal dropped rather than one repaired into an address nobody chose.
 */
async function nameShelf(
  pair: AtlasCategoryPair,
  corpus: readonly ProviderBriefingSource[],
  parent: string,
  model: Model,
): Promise<{
  readonly category: string
  readonly title: string
  readonly standfirst: string
} | null> {
  const written = await model.compose({
    system: ATLAS_CATEGORY_NAMING_PROMPT,
    user: [
      `Provider: ${pair.provider}`,
      `What agents were trying to get: a ${pair.kind} account`,
      `The top category the new shelf hangs from: ${parent}`,
      '',
      'The walks:',
      '',
      corpus.map((walk) => `id: ${walk.id}\ntext: ${walk.content}`).join('\n\n'),
    ].join('\n'),
    sections: [NAMING_TITLE, NAMING_STANDFIRST],
    sourceIds: corpus.map((walk) => walk.id),
    maxClaimLength: ATLAS_CATEGORY_STANDFIRST_MAX_LENGTH,
  })

  const pick = (section: string): string =>
    written.find((claim) => claim.section === section)?.text.trim() ?? ''

  const title = pick(NAMING_TITLE)
  const standfirst = pick(NAMING_STANDFIRST)
  if (title === '' || title.length > ATLAS_CATEGORY_TITLE_MAX_LENGTH) return null
  if (standfirst === '' || standfirst.length > ATLAS_CATEGORY_STANDFIRST_MAX_LENGTH) return null

  const category = atlasCategorySlugFromTitle(title)

  return category === null ? null : { category, title, standfirst }
}

/** The heading a reader sees at the top of the shelf. */
const NAMING_TITLE = 'title'

/** The one sentence under it, saying what belongs there. */
const NAMING_STANDFIRST = 'standfirst'

export interface AtlasCategoryProposalTickOutcome {
  readonly considered: number
  readonly raised: number
  /** Considered and nothing survived, which is the ordinary quiet outcome. */
  readonly skipped: number
  /** Raised into a row that was already there, on either unique index. */
  readonly duplicate: number
  readonly failed: number
}

/**
 * One pass over the queue.
 *
 * Sequential rather than concurrent, for `atlasTick`'s reason turned one way
 * round: two pairs proposed in parallel are cheap, but a model that is
 * unreachable should cost one pair's tick and not the batch's, and the store's
 * `settled` read for a pair is only current while nothing else is writing.
 *
 * **A failure leaves the pair in the queue.** Nothing is recorded until the draft
 * is whole, so an outage costs a tick and produces no half-written proposal for a
 * maintainer to puzzle over.
 */
export async function atlasCategoryProposalTick(
  deps: AtlasCategoryProposalDependencies,
  batchSize: number,
): Promise<AtlasCategoryProposalTickOutcome> {
  const { store, model, log = silentLog } = deps
  const pairs = await store.queue(batchSize)

  const outcome = { considered: 0, raised: 0, skipped: 0, duplicate: 0, failed: 0 }

  for (const pair of pairs) {
    outcome.considered++

    try {
      const proposed = await proposeCategory(pair, deps)
      if (proposed.draft === null) {
        outcome.skipped++
        log.info(`${pair.provider} was left where it is`, {
          event: 'atlas.category.skipped',
          provider: pair.provider,
          kind: pair.kind,
          proposed: proposed.proposed,
          unsourced: proposed.unsourced,
          blank: proposed.blank,
          unnamed: proposed.unnamed,
        })
        continue
      }

      const written = await store.raise({
        kind: pair.kind,
        provider: pair.provider,
        draft: proposed.draft,
        model: model.name,
      })

      if (written.outcome === 'raised') {
        outcome.raised++
        log.info(`${pair.provider} proposed for ${proposed.draft.category}`, {
          event: 'atlas.category.proposed',
          provider: pair.provider,
          kind: pair.kind,
          category: proposed.draft.category,
          shape: proposed.draft.shape,
        })
      } else {
        outcome.duplicate++
        log.warn(`${pair.provider} was already proposed when this one arrived`, {
          event: 'atlas.category.duplicate',
          provider: pair.provider,
          kind: pair.kind,
          verdict: written.outcome,
        })
      }
    } catch (error) {
      outcome.failed++
      log.error(`${pair.provider} could not be proposed for a shelf`, error, {
        event: 'atlas.category.failed',
        provider: pair.provider,
        kind: pair.kind,
      })
    }
  }

  return outcome
}

/**
 * The corpus and the taxonomy as the model reads them.
 *
 * **The shelves are listed with their standfirsts rather than as slugs.** The
 * section names carry the slugs already; what a model deciding between
 * `knowledge-docs` and `project-tracking` needs is the sentence each shelf claims
 * for itself, which is exactly what a maintainer wrote it for.
 */
function corpusPrompt(
  pair: AtlasCategoryPair,
  corpus: readonly ProviderBriefingSource[],
  categories: readonly AtlasCategoryRow[],
): string {
  const shelves = categories
    .filter((one) => one.parent !== null)
    .map((one) => `  ${one.slug} — ${one.title}: ${one.standfirst}`)

  const walks = corpus.map((walk) =>
    [`id: ${walk.id}`, `finished: ${walk.finishedAt.slice(0, 10)}`, `text: ${walk.content}`].join(
      '\n',
    ),
  )

  return [
    `Provider: ${pair.provider}`,
    `What agents were trying to get: a ${pair.kind} account`,
    '',
    'The shelves the Atlas already has:',
    '',
    ...shelves,
    '',
    'The walks. This is the only evidence there is about this provider, and the only thing you',
    'may cite:',
    '',
    walks.join('\n\n'),
  ].join('\n')
}

/**
 * The instruction for the shelf itself.
 *
 * **It asks for one answer and says why a wrong one is expensive.** The section
 * list is closed and already excludes everything settled, so the model cannot
 * propose a top category, cannot re-propose a declined slug and cannot name the
 * shelf the entry is already on — which leaves this prompt one job: choose between
 * what remains, or say nothing.
 *
 * **Saying nothing is a real answer and is stated as one.** The default failure of
 * a classifier handed fifteen labels and an unfamiliar provider is to pick the
 * nearest, and the nearest shelf is precisely what `#1096`'s fallback already
 * gives a reader. A proposal is only worth a maintainer's attention if it is
 * better than the default, so an unclear corpus should produce nothing.
 */
export const ATLAS_CATEGORY_PROPOSAL_PROMPT = [
  'You say where one third-party provider belongs in the Atlas of Kolonie AI — a map of places',
  'AI agents can get an account, shelved by what the account is for.',
  '',
  'This provider is on a shelf nobody chose. The Colony had no shelf for the kind of account',
  'agents were getting there, so it was filed under a default. You are reading the accounts of',
  'agents who actually walked that signup, to say where a reader would look for it.',
  '',
  'Return AT MOST ONE claim. The section you put it in IS your answer:',
  '',
  '  "add:<shelf>"       — this provider belongs on that existing shelf.',
  '  "new-under:<top>"   — no existing shelf fits, and a new one belongs under that top',
  '                        category. Use this sparingly: a shelf is part of the map and is',
  '                        read by everybody, and fifteen of them already exist.',
  '',
  'The text of your claim is WHY, in one or two sentences, for the maintainer who decides. Say',
  'what the walks describe agents doing at this provider that puts it there. Name the walk ids',
  'it came from.',
  '',
  'NOTHING IS A REAL ANSWER, AND OFTEN THE RIGHT ONE. Return no claim at all if the walks do',
  'not say clearly enough what this provider is for. The entry already sits somewhere; a',
  'proposal is only worth reading if it is better than that, and a shelf chosen because it was',
  'the nearest of fifteen is worse than the default it would replace — it is the same guess',
  'wearing a maintainer’s approval.',
  '',
  'JUDGE THE SERVICE, NOT THE SIGNUP. Where the account belongs has nothing to do with whether',
  'signup went well. A provider that turned every agent away still belongs on the shelf for',
  'what it sells.',
  '',
  'WRITE, DO NOT QUOTE. The walks contain things about their authors that must never be',
  'stored: write NO mailbox address, account handle, hostname, network address, domain,',
  'operator name, filesystem path, wallet address, key or token — including the address or',
  'handle an agent registered AT this provider. Naming the provider itself is what is wanted.',
  '',
  'A claim citing no walk is dropped. Do not answer from the provider’s name.',
].join('\n')

/**
 * The instruction for naming a shelf that does not exist yet.
 *
 * Separate because it is a different job with different failure modes: the first
 * prompt classifies, this one writes two pieces of published text that a hundred
 * entries may end up under. What carries over is every rule that keeps somebody
 * else's mailbox off the map, and one addition — **the shelf is not this
 * provider**. The strongest temptation for a model naming a category from one
 * provider's walks is to name the provider, which produces a taxonomy with one
 * company in it.
 */
export const ATLAS_CATEGORY_NAMING_PROMPT = [
  'You are naming a NEW shelf for the Atlas of Kolonie AI — a map of places AI agents can get',
  'an account, shelved by what the account is for. A shelf holds many providers and is read by',
  'everybody; the provider below is only the one that showed the shelf was missing.',
  '',
  'Return exactly two claims:',
  '',
  '  "title"      — the heading, two or three words, capitalised as a heading. "Ticketing",',
  '                 "Video Hosting". Not a sentence, no trailing full stop.',
  '  "standfirst" — ONE sentence under it saying what an agent would keep an account here for.',
  '                 Present tense, plain, no lead-in.',
  '',
  'NAME THE CATEGORY, NOT THE PROVIDER. The title must describe what this kind of account is',
  'for, so that other providers can be filed under it. A title naming one company is a shelf',
  'nothing else can ever go on.',
  '',
  'WRITE, DO NOT QUOTE, and write no mailbox address, account handle, hostname, network',
  'address, domain, operator name, filesystem path, wallet address, key or token.',
  '',
  'Name the walk ids each claim came from.',
].join('\n')
