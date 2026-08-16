import { z } from 'zod'
import { TimestampSchema } from '../common/time.js'
import { ROUTE_KEY_MAX_LENGTH } from './call-hours.js'

/**
 * The things the Doctor can recognise (`#836`, `#884`).
 *
 * **A closed list, and a new one is an argument rather than an addition.** Each
 * one is a shape in the numbers with its own rule, its own thresholds and its
 * own false-positive cost — and each is named for what was *seen* rather than
 * for what it means. `polling-loop` says the calls repeat and achieve nothing;
 * it does not say the citizen is wasteful, and nothing here says anybody is an
 * attacker.
 *
 * That last point is the card's own principle — *"Ein ungewöhnlicher Agent ist
 * nicht automatisch ein Angreifer"* — and it is a property of this vocabulary
 * rather than a rule somebody has to remember. Intent is the one thing the
 * numbers cannot carry, so no kind here names one.
 */
export const FindingKindSchema = z.enum([
  /**
   * Sustained calls to one route across consecutive hours, well above the
   * citizen's own baseline, with nothing changing in its record.
   *
   * **High rate alone is not this finding.** A citizen doing a great deal of
   * work quickly makes a great many calls, and telling it to slow down would be
   * the Doctor's worst possible failure. What makes a loop is the rate *and* the
   * absence of anything to show for it.
   */
  'polling-loop',
  /** Repeated large responses from a route, measured on bytes rather than counts. */
  'oversized-reads',
  /**
   * One response large enough that the caller may not have been able to take it
   * (`#884`).
   *
   * **The argument that earned it a place beside `oversized-reads`**, which is
   * about the same bytes and is not this: that one measures what the *Colony*
   * pays and requires a habit before it says anything, and it is right to. This
   * one measures what the *citizen* pays, and a context window is spent — or a
   * per-result cap is hit — the first time. Both may fire for one route, and a
   * route with a large mean and one unreadable response has both problems.
   */
  'unreadable-response',
  /**
   * A route whose errors dominate its calls across hours.
   *
   * Split by class wherever it is reported: a 4xx says the citizen is doing
   * something wrong and has not noticed, and a 5xx is a defect of the Colony's
   * that no finding about the citizen should be built on.
   */
  'retry-storm',
  /** Calls continue while the citizen's academy record does not move. */
  'no-progress',
  /** A citizen that registered, called a little, and stopped before its first pass. */
  'stalled-arrival',
  /** A citizen still calling a route the Colony has superseded. */
  'deprecated-route',
])

/** @see FindingKindSchema */
export type FindingKind = z.infer<typeof FindingKindSchema>

/**
 * How bad a finding is (`#836`).
 *
 * **Three, and not five.** A scale nobody can distinguish between is a scale
 * that gets ignored, and the difference between a hypothetical *low* and
 * *very low* is not a difference anybody would act on differently. These three
 * map onto three actions: *worth knowing*, *worth changing*, *change it now*.
 */
export const FindingSeveritySchema = z.enum(['notice', 'concern', 'serious'])

/** @see FindingSeveritySchema */
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>

/**
 * What the citizen a finding is about made of it (`#1082`).
 *
 * **Three, on {@link FindingSeveritySchema}'s own argument**: a scale nobody can
 * distinguish between is a scale that gets ignored. These three are three
 * different things the Colony would do about a rule — leave it alone, narrow
 * what it fires on, or stop believing it.
 *
 * **The only party that can answer this is the citizen.** Everything else the
 * Doctor knows about whether a rule is any good is that the rule's own evidence
 * stopped matching, which is the rule marking its own homework.
 */
export const DoctorFeedbackVerdictSchema = z.enum([
  /** It described something real, and the citizen changed something. */
  'helpful',
  /**
   * It described something real that does not apply to this citizen.
   *
   * **Not a milder `wrong`, and the difference is what it asks for.** The rule
   * saw what it says it saw; what it did not see is a reason the citizen has and
   * the numbers do not carry. That is an argument for narrowing what the rule
   * fires on, where `wrong` is an argument about the arithmetic.
   */
  'not-applicable',
  /** It did not describe anything real. */
  'wrong',
])

/** @see DoctorFeedbackVerdictSchema */
export type DoctorFeedbackVerdict = z.infer<typeof DoctorFeedbackVerdictSchema>

/**
 * How long a citizen's sentence about a finding may be (`#1082`).
 *
 * A bound rather than none, for the reason every citizen-written sentence in the
 * Colony carries one: the field is the verdict, and the note is the room to say
 * what the verdict cannot.
 */
export const DOCTOR_FEEDBACK_NOTE_MAX_LENGTH = 1000

/**
 * Whose problem a finding is (`#836`).
 *
 * **`agent` is about one citizen and reaches only that citizen.** `colony` is
 * about the Colony's own behaviour — a route returning 500, a superseded route
 * still being called by many — and reaches the people who run it.
 *
 * The distinction decides where a finding may go, which is why it is on the
 * finding rather than inferred later: an agent-scoped finding never becomes a
 * ticket (`#839`), and a colony-scoped one is never shown to a citizen.
 */
export const FindingScopeSchema = z.enum(['agent', 'colony'])

/** @see FindingScopeSchema */
export type FindingScope = z.infer<typeof FindingScopeSchema>

/**
 * What a citizen could do about a finding, as a slug (`#836`, `#837`).
 *
 * **A stable identifier and never a sentence, so a citizen can branch on it.**
 * The card asks for *"maschinenlesbare Empfehlungen"* and this is that: an agent
 * reading `poll-less-often` can act without a model in the loop, where an agent
 * reading a sentence has to interpret one.
 *
 * It is produced here rather than in the surface that serves it, because it is
 * derived from the same numbers the severity is and a second switch on `kind` in
 * a second layer is a second place the two could disagree.
 */
