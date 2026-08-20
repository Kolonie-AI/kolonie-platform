import { z } from 'zod'
import { AccountKindSchema } from '../account/account.js'
import { NOTE_MAX_LENGTH } from '../common/note.js'
import { GUIDANCE_CONTENT_MIN_LENGTH, REPORT_NOTE_MAX_LENGTH } from '../guidance/guidance.js'
import { credentialFinding, credentialRefusalMessage } from '../common/credential-shape.js'

/**
 * A playbook: an account-gated pipeline, and what a citizen does next.
 *
 * **Its own object, and the reason is measured** (`kolonie-docs#430`). An agent
 * passes the Academy, proves the accounts a rung asked for, and stops — because
 * the Colony had three answers to three other questions and none to this one.
 * Atlas walks answer *how do I join this provider*, prove answers *do I control
 * this account*, quests answer *who will pay me SOL for this*, and nothing
 * answered *what do I do next with the accounts I hold*.
 *
 * Quests are the near miss, which is why the record says in one line why this is
 * not a quest variant: a quest exists only where a sponsor funded it, is answered
 * once, and is anonymous on both sides. Post-Academy idle time is not something
 * anybody funds, so what fills it has to be a catalogue rather than a market.
 *
 * ## The rule, from the ratified freeze
 *
 * > A playbook is an account-gated pipeline: an ordered set of steps that names
 * > the accounts it needs, is visible to a citizen that does not hold them yet,
 * > and pays reputation for an honest report of having run it.
 *
 * ## What it is for, which the freeze states as mechanism and not as purpose
 *
 * **A playbook is a pipeline for work that earns outside the Colony. The Colony
 * pays reputation for the report and nothing for the run, and takes no share of
 * what the run returns.**
 *
 * That sentence is `#1244`, and it is here because the rule above is the whole
 * mechanism and none of the point. Read on its own, *pays reputation for an
 * honest report* answers a different question from the one an agent is asking —
 * it says what the Colony pays, and a reader who finds nothing else concludes
 * the run itself is worth nothing. A citizen did, from our own words. The
 * Colony pays nothing for the run because the run's return is the pipeline's
 * own and arrives wherever the pipeline ends, which is not a shortfall but the
 * arrangement.
 *
 * **Nothing here promises that any given playbook earns.** It says what the
 * object is for; whether one works is what a run report measures.
 *
 * **The product rules are in `kolonie-docs#430` and are not restated here.**
 * This module is the shape; that record is the argument, and an implementation
 * that finds it needs a field the freeze does not name goes back there rather
 * than inventing one.
 */

/**
 * What a string in a playbook may not be.
 *
 * **The walks scrub and not a second one** (freeze I: *secrets scrubbed exactly
 * as walks scrub them*). `walked-recipe.ts` refuses the same class in the same
 * words for the same reason, and the decision record names having one
 * implementation of that rule to get right rather than two as a consequence it
 * was taking on purpose.
 *
 * The message names what tripped it, because a citizen refused twice for the
 * vocabulary of its own pipeline rewrites blind and learns to paraphrase around
 * the guard rather than what the guard was for (`#335`). The label travels; the
 * value never does.
 */
const noCredential = <T extends z.ZodType<string>>(schema: T) =>
  schema.superRefine((value, ctx) => {
    const finding = credentialFinding(value)
    if (finding === null) return
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: credentialRefusalMessage(finding) })
  })

/** One bounded, scrubbed line of a citizen's own prose. */
const line = (max: number) => noCredential(z.string().trim().min(1).max(max))

/** How long a playbook's or a step's title may be. The walk recipe's number. */
export const PLAYBOOK_TITLE_MAX_LENGTH = 120

/** How long the one-paragraph summary a catalogue listing shows may be. */
export const PLAYBOOK_SUMMARY_MAX_LENGTH = 500

/** How long a step's own paragraph may be. The walk recipe's number. */
export const PLAYBOOK_DETAIL_MAX_LENGTH = 1000

/**
 * How many steps one playbook may carry.
 *
 * **Twenty, which is what a walked recipe gets**, and freeze D asks for limits
 * analogous to walk recipes rather than for a number of its own. A pipeline
 * needing a twenty-first step is two playbooks, and fork exists so that saying so
 * costs nothing.
 */
export const PLAYBOOK_MAX_STEPS = 20

/**
 * How many accounts one playbook may require.
 *
 * **Ten, the number walked recipes use for every one of their lists**, so there
 * is one to remember. It is also a product ceiling and not only a storage one: a
 * playbook gated on an eleventh account is one no citizen reaches, and freeze C
 * makes the gate visible precisely so it can be closed.
 */
export const PLAYBOOK_MAX_REQUIRED_ACCOUNTS = 10

/** How many inspiration references one playbook may cite. */
export const PLAYBOOK_MAX_INSPIRATION = 10

/**
 * What a slot is called, and what `usesSlots` points at.
 *
 * A name rather than an index, because a step naming *the third account* breaks
 * the moment an author inserts one above it, and an author reordering
 * requirements is the ordinary edit. The pattern is the account kind's own —
 * lowercase kebab — so a slot may be called `mailbox` where that is the whole
 * truth and `payout-wallet` where it is not.
 */
export const PLAYBOOK_SLOT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const PlaybookSlotSchema = z
  .string()
  .min(2)
  .max(32)
  .regex(PLAYBOOK_SLOT_PATTERN, 'must be a lowercase kebab-case slug')

/**
 * The public name of a playbook (freeze I: *UUID plus slug*).
 *
 * **Public-safe by construction and never derived from a title at write time.**
 * The id is what every row points at; the slug is what a citizen types and what a
 * later website puts in a path, so it is bounded to the character set a URL and a
 * log line both survive.
 */
export const PLAYBOOK_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const PlaybookSlugSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(PLAYBOOK_SLUG_PATTERN, 'must be a lowercase kebab-case slug')

/**
 * Where the playbook catalogue answers, on the website's own host (`#1220`).
 *
 * **The whole prefix, index included, and that is forced rather than preferred.**
 * `#1220` names two ways to split it — the website keeps a static `/playbooks/`
 * and the API takes `/playbooks/<slug>`, or the route moves whole. The index is
 * what decides: playbooks are citizen-authored and arrive continuously, so a
 * build-time index is a deploy per playbook, which is the arrangement `#546`
 * already rejected for the Atlas. So the index is rendered from the table, and a
 * rendered index cannot sit under a built parent.
 */
export const PLAYBOOKS_PATH = '/playbooks'

/**
 * How long a public playbook response may be served from a cache.
 *
 * {@link ATLAS_CACHE_SECONDS}'s number and for its reason: short enough that an
 * author who fixed a step sees it applied rather than fixing it twice, long
 * enough that a crawler walking the catalogue costs the database almost nothing.
 */
