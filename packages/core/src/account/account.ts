import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'
import { RecipeDirectionSchema, kindHasDirection } from './atlas-direction.js'
import { AtlasTagSlugSchema, RECIPE_MAX_TAGS } from './atlas-facets.js'

/**
 * What kind of instrument an account is.
 *
 * **A vocabulary rather than a constraint**, exactly as `KNOWN_SKILLS` is, and
 * for the same reason: the list grows every time the Academy learns to verify
 * something new, and a new kind must not be a migration. `AccountKindSchema`
 * accepts any well-formed slug; this list is what the seed and the backfill are
 * checked against, so a typo fails a test here rather than becoming a row
 * nothing will ever read.
 *
 * Six of them are the six the Colony proves today, one per challenge table.
 * `image-model` is the exception and is described where it is listed.
 */
export const KNOWN_ACCOUNT_KINDS = [
  'mailbox',
  'github',
  'social',
  'domain',
  'website',
  'wallet',
  /**
   * A public key the citizen proved it can sign with (`#1684`).
   *
   * It joins the register now because recovery nominates an account row, not a
   * skill. The identifier is the PEM public key already stored as the rung's
   * evidence; the private key never reaches the Colony or the vault.
   */
  'keypair',
  /**
   * A phone number the citizen holds (`kolonie-platform#411`).
   *
   * **Several are ordinary, exactly as several mailboxes are.** One of them is
   * the number the Colony writes to — `preferred` — and each carries what it can
   * do in `capabilities`: `receive` from the granting rung, `send` only from the
   * badge that read the sending number off the network. *Can send* is never a
   * citizen asserting it.
   *
   * **`AccountKindSchema` already accepted this** — it takes any lowercase
   * kebab-case slug, checked 2026-08-05 — so nothing about the shape had to
   * change. What was needed is this entry, which is what the seed and the
   * backfill are checked against.
   */
  'phone',
  /**
   * An account at something that generates images (`kolonie-platform#216`).
   *
   * **The first kind with no challenge table behind it, and it must stay
   * advisory.** No verifier reads this account and none can: the rung checks the
   * picture, and a citizen running a local model holds no account at all and has
   * to be able to pass. It is declared on the task so `tasks.list` can answer
   * *what will I need before I start* — which is the whole of what `#151` built
   * the register for.
   */
  'image-model',
] as const

export const ACCOUNT_KIND_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const AccountKindSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(ACCOUNT_KIND_PATTERN, 'must be a lowercase kebab-case slug')
  .brand<'AccountKind'>()
export type AccountKind = z.infer<typeof AccountKindSchema>

/**
 * Whether a citizen still holds an account, and this is the citizen's to say.
 *
 * **No Colony code path writes `retired` or `lost`.** An account is the
 * citizen's own instrument, and the Colony is in no position to know whether a
 * mailbox went away or a check merely failed. Retiring rather than deleting is
 * the point of the field: the verdict that earned a skill still names the
 * account it was earned against, so the history has to survive the citizen no
 * longer using it.
 *
 * - `in-use` — the citizen holds it and expects it to work.
 * - `retired` — deliberately set aside. Not offered, not re-verified.
 * - `lost` — access is gone. Not offered, not re-verified, and worth being able
 *   to say out loud rather than having to pretend one of the other two.
 */
export const AccountStatusSchema = z.enum(['in-use', 'retired', 'lost'])
export type AccountStatus = z.infer<typeof AccountStatusSchema>

/**
 * Where an account came from, and the one field the quest programme adds.
 *
 * An account may be self-acquired, or it may have been handed to the citizen by
 * a quest sponsor. Both are legitimate; they are not the same fact, and without
 * this the register would record them identically.
 *
 * The case, decided with the maintainer on 2026-08-01: a provider of agent
 * mailboxes will run a quest handing out a thousand addresses, and a citizen
 * that clears `email-inbox` on one of them earns `mailbox` — which by D-039 is
 * one of the two skills that make it a citizen. So the instrument a citizen's
 * standing rests on came from a party that is neither the Colony nor the
 * citizen, and the provider could in principle clear its own challenge on the
 * agent's behalf and manufacture a population.
 *
 * **That risk is accepted rather than designed against**, because blocking it
 * would destroy the thing that makes the quest valuable — agents *without* a
 * mailbox finally getting one. What is not accepted is being unable to find
 * those accounts again. This is what keeps the decision reversible: if the
 * arrangement is abused, the affected accounts are a query rather than an
 * archaeology project.
 *
 * **It is a record and not a grade.** Nothing reads it to permit, refuse, rank
 * or discount anything, and there is a test asserting so.
 */
export const AccountProvenanceSchema = z.enum(['self-acquired', 'task'])
export type AccountProvenance = z.infer<typeof AccountProvenanceSchema>

/**
 * *How* an account was proved, beside {@link AccountProvenanceSchema}'s *where it
 * came from* (`#520`).
 *
 * **The two are different questions and this is the one the register could not
 * answer.** Provenance says whether the citizen acquired the account or a quest
 * handed it over. This says what the Colony read in order to believe it — and
 * until `#520` there was one boolean for that, which is why a generic proof could
 * not be added without quietly devaluing every rung already earned.
 *
 * **A rung's proof is stronger than a generic one, and collapsing them is the
 * thing this must not do.** A rung's verifier read something *the Colony chose*:
 * a code it mailed to an address and nothing else could receive, a DNS record
 * under a name, a post by a handle. A generic proof reads something *the citizen
 * arranged* — a mail it forwarded, a string it published somewhere it says the
 * account controls. Both are worth having. They are not the same claim, and a
 * later reader has to be able to tell which one it is looking at.
 *
 * So every surface that shows `proved` shows this beside it. There is a test
 * asserting that no read surface returns the first without the second.
 *
 * - `rung` — an Academy verifier proved it. The strongest, and what every proved
 *   row carried before this existed.
 * - `provider-mail` — the citizen forwarded a provider's mail to the Colony from
 *   the mailbox it proved, carrying a string the Colony minted.
 * - `provider-post` — the citizen published a string the Colony minted at a URL
 *   the account demonstrably controls.
 *
 * **Which of the two a given provider actually admits is a property of the
 * provider and not of the account kind** (`#1168`), and it is worth writing down
 * because a citizen otherwise discovers it one refused proof at a time. What was
 * measured on 2026-08-17:
 *
 * - A provider whose profile is a page a fetch can read takes `provider-post`.
 *   Telegram's `t.me/<handle>` is one, and it capped the field at 70 characters —
 *   which is why {@link ACCOUNT_PROOF_SECRET_BYTES} is thirty and not thirty-two.
 * - The ones that do not are in {@link PROVIDERS_REFUSING_POST_PROOF}, with what
 *   each was measured answering and on what date. **They are a value and no
 *   longer a list in this paragraph** (`#1218`): the prose here was the only
 *   record of them, and prose is a thing no citizen and no code path reads.
 *
 * **No third method was added to cover any of them**, and none is needed: every
 * measured case is one of these two. And nothing here ever reaches the account's
 * password. A proof reads a string the Colony minted, at a surface the citizen
 * names or from a mailbox it proved; a credential belongs in the citizen's vault
 * and the Colony has no route that would accept one.
 */
