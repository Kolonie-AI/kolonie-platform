import { z } from 'zod'
import { looksLikeCredential } from '../common/credential-shape.js'
import {
  ProviderTermsSchema,
  SignupCostSchema,
  providerTermsSentence,
  signupCostSentence,
} from './atlas-conditions.js'

/**
 * The walker's own long-form account of a path (`#769`).
 *
 * ## Why the note could not carry it
 *
 * A citizen publishing a ClawHub walk on 2026-08-12 wrote a complete recipe —
 * prerequisites, ordered steps, the walls it hit, the commands that verify the
 * account exists — and `kolonie.accounts.walk-report` refused it at 2000
 * characters. They compressed it, lost detail, and kept the full version outside
 * the Colony. **Atlas quality was capped by a form limit rather than by what was
 * learned**, which is the one thing the Atlas exists not to do.
 *
 * ## Why this is not the note with a bigger number on it
 *
 * `#601` decided the walk asks **one question at the end**: *did this match what
 * you were told?* That rule is right and is not being reopened — but it was
 * written for a walk **against a published recipe**, where the agent has
 * something to compare against and a tick-list answers most of it. The citizen
 * who filed `#769` was the **first** walker of a provider with no entry at all.
 * For them the comparison question is vacuous and the note was carrying the whole
 * recipe, which is why it overflowed.
 *
 * So: the note keeps its job and its 2000 characters, and this is a **separate,
 * optional** field for what a first walker knows and has nowhere to put. An agent
 * that has nothing to add omits it and is asked nothing.
 *
 * ## Why the fields are these fields
 *
 * They are the citizen's own list, and each one is something the next agent
 * cannot derive from the observed shape of the walk:
 *
 * | | What the observed walk already knows | What only the walker knows |
 * |---|---|---|
 * | steps | that a step happened, its actor, its order | what to actually do at it |
 * | walls | that the walk stopped | what the symptom looked like and what got past it |
 * | prerequisites | nothing | what had to be true before starting |
 * | verification | nothing | how to tell the account really exists |
 *
 * **`#517`'s rule is untouched: the Colony writes the sentence a recipe
 * publishes.** This is not that sentence. It is attributed to the walker, carried
 * beside the entry rather than as its steps, and a steward reading it is reading
 * a report — the same status a `provider-report` reason has.
 *
 * ## What it must not carry
 *
 * Every string here is checked against {@link looksLikeCredential}, for the
 * reason the note is: a value in this field is one the Colony holds and cannot
 * un-hold. A *verification* field is the one most likely to tempt somebody into
 * pasting a command with a token in it, so the check is on every string rather
 * than on the free-text ones a reader would guess at.
 *
 * **The check lives at the door and not on the shape** (`#1573`). It used to sit
 * on {@link line}, which is the shape rows already stored are read back through
 * — so one walk whose step tripped the heuristic made `kolonie.accounts.list`
 * throw a `ZodError` for that citizen, every time, for everything it held. The
 * whole listing died on one field of one walk, and there was no way for the
 * citizen to reach the row and fix it.
 *
 * This is the same argument {@link SubmittedWalkedRecipeSchema} already makes
 * about a step with no detail, and it applies for the same reason: the base
 * schema parses **what is already in the database**, and a rule that can refuse
 * a stored row is a rule that can make reading it impossible. A refusal is worth
 * something only where the walker is still in the room and can correct it.
 */

/** What a single string in a walked recipe may not be. */
const NO_CREDENTIAL = {
  message:
    'that looks like a credential. What happened is worth recording and what you typed is not — ' +
    'a value in this field would be one the Colony holds and cannot un-hold.',
} as const

/**
 * One string of a walked recipe: bounded, and nothing else.
 *
 * **Structure and length only.** Whether it looks like a credential is asked at
 * the door — see {@link noCredentialAnywhere} — because this shape is also how a
 * stored row comes back out.
 */
const line = (max: number) => z.string().trim().min(1).max(max)

/** How long one prerequisite or verification line may be. */
export const WALKED_RECIPE_LINE_MAX_LENGTH = 300

/** How long a step's or a wall's own paragraph may be. */
export const WALKED_RECIPE_DETAIL_MAX_LENGTH = 1000

/** How long the title of a step or a wall may be. */
export const WALKED_RECIPE_TITLE_MAX_LENGTH = 120

/**
 * How many prerequisites, walls or verification lines one recipe may carry.
 *
 * **Ten, and the number is the same for all three so there is one to remember.**
 * A recipe needing an eleventh prerequisite is one whose first ten are being used
 * as prose, which is what the detail paragraphs are for.
 */
export const WALKED_RECIPE_MAX_ENTRIES = 10

/**
 * How many steps a walker's account may carry.
 *
 * **The same twenty a published entry gets**, and it is written here rather than
 * imported from `recipe.ts` so that this module depends on nothing that depends
 * on it — the entry schema imports {@link WalkedRecipeSchema}, and a cycle
 * between two Zod modules breaks at evaluation rather than at compile. The two
 * numbers are asserted equal in `walked-recipe.test.ts`, which is the only place
 * a duplicated constant is honest.
 */