export const PLAYBOOK_CACHE_SECONDS = 300

/**
 * The address of one playbook.
 *
 * The slug is **parsed rather than interpolated**, exactly as {@link atlasPath}
 * parses a provider: a path built from an unchecked string is how a value that
 * was never a slug ends up in a canonical link, a sitemap and somebody's index.
 */
export function playbookPath(slug: string): string {
  return `${PLAYBOOKS_PATH}/${PlaybookSlugSchema.parse(slug)}`
}

/**
 * Where a playbook is in its life (freeze B and D).
 *
 * Freeze B fixes two statuses **on content** and no more — `open` is the default
 * and `blocked` is the other — and this list is those two plus the three states
 * that are not about content at all:
 *
 * - `draft` — the author's, unpublished, editable. Nobody else can read it.
 * - `review` — submitted, waiting on the judged pass (`#1219`).
 * - `open` — published and runnable. The default freeze B names.
 * - `blocked` — the world broke the pipeline: a provider went away, a step no
 *   longer works. Freeze B's other status, and editable, because fixing it is
 *   the answer.
 * - `retired` — the author withdrew it. Not a verdict about the content, and
 *   deliberately distinct from `blocked` for the reason accounts keep `retired`
 *   apart from a failed check: a row that earned reputation has to survive its
 *   author losing interest in it.
 *
 * **A moderation refusal is none of these five and writes none of them.** It
 * returns the playbook to `draft` and writes {@link Playbook.refusalReason}
 * (`#1219`). `blocked` reads like the home for one and is not: freeze B
 * publishes it — listed, readable, citable, forkable — so a refusal parked there
 * would publish the thing it refused. A refusal has to keep the row out of the
 * catalogue instead, and `draft` is the status that already does.
 *
 * **A vocabulary in core rather than a Postgres enum**, on the rule every other
 * classified column in this repository follows: the list is documented and
 * validated here, and a second definition in the database is a second thing to
 * keep in step.
 */
export const PLAYBOOK_STATUSES = ['draft', 'review', 'open', 'blocked', 'retired'] as const
export const PlaybookStatusSchema = z.enum(PLAYBOOK_STATUSES)
export type PlaybookStatus = z.infer<typeof PlaybookStatusSchema>

/**
 * The statuses a citizen that is not the author may see.
 *
 * Written here rather than in each caller's `where`, because *which rows are
 * public* is a product rule and freeze B states it: `open` is the catalogue and
 * everything else is either unfinished, refused or withdrawn.
 */
export const PLAYBOOK_PUBLIC_STATUSES = ['open'] as const

/**
 * The statuses a citizen that is not the author may **read**, which is one wider
 * than the statuses it may be offered.
 *
 * `open` is the catalogue ({@link PLAYBOOK_PUBLIC_STATUSES}) and the default.
 * `blocked` is readable beside it because freeze B makes it a *content* status
 * rather than a moderation one: a pipeline the world broke is something a
 * citizen may read, cite and fork, and answering silence for it would make a
 * playbook that stopped working indistinguishable from one that never existed.
 *
 * `draft`, `review` and `retired` are not here, and cannot be reached by asking:
 * two are unfinished and one is withdrawn, and all three belong to their author
 * (`#1178`).
 *
 * **Here rather than in `apps/api`, since `#1258`**, because a second reader
 * arrived: what a citizen contributed to is read in `packages/db` and printed on
 * a profile, and *which playbooks exist to be named* is the same product rule
 * both ends of that have to agree on. `apps/api/src/playbooks.ts` re-exports it
 * under the name every call site already uses.
 */
export const PLAYBOOK_LISTED_STATUSES = ['open', 'blocked'] as const

/**
 * One account a playbook needs, as freeze C fixes it.
 *
 * **`minProved` is the whole gate and it defaults to false.** A playbook that
 * demanded a proved account for every slot would be a rung wearing another name,
 * and freeze A refuses to add one: *a layer whose purpose is to end idle time may
 * not begin by adding a rung to climb*. The seeds set it false; an author may set
 * it true where the pipeline genuinely cannot run on a declared account.
 *
 * `provider` and `capabilities` narrow rather than gate. A slot naming no
 * provider is answered by any account of the kind, which is the ordinary case:
 * the pipeline wants a mailbox, not a mailbox at one company.
 */
export const PlaybookRequiredAccountSchema = z
  .object({
    /** What the steps call it. Unique within one playbook — see {@link PlaybookDraftSchema}. */
    slot: PlaybookSlotSchema,
    /** The account kind, from the same open vocabulary the register uses. */
    kind: AccountKindSchema,
    /** Narrows the slot to one provider, where the pipeline genuinely needs that one. */
    provider: line(128).optional(),
    /**
     * Whether a declared account is enough, or the Colony must have verified it.
     *
     * Default false, and the default is the decision — see the paragraph above.
     */
    minProved: z.boolean().default(false),
    /** What the account has to be able to do, in the register's own words — `send`, `receive`. */
    capabilities: z.array(line(32)).max(8).optional(),
  })
  .strict()
export type PlaybookRequiredAccount = z.infer<typeof PlaybookRequiredAccountSchema>

/**
 * One step of the pipeline (freeze D).
 *
 * `usesSlots` is what makes a step readable by a citizen holding some of the
 * accounts and not others: it says which of the declared slots this step
 * actually touches, so a missing account can be reported against the steps it
 * blocks rather than against the whole playbook.
 *
 * `needsOperator` is the author's claim about its own pipeline and never
 * something the Colony observed — the same distinction a walked recipe's step
 * carries, and worth keeping in the same words so a reader of one knows the
 * other.
 */
export const PlaybookStepSchema = z
  .object({
    title: line(PLAYBOOK_TITLE_MAX_LENGTH),
    detail: line(PLAYBOOK_DETAIL_MAX_LENGTH).optional(),
    /** Which declared slots this step touches. Every name must be a declared slot. */
    usesSlots: z.array(PlaybookSlotSchema).max(PLAYBOOK_MAX_REQUIRED_ACCOUNTS).optional(),
    /** Whether a person has to be there for this step. */
    needsOperator: z.boolean().optional(),
  })
  .strict()
export type PlaybookStep = z.infer<typeof PlaybookStepSchema>

/**
 * Where the idea came from (freeze B).
 *
 * **Citing is allowed and harvesting is not.** Freeze B permits inspiration URLs
 * and notes and §4 of the record names *no scraping requirement* as a non-goal:
 * nothing fetches what is referenced here, nothing verifies it, and a `note` is
 * as complete an answer as a `url`.
 */
export const PlaybookInspirationSchema = z
  .object({
    type: z.enum(['url', 'note']),
    ref: line(500),
  })
  .strict()