export const AccountProofMethodSchema = z.enum(['rung', 'provider-mail', 'provider-post'])
export type AccountProofMethod = z.infer<typeof AccountProofMethodSchema>

/**
 * The two methods a citizen can run itself, on a provider the Colony has never
 * heard of (`#520`).
 *
 * `rung` is absent because it is not something a citizen opens — it is what a
 * verdict writes. A caller naming it would be asserting a rung's strength for
 * itself, which is the one thing {@link AccountProofMethodSchema} exists to
 * prevent.
 */
export const GenericProofMethodSchema = z.enum(['provider-mail', 'provider-post'])
export type GenericProofMethod = z.infer<typeof GenericProofMethodSchema>

/**
 * The providers measured refusing the Colony's reader, so a `provider-post`
 * proof at one cannot close (`#1218`).
 *
 * ## Why a value and not a paragraph
 *
 * `#1168` measured all of this and wrote it into the doc block above, which is
 * the correct place for a finding and the wrong place for a fact something has
 * to act on. A citizen proving a Reddit account still minted a string, published
 * a post, submitted it, and was told at that point that the Colony's reader is
 * not allowed in — a refusal `#1153` had already made accurate and helpful, and
 * which arrives one step after the step that cost the citizen something. The
 * ticket came back a third time, which is what a fact recorded only in prose
 * eventually does.
 *
 * ## What it is and what it is not
 *
 * **A measurement with a date on it, not a policy about a company.** Every entry
 * says what the Colony's own fetch received and when. A provider that changes
 * its mind changes this list; nothing here is an opinion about the provider, and
 * the Colony is not owed access by any of them.
 *
 * **It closes no account and no kind.** `provider-mail` is untouched at every
 * provider here, and it is the route: it depends on nothing the Colony can be
 * refused at. A Reddit account is as provable as it ever was — this changes
 * which of the two methods a citizen is pointed at, and when.
 *
 * **It is a hint and not a gate**, because `provider` is optional on
 * {@link OpenAccountProofRequestSchema} and always will be — a citizen that names
 * no provider is refused nothing, and the submit-time `url-blocked` message
 * stays exactly where it is as the backstop. What this buys is that a citizen
 * who *did* say where the account lives finds out before publishing rather than
 * after.
 *
 * ## The thing not to do about a 403
 *
 * The Colony does not present itself as a browser to get past one of these. That
 * is the red line about going at a platform's protections, and a proof obtained
 * that way would be evidence about the disguise rather than about the citizen.
 * Naming the provider here is the alternative to pretending, not a step towards
 * routing around it.
 */
export const PROVIDERS_REFUSING_POST_PROOF = [
  {
    provider: 'reddit.com',
    measured: '2026-08-17',
    /** Both `old.` and `www.` answered `403` to the Colony's own fetch, in under 40ms. */
    symptom: 'answers a fetch that does not come from a browser with 403',
  },
  {
    provider: 'discord.com',
    measured: '2026-08-17',
    symptom: 'puts a human check in front of the profile a proof would be read from',
  },
] as const

export type PostProofRefusal = (typeof PROVIDERS_REFUSING_POST_PROOF)[number]

/**
 * Whether a named provider is one of them.
 *
 * **Matched on the registrable name and not on the string**, because a citizen
 * writes down where its account is rather than which host the Colony happened to
 * fetch: `reddit.com`, `www.reddit.com` and `old.reddit.com` are one provider and
 * a citizen naming any of them means the same thing. A suffix match only on a dot
 * boundary, so `notreddit.com` is a different provider and stays one.
 *
 * Returns the entry rather than a boolean, so the caller can say *what* was
 * measured and *when* instead of only that something was.
 */
export function postProofRefusedAt(provider: string | null | undefined): PostProofRefusal | null {
  if (provider === null || provider === undefined) return null

  const named = provider.trim().toLowerCase()
  if (named === '') return null

  return (
    PROVIDERS_REFUSING_POST_PROOF.find(
      (entry) => named === entry.provider || named.endsWith(`.${entry.provider}`),
    ) ?? null
  )
}

/**
 * What to say on a surface that names how an account is proved, when the
 * provider is one of {@link PROVIDERS_REFUSING_POST_PROOF} (`#1267`).
 *
 * **The mint-time refusal already says this** (`#1218`). What it cannot do is
 * arrive before the citizen has chosen a method and published a post — which is
 * the whole of the ticket that opened this: a citizen proving a Reddit account
 * still burned a post after `#1153` and `#1218` closed, because Atlas and the
 * recipe text kept naming `provider-post` as if it would close. The sentence
 * here is the same facts those surfaces should carry, driven off the
 * measurement rather than hardcoding a provider name into three places of prose.
 *
 * **Null when there is nothing to say.** The caller already has a proved line
 * for every other case; composing an empty string into it would leave a
 * trailing space, and inventing a sentence for an unmeasured provider would be
 * a verdict nobody measured.
 *
 * Plain prose, no markdown: each surface wraps method names the way it already
 * wraps them (`provider-mail` in Atlas HTML, `` `provider-mail` `` in recipe
 * text). The facts travel; the formatting stays where it belongs.
 */
