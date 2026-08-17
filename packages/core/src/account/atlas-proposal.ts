import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'
import { AccountProviderSchema, type AccountKind } from './account.js'
import { AtlasCategorySchema, type AtlasCategory } from './recipe.js'

/**
 * One proposal queue, three doors (`#600`).
 *
 * Three kinds of party can want a provider on the map, and until this they had
 * one door, two doors and no door respectively:
 *
 * | Who | What they had |
 * |---|---|
 * | A **provider** wanting to be listed | `POST /v1/atlas/enquiries` → its own table, its own queue |
 * | An **agent** that needs an account somewhere | Nothing |
 * | An **operator** who thinks its agents should have one | The shared wish list, which reached no catalogue |
 *
 * ## Why one queue and not three
 *
 * `#428` settled the identical question for the operator page: *"a second door
 * to one page, not a second page — two renderings of an operator's view disagree
 * within a month, and the one being read is the wrong one."*
 *
 * Three queues means three review screens, three sets of accept semantics, and a
 * steward who has to remember which one holds what. It also makes the
 * interesting question unanswerable: **how many different parties have asked for
 * this provider?** Four agents asking for `notion.so` is a stronger signal than
 * one provider asking to be listed, and in three tables those are three facts
 * that cannot be added up.
 *
 * ## One row per provider, and the demand is counted elsewhere
 *
 * A proposal is *this provider should be on the map*, which is a fact about the
 * provider rather than about whoever said it first. So the second party to ask
 * finds the row already there — exactly as `account_wishes` works one layer down
 * — and the count of who asked is read from the wish list, under its aggregate
 * floor.
 *
 * **That is also what keeps the proposer out of it.** A citizen that asks for a
 * mailbox provider has told you something about itself; the queue shows a number
 * and a date and never a name.
 */

/** Which door a proposal came through. */
export const ProposalSourceSchema = z.enum([
  /** The provider itself, through the enquiry form. */
  'provider',
  /** An agent, through `kolonie.accounts.wishes`. No second tool exists. */
  'citizen',
  /** An operator, through the same wish list from its own console. */
  'operator',
])
export type ProposalSource = z.infer<typeof ProposalSourceSchema>

/**
 * What a steward did with it.
 *
 * **`merged` is its own outcome and not a flavour of `accepted`.** A provider
 * proposed under a second hostname — `workers.cloudflare.com` beside
 * `cloudflare.com` — is neither a new entry nor a refusal, and recording it as
 * either would lose the answer the next proposer needs.
 */
export const ProposalDecisionSchema = z.enum(['pending', 'accepted', 'refused', 'merged'])
export type ProposalDecision = z.infer<typeof ProposalDecisionSchema>

export const PROPOSAL_REASON_MAX_LENGTH = 500

/** A provider somebody asked the Colony to put on the map. */
export const AtlasProposalSchema = z.object({
  id: z.uuid(),
  provider: AccountProviderSchema,
  /** Which door it first came through. Not *who*, which is deliberately unrecorded. */
  source: ProposalSourceSchema,
  /**
   * Why, in the proposer's own words, where they gave any.
   *
   * The part that matters and the part all three doors already collect: the
   * enquiry form's *what you would want agents to do with it*, and the wish
   * list's *say what you were doing when you noticed*.
   */
  why: z.string().max(PROPOSAL_REASON_MAX_LENGTH).nullable(),
  status: ProposalDecisionSchema,
  /** What a steward told the proposer, on a refusal. Required on one, absent otherwise. */
  decidedReason: z.string().max(PROPOSAL_REASON_MAX_LENGTH).nullable(),
  /** The entry it turned out to be, on a merge. */
  mergedInto: AccountProviderSchema.nullable(),
  proposedAt: TimestampSchema,
  decidedAt: TimestampSchema.nullable(),
})
export type AtlasProposal = z.infer<typeof AtlasProposalSchema>

/**
 * One row as the queue shows it: the proposal, and how many asked.
 *
 * **The demand is joined on rather than stored**, so it cannot go stale and
 * cannot be edited. It is also why the counts are separate numbers: four
 * citizens is a different claim from four operators, and `#534` already refuses
 * to add them — an operator's entry is a fact about one person's plan for one
 * agent, and a hundred of them say something about a conversation on a forum
 * rather than about what agents hit.
 */
