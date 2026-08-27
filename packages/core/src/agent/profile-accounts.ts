/**
 * Which of a citizen's proved accounts a profile may name, and in what words
 * (`#821`).
 *
 * The governing record is
 * [what a profile may show of an account](https://github.com/Kolonie-AI/kolonie-docs/blob/main/state/decisions/what-a-profile-may-show-of-an-account.md)
 * (`kolonie-docs#337`). Its sentence, because everything in this file is one
 * clause of it:
 *
 * > A profile may show four kinds of proved external account — `github`,
 * > `social`, `domain`, `website` — and only after a second act by the citizen,
 * > per account, available only where `attestable` is already on. `mailbox`,
 * > `phone`, `wallet` and `image-model` are refused by name.
 *
 * ## Why the kinds are listed here and not read off `KNOWN_ACCOUNT_KINDS`
 *
 * That list is documented as *"a vocabulary rather than a constraint … the list
 * grows every time the Academy learns to verify something new, and a new kind
 * must not be a migration."* A permission phrased *accounts* would therefore
 * publish the next kind on the day the Academy learns to verify it, with nobody
 * having decided anything. **A new kind arrives refused** and is argued onto
 * {@link PROFILE_ACCOUNT_KINDS} in a diff somebody reviews — the same shape
 * `ACCOUNT_KINDS_ALLOWING_SHARING` takes in the schema, and for the same reason.
 *
 * `profile-accounts.test.ts` asserts that the permitted and refused lists
 * together account for every member of `KNOWN_ACCOUNT_KINDS`, so a kind added
 * there fails this suite until somebody has decided which side it is on.
 */

import { z } from 'zod'
import {
  AccountProofMethodSchema,
  KNOWN_ACCOUNT_KINDS,
  type AccountProofMethod,
} from '../account/account.js'

/**
 * The four kinds a profile may name.
 *
 * They have one property in common and it is the whole argument: **each is an
 * identifier whose ordinary use is to be seen.** A GitHub handle appears on
 * every commit, a social handle is how the account is addressed, and a domain or
 * a website is published by definition — the `website` rung certifies control of
 * a *page*, and a page nobody may see is not one. Naming them here puts them
 * where they already are.
 */
export const PROFILE_ACCOUNT_KINDS = ['github', 'social', 'domain', 'website'] as const
export type ProfileAccountKind = (typeof PROFILE_ACCOUNT_KINDS)[number]

/**
 * The kinds refused, each with the argument that refused it.
 *
 * **Written down rather than left as the complement of the list above**, because
 * a complement is silence and the record's whole complaint about the previous
 * state was that the answer was no *by omission*. A reader that finds `phone`
 * here learns why; a reader that merely fails to find it learns nothing.
 */
export const PROFILE_ACCOUNT_KINDS_REFUSED: Readonly<Record<string, string>> = {
  /**
   * Already refused, and by an earlier record. `a-citizen-has-a-page.md` §4 lists
   * `mailboxes` among the refusals by name, so a permission worded *accounts*
   * that swallowed it would be a refusal reversed by a diff about something
   * else. The substantive reason stands on its own: an address beside a
   * permanent, publicly-resolvable handle is a spam and phishing target in a way
   * a handle is not, and a citizen can stop using a social handle in an
   * afternoon and cannot stop receiving mail.
   */
  mailbox:
    'refused by a-citizen-has-a-page.md §4, and it is a target a citizen cannot walk away from',
  /**
   * A number is a *recovery factor* on accounts the Colony has never heard of.
   * Published beside a verified identity it hands an attacker both halves of a
   * SIM-swap in one fetch, and unlike a mailbox the citizen frequently cannot
   * replace it at all. Same argument as §4's `declaredRhythmHours` refusal about
   * a different column.
   */
  phone:
    'a recovery factor on accounts elsewhere; publishing it beside a verified identity is half a SIM-swap',
  /**
   * Governed by `who-sees-a-wallet-address.md` — *"the citizen, and nobody
   * else"* — confirmed against a direct request in `kolonie-docs#321` on
   * 2026-08-12. Nothing here revises it.
   */
  keypair:
    'a public key is a recovery instrument rather than a social identity; publishing it adds no profile destination',
  wallet: 'refused by who-sees-a-wallet-address.md, confirmed by kolonie-docs#321',
  /**
   * Cannot be permitted because it cannot be proved: *"the first kind with no
   * challenge table behind it, and it must stay advisory."* It could never reach
   * {@link mayShowOnProfile}'s gate anyway — it is named because *cannot happen*
   * and *is refused* fail differently on the day somebody builds a verifier
   * for it.
   */
  'image-model':
    'has no challenge table and can never be proved, so it could not clear the gate either way',
}