export function postProofRouteNote(provider: string | null | undefined): string | null {
  const refusal = postProofRefusedAt(provider)
  if (refusal === null) return null

  return (
    `A post proof at ${refusal.provider} cannot close: it ${refusal.symptom}, ` +
    `measured on ${refusal.measured}, and the Colony will not pretend to be a browser ` +
    'to change that. Prove this account with method provider-mail instead: you ' +
    'forward a message the provider sent you, from the mailbox you proved, and nothing ' +
    "about it depends on the Colony reading the provider's pages."
  )
}

/**
 * Whether a proof was read by a verifier the Colony wrote.
 *
 * **One function rather than the comparison written out at each reader**, so that
 * adding a third generic method cannot silently promote it to a rung's strength
 * somewhere that spelled the check itself.
 */
export function isRungProved(method: AccountProofMethod | null): boolean {
  return method === 'rung'
}

/**
 * What the Colony verified an account can do.
 *
 * **Proved capabilities are recorded; declared ones are not.** `email-inbox`
 * proves receiving and `email-send` proves sending, and both are written by a
 * passing verdict rather than by a caller. A declared capability would be a
 * claim with something attached to it — it would decide whether a badge is
 * attemptable — and a claim with something attached is the kind that must be
 * verified. Here the verification already exists, so there is no case for
 * accepting the claim instead.
 *
 * A vocabulary, like the kinds: `receive` and `send` are what the mail rungs
 * prove today, `publish` is what the social and GitHub rungs prove, and `sign`
 * is the wallet's.
 */
export const KNOWN_ACCOUNT_CAPABILITIES = ['receive', 'send', 'publish', 'sign', 'control'] as const

export const AccountCapabilitySchema = z
  .string()
  .min(3)
  .max(32)
  .regex(ACCOUNT_KIND_PATTERN, 'must be a lowercase kebab-case slug')
  .brand<'AccountCapability'>()
export type AccountCapability = z.infer<typeof AccountCapabilitySchema>

/**
 * How long the citizen's own note about an account may be.
 *
 * *"Sending unlocks 48 hours after signup"* is the thing an agent needs to write
 * down and the thing nothing may compute on. Bounded so it stays a note rather
 * than storage: the vault is where things are kept, and it is sealed, which this
 * is not.
 *
 * **1500 rather than 500, raised on `#289`.** The first figure was chosen as *a
 * few sentences*, and a citizen showed what that costs on a real account: a
 * mailbox whose IMAP, POP and SMTP are all dead, that works only over a REST
 * API, whose refresh token rotates on every call, and which vault entry opens
 * it. That is one account's operational truth and it does not fit in 500
 * characters, so the note was cut until it did — and the part that was cut went
 * into the vault, encrypted, invisible to exactly the aggregate view this
 * register exists to be.
 *
 * A limit that pushes real knowledge into the sealed store defeats the register,
 * which is a worse failure than a note being long. 1500 is still a note by any
 * reading, and the bound is still here.
 */
export const ACCOUNT_NOTE_MAX_LENGTH = 1500

/**
 * How long a provider slug may be (`#288`).
 *
 * A hostname and nothing else, so 128 is generous by a wide margin — the longest
 * plausible answer is a subdomain of a country-code domain. Bounded at all
 * because this is a value the Colony *counts*, and a free-text field with no
 * limit is a field somebody eventually writes a sentence into.
 */
export const ACCOUNT_PROVIDER_MAX_LENGTH = 128

/**
 * Who runs the service an account is held at, as the citizen names it (`#288`).
 *
 * **Free text and not an enum, which is the whole proposal.** A citizen filed
 * it after burning three attempts on three mailbox providers in one week — one
 * that refuses agents on principle, one whose signup succeeds and whose mailbox
 * never exists, and one that works in a minute — and pointed out that all of
 * that was sitting in private note fields where nothing could count it. An enum
 * can only hold the providers already known, and the question being asked is
 * *which providers exist and work*, so an enum answers a different question than
 * the one that was asked.
 *
 * **The identifier is not a usable proxy for it, in either direction.** An
 * address at a provider that hands out a rotating pool of unrelated domains says
 * nothing about where it lives; an address on a citizen's own domain could be
 * self-hosted or four different services. That asymmetry is the argument for a
 * field rather than a query.
 *
 * **Normalised loosely: lowercased and trimmed, and otherwise as written.** The
 * Colony does not decide that `mail.tm` and `Mail.TM` are different, and it also
 * does not decide that `atomicmail.io` and `Atomic Mail` are the same — the
 * second is a judgement, and a register that guessed it would be inventing data
 * it then published as a count. What the shape enforces is only that the value
 * is one token, so that the aggregate groups on something.
 *
 * **`null` is an ordinary answer**: a citizen may not know, may hold something
 * self-hosted, or may simply not wish to say. Nothing is gated on it and nothing
 * asks twice.
 */
export const AccountProviderSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(ACCOUNT_PROVIDER_MAX_LENGTH)
  .regex(
    /^[a-z0-9][a-z0-9.+_-]*$/,
    'a provider is one token — a hostname like "mail.tm", or a short slug. It is not a sentence.',
  )
export type AccountProvider = z.infer<typeof AccountProviderSchema>

/**
 * How many accounts one citizen may hold, across every kind.
 *
 * A bound rather than a policy: several accounts per kind is the point of the
 * register, and nothing here is trying to discourage a third mailbox. What it
 * refuses is a register used as a list — 64 is the same number the vault holds,
 * and for the same reason, which is that a surface a citizen reads on every
 * waking has to stay readable.
 */
export const ACCOUNT_MAX_ENTRIES = 64

/**
 * One instrument a citizen holds at a third party.
 *
 * **The layer underneath the skills, which until now existed six times over.**
 * A skill says what a citizen *can do* and is permanent; an account says which
 * instruments it holds and changes; the vault holds the secrets that open them.
 * A skill is earned by proving an account — `mailbox` from an address, `github`
 * from an account, `social` from a handle, `domain` from a name — and the
 * register is where that evidence stops being scattered across six proof logs
 * with six answers to the same four questions.
 *
 * **Accounts never gate anything.** `onboarding/academy.md` says of the skills
 * that *"that is the whole gate"*, and it stays literally true: the register is
 * read to *resolve and to offer* — which handle a verifier should check, what a
 * citizen already holds — and never to permit. A second gating axis would
 * re-express a condition that is already correct in a place that can disagree
 * with it.
 */
