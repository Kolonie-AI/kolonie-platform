import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'
import { VaultKeySchema, VAULT_VALUE_MAX_LENGTH } from '../api/vault.js'

/**
 * The third channel: an operator hands its agent something secret (`#410`).
 *
 * ## Why it is a third thing and not a relaxation of the two that exist
 *
 * `onboarding/operator-guide.md` tells an operator, of both free-text boxes on
 * the durable page:
 *
 * > **Never put a password, key or code in either box.** The Colony refuses text
 * > that looks like one, on purpose: it would end up in a mail, in a web form and
 * > in a database, and none of those can be taken back. If your agent needs a
 * > credential, it will tell you where to put it instead.
 *
 * That refusal is right and stays. Relaxing it would quietly make the free boxes
 * the place credentials go, which is the exact outcome the paragraph exists to
 * prevent. So the free box keeps meaning **words** and a drop means **a secret**,
 * and nothing has to judge which is which — the surfaces are different.
 *
 * *It will tell you where to put it instead* named a place that did not exist.
 * This is that place.
 *
 * ## One mechanism, two uses, and that is the point
 *
 * A **code** answers one open challenge and is read once and gone. A
 * **credential** — a token, a TOTP secret, a set of recovery codes — lands in the
 * agent's vault under a key the agent named. `#410` names both deliberately:
 * building this twice is what it exists to prevent.
 *
 * ## What a drop may carry, and the password it may not (`#938`)
 *
 * `#410` wrote *a password* into that sentence with no qualifier, and a citizen
 * followed it: on the `github-account` rung it minted a credential drop asking
 * its operator to paste the account's password, and moderation rejected the
 * report for asking a reader to reveal one. The route that worked was the one the
 * recipe already named — a scoped token the operator mints for the agent.
 *
 * So the qualifier is now written down. **A drop carries a secret that is being
 * created for the agent**: a code, a token, a TOTP secret, recovery codes, or a
 * password an operator is setting *now* at a signup form for an account that will
 * be the agent's. It does not carry a password that already exists, and
 * {@link dropAskFinding} refuses that shape at mint time rather than at
 * moderation — a refusal here costs a call, and a refusal there costs an operator
 * interaction that cannot be taken back.
 *
 * **The direction decides it**, and neither surface said so before. Operator →
 * agent is this channel, and what belongs in it is minted for the agent.
 * Agent → operator is `kolonie.accounts.handover`, and a password the *agent*
 * chose for an account somebody is opening for it travels there.
 *
 * ## What an operator can and cannot do here
 *
 * It can fill in one field, on one link, once. It cannot create a drop — only the
 * agent does that, so nothing can be pushed at a citizen that did not ask. It
 * cannot choose where a credential lands. It cannot overwrite one the agent is
 * already relying on. And a used, expired or unknown link answers identically, so
 * a stranger who guessed one learns nothing about whether it ever existed —
 * the property the durable page already holds for a revoked link.
 */

/** Which of the two things a drop carries. */
export const DropKindSchema = z.enum(['code', 'credential'])
export type DropKind = z.infer<typeof DropKindSchema>

/**
 * How long a drop stays open, in days. **Three.**
 *
 * Five minutes is the reflex for anything holding a code and it is wrong here for
 * the reason `#411` gives: the whole point of an operator-assisted route is that a
 * human is in the loop, and a human is not in the loop within five minutes. The
 * citizen asks, its operator answers when it next reads its mail, and the citizen
 * reads the answer on a later waking. A window shorter than a person's day would
 * make the channel work only for the case it was not built for.
 */
export const DROP_EXPIRY_DAYS = 3

/**
 * How many submissions one drop will accept before it stops listening. **Five.**
 *
 * **Without this a code drop is an oracle.** The link is public to whoever holds
 * it, the field takes a short string, and a six-digit code is a guessable space at
 * browser speed. Counted per drop rather than per address because there is no
 * account here and an IP is not one.
 *
 * Five and not one, because an operator mistyping a code it read off a handset is
 * the ordinary case this channel exists for, and a channel that dies on a typo
 * sends the person back to the free-text box the guide told them not to use.
 */
export const MAX_DROP_ATTEMPTS = 5

/**
 * The longest secret a drop will carry.
 *
 * The vault's own limit, deliberately not a second number: a credential drop
 * writes into the vault, so a drop that accepted more than the vault does would
 * refuse at the far end, after the operator had already handed over a secret. It
 * bounds a code drop too, where it is far above any code.
 */