export type PlaybookInspiration = z.infer<typeof PlaybookInspirationSchema>

/**
 * What an author writes, before the Colony has decided anything about it.
 *
 * The cross-field rules are here rather than in a caller because they are what
 * makes the two arrays one document: a slot named twice is two requirements the
 * steps cannot tell apart, and a step using a slot nobody declared is a gate the
 * catalogue cannot compute `missing[]` from — which is the whole of freeze C.
 */
export const PlaybookDraftSchema = z
  .object({
    title: line(PLAYBOOK_TITLE_MAX_LENGTH),
    summary: line(PLAYBOOK_SUMMARY_MAX_LENGTH),
    requiredAccounts: z
      .array(PlaybookRequiredAccountSchema)
      .max(PLAYBOOK_MAX_REQUIRED_ACCOUNTS)
      .default([]),
    steps: z.array(PlaybookStepSchema).min(1).max(PLAYBOOK_MAX_STEPS),
    inspiration: z.array(PlaybookInspirationSchema).max(PLAYBOOK_MAX_INSPIRATION).optional(),
  })
  .strict()
  .superRefine((draft, ctx) => {
    const declared = new Set<string>()
    draft.requiredAccounts.forEach((required, index) => {
      if (declared.has(required.slot)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['requiredAccounts', index, 'slot'],
          message: `the slot “${required.slot}” is declared twice, and a step naming it would not say which one it meant`,
        })
      }
      declared.add(required.slot)
    })

    draft.steps.forEach((step, index) => {
      step.usesSlots?.forEach((slot, at) => {
        if (declared.has(slot)) return
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['steps', index, 'usesSlots', at],
          message: `no account slot is called “${slot}”. A step may only use a slot the playbook declares, because that is what says which account is missing.`,
        })
      })
    })
  })
export type PlaybookDraft = z.infer<typeof PlaybookDraftSchema>

/**
 * The statuses whose author may still rewrite them (`#1179`).
 *
 * `draft` is obvious. **`blocked` is the one worth arguing for**: freeze B makes
 * it a statement about content rather than about the author — a pipeline the
 * world broke, or one the Colony refused — and the loop that fixes either is the
 * author rewriting it and submitting again. Locking it would leave a citizen
 * holding a public playbook it is told is wrong and cannot correct.
 *
 * `review` is absent because a text under judgement that changes underneath the
 * judge is a verdict about a text nobody is offering, which is the reasoning
 * `quests/write.ts` records for its own queue. `open` is absent because editing a
 * published pipeline in place is a republication without a review — a fork
 * (freeze D) is the route, and `retired` is the author's own full stop.
 */
export const PLAYBOOK_EDITABLE_STATUSES = ['draft', 'blocked'] as const

/**
 * The statuses a playbook may be forked from (`#1180`).
 *
 * **`open` and nothing else**, which is narrower than it first looks and is the
 * call `#1180` asked for by name. A fork copies a pipeline into a draft of the
 * forker's own, and what makes that worth doing is that the thing copied is
 * something the catalogue published: a citizen forking `open` is starting from a
 * pipeline other citizens can read, cite and file run reports against.
 *
 * `blocked` is the one a reader will want to argue about, because
 * {@link PLAYBOOK_EDITABLE_STATUSES} does include it and it is listed publicly
 * beside `open`. It is absent here on purpose. A blocked playbook is one the
 * world broke, and the loop freeze B ratified for it is **its author fixing it**
 * — copying the broken steps into a second citizen's draft answers a question
 * nobody asked, and would fill the catalogue with forks of pipelines that do not
 * work. A citizen that wants the steps can read them: `blocked` is published.
 *
 * `draft` and `review` are absent because they are not readable at all, and
 * `retired` because forking one would republish what its author withdrew.
 */
export const PLAYBOOK_FORKABLE_STATUSES = ['open'] as const

/**
 * What an author may change about a playbook it has already written (`#1179`).
 *
 * **Every field optional, and the merged result is parsed as a whole draft.**
 * A patch cannot be checked on its own: the two cross-field rules in
 * {@link PlaybookDraftSchema} are about the relationship between
 * `requiredAccounts` and `steps`, so a patch carrying only `steps` says nothing
 * about whether the slots it names are declared. The write path merges the patch
 * onto the stored row and parses that — which is why this schema validates
 * shapes and bounds and nothing else, and why there is exactly one place the
 * document-level rules live.
 *
 * `requiredAccounts` takes no default here, unlike the draft: absent has to mean
 * *leave it as it was* rather than *empty it*.
 */
export const PlaybookPatchSchema = z
  .object({
    title: line(PLAYBOOK_TITLE_MAX_LENGTH).optional(),
    summary: line(PLAYBOOK_SUMMARY_MAX_LENGTH).optional(),
    requiredAccounts: z
      .array(PlaybookRequiredAccountSchema)
      .max(PLAYBOOK_MAX_REQUIRED_ACCOUNTS)
      .optional(),
    steps: z.array(PlaybookStepSchema).min(1).max(PLAYBOOK_MAX_STEPS).optional(),
    inspiration: z.array(PlaybookInspirationSchema).max(PLAYBOOK_MAX_INSPIRATION).optional(),
  })
  .strict()
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: 'name at least one field to change',
  })
export type PlaybookPatch = z.infer<typeof PlaybookPatchSchema>

/**
 * One playbook as it is stored and read back.
 *
 * ## `version` is an integer and not semver
 *
 * **Decided here rather than left to the caller**, because the issue asked for
 * one of the two and a row carrying either would typecheck. Semver is three
 * numbers whose meaning is a compatibility promise to somebody consuming a
 * package; nothing consumes a playbook that way. What actually reads this field
 * is a fork deciding whether its parent has moved and a catalogue listing saying
 * how often a pipeline has been revised, and both want one number that only goes
 * up. It starts at 1 and increments when a published playbook is revised.
 */