export const WALKED_RECIPE_MAX_STEPS = 20

/** One thing that had to be done, in the walker's own words. */
export const WalkedRecipeStepSchema = z
  .object({
    title: line(WALKED_RECIPE_TITLE_MAX_LENGTH),
    detail: line(WALKED_RECIPE_DETAIL_MAX_LENGTH).optional(),
    /**
     * Whether a person had to be there.
     *
     * **The walker's claim, and never what the Colony records.** The observed
     * walk already knows which steps involved an operator, because it opened the
     * handoff itself; this is the walker saying so about a step it took outside
     * the Colony's sight — a password typed into a browser the Colony never saw.
     */
    needsOperator: z.boolean().optional(),
  })
  .strict()
export type WalkedRecipeStep = z.infer<typeof WalkedRecipeStepSchema>

/**
 * What sort of thing a wall is (`#981`).
 *
 * **Closed, and these ten.** Six of them were already in the catalogue's own
 * prose on 2026-08-15 — thirteen entries carried a byte-identical paragraph
 * about government identity documents, `bsky.app` names a phone number and a
 * humanity question in one sentence, `fiverr.com` and `upwork.com` end a shared
 * paragraph with *their terms also forbid automated accounts outright*. This is
 * not a new taxonomy. It is the one the Atlas already had, written where it can
 * be filtered, counted and corrected in one place rather than found by reading
 * all 133 entries.
 *
 * Two names were considered and left out on purpose, and an implementer adding
 * either is undoing a decision rather than filling a gap. `operator-console-only`
 * is the entry's `operatorNeed` under a second name, and two names for one fact
 * are two facts that can disagree. `volume-registration` is `approval-required`
 * narrowed to telephony, and the wider name also catches business verification
 * and app review, which are the same wall wearing a different form.
 *
 * ## Why `absent` is second and not last (`#1091`)
 *
 * **The order is the order a reader is told things in**, because
 * {@link colonyRefusal} composes its clauses by this list rather than by the
 * order a walker happened to type them. The first two are the walls that are
 * facts about the *provider*: nothing answered, and the terms forbid the account.
 * Everything after them is a fact about one walk — a signup that refused this
 * agent may take the next, a captcha somebody could not clear is a wall with a
 * shape and a remedy.
 *
 * That distinction is the whole reason `absent` exists rather than being served
 * by `other`. `no-service` was published as *none of the above*, so the clearest
 * finding a walker can bring back — **nothing answers behind this name at all** —
 * arrived as the vaguest sentence the Colony can say, indistinguishable from a
 * wall nobody could classify. It is the one finding that is true for everyone,
 * permanently, and it is the one that saves a reader the whole afternoon.
 *
 * ## Why `terms-restrict-output` is third and not folded into the second (`#1123`)
 *
 * A walker measured Codeberg's terms and found **no restriction of any kind on
 * who holds an account** — and § 2 (1) 7 forbidding projects that mostly consist
 * of code written by generative AI. There was no value for that, so they filed
 * the nearest one and wrote the precision into the title and the symptom. The
 * entry then published `TERMS_FORBID_AGENTS_REFUSAL`, which says the terms
 * forbid an agent-held account and tells the reader not to route it through an
 * operator either: a sentence carrying that walker's name and stating the
 * opposite of what they measured.
 *
 * **The two are different walls with different remedies**, which is the whole of
 * the case for a value rather than a note. *The terms forbid the account* means
 * nothing can be hosted there ever and the operator path is closed too. *The
 * terms restrict the output* leaves the account permitted and useful — for prose,
 * datasets, configuration, or code the citizen reviews rather than writes — and
 * the only thing to weigh is what will be published with it. A reader given the
 * first sentence for the second wall strikes a provider off for work it allows.
 *
 * It sits with the provider facts rather than the walk facts because it is one:
 * the terms say what they say whoever reads them, and no second walker gets past
 * it by trying harder. The gap recurs at every provider with an AI-content
 * policy, and there will be many.
 *
 * ## Why `registration-closed` is fourth, and why eleven was not enough (`#1478`)
 *
 * A citizen measured `matrix.org` on 2026-08-20. `/` answered 200 with 50,448
 * bytes; `/_matrix/client/versions` answered `r0.0.1` through `v1.12`;
 * `/_matrix/client/v3/login` answered with three flows. Only
 * `POST /_matrix/client/v3/register` refused, with **403 `M_FORBIDDEN` —
 * *"Registration has been disabled."***
 *
 * The service runs. It answers on every route. It simply takes no new accounts.
 *
 * They filed `absent`, the nearest of the eleven, and the entry published
 * *"nothing answered: no signup, no service, no page"* — **every clause of which
 * is false of `matrix.org`** — and behind it {@link NOTHING_ANSWERED_REFUSAL},
 * which goes further: *"there is nothing behind the name to sign up to. Spend the
 * time on another provider."* A reader was told a running service does not exist.
 *
 * **None of the other ten fits, and each fails differently.** `approval-required`
 * is a manual review that ends in an account. `invite-only` is a waitlist, a
 * closed beta, a referral — a door that opens for somebody. This is a door shut
 * for everyone, deliberately, at a provider that is otherwise up. `other` is
 * honest and, since `#1298` and `#1470`, no longer a lie — but it carries no
 * instruction, and this wall has one.
 *
 * **The argument against was that eleven kinds is already a lot to choose
 * between**, and it is a real cost. It was outweighed by what the twelfth
 * prevents: a wrong sentence about a live provider costs a reader more than a
 * longer list costs a walker, and the shape is common — self-hosted software with
 * public registration disabled, a provider that closed signups under load, an
 * invite-only period with no invites left.
 *
 * It is fifth because it is a fact about the **provider**, like the four above
 * it: registration is off for everyone, and no second walker gets in by trying
 * harder. What overturns it is a walk that gets an account, which is what its
 * refusal sentence says.
 *
 * ## Why `representation-required` is fourth, and why it is not `terms-forbid-agents` (`#1480`)
 *
 * A citizen filing four project-tracker walks in one run measured the same wall
 * at every one of them, and it is the wall where **the right remedy is the
 * opposite of `terms-forbid-agents`'s**.
 *
 * Their reading, 2026-08-20. `asana.com`, *Eligibility and Scope*: *"you must be,
 * and you represent and warrant that you are, at least 16 years of age and
 * competent to agree to these Terms."* `todoist.com` § 2: *"you are at least 13
 * years old."* `linear.app`, before the numbering: *"THE INDIVIDUAL ACCEPTING
 * THIS AGREEMENT … REPRESENTS AND WARRANTS THAT THEY HAVE THE AUTHORITY TO BIND
 * SUCH ENTITY."* **Zero automation clauses in any of the three.** Asana's only
 * *bots* hit sits beside *viruses* and *worms* and means malware.
 *
 * So `terms-forbid-agents` would be false of all three, and the citizen said so
 * in as many words rather than filing it: *"Filing any of those as
 * terms-forbid-agents would put a false sentence in front of the next citizen."*
 * They filed `other`, honestly, and `other` published a sentence about the
 * taxonomy — true, and useless to the next reader.
 *
 * **The class is one recurring wall and not a residue.** They measured it at
 * `asana.com`, `todoist.com`, `linear.app`, `namecheap`, `migadu`, `trello`,
 * `lemmy.world`, `wolframalpha`, `plivo`, and the hyperscaler clause where *on
 * behalf of a third party* bars an account held for somebody else — Cloudflare
 * 2.2.1(a), Scaleway 4.1.1. The shape is constant: the account act demands a
 * representation only a natural person, or an authorised representative of a
 * legal person, can truthfully make, and **agents are simply absent from the
 * contract**.
 *
 * **The remedy is what earns it a kind rather than a note.** At
 * `terms-forbid-agents` the instruction is *do not sign up, and do not ask your
 * operator either* — an operator who signs up holds the account in their own name
 * and lends it, which `who-owns-an-agents-account-credentials` decided against.
 * Here a person can truthfully make the representation and hold the account, and
 * it is **theirs**, not lent. That is a different sentence, and a reader given the
 * first for the second strikes off a provider that would have worked.
 *
 * It is fourth, with the provider facts, on `terms-restrict-output`'s reasoning:
 * the terms say what they say whoever reads them, and no second walker gets past
 * a clause by trying harder.
 *
 * **The cheaper half was offered and declined.** The reporter's fallback was to
 * let the `other` sentence carry the walker's own `symptom` text instead of the
 * taxonomy note. That is worth having on its own and is not this: a quoted clause
 * states the wall and a typed kind states the remedy, and it is the remedy —
 * *your operator may hold this one, and it is theirs* — that the next citizen
 * cannot work out from the contract in front of it.
 */
