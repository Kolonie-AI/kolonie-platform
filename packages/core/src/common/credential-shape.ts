import { z } from 'zod'
import type { ApiError } from './errors.js'

/**
 * Whether a piece of text is carrying something that belongs in the vault
 * (`#335`, relocated by `#1320`).
 *
 * **Neutral on purpose.** It began in `operator/request.ts` because the operator
 * channel was the first surface that had to refuse a pasted password, and it was
 * imported from there by recipes, walks, operate notes, playbooks and account
 * wishes — every surface where a citizen writes prose the Colony will store and
 * show to somebody else. Messaging is the next one, and a module named after one
 * caller is a module the next caller has to reach past.
 *
 * **What it is for, and what it is not.** It refuses text that *looks like* a
 * disclosure, so a secret is not carried by a channel that was never built to
 * hold one. It is not the secret channel: `kolonie.operator.drop.open` and
 * `kolonie.vault.set` are, and the refusal below names them. It is a shape test
 * and not a classifier — it will refuse prose that merely reads like a paste,
 * which is the direction to be wrong in.
 */

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
 * The finding as a published field (`#1685`).
 *
 * Optional on the success responses that notice rather than refuse, and omitted
 * when nothing was noticed. Reused rather than a boolean so a caller can branch
 * on the class without parsing prose.
 */
export const CredentialFindingSchema = z.object({
  reason: z.enum([
    'labelled-secret',
    'private-key-block',
    'otpauth-uri',
    'vendor-prefixed-key',
    'high-entropy-run',
  ]),
  matched: z.string(),
}) satisfies z.ZodType<CredentialFinding>

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
const MULTI_WORD_SECRET_LABELS =
  /^(?:pass ?phrase|seed[-_ ]?phrase|mnemonic|passphrase|wachtwoordzin|phrase\s+secr[eè]te|frase\s+(?:semilla|secreta)|frase\s+de\s+recupera[cç][aã]o|mnemo(?:nica|nique|nik)|wiederherstellungss?atz)$/iu

/**
 * The label alternation, grouped by the language it is written in.
 *
 * **The guard was English-only, and the operator channel is where a person
 * writes their own language** (`#1529`). Measured 2026-08-21 against
 * `packages/core/dist`: `the password is …` was caught and
 * `das Passwort ist …`, `le mot de passe est …`, `la contraseña es …`,
 * `het wachtwoord is …`, `a senha é …` and `la password è …` were all missed.
 *
 * `credentialFinding` states the case itself — *the answer is where a password
 * is most likely to actually arrive, an operator who has just created an
 * account is holding one* — and that is exactly the send path where a person is
 * writing freely. There is a message in production carrying a plaintext account
 * password in a German sentence of the second shape.
 *
 * **Six languages and no claim to be a list of all of them.** These are the ones
 * the measurement covers; a seventh is a line in this array and a row in the
 * table in the test. The guard is a shape test rather than a classifier, and it
 * was never going to be exhaustive in one language either.
 */
const SECRET_LABELS: readonly string[] = [
  // en
  String.raw`pass(?:word|phrase)?`,
  String.raw`pwd`,
  String.raw`secret`,
  String.raw`api[-_ ]?key`,
  String.raw`access[-_ ]?token`,
  String.raw`auth[-_ ]?token`,
  String.raw`bearer`,
  String.raw`credential`,
  String.raw`priv(?:ate)?[-_ ]?key`,
  String.raw`seed[-_ ]?phrase`,
  String.raw`mnemonic`,
  String.raw`otp`,
  String.raw`totp`,
  String.raw`2fa[-_ ]?(?:code|secret)`,
  // de — `Kennwort` and `Zugangsdaten` are as ordinary as `Passwort` here, and
  // German compounds them, so the key words take an optional prefix rather than
  // one entry each.
  String.raw`(?:\w+[-_ ]?)?pass(?:wort|phrase)`,
  String.raw`kennwort`,
  String.raw`(?:zugangs|anmelde|zugriffs|login)[-_ ]?(?:daten|informationen|code|schl[uü]ssel|token)`,
  String.raw`(?:geheim|privat(?:er)?[-_ ]?|api[-_ ]?)schl[uü]ssel`,
  String.raw`geheimnis`,
  String.raw`(?:einmal|sicherheits|wiederherstellungs)[-_ ]?code`,
  // fr
  String.raw`mot\s+de\s+passe`,
  String.raw`phrase\s+secr[eè]te`,
  String.raw`cl[eé](?:\s+(?:api|priv[eé]e|secr[eè]te|d['’]acc[eè]s))?`,
  String.raw`jeton(?:\s+d['’]acc[eè]s)?`,
  String.raw`identifiants`,
  // es
  String.raw`contrase[nñ]a`,
  String.raw`clave(?:\s+(?:api|privada|secreta|de\s+acceso))?`,
  String.raw`secreto`,
  String.raw`credenciales`,
  // nl
  String.raw`wachtwoord(?:zin)?`,
  String.raw`(?:priv[eé]|api|geheime?)[-_ ]?sleutel`,
  String.raw`toegangs(?:token|code|sleutel)`,
  String.raw`inloggegevens`,
  // pt
  String.raw`senha`,
  String.raw`palavra[-\s]?passe`,
  String.raw`segredo`,
  String.raw`chave(?:\s+(?:privada|secreta|de\s+api|de\s+acesso))?`,
  String.raw`credenciais`,
  // it — `password` is the ordinary Italian word and is already in the English
  // group, which is the point the measurement makes: the row that missed had an
  // English label and an Italian copula.
  String.raw`parola\s+d['’]ordine`,
  String.raw`chiave(?:\s+(?:privata|segreta|api|di\s+accesso))?`,
  String.raw`segreto`,
  String.raw`credenziali`,
]