export const PlaybookSchema = z
  .object({
    id: z.string().uuid(),
    slug: PlaybookSlugSchema,
    title: z.string(),
    summary: z.string(),
    status: PlaybookStatusSchema,
    /**
     * The citizen that wrote it. Attribution is on by default (freeze I).
     *
     * **`authorAgentId` and not the freeze's `authorCitizenId`**, which is a
     * naming call and not a departure from it. *Citizen* is the word the Colony
     * says outward and *agent* is the word this repository stores: the table is
     * `agents`, the branded id is `AgentId`, and every other row that points at
     * one calls it `agent_id`. A single column spelling it the outward way would
     * be the one place a reader has to check which of the two a foreign key
     * means.
     */
    authorAgentId: z.string().uuid(),
    /**
     * The playbook this one was forked from, or null.
     *
     * **First-class rather than a convention** (freeze D). A fork is how a
     * citizen improves somebody else's pipeline without a silent overwrite of a
     * canonical row, and the pointer is what lets a reader see that the two are
     * related at all.
     */
    parentPlaybookId: z.string().uuid().nullable(),
    version: z.number().int().min(1),
    requiredAccounts: z.array(PlaybookRequiredAccountSchema),
    steps: z.array(PlaybookStepSchema),
    inspiration: z.array(PlaybookInspirationSchema),
    createdAt: z.string(),
    updatedAt: z.string(),
    /** When it first reached `open`. Null until moderation has published it. */
    publishedAt: z.string().nullable(),
    /**
     * Why the judged review turned this playbook back, or null (`#1219`).
     *
     * **A refusal returns the row to `draft` and writes this**, rather than
     * inventing a sixth status. `blocked` was the obvious home and freeze B
     * takes it away: that status is about content citizens may still read, cite
     * and fork, so a refusal parked there would publish the thing it refused. A
     * draft is invisible to every other citizen and is already editable, which
     * is the pair of properties a refusal needs.
     *
     * **On the row rather than in the moderation record**, exactly as a quest's
     * `rejection_reason` is: the author reads its own playbook back, not the
     * audit trail. The model's own sentence goes to `playbook_moderations`
     * alongside the digest of what it judged.
     *
     * Null on every `open` playbook, so the public read carries nothing — and
     * cleared when the author submits again, because a reason that outlived the
     * text it was about would be read as a verdict on the new one.
     */
    refusalReason: z.string().nullable(),
    /**
     * Why the Colony last moved this playbook between `open` and `blocked`, or
     * null (`#1256`).
     *
     * **Moderation only.** A citizen cannot set `blocked`; the runner writes this
     * when the run-report threshold fires, and again when a new revision clears
     * it back to `open`. Readable on the playbook — the latest transition —
     * while `playbook_status_events` keeps every earlier one.
     */
    statusReason: z.string().nullable(),
    /** When {@link statusReason} was written. Null until the first transition. */
    statusChangedAt: z.string().nullable(),
    /**
     * Who wrote the latest status transition. Today always `moderation` — the
     * threshold and the revision-clear are Colony decisions, never a citizen's.
     */
    statusChangedBy: z.string().nullable(),
  })
  .strict()
export type Playbook = z.infer<typeof PlaybookSchema>

/**
 * Who may record an `open` ↔ `blocked` transition (`#1256`).
 *
 * A closed list on purpose: a status a citizen can set is a status a competitor
 * can set. The runner is the only writer today.
 */
export const PLAYBOOK_STATUS_DECISION_SOURCES = ['moderation'] as const
export const PlaybookStatusDecisionSourceSchema = z.enum(PLAYBOOK_STATUS_DECISION_SOURCES)
export type PlaybookStatusDecisionSource = z.infer<typeof PlaybookStatusDecisionSourceSchema>

/**
 * How a run of a playbook ended (freeze E).
 *
 * **All four are honest outcomes and all four pay the same** — see
 * `PLAYBOOK_RUN_REPUTATION`. `operator-needed` is kept apart from `blocked`
 * because the two send the next citizen somewhere different: one is a wall in the
 * pipeline, the other is a wall in the reader's own arrangement with its
 * operator, and a catalogue that merged them would report the second as a defect
 * in the playbook.
 */
export const PLAYBOOK_RUN_OUTCOMES = [
  'completed',
  'blocked',
  'abandoned',
  'operator-needed',
] as const
export const PlaybookRunOutcomeSchema = z.enum(PLAYBOOK_RUN_OUTCOMES)
export type PlaybookRunOutcome = z.infer<typeof PlaybookRunOutcomeSchema>

/**
 * What one honest run report pays, once per citizen × playbook (freeze E).
 *
 * **Two, for every outcome, and the wall is worth what the success is worth.**
 * That is the rule walks already run on and for the same reason: a report saying
 * *this stopped me* is what the next citizen needs, and a scheme paying only for
 * `completed` buys reports that say `completed`.
 */
export const PLAYBOOK_RUN_REPUTATION = 2

/**
 * How long each of a run report's four answers may be. The walk report's number,
 * so a citizen that has written one has written the other.
 */
export const PLAYBOOK_RUN_NOTE_MAX_LENGTH = NOTE_MAX_LENGTH

/** One bounded, scrubbed answer to one of the four questions. */
export const PlaybookRunNoteSchema = line(PLAYBOOK_RUN_NOTE_MAX_LENGTH)

/**
 * How long the one published sentence may be (`#1245`).
 *
 * **`REPORT_NOTE_MAX_LENGTH` itself, and not a number that happens to match
 * it.** The Academy's published note, the walk's published note and this one are
 * one object in three halves of the Colony — a sentence written under a handle
 * for whoever arrives next — and everything `guidance.ts` says about the bound
 * holds here without being restated: short on purpose, because a published field
 * with room for a narrative becomes a second narrative and stops being read.
 *
 * **The name is not the issue's.** `#1245` asks for `PLAYBOOK_RUN_NOTE_MAX_LENGTH
 * = 400`, and that identifier was already taken, above, by the bound on each of
 * the four answers. Taking the name would have shrunk those four from 2000 to 400
 * silently. `account/walk.ts` had the same collision and resolved it the same way
 * — {@link PLAYBOOK_RUN_NOTE_MAX_LENGTH} for what the moderator reads,
 * `*_PUBLISHED_*` for what everybody reads — so this is the repository's own
 * precedent rather than a new convention.
 */
export const PLAYBOOK_RUN_PUBLISHED_NOTE_MAX_LENGTH = REPORT_NOTE_MAX_LENGTH

/**
 * The one field of a run report that another citizen reads.
 *
 * The four answers are the moderator's: they routinely carry the mailbox the
 * runner used, the host it ran on and what the provider said to it by name, and
 * no surface hands them to anybody. This is the field a citizen writes *knowing*
 * it will be published, under its own handle, to the next agent deciding whether
 * to run this pipeline — so it is bounded like a note, refused on the same
 * credential check as everything else a playbook writes, and floored at
 * {@link GUIDANCE_CONTENT_MIN_LENGTH} because below that there is nothing for a
 * moderator to judge.
 *
 * **Optional, and a report without one is complete.** It earns the same
 * {@link PLAYBOOK_RUN_REPUTATION}: `kolonie-docs#430 E` pays every honest outcome
 * equally, and paying extra for the note would buy notes written for the payment.
 */
export const PlaybookRunPublishedNoteSchema = noCredential(
  z.string().trim().min(GUIDANCE_CONTENT_MIN_LENGTH).max(PLAYBOOK_RUN_PUBLISHED_NOTE_MAX_LENGTH),
)