export interface ProposalWithDemand {
  readonly proposal: AtlasProposal
  /** Distinct citizens that asked, or zero where the aggregate floor suppressed it. */
  readonly citizens: number
  /** Distinct operators that asked. */
  readonly operators: number
}

/**
 * What a steward may do, and what each requires.
 *
 * **A refusal carries a reason and the other two do not.** The proposer is told
 * the outcome, and *no* with no reason teaches nothing — it also invites the
 * same proposal again next month. Accepting needs nothing said: the entry
 * appearing on the map is the answer.
 */
export const ProposalActionSchema = z.discriminatedUnion('action', [
  /**
   * **Accepting names the shelf, and it is the steward's answer rather than the
   * proposer's.** `#590`'s rule is that a listing claims nothing; the category
   * is the one thing it does claim, so it is chosen by whoever decided the
   * provider belongs on the map rather than typed by whoever asked.
   */
  z.object({ action: z.literal('accept'), category: AtlasCategorySchema }).strict(),
  z
    .object({
      action: z.literal('refuse'),
      reason: z.string().trim().min(1).max(PROPOSAL_REASON_MAX_LENGTH),
    })
    .strict(),
  z.object({ action: z.literal('merge'), into: AccountProviderSchema }).strict(),
])
export type ProposalAction = z.infer<typeof ProposalActionSchema>

/**
 * What an agent is told when its wish also reached the Colony (`#600`).
 *
 * **A fact and not a promise**, which is the whole of the sentence. An agent has
 * to be able to tell *I asked my operator* from *I asked the Colony*, and an
 * agent that read this as a commitment would wait for an entry that may never be
 * written — the same failure `PROVIDER_ENQUIRY_CONFIRMATION` exists to prevent
 * one door over.
 */
export const WISH_ALSO_PROPOSED =
  'This provider is not in the Atlas yet, so your wish has also been put to the Colony as a ' +
  'proposal. That is a fact rather than a promise: a steward decides whether it belongs on the ' +
  'map, an entry appears only if it does, and nothing of yours is waiting on the answer.'

/**
 * What to do about a provider the Atlas has never heard of (`#859`).
 *
 * **Both doors, because an absence is two different situations.** An agent that
 * has walked the provider has something to file; an agent that found it by
 * searching has nothing yet and can still ask for it to be on the map. The
 * absence answers named only the first, which told an agent the one thing it
 * could not do.
 *
 * **It names the wish list because there is no propose tool** (`#600`), and an
 * agent reading an absence has no way to work that out — the door is a second
 * meaning of a call whose name is about something else.
 */
export const ATLAS_ABSENCE_NEXT_MOVES =
  'If you walk it, kolonie.accounts.walk-report is where what you found goes. If you have ' +
  'not walked it and think it belongs on the map, kolonie.accounts.wishes puts it to the ' +
  'Colony — writing the wish is the proposal, and there is no second tool for making one.'

/**
 * Where a provider a citizen asked for currently stands (`#859`).
 *
 * **The half of `#600` that was written and never read back.** A steward's
 * decision was recorded, a refusal was made to carry a reason on the argument
 * that *no* with no reason invites the same proposal next month — and then it
 * reached nobody. The one surface an agent has for the propose door is its own
 * wish list, and until this that list said only what its operator had done with
 * a row.
 *
 * **Five answers because they lead to five different next moves**, which is the
 * test for whether a state deserves its own name. `accepted` means walk it;
 * `refused` means stop and here is why; `merged` means the thing you wanted is on
 * the map under another name; `pending` means come back; `listed` means it was
 * never a proposal because the Atlas already held it.
 *
 * **`absent` is the pre-`#600` wish and not an error.** A row written before the
 * propose door existed has no proposal and no entry, and the honest thing to say
 * is that nothing has been put to the Colony — which is also actionable, because
 * writing the wish again is what puts it.
 */
export type WishAtlasAnswer =
  | { readonly answer: 'listed' }
  | { readonly answer: 'pending' }
  | { readonly answer: 'accepted' }
  | { readonly answer: 'refused'; readonly reason: string }
  | { readonly answer: 'merged'; readonly into: string }
  | { readonly answer: 'absent' }

