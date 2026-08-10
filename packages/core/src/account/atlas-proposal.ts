import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'
import { AccountProviderSchema } from './account.js'
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