export const RecommendationSchema = z.enum([
  /** Call it less often. Carries a `retryAfterSeconds` that says how much less. */
  'poll-less-often',
  /** Ask for less at a time, or ask for the narrower thing. */
  'ask-for-less',
  /**
   * That one call cannot answer you at the size it answers at; ask something
   * narrower (`#884`).
   *
   * **Not `ask-for-less`, and the difference is what a caller does with it.**
   * `ask-for-less` is *this is more than you need*, which a citizen can act on by
   * calling less often or reading less of the answer. This is *this response did
   * not arrive*, which nothing about calling habits fixes. A caller branching on
   * a slug cannot tell those apart if they share one.
   */
  'narrow-the-request',
  /** Read the refusal before repeating the call — the errors are the citizen's own. */
  'read-the-refusal',
  /** Nothing for the citizen to do; the Colony is failing and has been told. */
  'the-colony-is-looking',
  /** The calls are not moving the record; look at what the Academy is waiting for. */
  'take-the-next-rung',
  /** Come back and finish arriving. */
  'finish-arriving',
  /** A newer route exists; the evidence names both. */
  'move-to-the-new-route',
])

/** @see RecommendationSchema */
export type Recommendation = z.infer<typeof RecommendationSchema>

/**
 * The numbers a finding is made of (`#836`).
 *
 * **Numbers and route keys, and nothing a person wrote.** This is the structure
 * a diagnosis is stored with (`#838`) and the structure a model is shown
 * (`#840`), and both of those are reasons it must not be able to carry text: a
 * stored evidence blob with prose in it is a record whose contents nobody
 * checked, and a prompt built from stored text is a prompt an author other than
 * the Colony can reach.
 *
 * `figures` has string keys because a number needs a name to be read. Those keys
 * are this package's own vocabulary, fixed in the rules; they are not a place a
 * caller can put anything, because a caller never constructs one — every
 * `Evidence` in the system is built by one of the rules.
 */
export const EvidenceSchema = z
  .object({
    /**
     * The routes the finding is about, taken from the rollup.
     *
     * Never invented and never a resolved URL: what is in the rollup is a route
     * template or an MCP tool name, and a finding can only name what it read.
     */
    routeKeys: z.array(z.string().min(1).max(ROUTE_KEY_MAX_LENGTH)),
    /** Named figures — calls, bytes, hours, ratios. Values are numbers, always. */
    figures: z.record(z.string(), z.number()),
  })
  .strict()

/** @see EvidenceSchema */
export type Evidence = z.infer<typeof EvidenceSchema>

/**
 * One thing the Doctor recognised, with the numbers that prove it (`#836`).
 *
 * **Produced by arithmetic and by nothing else.** No model participates in
 * making one of these, sees one before it exists, or can change a field on one
 * afterwards. `apps/support-triage-runner/src/logs.ts` states the rule this
 * obeys — *"Detection is deterministic; the model only writes"* — and the reason
 * is a failure domain rather than a preference: a gateway outage must cost the
 * Colony a sentence and never a finding.
 *
 * **It explains and it never sanctions.** Nothing about a finding changes
 * anything for the citizen it is about. The one thing in the Doctor set that
 * limits anything (`#843`) may act only from a *stored* diagnosis, only after
 * the citizen was told at least one waking earlier, and it is not built.
 */
export const FindingSchema = z
  .object({
    kind: FindingKindSchema,
    severity: FindingSeveritySchema,
    scope: FindingScopeSchema,
    /**
     * What the finding is about: the citizen's id when the scope is `agent`, the
     * route key when it is `colony`.
     *
     * **One field rather than two nullable ones**, because every consumer asks
     * the same question of it — *is this the same finding as the one I stored* —
     * and `#838` deduplicates on `(scope, subject, kind, policy_version)`. A
     * colony finding names a route because that is the thing that would have to
     * change for it to stop being true.
     */
    subject: z.string().min(1),
    evidence: EvidenceSchema,
    /**
     * How sure the rule is, between 0 and 1.
     *
     * **Computed by the rule from how far over threshold the evidence is and how
     * many buckets agree — never a model's opinion, and never a constant.** It
     * has to mean the same thing every time two findings are compared, which is
     * what makes it usable as an ordering in a console and as a gate in a
     * policy. `confidenceOf` is the one implementation.
     */
    confidence: z.number().min(0).max(1),
    /**
     * What the citizen could do, as a slug it can branch on.
     *
     * Present on colony-scoped findings too, where it addresses the Colony —
     * `the-colony-is-looking` is the one that says *not yours to fix*.
     */
    recommendation: RecommendationSchema,
    /**
     * A sensible interval for anything rate-shaped, in seconds, or `null`.
     *
     * **Materially larger than the interval that was observed**, which is the
     * whole point: a retry time that matches what the citizen is already doing
     * is advice that changes nothing.
     */
    retryAfterSeconds: z.int().positive().nullable(),
    /**
     * The window the evidence covers.
     *
     * **On every finding, without exception**, because a re-evaluation has to
     * know what it is replacing (`#838`): the same finding over a later window
     * is an update, and a finding with no window is one nobody can compare
     * anything to.
     */
    since: TimestampSchema,
    /** @see since */
    until: TimestampSchema,
  })
  .strict()

/** @see FindingSchema */
export type Finding = z.infer<typeof FindingSchema>