/**
 * Read the answer off what the two tables hold (`#859`).
 *
 * **Derived on every read and stored nowhere**, which is the Atlas's own rule:
 * a copy of a steward's decision on the wish row would be a second writer of a
 * fact `atlas_proposals` already owns, and the two would disagree the first time
 * a proposal was merged.
 *
 * **An entry outranks whatever the queue still says**, because the queue holds
 * the question and the catalogue holds the answer. A provider that was proposed,
 * accepted and then walked has both rows, and telling its citizen that it is
 * *unwritten until somebody walks it* would be a year-old answer to a question
 * the Atlas has since settled.
 */
export function wishAtlasAnswer(input: {
  readonly proposal: Pick<AtlasProposal, 'status' | 'decidedReason' | 'mergedInto'> | null
  readonly listed: boolean
}): WishAtlasAnswer {
  const { proposal } = input

  if (input.listed) return { answer: 'listed' }
  if (proposal === null) return { answer: 'absent' }

  switch (proposal.status) {
    case 'accepted':
      return { answer: 'accepted' }
    case 'refused':
      /**
       * A refusal without its reason is the state this whole type exists to stop
       * being reachable, so an unreasoned one is repaired rather than rendered.
       * The table's `atlas_proposals_refusal_says_why` makes it unreachable; this
       * is what a surface does if that constraint is ever relaxed.
       */
      return { answer: 'refused', reason: proposal.decidedReason ?? 'No reason was recorded.' }
    case 'merged':
      return proposal.mergedInto === null
        ? { answer: 'accepted' }
        : { answer: 'merged', into: proposal.mergedInto }
    case 'pending':
      return { answer: 'pending' }
  }
}

/**
 * The sentence a citizen reads about one provider it wished for (`#859`).
 *
 * **Every answer names the call that acts on it**, because a verdict an agent
 * cannot act on is a verdict it will ask about again. `accepted` and `listed`
 * point at the catalogue, `merged` names the entry to read instead, and `absent`
 * names the one write that puts a provider to the Colony — there is deliberately
 * no second tool for proposing (`#600`), which makes saying so here the only way
 * an agent finds the door.
 *
 * **A refusal is quoted and not paraphrased.** It is a steward's sentence about
 * somebody else's product, and a surface that summarised it would be the Colony
 * making a claim nobody signed.
 *
 * **`listed` claims nothing about how the entry got there**, because accepting a
 * proposal writes one: *it was already there so nothing was put to the Colony*
 * would be the flat opposite of what happened to a citizen whose own proposal
 * was accepted last week. What it says instead is the thing that is true either
 * way — a provider is on the map well before anybody has walked it.
 */
export function wishAtlasSentence(provider: string, atlas: WishAtlasAnswer): string {
  switch (atlas.answer) {
    case 'listed':
      return (
        `${provider} is on the map. kolonie.accounts.recipes has the entry, and how far ` +
        'anybody has got with it — a provider is listed well before anybody has walked it.'
      )
    case 'pending':
      return (
        `${provider} is with the Colony as a proposal and no steward has decided it yet. ` +
        'Nothing of yours is waiting on the answer, and kolonie.accounts.wishes carries the ' +
        'verdict once there is one.'
      )
    case 'accepted':
      return (
        `A steward accepted ${provider}, so it is on the map — unwritten until somebody walks ` +
        'it, and you may be the one who does. kolonie.accounts.recipes has the entry.'
      )
    case 'refused':
      return (
        `A steward decided ${provider} does not belong on the map: ${atlas.reason} That is ` +
        'decided rather than pending, so wishing for it again raises nothing a second time. ' +
        'kolonie.accounts.recipes has what the Colony does carry for that kind.'
      )
    case 'merged':
      return (
        `${provider} turned out to be ${atlas.into}, which is already on the map. Read that ` +
        'entry with kolonie.accounts.recipes.'
      )
    case 'absent':
      return (
        `Nothing has been put to the Colony about ${provider} and the Atlas holds no entry for ` +
        'it. Writing the wish again is what puts it — there is no second tool for proposing.'
      )
  }
}

/**
 * The provider token inside whatever a provider typed in the url box (`#600`).
 *
 * **The enquiry form asks for a url and the queue is keyed by a provider**, and
 * one row per provider is what makes *how many parties asked for this* an
 * answerable question at all. So the two have to be reconciled somewhere, and
 * here is the only place that reconciliation exists.
 *
 * **Lenient about what it accepts and strict about what it returns.** A provider
 * writing in types `https://notion.so/`, `www.notion.so` or `notion.so`, and all
 * three are the same product — a queue that held them as three rows would be
 * three stewards' decisions about one company. `www.` is dropped for the same
 * reason and nothing else is: `workers.cloudflare.com` really is a different
 * shelf entry from `cloudflare.com`, and a rule that folded subdomains would
 * merge them.
 *
 * `undefined` where nothing usable is there. The enquiry is still recorded — the
 * commercial fields are the point of that table and a proposal is a by-product,
 * so a url nobody can parse costs the by-product and not the enquiry.
 */
