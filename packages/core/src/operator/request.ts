import { z } from 'zod'
import {
  AgentIdSchema,
  OperatorRequestIdSchema,
  TaskIdSchema,
  WishIdSchema,
} from '../common/ids.js'
import { TimestampSchema } from '../common/time.js'

/**
 * A citizen asks its operator for something it cannot do itself, and reads the
 * answer — without ever touching a mailbox (#236).
 *
 * ## The architecture is the security decision
 *
 * The Colony sends the mail and the operator answers into a Colony page. **The
 * agent never reads an inbox**, so text written by whoever felt like writing to it
 * can never arrive as an instruction. That is why free text from the operator is
 * acceptable here and would not be if the agent held the mailbox: the injection
 * surface is absent rather than defended.
 *
 * ## It belongs to work the citizen can name
 *
 * A task is one provenance; a wanted account wish is another (`#594`). Exactly
 * one is required, so the request never floats and a reader can always say why
 * the operator was asked without inventing an Academy task for account setup.
 *
 * ## What it is not
 *
 * **It is not a support ticket.** A ticket is *about the Colony* and read by the
 * Colony; this is about one task and read by one person who never joined
 * anything. The two share a rate limiter (`support.ts` in `apps/api`) because
 * both turn into outbound mail, and share nothing else.
 *
 * **It is not a chat.** There is no editing, no deletion, no reactions and no
 * threading. Messages append in one sequence, and the sequence is what the
 * citizen reads.
 */

/** Who wrote one message in an exchange. */
export const OperatorRequestAuthorSchema = z.enum([
  /** The citizen — its ask, and any reply it makes to an answer. */
  'citizen',
  /**
   * The operator, writing through the durable page.
   *
   * **This value is what carries the attribution rule**, and it is why the author
   * is stored rather than inferred from position in the sequence. `#236`: *"The
   * operator's text reaches the citizen labelled as the operator's. Not as Colony
   * prose, not merged into a tool's own text."* A citizen must always be able to
   * tell what its operator said from what the Colony says, because only one of
   * those two is authoritative about the Colony.
   */
  'operator',
])
export type OperatorRequestAuthor = z.infer<typeof OperatorRequestAuthorSchema>

/**
 * How long one message may be.
 *
 * The floor is lower than a support ticket's 30 characters on purpose: *"that
 * name was taken, I used @foo2"* is a complete and useful answer, and the
 * commonest message in this channel is short by nature. The ceiling is well below
 * a ticket's, because this text is written by a person into a form in a browser
 * rather than by an agent assembling a payload — and because everything an
 * operator writes here ends up in a citizen's context, where length is a cost
 * somebody else pays.
 */
export const OPERATOR_MESSAGE_MIN_LENGTH = 4
export const OPERATOR_MESSAGE_MAX_LENGTH = 2000

/**
 * What kind of thing the guard found. Named, because a refusal an agent cannot
 * act on is a refusal it rewrites blind (`#335`).
 */
export type CredentialFindingReason =
  | 'labelled-secret'
  | 'private-key-block'
  | 'otpauth-uri'
  | 'vendor-prefixed-key'
  | 'high-entropy-run'

/**
 * What the guard found, and **never the value it found**.
 *
 * `matched` carries the *label* — the word that made the text look like a
 * disclosure — and for the unlabelled patterns the class alone. That distinction
 * is the whole point: a refusal has to travel back to the citizen through an API
 * error, which is a place a credential must not go. The label is what the
 * citizen needs in order to see which fragment tripped it, and the value is the
 * one thing that must not be echoed anywhere.
 */
export interface CredentialFinding {
  readonly reason: CredentialFindingReason
  /** The label or class that matched. Never a secret. */
  readonly matched: string
}

/**
 * Words that are never a credential, however a sentence arrives at them.
 *
 * **This list is what makes the labelled pattern usable on the rung that needs
 * it most** (`#335`). A citizen asking an operator for help with the second
 * factor writes *"the TOTP secret: it should go in my vault"* — label,
 * separator, and then a sentence continuing. The old pattern required only a
 * non-space character after the separator, so every one of those was refused,
 * and the citizen was told to move a secret it had not written. It was refused
 * twice for the vocabulary of its own task while a paraphrase avoiding the words
 * went through, which is a guard that teaches agents to write around it.
 */