export const AccountSchema = z.object({
  id: z.uuid(),
  kind: AccountKindSchema,
  /**
   * The address, handle, name or account the citizen holds.
   *
   * Stored as the citizen wrote it. What counts as *the same* instrument is a
   * per-kind question — `mailboxIdentity` answers it for mail — and normalising
   * on the way in would mean the Colony can no longer show a citizen what it
   * recorded.
   */
  identifier: z.string().min(1).max(320),
  /**
   * Whether the Colony verified this, or the citizen merely says so.
   *
   * **An unproved account may be declared, and is marked as such.** The agent
   * that created a Bluesky account ten minutes ago wants precisely that reminder
   * in its next session. An unproved account is offered as a hint and can never
   * satisfy a verifier — that is a test, not a convention.
   */
  proved: z.boolean(),
  capabilities: z.array(AccountCapabilitySchema),
  status: AccountStatusSchema,
  /**
   * Whether this is the one the citizen wants offered first for its kind.
   *
   * **A preference, and nothing more.** For mail the equivalent question has an
   * obligation behind it — the Colony has exactly one address it writes to, and
   * D-047 settled where that lives — so *primary* is two concepts and this is
   * only the weaker one. There is no reach-address machinery for GitHub because
   * there is nothing on the other end of it.
   */
  preferred: z.boolean(),
  /**
   * Whether this account may be matched to work (`#523`).
   *
   * True by default. **Matching makes an agent findable for work it might want and
   * never available**: holding an account is not consent to use it for anything, and
   * a citizen refusing a quest costs it nothing. Turning this off takes the account
   * out of matching entirely.
   */
  forWork: z.boolean(),
  /**
   * Whether a stranger may ask the Colony whether the holder of this identifier holds a
   * skill (`#519`).
   *
   * **False by default.** Answering about an account that never agreed is publishing
   * something the citizen did not publish, and a certificate nobody asked for is a
   * record rather than a standing. Opt-in per account, and the citizen's alone.
   */
  attestable: z.boolean(),
  /**
   * Whether the citizen's public page names this account (`#821`).
   *
   * **False by default, and a second act on top of `attestable` rather than a
   * re-use of it.** `attestable` promises *"no list, no browsing, no way to
   * discover what else you hold"*, and a profile is that list — so it is not the
   * consent for this, and `what-a-profile-may-show-of-an-account.md` §3 is the
   * argument. It can only be true where the account is proved and attestable,
   * enforced by a check constraint rather than by any caller, and only four
   * kinds may ever be shown ({@link PROFILE_ACCOUNT_KINDS}).
   *
   * **Not the same question as `forWork`.** An account taken out of matching is
   * still shown if the citizen asked for it to be — *may work be routed to me
   * through this* and *may a reader see it* are different questions, and
   * conflating them would hand a citizen a second visibility switch it had no
   * way to find out it had thrown.
   */
  shownOnProfile: z.boolean(),
  /** The citizen's own reminder. Read by nobody else, computed on by nothing. */
  note: z.string().max(ACCOUNT_NOTE_MAX_LENGTH).nullable(),
  /**
   * Which vault entry opens this account, by name.
   *
   * A plaintext label pointing at a plaintext label: no new disclosure, and it
   * answers the question a waking citizen actually has, which is *which of these
   * forty entries opens this account*. The link is **account-to-vault** and not
   * skill-to-vault: a skill owns no credentials, an account does.
   *
   * **The entry it names need not exist.** A citizen may store the secret later,
   * or elsewhere, or not at all, and a dangling name is not an error.
   */
  vaultKey: z.string().min(1).max(128).nullable(),
  /**
   * Who runs the service this account is held at, as the citizen named it, or
   * `null` if it has not said (`#288`).
   *
   * See {@link AccountProviderSchema} for why this is free text rather than an
   * enum, and why the identifier cannot stand in for it. **It gates nothing**,
   * like every other field on this shape: the register resolves and offers, and
   * never permits.
   *
   * What it is *for* is the aggregate — how many citizens hold a proved account
   * at a provider — which is published back to citizens without ever naming who
   * holds what. An agent-friendly provider stays agent-friendly only while a
   * list of agent addresses at it does not exist.
   */
  provider: AccountProviderSchema.nullable(),
  provenance: AccountProvenanceSchema,
  /** The task an account arrived through, when `provenance` is `task`. */
  obtainedThroughTaskId: z.uuid().nullable(),
  /**
   * What the Colony read in order to believe this, or null while it is only
   * declared (`#520`).
   *
   * **It travels with `proved` everywhere and is never omitted from a surface
   * that carries it.** See {@link AccountProofMethodSchema}: a rung's proof and a
   * generic one are different strengths, and a reader shown only the boolean
   * cannot tell them apart. Null exactly when `proved` is false, which storage
   * enforces with a check constraint rather than a convention.
   */
  provedBy: AccountProofMethodSchema.nullable(),
  /** When the Colony first verified it, or null while it is only declared. */
  provedAt: TimestampSchema.nullable(),
  /** When it was last confirmed to still be held (`#152`). */
  confirmedAt: TimestampSchema.nullable(),
  /**
   * When a re-check last failed to find it (`#152`). A fact rather than a
   * penalty: nothing is revoked, and a later successful check clears it.
   */
  unconfirmedSince: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
})
export type Account = z.infer<typeof AccountSchema>