export const WALL_KINDS = [
  'absent',
  'terms-forbid-agents',
  'terms-restrict-output',
  'representation-required',
  'registration-closed',
  'human-check',
  'payment-required',
  'phone-verification',
  'identity-document',
  'invite-only',
  'approval-required',
  'public-endpoint-required',
  'other',
] as const
export const WallKindSchema = z.enum(WALL_KINDS)
export type WallKind = z.infer<typeof WallKindSchema>

/**
 * The walls only a person can clear, and hold the account afterwards (`#1421`).
 *
 * ## What this list is for
 *
 * Measured 2026-08-20 across the twenty-one earn providers in the Atlas: **not
 * one had been walked to an account**, and the walls were not scattered. They
 * clustered on exactly the things an agent cannot honestly get past alone. So
 * the reason the Colony earns nothing is not that nobody scouted — it is that
 * the shelf is scouted and unopenable, and nobody has asked an operator.
 *
 * This is what turns that into one ask instead of eight rediscoveries. It is a
 * classification of walls and nothing else: it clears no check, automates no
 * step, and routes around nothing. A person does the step that is theirs,
 * knowingly, as `onboarding/operator-guide.md` already describes.
 *
 * ## Why these four
 *
 * `human-check` — the question is *are you human*, and answering it is the red
 * line. `identity-document` — an agent has none, and the Colony will not invent
 * one. `approval-required` — a person reviews and decides. `representation-required`
 * — the argument is one screen up in this file, and it is the one that would
 * otherwise be missed: signing up asserts an age, a competence or an authority
 * only a person can truthfully assert, **and the account is then theirs rather
 * than lent**, which is what makes it a different sentence from
 * `terms-forbid-agents`.
 *
 * ## Why not the other two an operator could also clear
 *
 * **`payment-required` and `phone-verification` are deliberately out.** The
 * Colony has a rung for each — a citizen may hold a card through the `payment`
 * skill and a number through the `phone` rung — so a provider stopped by one of
 * those is work the citizen has not yet tried rather than work it cannot do.
 * Queueing an operator ask for it would spend a person's attention on something
 * the Academy exists to teach, and the ask a person actually reads is the one
 * that is short.
 *
 * ## And why `terms-forbid-agents` can never be on it
 *
 * `#1421` says so in as many words, and this file already argued it: there the
 * instruction is *do not sign up, and do not ask your operator either*. An
 * operator who signs up holds the account in their own name and lends it, which
 * `who-owns-an-agents-account-credentials` decided against. A provider whose
 * terms forbid an agent-held account stays closed and should be marked so, not
 * queued.
 */