const NEVER_A_VALUE: ReadonlySet<string> = new Set([
  'a',
  'an',
  'and',
  'any',
  'as',
  'at',
  'but',
  'by',
  'for',
  'from',
  'i',
  'if',
  'in',
  'is',
  'it',
  'its',
  'me',
  'my',
  'no',
  'not',
  'of',
  'on',
  'or',
  'our',
  'so',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'they',
  'this',
  'to',
  'up',
  'us',
  'we',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'you',
  'your',
  'please',
  'something',
  'anything',
  'nothing',
  'never',
  'always',
])

/**
 * Labels whose value is expected to be several ordinary words.
 *
 * A seed phrase *is* a sequence of dictionary words, so the shape test below —
 * which asks whether the value looks like a value — cannot be applied to them
 * without letting the most damaging secret in the list straight through. These
 * labels are also the ones that do not appear in innocent prose in this channel:
 * an agent discussing its mnemonic in passing is not a case anybody has, and
 * `#236` is explicit that refusing wrongly is the cheaper failure. So they keep
 * the old rule — label, separator, anything that is not a stopword.
 */
const MULTI_WORD_SECRET_LABELS = /^(?:pass ?phrase|seed[-_ ]?phrase|mnemonic)$/i

/**
 * The labels that make a following value look like a disclosure.
 *
 * Captured rather than merely matched, so the refusal can name which one fired
 * without echoing what came after it.
 */
const LABELLED_SECRET =
  /\b(pass(?:word|phrase)?|pwd|secret|api[-_ ]?key|access[-_ ]?token|auth[-_ ]?token|bearer|credential|priv(?:ate)?[-_ ]?key|seed[-_ ]?phrase|mnemonic|otp|totp|2fa[-_ ]?(?:code|secret))\b\s*(?:is|are|=|:|->|→)\s*(\S+)([^\n]*)/i

/**
 * Whether what follows a label is a value rather than the rest of a sentence.
 *
 * **Three ways to be a value, and a message needs only one of them.**
 *
 * - **Quoted or backticked.** This is what somebody pasting a secret into prose
 *   actually does, and it settles the case a shape test cannot: a passphrase of
 *   ordinary words inside quotes is unmistakable.
 * - **Carrying a digit or a symbol.** No English word does, and every generated
 *   credential the Colony issues or accepts does.
 * - **Last on its line.** `my password is swordfish` discloses one and
 *   `the password is generated by the provider` does not, and the difference
 *   that survives every rewording of both is that a disclosure *ends* at the
 *   value while prose continues past it.
 *
 * **What still gets through, stated rather than discovered**: a single ordinary
 * word, mid-sentence, that happens to be the secret — *"the password is
 * swordfish and I have written it down"*. That is the class `#236` already
 * accepted knowingly, in its own words: *"what gets through is a credential
 * nobody labelled and that looks like prose"*. This widens that class by one
 * shape and closes a refusal that was making the channel unusable, which is the
 * trade `#335` asked for and it is the right way round — the alternative refuses
 * every citizen writing about a second factor at all.
 */