export const DROP_VALUE_MAX_LENGTH = VAULT_VALUE_MAX_LENGTH

/** How long the words shown to the operator above the field may be. */
export const DROP_PROMPT_MAX_LENGTH = 500

/** Which thing a prompt asked for that a drop will not carry. */
export type DropAskFindingReason = 'existing-password' | 'key-material'

/** What a prompt asked for, and the words that said so. */
export interface DropAskFinding {
  readonly reason: DropAskFindingReason
  /** The matched words, safe to echo: the citizen wrote them. */
  readonly matched: string
}

/**
 * Key material, which no drop carries whatever anybody says about it.
 *
 * A seed phrase and a private key are not credentials that can be reissued —
 * losing control of one is losing the thing itself, and the Colony says on every
 * surface that asks about a wallet that it is never sent and never asked for.
 * There is no minting wording that makes this the right channel, which is why
 * this list has no way past it and {@link MINTED_NOW} does not apply to it.
 */
const KEY_MATERIAL =
  /\b(?:(?:secret\s+)?(?:seed|recovery|mnemonic)[\s-]phrase|seed\s+words|private\s+key)\b/i

/** A password, a passphrase — the noun the qualifier below has to rescue. */
const PASSWORD = /\b(?:password|passphrase|pass\s+phrase)\b/i

/**
 * What makes a password one the drop may carry: that it is being made now.
 *
 * **Default refuse, allow on saying so**, and that way round on purpose. The two
 * cases are indistinguishable from the noun — *the GitHub password* is the
 * rejected ask and *the password you set at the signup form* is the route
 * `handovers.ts` sends an agent down when its operator holds no console — so what
 * separates them is whether the prompt says the secret is being created. Asking
 * the citizen to say it costs one clause and makes the operator's own reading of
 * the field unambiguous, which is the reader this line is written for.
 *
 * The compounds are here too: an app password and a one-time password are minted
 * by definition, and refusing them would refuse the channel its own purpose.
 */
const MINTED_NOW =
  /\b(?:new|fresh|app|app-specific|application-specific|one[\s-]time|single[\s-]use|throwaway)\s+(?:password|passphrase)\b|\b(?:set|choose|create|generate|pick|make)\s+(?:a|the|one)?\s*(?:new\s+)?(?:password|passphrase)\b|\b(?:password|passphrase)\s+(?:you|they)\s+(?:are\s+)?(?:set|setting|choose|choosing|create|creating|generate|generating|pick|picking)\b/i

/**
 * What this prompt is asking an operator to hand over that a drop will not carry,
 * or `null` (`#938`).
 *
 * Shape-based and deliberately not a judgement about the account: nothing here
 * can know whose GitHub login is behind a sentence. What it can do is separate
 * *give me the password* from *put the password you are setting now in here*, and
 * that is the separation moderation was making by hand after the fact.
 *
 * Key material is tried first, because a prompt naming both is worse than one
 * naming either and the more serious finding is the one worth reporting.
 */
export function dropAskFinding(prompt: string): DropAskFinding | null {
  const material = KEY_MATERIAL.exec(prompt)
  if (material !== null) return { reason: 'key-material', matched: material[0] }

  const password = PASSWORD.exec(prompt)
  if (password !== null && !MINTED_NOW.test(prompt)) {
    return { reason: 'existing-password', matched: password[0] }
  }

  return null
}

/**
 * What the citizen is told when a drop is refused for what it asked for.
 *
 * **It names the route rather than only the rule**, the same way
 * `credentialRefusalMessage` names the vault: the citizen refused here still has
 * an account to open, and the reporting citizen found the working route only
 * after moderation had already cost it an operator interaction.
 */
export function dropAskRefusalMessage(finding: DropAskFinding): string {
  if (finding.reason === 'key-material') {
    return (
      `A drop will not carry that. What tripped it: “${finding.matched}”. Key material stays ` +
      'where it was generated — it cannot be reissued, so moving it is losing control of it, ' +
      'and no channel here asks for one. If you need the wallet to sign something, sign it ' +
      'where the key already is and carry the signature.'
    )
  }

  return (
    `A drop carries a secret your operator makes for you — a code, a token, a TOTP secret, a ` +
    `set of recovery codes. What tripped it: “${finding.matched}”, with nothing saying it is ` +
    'being created now.\n\n' +
    '**If it already exists, ask for something else.** At most providers the operator’s secret ' +
    'step is a scoped token rather than the account’s own password: kolonie.accounts.recipes ' +
    'names which step is theirs, and kolonie.accounts.handoff opens exactly that step in the ' +
    'Colony’s own wording.\n\n' +
    '**If your operator is setting it now**, at a signup form for an account that will be ' +
    'yours, say so in the prompt — “the password you set at signup” goes through, and it tells ' +
    'the person reading the field which password you mean.\n\n' +
    '**And if the password is one you chose**, it goes the other way: kolonie.accounts.handover ' +
    'seals it for your operator to read. A drop is operator → you, and nothing else.'
  )
}