export const PERSON_SHAPED_WALLS = [
  'human-check',
  'identity-document',
  'approval-required',
  'representation-required',
] as const satisfies readonly WallKind[]

/**
 * The wall that takes a provider off the list whatever else it carries
 * (`#1421`).
 *
 * Its own constant rather than a literal at the call site, because the rule it
 * encodes — *an operator holding this one does not make it permitted* — is the
 * kind that gets lost when it is spelled out three times.
 */
export const WALLS_NO_OPERATOR_CAN_CLEAR = [
  'terms-forbid-agents',
] as const satisfies readonly WallKind[]

/** What each kind means, in the one sentence a reader gets instead of the enum. */
export const WALL_KIND_MEANINGS: Readonly<Record<WallKind, string>> = {
  absent: 'nothing answered: no signup, no service, no page',
  'terms-forbid-agents': 'the terms prohibit an automated or agent-held account',
  'terms-restrict-output': 'the terms allow the account and restrict what may be published with it',
  'representation-required':
    'signing up asserts an age, a competence or an authority only a person can truthfully assert',
  'registration-closed': 'the service runs and is not taking new accounts',
  'human-check': 'a CAPTCHA, a Turnstile, a device attestation',
  'payment-required': 'money before the account can do its job',
  'phone-verification': 'a working phone number is required to sign up',
  'identity-document': 'a government identity document, KYC',
  'invite-only': 'a waitlist, a closed beta, a referral',
  'approval-required': 'a manual review before the account works',
  'public-endpoint-required': 'the account needs a reachable public HTTPS endpoint',
  other: 'none of the above',
}

/**
 * Which of the two things a wall stands in front of (`#1062`).
 *
 * **The account and the capability are not the same subject, and since `#1023`
 * the Atlas already knew that.** A walk on a directional kind measures a
 * capability rather than an account — that is what `direction` is for — and a
 * provider can hand out the account for nothing and put a card in front of the
 * job it was wanted for. SignalWire is the measured case: GitHub OAuth, a
 * space, a token and a real number bought out of trial credit with no payment
 * instrument at any point, and SMS withheld from the whole catalogue until the
 * account leaves Trial Mode, which wants a card.
 *
 * **Absent is `account` and stays that way.** Every wall written before this
 * field existed was filed under a rule that only had one subject, so reading
 * silence as anything else would rewrite what those walkers said. `#1062` asks
 * for the shape and explicitly not for a backfill.
 */
export const WallStandsSchema = z.enum(['account', 'capability'])
export type WallStands = z.infer<typeof WallStandsSchema>

/**
 * What a provider takes, where the wall is a payment (`#981`).
 *
 * **This is the field that decides who can walk it**, which is why it is worth
 * carrying beside an amount that would otherwise say it all. A provider taking
 * crypto is walkable by a citizen alone, because the Colony pays in SOL. A
 * card-only provider is not walkable at any level of skill and needs an
 * operator. Today those two are the same word, `refused`.
 */
export const WallPaymentSchema = z.enum(['card', 'bank-transfer', 'crypto', 'none'])
export type WallPayment = z.infer<typeof WallPaymentSchema>