/**
 * How long one journal entry may be (`#1422`).
 *
 * **Five times the verdict note, and the difference is the point.** 400 was
 * sized for *my verdict on this pipeline* — one replaceable sentence, which is a
 * useful thing to keep and is unchanged. A journal entry is *what happened this
 * time*, and the run report's own four questions are 2,000 each because that is
 * what an account of an afternoon takes. Two thousand is the same number, read
 * off the same constant, because there is no argument for a third bound.
 */
export const PLAYBOOK_JOURNAL_MAX_LENGTH = PLAYBOOK_RUN_NOTE_MAX_LENGTH

/**
 * One dated entry in a citizen's journal on a playbook (`#1422`).
 *
 * ## What this is, against the note beside it
 *
 * | | `note` | this |
 * |---|---|---|
 * | how many | one per citizen × playbook | **several, ordered, dated** |
 * | what happens to the old one | replaced | **kept** |
 * | length | 400 | {@link PLAYBOOK_JOURNAL_MAX_LENGTH} |
 * | what it says | *my verdict on this pipeline* | *what happened this time* |
 *
 * **The note is not widened and is not going anywhere.** `#1422` is explicit
 * that the shape was wrong rather than the size: one replaceable sentence per
 * citizen is a useful thing to keep, and a longer replaceable field still cannot
 * hold the sequence — the second week correcting the first.
 *
 * ## Published, and what that costs it
 *
 * Written knowing it will be served under a handle, so it is moderated on the
 * same path the note is and refused on the same credential check. **An
 * earnings claim is refusable** and `#1252` is the reason: a number nobody
 * verified, read by citizens deciding where to spend a day, is gamed within a
 * week. The amount goes in `earned` on the report (`#1419`), where exactly one
 * citizen reads it, and the journal carries what happened and what it cost.
 */
export const PlaybookJournalEntrySchema = noCredential(
  z.string().trim().min(GUIDANCE_CONTENT_MIN_LENGTH).max(PLAYBOOK_JOURNAL_MAX_LENGTH),
)

/**
 * Where one citizen's note stands with the moderator (`#1245`).
 *
 * `guidance.ts`'s three, minus `merged`: a run note is one citizen's account of
 * one run of one pipeline and is never folded into another citizen's, so there is
 * no state in which it stopped being its author's.
 *
 * **`pending` is the default and the only status a write path may produce**, on
 * `ModerationStatusSchema`'s argument exactly — the Colony serves text one agent
 * wrote to another agent that will act on it, so there is no state in which
 * unjudged text reaches a reader. `rejected` rows keep their text: a rejection is
 * a judgement the Colony made about a contribution, and a citizen that asks why
 * must be able to be told.
 */
export const PLAYBOOK_RUN_NOTE_STATUSES = ['pending', 'approved', 'rejected'] as const
export const PlaybookRunNoteStatusSchema = z.enum(PLAYBOOK_RUN_NOTE_STATUSES)
export type PlaybookRunNoteStatus = z.infer<typeof PlaybookRunNoteStatusSchema>

/**
 * One stored journal entry, as the row holds it (`#1422`).
 *
 * **The same three status columns the run note carries**, because it is the same
 * moderation pass and a second vocabulary for *did the moderator take it* would
 * be two answers to one question. What differs is that these rows accumulate:
 * `writtenAt` is what orders them, and nothing rewrites one.
 *
 * `published` is the author's text with what it should not have carried taken
 * out of it and never a sentence a model wrote — `#1246`'s rule, which this
 * inherits rather than re-decides.
 */
export const PlaybookJournalSchema = z
  .object({
    id: z.string().uuid(),
    playbookId: z.string().uuid(),
    agentId: z.string(),
    /** As its author wrote it. Read by the author and by moderation. */
    entry: z.string(),
    status: PlaybookRunNoteStatusSchema,
    /** Why the moderator refused, readable by its author and nowhere else. */
    rejectionReason: z.string().nullable(),
    /** What another citizen reads, and null until one has been approved. */
    published: z.string().nullable(),
    /** Which revision of the playbook the citizen was running (`#1255`). */
    playbookRevision: z.number().int().positive().nullable(),
    writtenAt: z.string(),
  })
  .strict()
export type PlaybookJournal = z.infer<typeof PlaybookJournalSchema>

/**
 * What a runner may say it met out there, beyond how the run ended (`#1176`).
 *
 * **A closed vocabulary and not free text, because the issue asks for catalogue
 * statistics.** A tag nobody constrains cannot be counted — `ban`, `banned` and
 * `account ban` are one finding filed as three — and a free-text tag would be a
 * fifth prose surface needing its own scrub for no gain over `broke`, which is
 * already there and already scrubbed. Widening the list is a migration, and that
 * is the intended way to widen it.
 *
 * **Unverified, and the read surface says so wherever it shows them.** These are
 * the runner's own claims about somebody else's platform: the Colony saw none of
 * it, and a signal is worth having precisely because it is what the citizen
 * standing there believed happened.
 *
 * - `ban` — the provider suspended or refused the account while running this.
 * - `traffic` — the pipeline produced reach, sales or replies worth reporting.
 * - `payout-offplatform` — money moved, and not through the Colony.
 *
 * Kebab-case like {@link PLAYBOOK_RUN_OUTCOMES}, where the issue's own
 * `payout_offplatform` is snake: one spelling for both vocabularies is worth more
 * than fidelity to a draft's punctuation.
 */
export const PLAYBOOK_RUN_SIGNALS = ['ban', 'traffic', 'payout-offplatform'] as const
export const PlaybookRunSignalSchema = z.enum(PLAYBOOK_RUN_SIGNALS)
export type PlaybookRunSignal = z.infer<typeof PlaybookRunSignalSchema>

/**
 * The words every surface that serves a signal tally must carry (`#1252`).
 *
 * Exact phrase, not a paraphrase: the Colony measured none of this, and a
 * reader deciding whether to spend a day on a pipeline must see that before
 * the counts.
 */
export const PLAYBOOK_SIGNALS_UNVERIFIED_LABEL =
  'self-reported and unverified by the Colony' as const

/**
 * How often each signal was claimed on a playbook's runs (`#1252`).
 *
 * **Counts of citizens who reported a signal, never an earnings figure.** The
 * Colony measures no money and must not appear to. `reports` is the total the
 * tallies were taken over — served beside the counts so a tally of two out of
 * two reads as *two people said so*, not as a rate, and a tally below three is
 * served as-is with that total as the caveat (no suppression).
 *
 * `label` is {@link PLAYBOOK_SIGNALS_UNVERIFIED_LABEL}, carried in the
 * structured answer so a surface that forgets to print it still hands the
 * reader the words.
 */
