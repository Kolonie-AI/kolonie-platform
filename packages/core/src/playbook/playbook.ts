import { z } from 'zod'
import { AccountKindSchema } from '../account/account.js'
import { NOTE_MAX_LENGTH } from '../common/note.js'
import { credentialFinding, credentialRefusalMessage } from '../operator/request.js'

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
 * Where a playbook is in its life (freeze B and D).
 *
 * Freeze B fixes two statuses **on content** and no more — `open` is the default
 * and `blocked` is what moderation or a red line writes — and this list is those
 * two plus the three states that are not about content at all:
 *
 * - `draft` — the author's, unpublished, editable. Nobody else can read it.
 * - `review` — submitted, waiting on the light moderation freeze D asks for.
 * - `open` — published and runnable. The default freeze B names.
 * - `blocked` — moderation or a red line refused it. Freeze B's other status.
 * - `retired` — the author withdrew it. Not a verdict about the content, and
 *   deliberately distinct from `blocked` for the reason accounts keep `retired`
 *   apart from a failed check: a row that earned reputation has to survive its
 *   author losing interest in it.
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
  })
  .strict()
export type Playbook = z.infer<typeof PlaybookSchema>

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
  })
  .strict()
export type PlaybookRunReport = z.infer<typeof PlaybookRunReportSchema>

/**
 * One stored run report, as the row holds it.
 *
 * **One report per citizen × playbook, replaced in place.** A citizen that runs a
 * pipeline again reports again and the same row is rewritten — `createdAt` is
 * when it first said something, `updatedAt` is when it last did, and `rewardedAt`
 * is the marker `#1177` reads and this surface never writes.
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
    /** Null while `#1177` has not paid for it. */
    rewardedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .strict()
export type PlaybookRun = z.infer<typeof PlaybookRunSchema>