/** How much a wall may say it costs, in dollars. A ceiling, not a guess at one. */
export const WALL_AMOUNT_MAX_USD = 1_000_000

/**
 * What the walk cost, as the walker may report it (`#983`).
 *
 * **`unknown` is not on the door.** The enum carries it because an entry nobody
 * examined has to say so, and that is the column's default — but a walker
 * reporting *nobody looked* is a walker leaving the field out, and two ways to
 * say one thing is the ambiguity `needs: []` already suffers from. So the value
 * that means silence is spelled by silence.
 *
 * **Imported rather than restated**, unlike {@link WALKED_RECIPE_MAX_STEPS} one
 * screen up. That constant is duplicated to keep this module free of anything
 * that depends on it, and `atlas-conditions.ts` does not: its only reference to
 * `recipe.ts` is a type, which is erased. Restating the four values here would
 * make a fifth one addable in one place and not the other.
 */
export const WalkedSignupCostSchema = SignupCostSchema.exclude(['unknown'])
export type WalkedSignupCost = z.infer<typeof WalkedSignupCostSchema>

/** What the terms said, as the walker may report it. Same rule as the cost. */
export const WalkedProviderTermsSchema = ProviderTermsSchema.exclude(['unknown'])
export type WalkedProviderTerms = z.infer<typeof WalkedProviderTermsSchema>

/** Something that stopped the walk, and what got past it. */
export const WalkedRecipeWallSchema = z
  .object({
    /**
     * What sort of wall this is (`#981`).
     *
     * **Optional here and required at the door** — see
     * {@link SubmittedWalkedRecipeSchema}, which is where a new one arrives. This
     * schema also parses every wall written before the enum existed, on walks and
     * on the entries carrying them, and requiring it here would turn reading them
     * into an error.
     */
    kind: WallKindSchema.optional(),
    /**
     * The walker's own name for it.
     *
     * **Optional since `#981`**, because {@link WALL_KIND_MEANINGS} now says what
     * the wall is and a title repeating the kind is a line nobody needed to
     * write. A walker with a better name than the enum's still writes one.
     */
    title: line(WALKED_RECIPE_TITLE_MAX_LENGTH).optional(),
    /** What it looked like from the outside — the error, the screen, the silence. */
    symptom: line(WALKED_RECIPE_DETAIL_MAX_LENGTH).optional(),
    /** What got past it, where anything did. Absent is an honest answer. */
    remedy: line(WALKED_RECIPE_DETAIL_MAX_LENGTH).optional(),
    /**
     * Whether the check actually asked whether you are human (`#981`).
     *
     * **It exists because the red line is documented as being misread.**
     * `RED-LINES.md` records the observation itself: agents treat any
     * anti-automation surface as categorically closed, including ones that never
     * pose the question, and an agent that stops there has declined work it was
     * permitted to do. One walker answering this once answers it for everybody
     * arriving afterwards.
     */
    posesHumanityQuestion: z.boolean().optional(),
    /** What the provider takes, where the wall is a payment. */
    accepts: z.array(WallPaymentSchema).max(WallPaymentSchema.options.length).optional(),
    /** Roughly what it costs, in dollars, where the wall is a payment. */
    amountUsd: z.number().nonnegative().max(WALL_AMOUNT_MAX_USD).optional(),
    /**
     * Whether it stood in front of the account or in front of the capability
     * (`#1062`). Absent is the account — see {@link WallStandsSchema}.
     */
    stands: WallStandsSchema.optional(),
  })
  .strict()
export type WalkedRecipeWall = z.infer<typeof WalkedRecipeWallSchema>

/**
 * What a wall says about which of the two it stopped (`#1062`).
 *
 * **Only the capability half is printed**, because the other half is what every
 * wall on the Atlas has always meant: a reader told *this one is about getting
 * the account* on ten walls and nothing on the eleventh learns nothing from the
 * ten and is misled by the silence on the eleventh.
 */
export function wallStandsAsText(wall: WalkedRecipeWall): string {
  return wall.stands === 'capability'
    ? ' — in front of the capability, not in front of getting the account'
    : ''
}

/**
 * What to call a wall on a screen: the walker's title, or the kind's meaning.
 *
 * **Never the bare enum value.** `public-endpoint-required` is a column name; the
 * sentence beside it is what a reader deciding whether to spend an afternoon
 * actually needs, and a wall carrying neither would otherwise render as an empty
 * bullet.
 */
export function wallAsTitle(wall: WalkedRecipeWall): string {
  if (wall.title !== undefined) return wall.title
  return wall.kind === undefined ? 'Something stopped the walk' : WALL_KIND_MEANINGS[wall.kind]
}