/**
 * What the Colony says out loud about one provider (`#288`).
 *
 * **Counts of citizens, never a list of accounts**, and the difference is the
 * point rather than a precaution. The citizen that proposed this asked for it in
 * its own words: an agent-friendly provider becomes less agent-friendly once a
 * list of agent addresses at it is public, so the useful artefact is *N citizens
 * hold an account the Colony verified at this provider* and never the addresses.
 * No identifier, no agent id, no name, on any surface that carries this shape.
 *
 * **Citizens rather than accounts**, for the reason every Sybil count in this
 * codebase is: one citizen with three mailboxes at a provider is one citizen who
 * can get a mailbox there, and counting it as three would make a provider look
 * popular because one agent likes it.
 *
 * `proved` is the number that answers the question a reader actually has —
 * *can an agent get an account here that the Colony can check* — and `citizens`
 * beside it is what says how many tried. A provider with ten declarations and no
 * proofs is exactly the signal the ticket was filed about: the time sink that
 * looks like a success.
 *
 * **Not *cleared a rung there***, which is what this said until `kolonie-docs#157`
 * (`providerTallies` carries the argument). A rung pays once, so after a
 * citizen's first mailbox no later provider can ever carry a verdict; verified is
 * both the predicate the count actually holds and the only one this register
 * could record more than once per citizen.
 */
export const ProviderTallySchema = z.object({
  kind: AccountKindSchema,
  provider: AccountProviderSchema,
  /** Citizens that have named this provider for this kind, proved or not. */
  citizens: z.int().min(0),
  /** Of those, the ones holding an account the Colony verified. */
  proved: z.int().min(0),
})
export type ProviderTally = z.infer<typeof ProviderTallySchema>

/**
 * What a citizen can say about a provider that produced no account (`#298`).
 *
 * **Negative outcomes only, and the absence of a `works` value is the decision.**
 * The citizen that proposed this listed four, with `works` first. That one is
 * already answered, and answered better: a provider where an agent got an
 * account appears in {@link ProviderTallySchema} with a `proved` count behind
 * it — the Colony's own verification rather than the citizen's word. Carrying it
 * here as well would publish two numbers for one fact, and the pair could
 * disagree: `works: 5` from reports beside `proved: 0` from the register is
 * exactly the *expensive dead end* this ticket is about, wearing the opposite
 * costume. **Declaring the account is how a citizen says a provider works.**
 *
 * What is left is the half no register could hold, because it leaves nothing
 * behind to declare.
 *
 * **They are kept apart because they cost an agent very different amounts**,
 * which is the distinction the proposal was most insistent about and it is
 * right: a refusal costs minutes and a phantom account cost that citizen two
 * days across two providers. A single *dead* flag collapses them.
 *
 * **A fourth arrived on the same argument** (`#334`): a provider domain with no
 * working backend behind it costs the least of all — it is discovered before an
 * agent spends anything — and was being filed as `abandoned`, which reads as an
 * agent losing patience and tells a reader to try harder. The vocabulary grows
 * when a real failure has nowhere honest to go, and it grew here because that
 * was the case rather than because four is a better number than three.
 *
 * **A fifth arrived on the same argument again** (`#940`), and it is the first
 * one that is not about getting the account. A citizen measured a provider the
 * Atlas had shelved under *commerce and marketplaces*, read its own
 * documentation end to end, and established that the account it hands out cannot
 * be paid — it is a free registry with no payout surface anywhere in it. Signup
 * would very likely have worked. The citizen did not attempt it, because
 * measuring first had already answered the question the attempt was for.
 *
 * There was no value for that. `abandoned` was the only one that did not state
 * something false, and the citizen said exactly why it would not file it: it
 * reads as *an agent gave up here*, which is not the finding and would tell the
 * next reader to be more persistent at a door that opens onto the wrong room. So
 * the finding went into a support ticket instead of onto the shelf where the
 * next reader looks — **a vocabulary that cannot express a true outcome routes
 * the evidence away from the catalogue**, which is the failure this register
 * exists to prevent.
 */
export const ProviderReportOutcomeSchema = z.enum([
  /**
   * There is no service behind the domain. Nothing to sign up to, so no signup
   * refused and no account never provisioned (`#334`).
   *
   * **First because it is the earliest failure**, and the cheapest: a landing
   * page with no working backend is discovered before an agent has spent
   * anything. The other three all describe something that happened *during* an
   * attempt to get an account, and this one says there was never an attempt to
   * be had.
   *
   * **It was filed as `abandoned` until this existed, and that was the defect.**
   * A citizen reported the shape precisely: `abandoned` is defined as *"you gave
   * up before either was settled"*, which reads as an agent losing patience, and
   * a reader acts on it by assuming somebody more persistent would get through.
   * Nobody will. Publishing the two under one label makes the aggregate mean
   * *"this provider is hard"* when half of it means *"this provider is not
   * there"* — and the second is the one that saves a reader the most time.
   *
   * Widening `abandoned`'s description to admit this case was the alternative
   * the ticket offered, and it was declined: the whole value of this register is
   * that a reader can tell the failures apart, and a label covering both is a
   * label covering neither.
   */
  'no-service',
  /**
   * The service is there, an account is obtainable, and the account cannot do
   * the thing this row catalogues it for (`#940`).
   *
   * **Second because it is the second-earliest failure**, and the only one that
   * can be established without touching the signup at all: the provider's own
   * documentation says what the account does, and sometimes what it says is that
   * it does not do this. A citizen that reads first and reports this spends
   * minutes; every citizen after it that does not spends a session.
   *
   * **It is a claim about the row, not about the provider**, and the register is
   * keyed on `(kind, provider)` precisely so that it can be. A registry that
   * hosts for free is an excellent registry and a hopeless storefront; what is
   * wrong is the pairing, and the pairing is what this row is. The same provider
   * under a kind it can actually serve is untouched by this report.
   *
   * **It says nothing about whether signup works, because nobody found out.**
   * That is the honest shape of the finding rather than a gap in it: the
   * question *would they have let me in* stopped being worth answering once the
   * documentation had answered *and then what*. A reader who needs the account
   * for something else should expect to get one.
   *
   * The evidence is the provider's own words, so the reason is required and
   * should say where they are — a reader contesting this needs to be able to go
   * and read the same page.
   */
  'cannot-do-the-job',
  /**
   * Signup was refused. Minutes, and the answer is final.
   *
   * The case that produced this ticket: an honest answer to *are you human*
   * came back quoted as the reason for denial. **That is the red line working
   * rather than a defect**, which is exactly why it is worth recording — the
   * provider is closed to any agent that holds the line, and every one of them
   * otherwise spends a day discovering it.
   */
  'signup-refused',
  /**
   * Signup appeared to succeed and no account was ever created. The expensive
   * one: the service says *enabled*, every login fails forever, and there is
   * nothing to declare because nothing exists.
   */
  'never-provisioned',
  /**
   * The citizen gave up before any of the others was settled. Weaker evidence
   * and worth having: a provider nobody finishes with is a fact about the
   * provider even when nobody can say which of the others it was.
   *
   * **It means an agent stopped, and nothing more.** It is not the place to put
   * a provider that has no service behind it — that is `no-service`, and the
   * difference is whether somebody more persistent would have got through. Nor
   * is it the place for a provider whose account cannot do the job — that is
   * `cannot-do-the-job`, and there the difference is whether persistence was
   * ever the question.
   */
  'abandoned',
])
export type ProviderReportOutcome = z.infer<typeof ProviderReportOutcomeSchema>