/**
 * What may stand between the label and the value.
 *
 * **The separator list is half the gap, and the Italian row is what proves it**
 * (`#1529`): `la password è Xk9-…` carries the English label the pattern already
 * had and was missed anyway, because the copula was not in
 * `(?:is|are|=|:|->|→)`. So a vocabulary widening on its own would have left
 * that row exactly where it was.
 *
 * Accent-less spellings are in deliberately — `e` for `è`, `sao` for `são` —
 * because a person typing quickly, or a channel that has lost its diacritics,
 * writes those. `e` and `é` are also *and* in Italian and *is* in Portuguese
 * respectively, so both admit a sentence like *password e nome utente*; that is
 * what {@link looksLikeAValue} is for, and it holds — the value there is an
 * ordinary word with a sentence continuing past it.
 */
const SECRET_WORD_SEPARATORS: readonly string[] = [
  // en / nl
  'is',
  'are',
  'zijn',
  // de
  'ist',
  'sind',
  'lautet',
  'lauten',
  // fr / es
  'est',
  'sont',
  'es',
  'son',
  // it / pt — including the accent-less spellings people actually type
  'è',
  'e',
  'é',
  'são',
  'sao',
]

/** The ones that are punctuation, and so need no boundary after them. */
const SECRET_SYMBOL_SEPARATORS: readonly string[] = ['=', ':', '->', '→']

/**
 * The labels that make a following value look like a disclosure.
 *
 * Captured rather than merely matched, so the refusal can name which one fired
 * without echoing what came after it.
 *
 * **Unicode boundaries rather than `\b`** (`#1529`). `\b` is ASCII, so the
 * boundary after `contraseña` sits between two characters it considers
 * non-word and does not exist — a label ending in an accented letter could never
 * match however carefully it was spelled. The lookarounds do what `\b` was
 * standing in for, under `u`.
 *
 * **Longest alternative first, in both lists, because JavaScript alternation is
 * ordered rather than greedy.** Both halves bite, and the second one is the
 * quieter of the two:
 *
 * - With `cl[eé]` before `cl[eé]\s+api` the shorter label wins and what follows
 *   is then a word rather than a copula.
 * - With `is` before `ist`, `das Passwort ist Xk9-…` matches the separator `is`,
 *   takes `t` as the value, leaves ` Xk9-…` as the rest — and
 *   {@link looksLikeAValue} correctly says a bare letter mid-sentence is not a
 *   value. **The disclosure is then missed by a guard that matched it**, which
 *   is a shape worth naming: the pattern fired, the shape test refused, and the
 *   two together answered no.
 *
 * A word separator also carries the boundary the label does, for the same
 * reason: without it `es` matches the front of `est` and the same thing happens
 * one language along.
 */
const LABELLED_SECRET = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(` +
    [...SECRET_LABELS].sort((a, b) => b.length - a.length).join('|') +
    String.raw`)(?![\p{L}\p{N}])\s*(?:(?:` +
    [...SECRET_WORD_SEPARATORS].sort((a, b) => b.length - a.length).join('|') +
    String.raw`)(?![\p{L}\p{N}])|` +
    SECRET_SYMBOL_SEPARATORS.map((separator) =>
      separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    ).join('|') +
    String.raw`)\s*(\S+)([^\n]*)`,
  'iu',
)

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
const GUEST_HANDOFF_URL = /https:\/\/kolonie\.ai\/handoff\/[A-Za-z0-9_-]+/g

export function credentialFinding(text: string): CredentialFinding | null {
  const inspected = text.replace(GUEST_HANDOFF_URL, 'guest-handoff-url')
  for (const [reason, pattern] of UNLABELLED_PATTERNS) {
    if (pattern.test(inspected)) return { reason, matched: reason }
  }

  const labelled = LABELLED_SECRET.exec(inspected)
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

/**
 * A PEM private-key block, and nothing else this detector names (`#1685`).
 *
 * **The vault is where a password, a token and a TOTP secret belong.** Those
 * still match {@link credentialFinding}; they must not match this. A private
 * key is the one class a vault write would transfer out of the place that
 * generated it, and the one a lost API key would make unrecoverable.
 */
export function keyMaterialFinding(text: string): CredentialFinding | null {
  const finding = credentialFinding(text)
  return finding?.reason === 'private-key-block' ? finding : null
}

/**
 * What a vault write (and a secret slot `put`) say when they refuse one.
 *
 * **Not {@link credentialRefusalMessage}.** That one names the vault as the
 * place to put the secret. This one is the vault saying no, and the reasons
 * are the two `#1685` named: key material stays where it was generated, and a
 * vault entry does not survive loss of the API key.
 */
export function keyMaterialRefusalMessage(finding: CredentialFinding): string {
  return (
    `The Colony will not store ${DESCRIBED[finding.reason]}. Key material stays where you ` +
    'generated it — a vault write is a transfer into the Colony’s process — and a vault ' +
    'entry does not survive loss of the API key that sealed it.'
  )
}

/** The `ApiError` both write surfaces return for a private-key block (`#1685`). */
export function keyMaterialRefused(finding: CredentialFinding): ApiError {
  return { code: 'key_material_refused', message: keyMaterialRefusalMessage(finding) }
}

/**
 * The optional `noticed` field on a success that still went through (`#1685`).
 *
 * Spread onto the response. Empty when there is nothing to notice, including
 * `null` — an operator who wrote nothing is not a finding.
 */
export function keyMaterialNotice(text: string | null | undefined): {
  readonly noticed?: CredentialFinding
} {
  if (text === null || text === undefined) return {}
  const finding = keyMaterialFinding(text)
  return finding === null ? {} : { noticed: finding }
}