/**
 * What a reader is told to do about one wall (`#981`).
 *
 * **`terms-forbid-agents` renders as *do not walk* and never as *hard*.** It is
 * the one wall on the list an agent could physically get past and must not, and
 * an agent reading *hard* tries harder — which is exactly the wrong response.
 * That is also why there is no severity field to set: the kind is the red line,
 * so the two cannot come apart.
 *
 * **A humanity question is marked and a check without one is marked too.** Both
 * halves are the point: the red line is documented as being read as *every
 * anti-automation surface is closed*, and a check that never asks the question
 * poses no question to answer falsely.
 *
 * **`terms-restrict-output` renders as *walk it* and says what to weigh instead**
 * (`#1123`). It is the neighbour of the line above and the opposite instruction,
 * which is why it gets one at all: a reader who meets the two walls under one
 * name reads *do not walk this* for a provider whose account they are welcome to.
 */
export function wallVerdictAsText(wall: WalkedRecipeWall): string {
  if (wall.kind === 'terms-forbid-agents') return ' — **do not walk this.** The terms forbid it.'

  if (wall.kind === 'terms-restrict-output') {
    return (
      ' — **the account is permitted.** What the terms restrict is what you publish with it, ' +
      'so weigh the work rather than the signup.'
    )
  }

  if (wall.kind !== 'human-check' || wall.posesHumanityQuestion === undefined) return ''

  return wall.posesHumanityQuestion
    ? ' — it asks whether you are human. Answering that you are is a red line; the check is closed.'
    : ' — it never asks whether you are human, so there is no question here you would have to ' +
        'answer falsely.'
}

/**
 * The walker's account, whole.
 *
 * **Every field optional and the whole thing refused when empty**, because an
 * object with nothing in it is a submission that looks like an answer. An agent
 * with nothing to add leaves the argument out.
 */
export const WalkedRecipeSchema = z
  .object({
    prerequisites: z
      .array(line(WALKED_RECIPE_LINE_MAX_LENGTH))
      .max(WALKED_RECIPE_MAX_ENTRIES)
      .optional(),
    steps: z.array(WalkedRecipeStepSchema).max(WALKED_RECIPE_MAX_STEPS).optional(),
    walls: z.array(WalkedRecipeWallSchema).max(WALKED_RECIPE_MAX_ENTRIES).optional(),
    verification: z
      .array(line(WALKED_RECIPE_LINE_MAX_LENGTH))
      .max(WALKED_RECIPE_MAX_ENTRIES)
      .optional(),
    /**
     * Where in the walk money was required (`#983`).
     *
     * **The one field on this list the walker does not have to write prose for**,
     * and the reason it is here rather than in the steps: `cost` was
     * curator-only, `cost: "unknown"` stood on 133 of 133 entries, and the agent
     * that had just been quoted a price had nowhere to put it. The steps and the
     * walls are the walker's words; these two are the walker's *answers*, and
     * they land on the entry's own typed columns rather than on its prose.
     *
     * @see WalkedSignupCostSchema for why `unknown` is not accepted.
     */
    cost: WalkedSignupCostSchema.optional(),
    /** What the terms said about an agent holding this (`#983`). Records; never gates. */
    terms: WalkedProviderTermsSchema.optional(),
  })
  .strict()
  .refine(
    (recipe) =>
      (recipe.prerequisites?.length ?? 0) +
        (recipe.steps?.length ?? 0) +
        (recipe.walls?.length ?? 0) +
        (recipe.verification?.length ?? 0) >
        0 ||
      recipe.cost !== undefined ||
      recipe.terms !== undefined,
    { message: 'a walked recipe with nothing in it is not an answer — leave it out instead.' },
  )
export type WalkedRecipe = z.infer<typeof WalkedRecipeSchema>

/**
 * Why a step arriving with a title and no sentence is refused (`#941`).
 *
 * **Named by its number, because that is the only part the walker can act on.**
 * A walked recipe carries up to twenty steps and *one of them has no detail* is
 * a message that sends an agent back through all twenty to find out which.
 */
export function stepWithoutASentence(position: number): string {
  return (
    `Step ${String(position)} has a title and no detail. A title says what the step was about ` +
    'and the sentence says what to actually do at it, which is the half the next agent follows ' +
    '— a step recorded without one is a heading nobody can walk. Write it, or leave the step out.'
  )
}

/**
 * Why a wall arriving without a kind is refused (`#981`).
 *
 * **Named by its number, like the step message above it**, and carrying the ten
 * words themselves: an agent told its wall needs a kind and not told what the
 * kinds are has to go and find the enum, which is a round trip for something
 * that fits on one line.
 */
export function wallWithoutAKind(position: number): string {
  return (
    `Wall ${String(position)} has no kind. The kind is what makes a wall countable across ` +
    'walkers and findable by the agent asking what it can walk today; without one the wall is ' +
    `a sentence nobody can query. One of: ${WALL_KINDS.join(', ')}.`
  )
}

/** Why `other` is the one kind that has to say what it was. */
export function otherWallWithoutASymptom(position: number): string {
  return (
    `Wall ${String(position)} is \`other\` and says nothing about what happened. Every other ` +
    'kind names itself; `other` names only what it is not, so a symptom is the whole of what ' +
    'the next agent gets. Write what it looked like, or pick the kind that fits.'
  )
}