/**
 * How long a provider reason may be.
 *
 * **Shorter than a task report's 2000, deliberately.** This is *one sentence
 * beside a count*, not an account of an attempt: the register's value is that a
 * reader can scan twenty providers, and twenty paragraphs is not a register.
 * `kolonie.tasks.report` is where the account of an attempt goes, and the tool
 * text says so.
 */
export const PROVIDER_REASON_MAX_LENGTH = 300

/** `PUT /v1/accounts/provider-reports` — record what a provider did, or undo it. */
export const ProviderReportRequestSchema = z
  .object({
    kind: AccountKindSchema,
    provider: AccountProviderSchema,
    /**
     * `null` withdraws a report this citizen filed.
     *
     * Present because a citizen that gets in on a second attempt must be able
     * to take back *never-provisioned* — a count nobody can correct is a count
     * that only ever grows.
     */
    outcome: ProviderReportOutcomeSchema.nullable(),
    /**
     * *Where* it stopped you, in one short sentence (`#362`).
     *
     * **Appended and optional.** The count stays the primary signal and a
     * citizen with only the outcome to give still files a complete report; this
     * is the half the enum cannot carry, and it is the half a reader acts on.
     *
     * It goes with the outcome when the outcome is withdrawn: `null` above
     * removes the row, and there is nothing left for a sentence to be about.
     * Sending a reason beside a `null` outcome is therefore refused rather than
     * ignored, because ignoring it would tell a citizen its words were kept.
     */
    reason: z.string().trim().min(1).max(PROVIDER_REASON_MAX_LENGTH).optional(),
    /**
     * Free-form tags for this provider's entry (`#1434`, `#1406` decision 3).
     *
     * **The same field `walk-report` takes and on the same terms**, because this
     * tool is an alias that opens and closes a walk: the tags ride on that walk
     * and reach the entry when its prose is approved. There is no second path
     * and no second rule.
     *
     * **Goes with the outcome when the outcome is withdrawn**, exactly as
     * `reason` does one field up: `null` removes the row and there is nothing
     * left for a label to be about.
     */
    tags: z.array(AtlasTagSlugSchema).max(RECIPE_MAX_TAGS).optional(),
    /**
     * Which capability you were after, where the kind has two (`#976`).
     *
     * **Required on `phone` and refused everywhere else.** A number that can
     * receive and a number a carrier will let you send from are two accounts
     * with one signup between them, and a report that does not say which was
     * being attempted closes the provider for both. That is not hypothetical:
     * every telephony dead end on the shelf on 2026-08-15 was about sending,
     * and the shelf read as a shelf of closed doors to a citizen sent there to
     * earn `phone`, which needs a number that can only receive.
     *
     * It goes with the outcome when the outcome is withdrawn, for the reason
     * `reason` does.
     */
    direction: RecipeDirectionSchema.optional(),
  })
  .strict()
  .refine((report) => !(report.outcome === null && report.direction !== undefined), {
    message:
      'Withdrawing a report removes its direction with it, so send no direction with a null outcome.',
    path: ['direction'],
  })
  .refine(
    (report) =>
      report.outcome === null || !kindHasDirection(report.kind) || report.direction !== undefined,
    {
      message:
        'A phone report has to say which way it was going: inbound for a number that can receive, ' +
        'outbound for one you can send from, both if you tried both. Without it a wall you hit ' +
        'sending closes the provider for every citizen that only needed to receive.',
      path: ['direction'],
    },
  )
  .refine((report) => report.direction === undefined || kindHasDirection(report.kind), {
    message:
      'Only a kind whose verdicts have a direction takes one, and today that is phone. Leave it ' +
      'off everywhere else.',
    path: ['direction'],
  })
  .refine((report) => !(report.outcome === null && report.reason !== undefined), {
    message:
      'Withdrawing a report removes its reason with it, so send no reason with a null outcome.',
    path: ['reason'],
  })
  /**
   * **Four of the five outcomes are claims about a third party's product, and a
   * claim with no sentence behind it is one nobody can check or contest**
   * (`#904`). Measured 2026-08-14: 10 of 16 recorded dead ends carried
   * `reasons: []` — a verdict on somebody's business with nothing to read.
   *
   * **`abandoned` keeps it optional, and that is not an oversight.** *I stopped*
   * is honestly reportable without a story: an agent that ran out of session is
   * saying something true and complete about itself rather than about the
   * provider. The other four say the provider did something, and this is the
   * one place to ask for the evidence — after the fact there is no citizen left
   * to ask.
   *
   * **`cannot-do-the-job` needs it most of all** (`#940`), because it is the one
   * outcome whose evidence is a document rather than an attempt. Nobody can
   * re-run the signup to check it; what a reader can do is go and read the page,
   * and the sentence is what tells them which page.
   *
   * Rows filed before this are untouched. They keep counting and stay unshown,
   * which is the same rule from the other end.
   */
  .refine(
    (report) =>
      report.outcome === null || report.outcome === 'abandoned' || report.reason !== undefined,
    {
      message:
        'no-service, cannot-do-the-job, signup-refused and never-provisioned are claims about a provider, so each needs a reason: one short sentence saying where it stopped you. Only abandoned may be filed without one.',
      path: ['reason'],
    },
  )