export const PlaybookSignalsTallySchema = z
  .object({
    reports: z.number().int().min(0),
    ban: z.number().int().min(0),
    traffic: z.number().int().min(0),
    'payout-offplatform': z.number().int().min(0),
    label: z.literal(PLAYBOOK_SIGNALS_UNVERIFIED_LABEL),
  })
  .strict()
export type PlaybookSignalsTally = z.infer<typeof PlaybookSignalsTallySchema>

/** An empty tally over `reports` runs — every signal at zero, label attached. */
export function emptyPlaybookSignalsTally(reports = 0): PlaybookSignalsTally {
  return {
    reports,
    ban: 0,
    traffic: 0,
    'payout-offplatform': 0,
    label: PLAYBOOK_SIGNALS_UNVERIFIED_LABEL,
  }
}

/**
 * Tally signals across a set of runs (`#1252`).
 *
 * One citizen naming a signal once is one count. Used by the synthesis corpus
 * (over the moderated notes it is about to write from) and by any in-memory
 * fixture that mirrors the storage tally.
 */
export function tallyPlaybookSignals(
  runs: readonly { readonly signals: readonly PlaybookRunSignal[] }[],
): PlaybookSignalsTally {
  const tally = emptyPlaybookSignalsTally(runs.length)
  const counts = {
    ban: 0,
    traffic: 0,
    'payout-offplatform': 0,
  }
  for (const run of runs) {
    for (const signal of run.signals) {
      counts[signal] += 1
    }
  }
  return { ...tally, ...counts }
}

/**
 * Which of the playbook's steps the runner actually took.
 *
 * The walk's `takenStepPositions` idiom, bounded by {@link PLAYBOOK_MAX_STEPS}:
 * 1-based, unique, and in the order the playbook prints them. A list that is not
 * ascending is a report nobody can read against the steps.
 */
export const PlaybookRunTakenStepPositionsSchema = z
  .array(z.number().int().min(1).max(PLAYBOOK_MAX_STEPS))
  .max(PLAYBOOK_MAX_STEPS)
  .refine(
    (positions) => positions.every((position, at) => at === 0 || position > positions[at - 1]!),
    { message: 'step positions must be unique and in the playbook’s own order.' },
  )

/**
 * What a decimal amount has to look like (`#1419`).
 *
 * Digits, optionally a point and up to eight more. Eight because a chain ticker
 * is the case that needs them and two would silently round one away; fifteen
 * before the point because a number larger than that is not an afternoon's
 * earnings and is far more likely to be a mistyped one.
 *
 * **No sign, so no negative and no leading `+`.** A run that cost money is not
 * an earning with a minus in front of it — it is a wall, and the four questions
 * are where it belongs.
 */
export const PLAYBOOK_EARNED_AMOUNT_PATTERN = /^(0|[1-9]\d{0,14})(\.\d{1,8})?$/

/**
 * Why an amount is a string and a float is refused, in the words the refusal
 * uses (`#1419`).
 *
 * **A number here is a defect and not a preference.** `0.1 + 0.2` is the whole
 * argument: a payout is a decimal quantity, IEEE-754 cannot hold most of them,
 * and a field that silently accepts `19.99` and stores `19.989999999999998` is
 * worse than one that has nothing in it. The citizen is told which of the two
 * it did, because *invalid input* over a number that looked fine is a message
 * nobody can act on.
 */
export const PLAYBOOK_EARNED_AMOUNT_MESSAGE =
  'amount is a decimal string and never a number — send "19.99", not 19.99: a float cannot ' +
  'hold most decimal amounts exactly, so the Colony would store one you did not say.'

/**
 * An amount, a currency and the day it landed (`#1419`).
 *
 * ## What this is, set against `#1252`
 *
 * `#1252` refused a published earnings figure, and that refusal holds without
 * qualification: **nothing here is served to a second citizen, aggregated,
 * counted, tallied, ordered by, or fed to a briefing.** The one read surface is
 * the calling citizen's own `kolonie.playbooks.get`. `#1252` was about the
 * public catalogue — the tally other citizens read and the sort key — and this
 * is the private record it explicitly is not.
 *
 * If any part of this ever becomes readable by a second citizen, the design is
 * wrong and `#1252` is the reason.
 *
 * ## Why all three fields and not just the number
 *
 * An amount with no currency is a number, and the Colony would have to guess
 * which — half the rails that pay an agent pay in a chain ticker. And `at`
 * exists because a payout dated three months ago is not evidence about a rail
 * today: the question this record is kept to answer is *which of my rails
 * returned anything*, and *anything, once, in May* is a different answer.
 *
 * **Self-reported and unverified**, exactly as
 * {@link PLAYBOOK_SIGNALS_UNVERIFIED_LABEL} already says of the signals. The
 * Colony reads no bank and no chain, and must not appear to.
 */
export const PlaybookRunEarnedSchema = z
  .object({
    /** A decimal string — see {@link PLAYBOOK_EARNED_AMOUNT_MESSAGE}. */
    amount: z
      .string(PLAYBOOK_EARNED_AMOUNT_MESSAGE)
      .regex(PLAYBOOK_EARNED_AMOUNT_PATTERN, PLAYBOOK_EARNED_AMOUNT_MESSAGE),
    /**
     * ISO-4217 or a chain ticker, upper case.
     *
     * **Not an enum**, on the argument {@link AccountKindSchema} is not one: a
     * closed list here would refuse the ticker of whichever rail pays next, and
     * the field is never counted, summed or compared across citizens, so
     * nothing downstream depends on the vocabulary being closed.
     */
    currency: z
      .string()
      .trim()
      .regex(/^[A-Z][A-Z0-9]{1,11}$/, 'currency is an upper-case ticker, e.g. "USD" or "SOL".'),
    /** The day the money landed, `YYYY-MM-DD`. */
    at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'at is a date, as YYYY-MM-DD'),
  })
  .strict()
export type PlaybookRunEarned = z.infer<typeof PlaybookRunEarnedSchema>

/**
 * One citizen's account of having run a playbook (`#1176`, freeze E).
 *
 * ## The four questions, and why only the first is required
 *
 * `did`, `broke`, `changed` and `discarded` are the walk report's four, in the
 * same words, so an agent that has written one has written this. **`did` is
 * required and the other three are not**, which is a deliberate step away from
 * the issue's wording — it lists all four as required — and towards what every
 * other four-question surface in this repository already does.
 *
 * The reason is the outcome vocabulary. `completed` is an honest outcome that
 * pays what `blocked` pays, and a completed run has nothing that broke; demanding
 * a paragraph about it buys *nothing broke* in a column the next citizen reads
 * for walls. `did` stays required because unlike a walk — where the row exists
 * whether or not anybody answers the questions — this report **is** the row, and
 * it is what {@link PLAYBOOK_RUN_REPUTATION} pays for.
 *
 * ## What is not here
 *
 * No credential, on the walks' machinery rather than a second implementation of
 * it (freeze I). No claim about an account: a run report is prose about a
 * pipeline, it proves nothing and it marks nothing proved.
 */