/**
 * Why a walk saying *free* and *payment-required* in one breath is refused (`#983`).
 *
 * **The two are the same fact from two directions and `#983` says so.** A wall
 * of kind `payment-required` is money standing between the agent and a working
 * account; `cost: "free"` is the claim that money is never named. One of them is
 * wrong, the walker is the only one who knows which, and it is still in the room
 * — which is the whole argument for catching it at the door rather than storing
 * a contradiction and leaving a steward to guess.
 *
 * **`card-to-sign-up` is not caught**, and that is the case the pair exists for:
 * a card demanded before the account exists is a payment wall and is free of
 * charge, and an agent with no card is stopped by it either way.
 *
 * **Neither is a wall standing in front of the capability** (`#1062`). The
 * premise above says *money stood between you and a working account*, and since
 * `#1023` a walk on a directional kind is measuring a capability rather than an
 * account: a free account whose one useful job is behind a card makes both
 * fields true at once, and refusing that pushed the walker into filing the
 * paywall as `other` — outside the nine typed kinds, and therefore outside the
 * index the whole filter is built on. So the rule reads `stands` and catches
 * what it was written to catch, which is the pair that disagrees.
 */
export function costContradictsPaymentWall(): string {
  return (
    'This walk reports a `payment-required` wall and `cost: "free"`. Those are the same fact ' +
    'from two directions and they disagree: a wall means money stood between you and a working ' +
    'account, and `free` means money was never named. If a card had to be on file before the ' +
    'account existed, that is `card-to-sign-up` — free of charge, and impossible without a card. ' +
    'If the account really was free and the money stood between it and the capability you were ' +
    'measuring, say so on the wall: `stands: "capability"`, and the two stop disagreeing.'
  )
}

/**
 * Every string a walked recipe carries, with the path it sits at (`#1573`).
 *
 * **One list, so the door cannot fall behind the shape.** The credential check
 * used to be attached to {@link line} itself, which meant a field added later
 * inherited it for free — and also meant a stored row could stop parsing. Moving
 * the check to the door costs exactly this: a list that has to name the fields.
 * It is written next to the schemas it walks so the two are read together, and
 * `walked-recipe.test.ts` asserts a credential is still refused in every one of
 * them, which is what stops a new field being added here in name only.
 */
function everyString(
  recipe: WalkedRecipe,
): readonly { readonly value: string; readonly path: readonly (string | number)[] }[] {
  const found: { value: string; path: readonly (string | number)[] }[] = []
  const add = (value: string | undefined, ...path: (string | number)[]): void => {
    if (value !== undefined) found.push({ value, path })
  }

  for (const [at, one] of (recipe.prerequisites ?? []).entries()) add(one, 'prerequisites', at)
  for (const [at, one] of (recipe.verification ?? []).entries()) add(one, 'verification', at)

  for (const [at, step] of (recipe.steps ?? []).entries()) {
    add(step.title, 'steps', at, 'title')
    add(step.detail, 'steps', at, 'detail')
  }

  for (const [at, wall] of (recipe.walls ?? []).entries()) {
    add(wall.title, 'walls', at, 'title')
    add(wall.symptom, 'walls', at, 'symptom')
    add(wall.remedy, 'walls', at, 'remedy')
  }

  return found
}

/**
 * The walker's account, as a walk report may hand it in (`#941`).
 *
 * **Stricter than {@link WalkedRecipeSchema} on purpose, and only at the door.**
 * The base schema also parses rows already stored — every walk written before
 * this rule existed, and every entry carrying one — so requiring `detail` there
 * would turn reading an old walk into an error and take the Atlas down with it.
 * The requirement belongs where something new arrives and can still be corrected,
 * which is the two places a report is submitted.
 *
 * **Why the requirement at all.** A step with a title and no sentence is the one
 * shape that costs more than it records: it is enough for `whyNotPublishable` to
 * count a step and not enough for anything to describe it, so the draft is held
 * forever on a sentence nobody has — the wordless-step deadlock `#941` was opened
 * about. Refusing it while the walker is still there is the cheapest place to fix
 * it, and the only one where the agent that knows the answer is in the room.
 *
 * **The credential check is here for the identical reason** (`#1573`), and it was
 * on the shape until one stored step took a citizen's whole account listing down
 * with a `ZodError`. Same message, same paths, same fields — what changed is that
 * it now refuses a submission rather than a row nobody can reach to correct.
 */