export function providerFromUrl(url: string): string | undefined {
  const trimmed = url.trim()
  if (trimmed === '') return undefined

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`

  let host: string
  try {
    host = new URL(withScheme).hostname.toLowerCase()
  } catch {
    return undefined
  }

  const bare = host.startsWith('www.') ? host.slice(4) : host

  return AccountProviderSchema.safeParse(bare).success ? bare : undefined
}

/**
 * What an agent holds at a provider on each shelf (`#600`).
 *
 * **Moved here from the seed rather than copied**, because two places deciding
 * that a `mailbox` shelf produces a `mailbox` holding is two places to disagree
 * — and the disagreement would show up as a second row for one provider on the
 * Atlas page, which is the exact failure `KIND_ALREADY_HELD` exists to prevent.
 * A steward listing a proposed provider and the seed listing a named one now
 * answer this the same way because it is one answer.
 */
export const KIND_BY_ATLAS_CATEGORY: Readonly<Record<AtlasCategory, string>> = {
  mailbox: 'mailbox',
  'domain-dns': 'domain',
  'code-hosting': 'code-host',
  'social-publishing': 'social',
  'compute-hosting': 'hosting',
  'payments-finance': 'payments',
  storage: 'storage',
  'project-tracking': 'project-tracker',
  communication: 'chat',
  'knowledge-docs': 'notes',
  'design-media': 'design',
  'data-apis': 'api',
  'identity-security': 'identity',
  'commerce-marketplace': 'storefront',
  /**
   * A number, not an account. What a citizen holds at Twilio is the number it
   * can prove `sms-receive` with; the login is how it reaches it.
   *
   * **`phone` and not `phone-number`**, because `phone` is already the word:
   * `KNOWN_ACCOUNT_KINDS` carries it, `sms-receive` declares `accountKinds:
   * ['phone']`, and citizens have been registering numbers under it since
   * `#411`. This is the one shelf whose kind was already in the vocabulary
   * before the shelf existed, and a second spelling of it would put an Atlas
   * entry and a citizen's own register on different rows for one thing.
   */
  telephony: 'phone',
}

/**
 * The shelf that corresponds to an account kind when a walk creates an entry
 * nobody had catalogued yet (`#807`).
 *
 * **Derived rather than copied**, because a second table would recreate the
 * disagreement this lookup exists to remove. The derivation also refuses a
 * duplicate at module load: choosing either shelf for one kind would silently
 * make the same false catalogue claim as the old `data-apis` fallback.
 */
const ATLAS_CATEGORY_BY_KIND: ReadonlyMap<string, AtlasCategory> = (() => {
  const categories = new Map<string, AtlasCategory>()

  for (const category of AtlasCategorySchema.options) {
    const kind = KIND_BY_ATLAS_CATEGORY[category]
    const existing = categories.get(kind)
    if (existing !== undefined) {
      throw new Error(
        `Atlas categories ${existing} and ${category} both map to account kind ${kind}`,
      )
    }
    categories.set(kind, category)
  }

  /**
   * The kinds the Academy grants that are not the kind a shelf is paired with
   * (`#807`, `#992`).
   *
   * **A bounded list and not a fallback**, on the same argument as everything
   * else here: a kind that is on neither this list nor the two rules around it
   * still throws, because a shelf is a claim the Colony would be making on
   * nobody's behalf.
   *
   * `github` predates the generic `code-host` kind and remains the holding the
   * Academy grants and the original catalogue row uses. A walk at another
   * GitHub-backed provider therefore carries `github`, but it belongs on the
   * same code-hosting shelf rather than becoming an API by default.
   *
   * `website` is the same shape and was found the same way. Measured on live
   * data 2026-08-15 (`#992`), three of the eight measured-but-uncatalogued pairs
   * reached no shelf at all and all three were `website` — `github.io`,
   * `localhost.run` and `localtunnel`, one proved citizen each. So every citizen
   * that has ever passed `website-verify` had proved it somewhere the Atlas
   * could not file.
   *
   * **`compute-hosting` rather than a sixteenth shelf**, of the three readings
   * `#992` set out. The shelf already carries `netlify.com`, `vercel.com`,
   * `workers.cloudflare.com`, `render.com`, `fly.io` and `railway.app` — every
   * provider a citizen looking for a page it controls would reach for — so a
   * separate *websites* shelf would split those six from `github.io` and make
   * one question two places to look. The boundary it would draw, *a page I
   * control* against *a machine I rent*, is not one the providers respect.
   *
   * **And not the third reading, that the kind is wrong.** `localtunnel` and
   * `localhost.run` host no code and store no repository; what the rung proves
   * at all three is a page carrying a meta tag, which is what `website` says. A
   * fix in what `website-verify` records would have to call a tunnel a code
   * host, which is false about two of the three pairs that prompted this.
   *
   * The pairing is untouched: `compute-hosting` still *produces* `hosting` when
   * a steward publishes a proposed provider onto it, exactly as `code-hosting`
   * still produces `code-host`. This direction is many-to-one and only this one.
   */
  const SHELF_BY_GRANTED_KIND: Readonly<Record<string, AtlasCategory>> = {
    github: 'code-hosting',
    website: 'compute-hosting',
  }

  for (const [kind, shelf] of Object.entries(SHELF_BY_GRANTED_KIND)) {
    /**
     * **It cannot mask a pairing either.** A kind that is already some shelf's
     * paired kind would be re-shelved silently by an entry here, which is the
     * same false catalogue claim the guard above refuses.
     */
    const existing = categories.get(kind)
    if (existing !== undefined && existing !== shelf) {
      throw new Error(`Account kind ${kind} is paired with shelf ${existing}, not ${shelf}`)
    }
    categories.set(kind, shelf)
  }

  /**
   * **A kind spelled as a shelf belongs on that shelf** (`#917`).
   *
   * The kind vocabulary is deliberately open — `kolonie.accounts.declare` invites
   * *another slug of your own* — and the single most predictable thing a citizen
   * reaches for is the name of the shelf it can see. Measured 2026-08-14, two of
   * the four drafts waiting for a steward carried `code-hosting`, which is the
   * category's own name and not the `code-host` kind paired with it. Neither
   * resolved, so both sat on `data-apis` waiting to be published onto a shelf
   * nobody browsing for a code host would look at.
   *
   * **Derived and bounded rather than an alias list.** It covers exactly the
   * fifteen category names and grows only when a shelf does, which is what makes
   * it different from answering each citizen's invention with another line. A
   * kind that is not a category name still throws, and that is still right.
   *
   * **It cannot mask a pairing.** `set` runs after the map above, so a category
   * name that is already a kind of some other shelf would be an overwrite — the
   * guard refuses it rather than silently re-shelving the pair. Today the two
   * that coincide, `mailbox` and `storage`, name their own shelf and agree.
   */
  for (const category of AtlasCategorySchema.options) {
    const existing = categories.get(category)
    if (existing !== undefined && existing !== category) {
      throw new Error(
        `Account kind ${category} is a category name but is paired with shelf ${existing}`,
      )
    }
    categories.set(category, category)
  }

  return categories
})()

/**
 * Resolve the one Atlas shelf currently paired with an account kind.
 *
 * An unknown kind is an error rather than a guessed shelf: categories are real
 * catalogue claims, and the account-kind vocabulary is deliberately open.
 */
export function atlasCategoryForKind(kind: AccountKind): AtlasCategory {
  const category = ATLAS_CATEGORY_BY_KIND.get(kind)
  if (category === undefined) throw new Error(`No Atlas category maps to account kind ${kind}`)
  return category
}

/**
 * Every account kind {@link atlasCategoryForKind} answers for (`#1106`).
 *
 * **The same map read forwards, so that a query can ask the complement.** The
 * category-proposal queue is *the pairs whose kind reaches no shelf*, and a
 * caller that could only ask one kind at a time would have to fetch every pair
 * and filter afterwards — which applies its `limit` to rows it is about to throw
 * away. Handed to SQL as a `not in`, the limit falls where it should.
 */
export function atlasShelvedKinds(): readonly string[] {
  return [...ATLAS_CATEGORY_BY_KIND.keys()]
}
