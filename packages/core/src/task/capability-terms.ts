/**
 * A quest that describes work needing a capability, while requiring none
 * (`#353`).
 *
 * `#352` tells the sponsor the field exists. This is the net underneath it: a
 * sponsor may still describe browser work and publish it open to everyone, and
 * the citizen that picks it up discovers the prerequisite mid-attempt — the
 * failure `requires` exists to prevent.
 *
 * **A flag for a steward, never a rejection.** Leaving a quest open is
 * legitimate: a sponsor may want anyone to try, or may be describing a
 * capability the Academy grants no skill for. A rule that refused would be the
 * Colony deciding what a sponsor may ask for, which is not this feature's
 * business. A steward that sees the mismatch and can ask is.
 *
 * **A keyword match and deliberately not a classifier.** The check has to be
 * readable and arguable in one place: a maintainer must be able to ask *why did
 * this fire* and get a term back.
 */

/** A word a quest text uses, and the skill it points at. */
export interface CapabilityTerm {
  /** Matched case-insensitively, on a word boundary. */
  readonly term: string
  /** The skill the Academy grants for this capability. */
  readonly skill: string
}

/**
 * The terms, in one place, each with the skill it points at.
 *
 * Four families, which are the four the issue names and the four whose absence
 * costs a citizen a whole attempt: a browser, an address that receives mail, a
 * wallet, and a domain. Each entry is a word a sponsor writing that work is
 * very likely to use and unlikely to use otherwise.
 *
 * **Kept short on purpose.** Every term is a chance to fire on a quest that
 * needed nothing, and a steward that learns to skim the flag has lost it. A
 * term earns its place by being nearly unambiguous in a quest text.
 */
export const CAPABILITY_TERMS: readonly CapabilityTerm[] = [
  { term: 'browser', skill: 'browser' },
  { term: 'headless', skill: 'browser' },
  { term: 'captcha', skill: 'browser' },
  { term: 'log in', skill: 'browser' },
  { term: 'sign in', skill: 'browser' },
  { term: 'email address', skill: 'mailbox' },
  { term: 'e-mail address', skill: 'mailbox' },
  { term: 'mailbox', skill: 'mailbox' },
  { term: 'inbox', skill: 'mailbox' },
  { term: 'wallet', skill: 'wallet' },
  { term: 'usdc', skill: 'wallet' },
  { term: 'on-chain', skill: 'wallet' },
  { term: 'domain', skill: 'domain' },
  { term: 'dns', skill: 'domain' },
  { term: 'nameserver', skill: 'domain' },
]

/**
 * What fired, and what would stop it firing.
 *
 * Named for the requirement it is about rather than for the capability: core
 * already has a `CapabilityFlag`, which is what a citizen declares about its own
 * runtime, and two types with one name would be a collision waiting on whoever
 * imports both.
 */
export interface RequirementFlag {
  /** The term found in the text, so a maintainer can ask why this fired. */
  readonly term: string
  /** The skill it points at, which the quest does not require. */
  readonly skill: string
}

/**
 * Which capability terms a quest's text uses without requiring the skill.
 *
 * **Only when nothing is required at all.** `#353` scopes this to an *empty*
 * requirement set: a sponsor that has chosen a requirement has been through the
 * decision, and second-guessing which further skills its wording implies is the
 * classifier this is deliberately not. A quest requiring `mailbox` and
 * mentioning a browser is a sponsor's judgement, not a mismatch.
 *
 * That is also what keeps the acceptance criterion simple: *a quest that names a
 * term and already requires the corresponding skill is not flagged* holds by
 * construction, and so does the wider version of it nobody has to maintain — a
 * quest that required something else entirely is not flagged either.
 *
 * One entry per term that matched, in the order the terms are declared, so two
 * readings of the same quest produce the same list.
 */
export function capabilityMismatches(quest: {
  readonly title: string
  readonly description: string
  readonly instructions: string
  readonly requires: readonly string[]
}): readonly RequirementFlag[] {
  if (quest.requires.length > 0) return []

  const text = `${quest.title}\n${quest.description}\n${quest.instructions}`.toLowerCase()

  return CAPABILITY_TERMS.filter(({ term }) => mentions(text, term)).map(({ term, skill }) => ({
    term,
    skill,
  }))
}

/**
 * Whether the text uses this term as a word rather than inside another.
 *
 * Word boundaries in both directions, because `inbox` inside `pinbox` is not a
 * mailbox and `dns` inside `dnsmasq` is not a zone — and a flag that fires on a
 * substring is the flag a steward stops reading.
 */
function mentions(text: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(text)
}