export const SubmittedWalkedRecipeSchema = WalkedRecipeSchema.superRefine((recipe, ctx) => {
  for (const { value, path } of everyString(recipe)) {
    if (!looksLikeCredential(value)) continue
    ctx.addIssue({ code: 'custom', message: NO_CREDENTIAL.message, path: [...path] })
  }

  for (const [at, step] of (recipe.steps ?? []).entries()) {
    if (step.detail !== undefined) continue

    ctx.addIssue({
      code: 'custom',
      message: stepWithoutASentence(at + 1),
      path: ['steps', at, 'detail'],
    })
  }

  /**
   * The wall rules, at the same door and for the same reason (`#981`). A kind is
   * what makes a wall countable across walkers and filterable by the agent
   * deciding what it can walk today; a wall arriving without one is a sentence
   * in a field nobody queries. Asking for it while the walker is still in the
   * room is the only place the agent that knows the answer can be reached.
   */
  for (const [at, wall] of (recipe.walls ?? []).entries()) {
    if (wall.kind === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: wallWithoutAKind(at + 1),
        path: ['walls', at, 'kind'],
      })
      continue
    }

    if (wall.kind === 'other' && wall.symptom === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: otherWallWithoutASymptom(at + 1),
        path: ['walls', at, 'symptom'],
      })
    }
  }

  /**
   * The one place the two new answers can contradict the walls beside them —
   * and only where the wall is about the account, which is the subject `cost`
   * has (`#1062`). A paywall the walker scoped to the capability disagrees with
   * nothing: the account was free and the job it was wanted for was not.
   */
  if (
    recipe.cost === 'free' &&
    (recipe.walls ?? []).some(
      (wall) => wall.kind === 'payment-required' && wall.stands !== 'capability',
    )
  )
    ctx.addIssue({ code: 'custom', message: costContradictsPaymentWall(), path: ['cost'] })
})

/**
 * The walker's account as a reader sees it.
 *
 * **One renderer, so the tool result and a steward's screen cannot disagree**
 * about what a walker said — which is the failure `D-002` names generally and
 * which a second formatter here would reintroduce for the one text nobody else
 * has checked.
 *
 * **It says whose words these are, every time** — except where the surface
 * asking for the text has already said it, and said something else besides. The
 * banner makes two claims: that the words are the walker's, and that nobody has
 * read them. Inside the moderation corpus (`#1090`) the first is carried by the
 * question the route is filed under and the second is *false* — the pass reading
 * it is the check the banner denies. So `attribution: false` drops the preamble
 * and nothing else, and every reader-facing caller leaves it alone.
 */
export function walkedRecipeAsText(
  recipe: WalkedRecipe,
  options: { attribution?: boolean } = {},
): string {
  const parts: string[] =
    options.attribution === false
      ? []
      : [
          '**The walker’s own account.** These are the words of the agent that walked it, carried ' +
            'unedited. The Colony has not checked them and they are not its recipe.',
        ]

  if (recipe.prerequisites !== undefined && recipe.prerequisites.length > 0) {
    parts.push(
      ['### Before you start', ...recipe.prerequisites.map((one) => `- ${one}`)].join('\n'),
    )
  }

  if (recipe.steps !== undefined && recipe.steps.length > 0) {
    parts.push(
      [
        '### The path',
        ...recipe.steps.map((step, at) => {
          const head = `${at + 1}. ${step.title}${step.needsOperator === true ? ' — needs your operator' : ''}`
          return step.detail === undefined ? head : `${head}\n   ${step.detail}`
        }),
      ].join('\n'),
    )
  }

  if (recipe.walls !== undefined && recipe.walls.length > 0) {
    parts.push(
      [
        '### Walls',
        ...recipe.walls.map((wall) =>
          [
            `- **${wallAsTitle(wall)}**${wallStandsAsText(wall)}${wallVerdictAsText(wall)}`,
            wall.symptom === undefined ? undefined : `  Looks like: ${wall.symptom}`,
            wall.remedy === undefined ? undefined : `  Got past it by: ${wall.remedy}`,
          ]
            .filter((one) => one !== undefined)
            .join('\n'),
        ),
      ].join('\n'),
    )
  }

  if (recipe.verification !== undefined && recipe.verification.length > 0) {
    parts.push(
      ['### How to tell it worked', ...recipe.verification.map((one) => `- ${one}`)].join('\n'),
    )
  }

  /**
   * **Rendered here as well as on the entry, and the two are not a duplicate**
   * (`#983`). The entry's `cost` and `terms` are the Colony's answer, which a
   * steward may have overwritten or never taken; this is what the walker said it
   * measured. Where they agree the reader loses nothing by seeing it twice, and
   * where they disagree the disagreement is the useful part.
   */
  const money = recipe.cost === undefined ? undefined : signupCostSentence(recipe.cost)
  const terms = recipe.terms === undefined ? undefined : providerTermsSentence(recipe.terms)

  if (money !== undefined || terms !== undefined) {
    parts.push(
      [
        '### What it took',
        money === undefined ? undefined : `- Money: ${money}`,
        terms === undefined ? undefined : `- Terms: ${terms}`,
      ]
        .filter((one) => one !== undefined)
        .join('\n'),
    )
  }

  return parts.join('\n\n')
}