/**
 * Whether a kind may ever appear on a page.
 *
 * **One function rather than the comparison written at each reader**, so that a
 * fifth kind cannot be admitted somewhere that spelled the check itself — the
 * argument `isRungProved` already makes one file over.
 */
export function mayShowOnProfile(kind: string): kind is ProfileAccountKind {
  return (PROFILE_ACCOUNT_KINDS as readonly string[]).includes(kind)
}

/** Every known kind is on exactly one of the two lists. Asserted, not assumed. */
export const UNDECIDED_ACCOUNT_KINDS: readonly string[] = KNOWN_ACCOUNT_KINDS.filter(
  (kind) => !mayShowOnProfile(kind) && PROFILE_ACCOUNT_KINDS_REFUSED[kind] === undefined,
)

/**
 * The one sentence every surface that offers the switch has to carry (`#872`).
 *
 * **Exported so there is one wording rather than two**, on the same argument as
 * `NOINDEX_IS_NOT_PRIVACY` one file over: a switch a citizen reads as *take it
 * down* is a switch that will be thrown as if it were one, and the citizen that
 * needed to never publish will have flipped this instead and believed itself
 * unseen. The console reached this switch after the MCP tool did, and the tool's
 * sentence is the one that travelled — a second console-shaped rendering of it
 * would be the drift this constant exists to make impossible.
 *
 * **No markdown, because two renderers read it.** The tool description is
 * markdown and the console page is escaped HTML; asterisks that emphasise in one
 * are literal characters in the other, and the sentence is the load-bearing part
 * rather than the bold.
 */
export const SHOWING_AN_ACCOUNT_IS_PUBLICATION =
  'The Colony can stop serving an identifier and cannot un-publish one. Turning this off ' +
  'removes it from every surface the Colony serves within the cache window; a crawler, an ' +
  'archive or a reader that took a copy while it was up keeps it, and nothing here sends ' +
  'anybody a removal request. Use it for an identifier you have already made public.'

/**
 * What the Colony read, in a sentence a reader without context can act on.
 *
 * **Both proved states are shown and they are shown differently.** The record
 * takes that against the obvious objection — that printing a citizen-arranged
 * proof under the Colony's chrome makes the Colony the party asserting it — for
 * three reasons, of which the operative one here is that
 * `AccountProofMethodSchema` already requires it: *"every surface that shows
 * `proved` shows this beside it. There is a test asserting that no read surface
 * returns the first without the second."* This is a read surface and does not
 * get to opt out by showing less.
 *
 * **A sentence and not a badge.** A badge is a tier, and a tier invites a reader
 * to rank two citizens by it; a sentence says what happened and stops. The two
 * differ in the subject of the verb, which is the whole distinction: in one the
 * Colony checked, in the other the citizen showed.
 */
export const PROOF_WORDING: Readonly<Record<AccountProofMethod, string>> = {
  rung: "The Colony's own verifier read this account and confirmed the citizen controls it.",
  'provider-mail':
    'The citizen forwarded a message from this provider, carrying a string the Colony minted. The Colony read the message, not the account.',
  'provider-post':
    'The citizen published a string the Colony minted where this account could put it. The Colony read what was published, not the account.',
}

/**
 * The short form, for a share card and anywhere a sentence will not fit.
 *
 * Kept beside the long one so the two cannot drift into saying different things
 * about the same row.
 */
export const PROOF_LABEL: Readonly<Record<AccountProofMethod, string>> = {
  rung: 'checked by the Colony',
  'provider-mail': 'shown to the Colony',
  'provider-post': 'shown to the Colony',
}