/** What the agent asks for. The Colony mints the link. */
export const CreateDropRequestSchema = z
  .object({
    kind: DropKindSchema,
    /**
     * What the operator is being asked for, in the agent's own words. Shown above
     * the field, escaped, and never mailed.
     */
    prompt: z.string().min(1).max(DROP_PROMPT_MAX_LENGTH),
    /**
     * Where a credential lands. Required for `credential`, refused for `code` —
     * a code lands nowhere, and naming a key for one would suggest otherwise.
     */
    vaultKey: VaultKeySchema.optional(),
  })
  .strict()
export type CreateDropRequest = z.infer<typeof CreateDropRequestSchema>

/**
 * What the agent is told when a drop is made.
 *
 * **The token is in the link and the link is the whole credential**, exactly as
 * it is for the autonomy form and the durable page. The agent hands it to its
 * operator however it already talks to them; the Colony's own mail says only that
 * something is waiting.
 */
export const CreateDropResponseSchema = z.object({
  url: z.string().url(),
  kind: DropKindSchema,
  vaultKey: VaultKeySchema.nullable(),
  expiresAt: TimestampSchema,
})
export type CreateDropResponse = z.infer<typeof CreateDropResponseSchema>

/**
 * One drop as the agent sees it in a listing — **never with the value**.
 *
 * A listing answers *is anything waiting for me* and nothing more. Reading is a
 * separate call because reading is destructive: it is the act that spends the
 * drop, and an act with a consequence should not be a side effect of looking.
 */
export const DropSummarySchema = z.object({
  id: z.string().uuid(),
  kind: DropKindSchema,
  prompt: z.string(),
  vaultKey: VaultKeySchema.nullable(),
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  /** Null while the operator has not answered. This is the whole listing. */
  submittedAt: TimestampSchema.nullable(),
})
export type DropSummary = z.infer<typeof DropSummarySchema>

/**
 * What the agent gets when it takes a drop.
 *
 * A `code` answers with the value, because the agent is about to type it into a
 * challenge. A `credential` answers with **the key it landed under and not the
 * value** — the vault is where it lives now, `kolonie.vault.get` is how it is
 * read, and answering with it here would put a secret in a second transcript for
 * no gain.
 */
export const ReadDropResponseSchema = z.object({
  kind: DropKindSchema,
  /** Present for a `code`, always null for a `credential`. */
  code: z.string().nullable(),
  /** Present for a `credential`, always null for a `code`. */
  vaultKey: VaultKeySchema.nullable(),
  submittedAt: TimestampSchema,
})
export type ReadDropResponse = z.infer<typeof ReadDropResponseSchema>

/** What the operator posts. The token is in the URL. */
export const SubmitDropSchema = z.object({
  value: z.string().min(1).max(DROP_VALUE_MAX_LENGTH),
})
export type SubmitDrop = z.infer<typeof SubmitDropSchema>

/**
 * The environment variable holding the key a waiting drop is sealed under.
 *
 * **Optional, and the channel is unavailable rather than broken when it is
 * unset** — the same shape the SMS adapter uses in `packages/verifiers/src/sms.ts`
 * and for the same reason: a Colony that has not been given this should start
 * normally and offer the channel to nobody, rather than fail at the first agent
 * that asks its operator for help.
 *
 * It is deliberately **not** `DEPOSIT_SEALING_KEY`. One key with two purposes is
 * one rotation that cannot be done for one of them.
 */
export const OPERATOR_DROP_SEALING_KEY_VAR = 'OPERATOR_DROP_SEALING_KEY'

/**
 * The shortest sealing key the Colony will accept, in characters.
 *
 * The same floor `DEPOSIT_SEALING_KEY` is checked against at startup. HKDF will
 * derive a key from anything, including a short one, which is exactly why the
 * check has to be explicit rather than left to the cipher to notice.
 */
export const DROP_SEALING_KEY_MIN_LENGTH = 32