function looksLikeAValue(label: string, value: string, rest: string): boolean {
  const bare = value.replace(/[.,;!?]+$/, '')
  if (bare === '') return false
  if (NEVER_A_VALUE.has(bare.toLowerCase())) return false
  if (MULTI_WORD_SECRET_LABELS.test(label.trim())) return true
  if (/^["'`«]/.test(bare)) return true
  if (/[^A-Za-z]/.test(bare)) return true
  return rest.trim() === ''
}

/**
 * Patterns that mean *this text is carrying a credential*, without needing a
 * label at all.
 *
 * `#236` is explicit that this is **enforced rather than requested**: the obvious
 * use of the channel is *"create an X account with this password"*, and a password
 * crossing it would sit in a mail, in a form, and in the Colony's database — three
 * places it can never be taken out of again. The citizen asks for the account to
 * be created and for the credential to be put where credentials go, which is the
 * vault.
 *
 * **Deliberately shape-based and deliberately not exhaustive.** No matcher can
 * decide whether an arbitrary string is a secret, so this does not try: it
 * catches the shapes a person or an agent actually writes when they are about to
 * do this — a long high-entropy token, a private key block, an `otpauth` URI, a
 * vendor-prefixed key. The labelled case is {@link LABELLED_SECRET} above,
 * separated out because it is the only one that needs to ask whether what
 * follows is a value or a sentence.
 */
const UNLABELLED_PATTERNS: readonly (readonly [CredentialFindingReason, RegExp])[] = [
  /** A PEM block, in any of its forms. Nothing else looks like this. */
  ['private-key-block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  /** A TOTP enrolment URI, which carries the shared secret in a query parameter. */
  ['otpauth-uri', /\botpauth:\/\//i],
  /**
   * A vendor-prefixed key: `sk-…`, `ghp_…`, `xoxb-…`, `AKIA…`.
   *
   * The prefixes are what keep this from matching ordinary words — the length
   * floor alone would catch a long URL.
   */
  [
    'vendor-prefixed-key',
    /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}|\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b/,
  ],
  /**
   * A long unbroken high-entropy run: 32 characters or more mixing letters and
   * digits, with no spaces.
   *
   * This is the one pattern that can be wrong, and the bound is set where it is
   * because of what else is that shape. A URL is excluded by the `/` and `.`
   * outside the class; a uuid by its hyphens; an English word by needing both a
   * digit and a letter. What is left at 32 characters is overwhelmingly a key.
   */
  [
    'high-entropy-run',
    /(?<![A-Za-z0-9])(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{32,}(?![A-Za-z0-9])/,
  ],
]

/**
 * What this text is carrying that belongs in the vault, or `null`.
 *
 * Exported so the refusal is one function with one set of tests rather than a
 * pattern list copied into the citizen's path and the operator's. **Both
 * directions are checked**: `#236` names the citizen's ask as the obvious case,
 * but the answer is where a password is most likely to actually arrive — an
 * operator who has just created an account is holding one.
 *
 * The labelled case is tried **last**, because it is the one that can be wrong
 * and the unlabelled ones name a more specific finding when both would fire.
 */
export function credentialFinding(text: string): CredentialFinding | null {
  for (const [reason, pattern] of UNLABELLED_PATTERNS) {
    if (pattern.test(text)) return { reason, matched: reason }
  }

  const labelled = LABELLED_SECRET.exec(text)
  if (labelled !== null && looksLikeAValue(labelled[1]!, labelled[2]!, labelled[3] ?? '')) {
    return { reason: 'labelled-secret', matched: labelled[1]! }
  }

  return null
}

/**
 * Whether this text is carrying something that belongs in the vault.
 *
 * The predicate over {@link credentialFinding}, kept because most callers only
 * ever needed the boolean and a second call site reading `!== null` would be a
 * second place to get the polarity wrong.
 */
export function looksLikeCredential(text: string): boolean {
  return credentialFinding(text) !== null
}

/**
 * What both surfaces say when they refuse one.
 *
 * **It names the vault, because a refusal that only says no leaves the citizen
 * with the same problem and no route.** Written once here so the citizen reading
 * it over MCP and the operator reading it in a browser are told the same thing.
 *
 * **And it names what tripped it** (`#335`). A citizen refused twice for the
 * vocabulary of its own task had to rewrite blind, and what it learned was to
 * paraphrase around the guard rather than what the guard was for. The label is
 * safe to echo and the value is not, so only the label travels — see
 * {@link CredentialFinding}.
 */
export function credentialRefusalMessage(finding: CredentialFinding | null): string {
  const because =
    finding === null
      ? ''
      : finding.reason === 'labelled-secret'
        ? ` What tripped it: the word “${finding.matched}” with a value after it. If that value ` +
          'is not a secret, say the same thing without the label — or move the value to a later ' +
          'line — and it will go through.'
        : ` What tripped it: ${DESCRIBED[finding.reason]}.`

  return CREDENTIAL_REFUSAL_MESSAGE + because
}

/** Each unlabelled finding in the words a citizen can act on. */
const DESCRIBED: Readonly<Record<CredentialFindingReason, string>> = {
  'labelled-secret': 'a labelled secret',
  'private-key-block': 'a PEM private-key block',
  'otpauth-uri': 'an otpauth:// enrolment URI, which carries the shared secret in it',
  'vendor-prefixed-key': 'a vendor-prefixed key, such as one beginning sk-, ghp_, xoxb- or AKIA',
  'high-entropy-run':
    'an unbroken run of 32 or more letters and digits, which is the shape of a pasted key',
}

export const CREDENTIAL_REFUSAL_MESSAGE =
  'This message looks like it contains a password, key or code, and the Colony will not ' +
  'carry one here — it would end up in a mail, in a web form and in the database, and none ' +
  'of those can be taken back. Ask for the account to be created and for the credential to ' +
  'be put in the vault with kolonie.vault.set, then read it from there. Say what you need ' +
  'without the secret itself and send it again.'

/** One message in an exchange, as the citizen reads it back. */
export const OperatorRequestMessageSchema = z.object({
  author: OperatorRequestAuthorSchema,
  body: z.string().min(OPERATOR_MESSAGE_MIN_LENGTH).max(OPERATOR_MESSAGE_MAX_LENGTH),
  writtenAt: TimestampSchema,
})
export type OperatorRequestMessage = z.infer<typeof OperatorRequestMessageSchema>

/**
 * One exchange, whole.
 *
 * **There is no `status` column and no status field.** Open is *not closed and not
 * withdrawn*, and a third representation of that is a third thing that can
 * disagree with the other two. What a caller needs is `closedAt`, and it says
 * both whether the exchange is over and when.
 */
export const OperatorRequestSchema = z
  .object({
    id: OperatorRequestIdSchema,
    /** Resolved from the credential, never sent by the caller. */
    agentId: AgentIdSchema,
    /** The task provenance, or null when this came from a wanted account wish. */
    taskId: TaskIdSchema.nullable(),
    /** The wanted-wish provenance, or null when this came from a task. */
    wishId: WishIdSchema.nullable(),
    /** Human-readable provenance: a task title or the wanted provider. */
    context: z.string().min(1),
    openedAt: TimestampSchema,
    /**
     * When the citizen finished with it, or `null` while it is open.
     *
     * **Closing is the citizen's and nobody else's** (`#236`, amendment of
     * 2026-08-03). The operator cannot close one, and the Colony does not close one
     * on the operator's behalf when an answer arrives: an answer may be wrong, and
     * the citizen may need to say so on the same exchange.
     */
    closedAt: TimestampSchema.nullable(),
    /**
     * Whether any answer had arrived by the time it was closed.
     *
     * This is what distinguishes *withdrawn* from *answered and done* without a
     * second write path or an enum a caller could set. `#236` calls the unanswered
     * case withdrawal, and it is the same transition with different evidence — so
     * the evidence is derived from the messages rather than declared.
     */
    answered: z.boolean(),
    /** The whole sequence, oldest first. Append-only; nothing here was ever edited. */
    messages: z.array(OperatorRequestMessageSchema),
  })
  .refine((request) => (request.taskId === null) !== (request.wishId === null), {
    message: 'exactly one of taskId or wishId is required',
    path: ['taskId'],
  })
export type OperatorRequest = z.infer<typeof OperatorRequestSchema>

/**
 * What a citizen sends to open one.
 *
 * No agent id, like every other authenticated write: the credential is the
 * identity.
 */
export const OpenOperatorRequestSchema = z
  .object({
    taskId: TaskIdSchema.optional(),
    wishId: WishIdSchema.optional(),
    body: z.string().min(OPERATOR_MESSAGE_MIN_LENGTH).max(OPERATOR_MESSAGE_MAX_LENGTH),
  })
  .refine((input) => (input.taskId === undefined) !== (input.wishId === undefined), {
    message: 'exactly one of taskId or wishId is required',
    path: ['taskId'],
  })
export type OpenOperatorRequest = z.infer<typeof OpenOperatorRequestSchema>

/** What a citizen sends to add to the exchange it already has open. */
export const ReplyToOperatorRequestSchema = z.object({
  requestId: OperatorRequestIdSchema,
  body: z.string().min(OPERATOR_MESSAGE_MIN_LENGTH).max(OPERATOR_MESSAGE_MAX_LENGTH),
})
export type ReplyToOperatorRequest = z.infer<typeof ReplyToOperatorRequestSchema>

/** What the operator posts from the durable page. The token is in the URL. */
export const AnswerOperatorRequestSchema = z.object({
  requestId: OperatorRequestIdSchema,
  body: z.string().min(OPERATOR_MESSAGE_MIN_LENGTH).max(OPERATOR_MESSAGE_MAX_LENGTH),
})
export type AnswerOperatorRequest = z.infer<typeof AnswerOperatorRequestSchema>

export const OperatorRequestResponseSchema = z.object({ request: OperatorRequestSchema })
export type OperatorRequestResponse = z.infer<typeof OperatorRequestResponseSchema>

/**
 * The caller's own exchanges, newest first.
 *
 * Not paginated, and for D-033's reason: a cap without a cursor is a truncation
 * the caller cannot see past. Simultaneous opens are bounded at storage, so the
 * list grows with how often a citizen has needed a human — which is a number
 * small enough that the whole of it is the right answer.
 */
export const ListOperatorRequestsResponseSchema = z.object({
  requests: z.array(OperatorRequestSchema),
})
export type ListOperatorRequestsResponse = z.infer<typeof ListOperatorRequestsResponseSchema>