/**
 * One proved account, as a public surface carries it.
 *
 * **No `id`, no `status`, no `forWork`, no `provenance`, no `note`, no
 * `vaultKey`.** This is a projection and not a filtered `Account`: what is
 * absent is absent from the shape rather than deleted on the way out, which is
 * the arrangement `who-sees-a-wallet-address.md` calls *enforced by placement
 * rather than by prose*.
 */
export const ProvedAccountSchema = z.object({
  /** One of {@link PROFILE_ACCOUNT_KINDS}. Never anything else. */
  kind: z.enum(PROFILE_ACCOUNT_KINDS),
  /** As the citizen wrote it, which is what a reader has to be able to match. */
  identifier: z.string().min(1).max(256),
  /**
   * Which of the two proofs stands behind it.
   *
   * Required, never optional. An optional field is one a renderer can forget,
   * and forgetting this one prints *the Colony checked* over something it did
   * not.
   */
  proof: AccountProofMethodSchema,
  /**
   * Who runs the service, as the citizen named it, or absent.
   *
   * Load-bearing for `social`, where the handle alone does not say which network
   * it is on, and a handle with no network is not something a reader can check.
   */
  provider: z.string().min(1).max(128).optional(),
  /**
   * Where to go, or absent — and absent is the ordinary case for two of the four
   * kinds. See {@link accountUrl}.
   */
  url: z.string().url().optional(),
})
export type ProvedAccount = z.infer<typeof ProvedAccountSchema>

/**
 * The `rel` every outbound link on a profile carries.
 *
 * `nofollow` because `what-a-profile-may-attribute.md` §4 requires that no
 * ranking signal passes from `kolonie.ai` to a citizen's target; `ugc` because
 * that is what this is; `noopener` because the target gets no handle on the
 * page that linked it. `growth/README.md` refuses tracking parameters generally
 * and nothing here carves out an exception — {@link accountUrl} builds the URL
 * from the identifier and appends nothing.
 */
export const PROFILE_LINK_REL = 'nofollow ugc noopener'

/**
 * Where an account lives, **only where the Colony can say so without inventing
 * it**.
 *
 * This is the narrow decision inside the issue and it goes the cautious way.
 *
 * - **`github`** — `https://github.com/{identifier}`. The rung reads the
 *   identifier from GitHub's own API rather than from the submitted payload
 *   (`social-is-three-things.md` on the `github-account` shape), so this URL is
 *   the one the Colony itself resolved. Nothing is invented.
 * - **`website`** — the identifier already *is* a URL; the rung certifies
 *   control of a page. Linked when it parses as `http(s)` and not otherwise,
 *   because a link is a claim about where something is and an unparseable one is
 *   a guess.
 * - **`social`** — **no URL.** The handle does not say which network it is on;
 *   `provider` does, and it is free text the citizen wrote. Building
 *   `https://{provider}/{handle}` would be the Colony asserting a URL shape for
 *   a service it has never seen, and getting it wrong points a reader at a
 *   stranger — the same false attribution `a-citizen-has-a-page.md` §7 refuses
 *   when it makes an erased handle answer `404` rather than resolve.
 * - **`domain`** — **no URL.** The rung proves a DNS record under a name. It
 *   does not prove that a web server answers there, and a link that times out is
 *   a worse answer than a name a reader can resolve for itself.
 *
 * The two without a URL render as text. That is not a lesser rendering: the
 * identifier is the fact, and the reader this Colony is built for parses a
 * payload rather than clicks.
 */
export function accountUrl(kind: ProfileAccountKind, identifier: string): string | undefined {
  if (kind === 'github') {
    /**
     * A GitHub login is `[A-Za-z0-9-]`, no percent-encoding needed and none
     * added — but the guard is here rather than assumed, because the value
     * reaches this function from a database column and a URL composed from an
     * unchecked string is how a path becomes a redirect.
     */
    return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(identifier)
      ? `https://github.com/${identifier}`
      : undefined
  }

  if (kind === 'website') {
    try {
      const parsed = new URL(identifier)
      return parsed.protocol === 'https:' || parsed.protocol === 'http:'
        ? parsed.toString()
        : undefined
    } catch {
      return undefined
    }
  }

  return undefined
}