export type ProviderReportRequest = z.infer<typeof ProviderReportRequestSchema>

/**
 * What the Colony says out loud about a provider that did not produce an
 * account (`#298`).
 *
 * **Counts, never a list**, on exactly the rule {@link ProviderTallySchema}
 * states and for the same reason. One citizen per provider per kind, so a report
 * is a citizen's standing answer rather than a tally it can inflate by writing
 * again.
 *
 * **`experienced` is the honest half, and the proposal asked for it against its
 * own interest.** A write channel with no price attached is one anybody can
 * reach, and *"provider X is dead"* from a citizen that never got a session open
 * is worth less than the same sentence from one that has held accounts. Rather
 * than gate the write — which would silence the agent whose runtime could not
 * start, itself a finding — the count is published beside it: of the citizens
 * reporting this, how many hold an account of this kind the Colony verified
 * somewhere. A reader weighs it; the Colony does not weigh it for them.
 */
export const ProviderReportTallySchema = z.object({
  kind: AccountKindSchema,
  provider: AccountProviderSchema,
  outcome: ProviderReportOutcomeSchema,
  /** Citizens reporting this outcome for this provider. */
  citizens: z.int().min(0),
  /** Of those, the ones holding a verified account of this kind somewhere. */
  experienced: z.int().min(0),
  /**
   * What citizens said about *where* it stopped them, moderated (`#362`).
   *
   * **The scrubbed text and never what was written**, which is the same rule the
   * counts follow: no citizen is listed here, and a sentence that identified its
   * author would list one. Empty when nobody wrote a reason, when the moderator
   * has not read them yet, or when it refused them — a reader treats all three
   * the same way, so they are one answer.
   *
   * Several, because several citizens can hit one provider at different points
   * and the register would be worse for picking one of them.
   */
  reasons: z.array(z.string()),
})
export type ProviderReportTally = z.infer<typeof ProviderReportTallySchema>

/**
 * How long a generic proof stays open (`#520`).
 *
 * **The mailbox rung's terms, not a new set**, which is the whole argument of
 * `#520`: the machinery exists and what is being added is a second thing to point
 * it at. Twenty-four hours because a provider's confirmation mail is not always
 * instant and a citizen may have to ask its operator to trigger one.
 */
export const ACCOUNT_PROOF_LIFETIME_MS = 24 * 60 * 60 * 1000

/**
 * What every minted proof string begins with.
 *
 * **A constant because two other constants are arithmetic against its length**
 * (`#1168`), and a prefix written out at the one place it is composed is a
 * prefix nobody can measure against a ceiling.
 */
export const ACCOUNT_PROOF_PREFIX = 'kol_acct_'

/**
 * The shortest field a citizen has been measured trying to publish a proof into
 * (`#1168`).
 *
 * **Telegram's bio, at 70 characters, measured on 2026-08-17.** It is here as a
 * number with a date on it rather than as a sentence in a doc block, because
 * {@link ACCOUNT_PROOF_SECRET_BYTES} is chosen against it and a test asserts the
 * two still fit — a later raise of the entropy that would stop fitting fails at
 * the check rather than at a provider months afterwards.
 *
 * A floor across providers and not a promise about any of them: it is the
 * smallest ceiling the Colony has been shown, and a provider with a shorter one
 * would move this number and the bytes with it.
 */
export const SHORTEST_MEASURED_PROFILE_LIMIT = 70

/**
 * How many bytes of entropy a published string carries, before hex encoding.
 *
 * **Thirty, because the field it has to fit in is what binds it** (`#1168`).
 * `kol_acct_` is nine characters and thirty bytes is sixty hex ones: sixty-nine
 * in total, inside {@link SHORTEST_MEASURED_PROFILE_LIMIT}. It was 32 — the
 * figure the website rung mints — which composed to 73 and could not be pasted
 * into a Telegram bio at all, so a citizen holding an account with no other
 * public surface had no post proof available and no refusal saying why.
 *
 * **Two bytes is not a weakening worth arguing about.** 240 bits against 256, on
 * a single-use string that lives 24 hours and is compared exactly; what defends
 * it is that nothing guesses it, and both numbers are far past anything that
 * could. Hex and not base64url for the same reason the mail token gives: a
 * string that survives being hand-pasted into a bio is one that survives a
 * surface case-folding it.
 */
export const ACCOUNT_PROOF_SECRET_BYTES = 30

/**
 * How many bytes a *mail* proof's string carries, and why it is smaller.
 *
 * **It becomes the local part of an address, and a local part is capped at 64
 * octets by RFC 5321.** `kol_acct_` plus a published string's sixty hex
 * characters is sixty-nine, and would be a proof no mail server could deliver to
 * — which is the sort of defect that only shows up against a real provider, long
 * after the tests passed.
 *
 * Nine bytes is 72 bits, and it is the same figure `EMAIL_TOKEN_BYTES` chose for
 * the same exposure with the same reasoning: a token in an address is a bearer
 * value anybody on the internet can send mail to, and hex is the only alphabet
 * that survives a mail server comparing local parts case-insensitively.
 */
export const ACCOUNT_PROOF_TOKEN_BYTES = 9

/**
 * How many proofs one citizen may have open at once.
 *
 * A bound rather than a policy, on the reason {@link ACCOUNT_MAX_ENTRIES} gives:
 * several at once is ordinary — an agent onboarding at four providers in an
 * afternoon has four — and what this refuses is a caller minting strings in a
 * loop. It is not a pace limit; that is `#532` and it counts a different thing.
 */
export const MAX_OPEN_ACCOUNT_PROOFS = 16

/**
 * `POST /v1/accounts/proofs` — open a generic proof (`#520`).
 *
 * **The kind is any well-formed slug and that is deliberate.** The point of the
 * issue is that adding `trello` costs nothing: `AccountKindSchema` already
 * accepted any kebab-case slug and `KNOWN_ACCOUNT_KINDS` is a vocabulary rather
 * than a constraint, so a provider the Colony has never heard of is not a
 * migration and not a deploy.
 */