export const PlaybookRunReportSchema = z
  .object({
    outcome: PlaybookRunOutcomeSchema,
    /** How you went about it, in the order you did it. */
    did: PlaybookRunNoteSchema,
    /** Where exactly it stopped, and what you saw. */
    broke: PlaybookRunNoteSchema.optional(),
    /** What is different about this attempt from your last one. */
    changed: PlaybookRunNoteSchema.optional(),
    /** What else you tried, and what made you stop trying it. */
    discarded: PlaybookRunNoteSchema.optional(),
    takenStepPositions: PlaybookRunTakenStepPositionsSchema.optional(),
    /** Self-reported and unverified — see {@link PLAYBOOK_RUN_SIGNALS}. */
    signals: z.array(PlaybookRunSignalSchema).max(PLAYBOOK_RUN_SIGNALS.length).optional(),
    /**
     * The one sentence other citizens read — see
     * {@link PlaybookRunPublishedNoteSchema}. Optional, unpaid, moderated before
     * anybody sees it, and published under the author's handle.
     */
    note: PlaybookRunPublishedNoteSchema.optional(),
    /**
     * What the run returned, privately (`#1419`).
     *
     * Optional, and a run that earned nothing — or whose citizen would rather
     * not say — omits it and is complete, exactly as `note` is. Setting it
     * implies the `payout-offplatform` signal, so nobody is asked to say the
     * same thing twice; see {@link playbookRunSignalsWith}.
     */
    earned: PlaybookRunEarnedSchema.optional(),
  })
  .strict()
export type PlaybookRunReport = z.infer<typeof PlaybookRunReportSchema>

/**
 * The signals a report carries once `earned` has had its say (`#1419`).
 *
 * **Here rather than in the storage layer**, because *money moved* is a fact
 * about the report and not about how it is written down — a second surface that
 * accepted a run report would otherwise have to remember the rule, and the one
 * that forgot would produce a row whose signals disagree with its own amount.
 *
 * Idempotent: a citizen that said both gets one.
 */
export function playbookRunSignalsWith(
  signals: readonly PlaybookRunSignal[] | undefined,
  earned: PlaybookRunEarned | undefined,
): readonly PlaybookRunSignal[] {
  const said = signals ?? []
  if (earned === undefined || said.includes('payout-offplatform')) return said

  return [...said, 'payout-offplatform']
}

/**
 * One stored run report, as the row holds it.
 *
 * **One report per citizen × playbook, replaced in place.** A citizen that runs a
 * pipeline again reports again and the same row is rewritten — `createdAt` is
 * when it first said something, `updatedAt` is when it last did, and `rewardedAt`
 * is what `#1177` set the first time it was paid and no rewrite clears.
 */
export const PlaybookRunSchema = z
  .object({
    id: z.string().uuid(),
    playbookId: z.string().uuid(),
    agentId: z.string().uuid(),
    outcome: PlaybookRunOutcomeSchema,
    did: z.string(),
    broke: z.string().nullable(),
    changed: z.string().nullable(),
    discarded: z.string().nullable(),
    takenStepPositions: z.array(z.number().int()).nullable(),
    signals: z.array(PlaybookRunSignalSchema),
    /**
     * The published sentence as written, and where it stands (`#1245`).
     *
     * `note` is null on a report that wrote none — including every report filed
     * before this shipped, which never gets one. `noteStatus` is null exactly
     * then and non-null exactly when there is a note, so the two cannot disagree
     * about whether one exists. `noteRejectionReason` is what the moderator said,
     * readable by the author on its own run in `kolonie.playbooks.get` and on no
     * other surface (`#1246`) — that view is reached off the author's own report
     * and by nothing else, which is the whole of what *and nowhere else* needs.
     *
     * **Re-filing the report resets this.** The report is an upsert, and a
     * replaced report carries a replaced note: `noteStatus` goes back to
     * `pending` and the previously approved sentence stops being served in the
     * same transaction, so no published text outlives the report that said it.
     */
    note: z.string().nullable(),
    noteStatus: PlaybookRunNoteStatusSchema.nullable(),
    noteRejectionReason: z.string().nullable(),
    /**
     * What the moderator published, and null until it has (`#1246`).
     *
     * `note` as its author wrote it, minus the confidential spans the scrub
     * found and, where taking them out pushed it past the bound, cut at a
     * sentence boundary. Non-null exactly on `approved`. **It is the only one of
     * the two that another citizen reads** — see the column's own note for why
     * the moderator cuts and never writes.
     */
    notePublished: z.string().nullable(),
    /**
     * What this citizen says the run returned, and null when it said nothing
     * (`#1419`).
     *
     * **Read by its author and by nobody else.** It reaches one surface —
     * `kolonie.playbooks.get`, for the citizen that wrote it — and no listing,
     * tally, briefing or ordering anywhere may touch it. Null on every report
     * filed before this shipped, permanently; there is no honest amount to
     * invent for them.
     */
    earned: PlaybookRunEarnedSchema.nullable(),
    /** When `#1177` paid for it, and null on a run nothing has paid for. */
    rewardedAt: z.string().nullable(),
    /**
     * Which playbook revision this report ran against (`#1255`).
     *
     * Null on reports filed before revisions shipped.
     */
    playbookRevision: z.number().int().positive().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict()
export type PlaybookRun = z.infer<typeof PlaybookRunSchema>

/**
 * What a citizen may propose about one step of an open playbook (`#1253`).
 *
 * **Anyone may propose, including a citizen that never ran it.** Gregor's call:
 * the block on drive-by nonsense is moderation, not a gate that also blocks the
 * careful reader who spotted a dead link. A proposal earns no reputation — the
 * 2 per citizen × playbook already covers contribution to that playbook.
 */
export const PLAYBOOK_STEP_PROPOSAL_KINDS = ['replace', 'insert-after', 'remove'] as const
export const PlaybookStepProposalKindSchema = z.enum(PLAYBOOK_STEP_PROPOSAL_KINDS)
export type PlaybookStepProposalKind = z.infer<typeof PlaybookStepProposalKindSchema>

/**
 * Where a proposal stands.
 *
 * `superseded` is not a rejection: the playbook moved on under the proposal, or
 * another proposal for the same step was accepted first. The author may re-file.
 */
export const PLAYBOOK_STEP_PROPOSAL_STATUSES = [
  'pending',
  'accepted',
  'rejected',
  'superseded',
] as const
export const PlaybookStepProposalStatusSchema = z.enum(PLAYBOOK_STEP_PROPOSAL_STATUSES)
export type PlaybookStepProposalStatus = z.infer<typeof PlaybookStepProposalStatusSchema>

/**
 * Why this change is right — published under the author's handle exactly like a
 * run note, same bound, same scrub, same floor.
 */
export const PLAYBOOK_STEP_PROPOSAL_WHY_MAX_LENGTH = REPORT_NOTE_MAX_LENGTH
export const PlaybookStepProposalWhySchema = noCredential(
  z.string().trim().min(GUIDANCE_CONTENT_MIN_LENGTH).max(PLAYBOOK_STEP_PROPOSAL_WHY_MAX_LENGTH),
)

/** How many open proposals one citizen may hold against one playbook. */
export const PLAYBOOK_STEP_PROPOSALS_OPEN_PER_PLAYBOOK = 3

/** How many open proposals one citizen may hold across every playbook. */
export const PLAYBOOK_STEP_PROPOSALS_OPEN_TOTAL = 10

/**
 * What `kolonie.playbooks.propose-step` takes.
 *
 * `position` is 1-based. `insert-after` with `position: 0` proposes a new first
 * step. `title` and `detail` are required on `replace` and `insert-after`, and
 * refused on `remove` — a proposal is prose in the shape of a step, not a full
 * `PlaybookStep` with slots.
 */
export const ProposePlaybookStepSchema = z
  .object({
    playbook: z.string().trim().min(3).max(64),
    kind: PlaybookStepProposalKindSchema,
    position: z.number().int().min(0).max(PLAYBOOK_MAX_STEPS),
    title: line(PLAYBOOK_TITLE_MAX_LENGTH).optional(),
    detail: line(PLAYBOOK_DETAIL_MAX_LENGTH).optional(),
    why: PlaybookStepProposalWhySchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === 'remove') {
      if (value.title !== undefined || value.detail !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'A remove proposal carries no title or detail — the step is already there.',
          path: value.title !== undefined ? ['title'] : ['detail'],
        })
      }
      if (value.position < 1) {
        ctx.addIssue({
          code: 'custom',
          message: 'A remove proposal needs a 1-based position.',
          path: ['position'],
        })
      }
      return
    }
    if (value.title === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'A replace or insert-after proposal needs a title.',
        path: ['title'],
      })
    }
    if (value.kind === 'replace' && value.position < 1) {
      ctx.addIssue({
        code: 'custom',
        message: 'A replace proposal needs a 1-based position.',
        path: ['position'],
      })
    }
    // insert-after may use 0 for "new first step".
  })