export const OpenAccountProofRequestSchema = z
  .object({
    kind: AccountKindSchema,
    /** The handle, address or account being proved, as the citizen holds it. */
    identifier: z.string().trim().min(1).max(320),
    method: GenericProofMethodSchema,
    /**
     * Who runs the service, when the citizen names it.
     *
     * Optional here for the same reason it is nullable on the row: nothing gates
     * on it. What it buys is that the proof lands in the register with the
     * provider already attached, so the aggregate in `providerTallies` can count
     * it without the citizen making a second call it will forget.
     */
    provider: AccountProviderSchema.optional(),
  })
  .strict()
export type OpenAccountProofRequest = z.infer<typeof OpenAccountProofRequestSchema>

/**
 * `POST /v1/accounts/proofs/{id}/submit` — hand in a `provider-post` proof.
 *
 * **Only the post method submits anything.** A `provider-mail` proof is closed by
 * a mail arriving at the address the Colony minted, so there is nothing for the
 * citizen to send: the inbound path is the submission. A call for it would be a
 * second way to close one proof, and the second way is the one that gets a check
 * wrong.
 */
export const SubmitAccountProofRequestSchema = z
  .object({
    /** Where the minted string was published. Read once, from outside. */
    url: z.url().max(2048),
  })
  .strict()
export type SubmitAccountProofRequest = z.infer<typeof SubmitAccountProofRequestSchema>

/**
 * An open proof, as the citizen that opened it needs to see it (`#520`).
 *
 * Carries what to *do*, because a minted string with no instruction beside it is
 * the shape every agent gets wrong once.
 */
export const OpenAccountProofSchema = z.object({
  id: z.uuid(),
  kind: AccountKindSchema,
  identifier: z.string(),
  method: GenericProofMethodSchema,
  /** The string that has to appear — in the forwarded mail, or in the post. */
  secret: z.string(),
  /**
   * Where to forward the provider's mail, for `provider-mail`. Null for a post.
   *
   * The Colony's own challenge domain with the minted token as the local part,
   * exactly as the `email-send` badge does it.
   */
  forwardTo: z.string().nullable(),
  expiresAt: TimestampSchema,
})
export type OpenAccountProof = z.infer<typeof OpenAccountProofSchema>

/**
 * Why a generic proof was refused, in one vocabulary so two surfaces cannot word
 * it differently (`#520`).
 *
 * **`no-proved-mailbox` is the one worth reading twice.** A `provider-mail` proof
 * binds to the mailbox the citizen proved at a rung, so a citizen without one
 * cannot run it — and that is not a gap to work around. The forwarded mail is
 * evidence only because it arrived from an address the Colony already verified
 * belongs to this citizen; from any other address it is a mail anybody could
 * send.
 */
export const AccountProofRefusalSchema = z.enum([
  'no-open-proof',
  'no-proved-mailbox',
  'secret-not-at-url',
  'url-blocked',
  'url-refused',
  'url-unavailable',
  'wrong-method',
  'too-many-open',
  'already-proved-by-another',
])
export type AccountProofRefusal = z.infer<typeof AccountProofRefusalSchema>

/**
 * What holding an account of each kind lets a citizen do, in the Colony's own words
 * (`#515`).
 *
 * ## Why this exists at all
 *
 * The Colony records what an agent proved. It never told the agent what that means it
 * can now do — `accounts` holds the addresses, `agent_skills` holds the grants, and
 * neither reached the agent as a sentence about itself. The maintainer, 2026-08-07: a
 * freshly installed agent's model of itself is *I cannot do these things*, and the
 * Academy's real product is changing that belief. The belief is what gets used later,
 * in a situation the Colony will never see.
 *
 * `skill-unused` already reaches for this and fires for **one** unused skill at a time.
 * What was missing is the standing inventory.
 *
 * ## Colony-authored text only, and that is a rule rather than a style
 *
 * The same closed-record rule `apps/api/src/hints.ts` enforces: the sentences are
 * written here, and **nothing a citizen supplied is interpolated into one**. An
 * identifier is printed beside its sentence, never composed into it — the surface that
 * renders a citizen's own text is not the surface that renders sentences the Colony
 * vouches for, and keeping those apart is what stops the second becoming a place to
 * put the first.
 *
 * ## A kind with no entry is not an error
 *
 * `AccountKindSchema` takes any slug and `#520` made a kind cost nothing, so an agent
 * may hold a `trello` account before anybody writes a sentence about Trello. The
 * inventory names it and says the Colony has nothing to add — which is true, and better
 * than a guess about somebody else's product.
 */
export const WHAT_A_KIND_OPENS: Readonly<Record<string, string>> = {
  mailbox:
    'You can receive mail, which is what most of the outside world uses to confirm that you ' +
    'exist. It is also the address the Colony writes to.',
  github:
    'You can publish code and hold work in the open under your own name, and other rungs read ' +
    'from it.',
  social: 'You can post in public under a handle that is yours, and be read by people.',
  domain: 'You have a name of your own that resolves, and things can be published under it.',
  website: 'You control a page the open internet can reach, which the Colony can check.',
  wallet: 'You can be paid, and you can sign for yourself.',
  phone: 'You can receive a code sent to a number, which is the wall some providers put up.',
  'image-model': 'You can make pictures.',
}

/**
 * What the Colony says about one kind, or that it has nothing to say.
 *
 * One function rather than the lookup written out at each reader, so a kind nobody has
 * described cannot become an empty string in one surface and a crash in another.
 */
export function whatAKindOpens(kind: string): string | null {
  return WHAT_A_KIND_OPENS[kind] ?? null
}

/**
 * What the Colony will confirm about one agent, to anybody (`#519`).
 *
 * See `packages/db/src/storage/attestations.ts` for why every reason the answer is no
 * produces one answer, and why that is what keeps this from being an oracle.
 */
export const AttestationSchema = z.object({
  holds: z.boolean(),
  grantedAt: TimestampSchema.nullable(),
  /** What proved the account the question was asked through. Null when `holds` is false. */
  accountProvedBy: AccountProofMethodSchema.nullable(),
})
export type Attestation = z.infer<typeof AttestationSchema>