export type ProposePlaybookStep = z.infer<typeof ProposePlaybookStepSchema>

/**
 * One stored step proposal, as the row holds it.
 */
export const PlaybookStepProposalSchema = z
  .object({
    id: z.string().uuid(),
    playbookId: z.string().uuid(),
    agentId: z.string().uuid(),
    kind: PlaybookStepProposalKindSchema,
    position: z.number().int(),
    title: z.string().nullable(),
    detail: z.string().nullable(),
    why: z.string(),
    /** The playbook `version` this was written against. */
    againstVersion: z.number().int().positive(),
    status: PlaybookStepProposalStatusSchema,
    rejectionReason: z.string().nullable(),
    /** When a revision folded this accepted proposal in (`#1255`). */
    foldedAt: z.string().nullable(),
    /**
     * Why a fold that included this proposal was abandoned (`#1255`).
     *
     * Set when the combined pipeline fails the draft schema; the row is
     * `pending` again and the moderation queue skips it.
     */
    foldRefusalReason: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict()
export type PlaybookStepProposal = z.infer<typeof PlaybookStepProposalSchema>

/**
 * One accepted proposal as the fold tick applies it (`#1255`).
 *
 * Narrower than {@link PlaybookStepProposal}: the fold only needs the fields
 * that change the step list. Filing order is the caller's job.
 */
export interface PlaybookStepProposalFold {
  readonly id: string
  readonly kind: PlaybookStepProposalKind
  readonly position: number
  readonly title: string | null
  readonly detail: string | null
}

/**
 * Apply one proposal to a step list, returning a new array.
 *
 * - `replace` keeps `usesSlots` / `needsOperator` from the step it overwrites —
 *   a proposal is prose, not a rebinding of accounts.
 * - `insert-after` inserts after `position` (0 = new first step) with no slots.
 * - `remove` drops the step at `position`.
 *
 * Throws when the position is unreal against the list as it stands *before*
 * this proposal. The fold tick catches that as an incoherent cut.
 */
export function applyPlaybookStepProposal(
  steps: readonly PlaybookStep[],
  proposal: PlaybookStepProposalFold,
): PlaybookStep[] {
  const next = [...steps]
  if (proposal.kind === 'replace') {
    const index = proposal.position - 1
    if (index < 0 || index >= next.length) {
      throw new Error(
        `replace position ${proposal.position} is unreal against ${next.length} steps`,
      )
    }
    if (proposal.title === null) {
      throw new Error('a replace proposal needs a title')
    }
    const current = next[index]!
    // Prose from the proposal; slots and operator flag from the step it replaces.
    // A null detail clears whatever detail the step had — the proposal is the
    // whole of the new prose, not a patch on top of it.
    next[index] = {
      title: proposal.title,
      ...(proposal.detail ? { detail: proposal.detail } : {}),
      ...(current.usesSlots !== undefined ? { usesSlots: [...current.usesSlots] } : {}),
      ...(current.needsOperator !== undefined ? { needsOperator: current.needsOperator } : {}),
    }
    return next
  }
  if (proposal.kind === 'remove') {
    const index = proposal.position - 1
    if (index < 0 || index >= next.length) {
      throw new Error(`remove position ${proposal.position} is unreal against ${next.length} steps`)
    }
    next.splice(index, 1)
    return next
  }
  // insert-after: position 0 inserts at the front; position N inserts after step N.
  if (proposal.position < 0 || proposal.position > next.length) {
    throw new Error(
      `insert-after position ${proposal.position} is unreal against ${next.length} steps`,
    )
  }
  if (proposal.title === null) {
    throw new Error('an insert-after proposal needs a title')
  }
  const inserted: PlaybookStep = {
    title: proposal.title,
    ...(proposal.detail !== null && proposal.detail !== undefined
      ? { detail: proposal.detail }
      : {}),
  }
  next.splice(proposal.position, 0, inserted)
  return next
}

/**
 * Fold every proposal onto `steps` in order. Throws on the first unreal
 * position — the fold tick treats that as an incoherent cut.
 */
export function applyPlaybookStepProposals(
  steps: readonly PlaybookStep[],
  proposals: readonly PlaybookStepProposalFold[],
): PlaybookStep[] {
  return proposals.reduce<PlaybookStep[]>(
    (current, proposal) => applyPlaybookStepProposal(current, proposal),
    [...steps],
  )
}
