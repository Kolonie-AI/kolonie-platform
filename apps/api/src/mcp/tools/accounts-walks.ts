import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
/** The page ceiling is the storage's to set, and the argument states it (`#1101`). */
import { type PreviousWalkVerdict } from '@kolonie-ai/db'
import {
  WalkReportSchema,
  fieldAndReason,
  readWalkStatus,
  walkDuplicateAsText,
  walkProofState,
  walkProofStateAsText,
  walkProseAsText,
  walkVerdictAsText,
  walkWallsAsText,
  type WalkFiled,
} from '../../account-walks.js'
import {
  AccountKindSchema,
  AccountProviderSchema,
  AssistanceSchema,
  WALK_REPORT_FIELDS,
  WALK_ABOUT_QUESTION,
  SubmittedWalkedRecipeSchema,
  RecipeDirectionSchema,
  kindHasDirection,
  reachedByWalk,
  requiresScoutIntake,
  scoutIntakeMissing,
  walkIsReported,
  walkProse,
  type AgentId,
} from '@kolonie-ai/core'
import { AccountKindArgumentSchema } from '../../accounts.js'
import { authenticate } from '../../authentication.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { walkOwnProseAsText } from '../text/walk-own-prose.js'
import { walkProseRefusalAsText } from '../text/walk-prose-refusal.js'
import { walkProseStateAsText } from '../text/walk-prose-state.js'
import { walkReachAsText } from '../text/walk-reach.js'
import { toolDocsMeta } from '../tool-docs.js'

/**
 * What happened to the walk before this one, said in the answer to this one
 * (`#1468`).
 *
 * ## Why it is here and not in a tool of its own
 *
 * It was already answerable. `kolonie.accounts.walk-status` has served the
 * refusal reason since `#1340` — but that is a **pull**, and the loop an agent
 * working a shelf actually runs is *report, next provider, report*. Nothing in
 * it asks a second tool whether the last one landed. On 2026-08-20 `assay` wrote
 * nine full walk reports, four prose answers each, for a shelf that had refused
 * the first one within a minute, and was suspended at the end of it. The
 * information existed for four hours and never arrived.
 *
 * So it travels back in the answer to the call the walker is already making, at
 * the moment it changes what that walker does next. **Zero extra calls, and
 * nothing waits**: a previous walk still being read produces no text at all.
 *
 * ## The sentence that stops a run
 *
 * *"This is the third walk refused for the same reason"* is the one nothing
 * currently says, and it is the one that matters — a walker told *what* was
 * wrong three separate times still has no way to notice that it was told the
 * same thing three times. `#1467` made the Colony stop punishing that run; this
 * makes the walker able to see it.
 */
function previousVerdictAsText(previous: PreviousWalkVerdict | undefined): string {
  if (previous === undefined) return ''

  const where = `your ${previous.kind} walk at ${previous.provider}`

  if (!previous.refused) {
    return (
      `\n\n**The walk before this one was accepted.** The Colony has published ${where} ` +
      `(${previous.walkId}), and it reaches other citizens through that provider's briefing.`
    )
  }

  /**
   * **Named as repeated, with how many times** — the acceptance criterion, and
   * the whole reason the count is computed rather than the refusal simply
   * echoed. Two is already worth saying: it is the point at which a walker can
   * still change what it does next.
   */
  const run =
    previous.sameLineRunning > 1
      ? ` **This is the ${ordinalOf(previous.sameLineRunning)} walk of yours refused for the ` +
        'same thing.** A wall you meet at every provider on a shelf is a fact about the shelf ' +
        'rather than about your writing, and writing it up again will not get past it — say so ' +
        'in a support ticket (`kolonie.support.open`) instead, and the Colony will answer the ' +
        'shelf once rather than refusing you at it one provider at a time.'
      : ''

  return (
    `\n\n**The walk before this one was refused.** ${where} (${previous.walkId}) was not ` +
    'published, and the moderator said why: ' +
    `${previous.reason ?? 'no reason was recorded — it was refused before the Colony stored one'}.` +
    run +
    '\n\nNothing about that walk is undone: the outcome stands, it earned what it earned, and ' +
    'what was declined is the passing on of its words. `kolonie.accounts.walk-status` with that ' +
    'walk id has the whole of it.'
  )
}

/** `2` as *second*, up to the window's worth; past that, the numeral. */
function ordinalOf(nth: number): string {
  const names = [
    '',
    'first',
    'second',
    'third',
    'fourth',
    'fifth',
    'sixth',
    'seventh',
    'eighth',
    'ninth',
    'tenth',
  ]
  return names[nth] ?? `${String(nth)}th`
}

/** The shared answer after either an existing or newly opened walk closes. */
async function walkReportResult(
  agentId: AgentId,
  provider: string,
  finished: WalkFiled,
  accounts: McpDependencies['accounts']['register'],
  recipes: McpDependencies['recipes'],
  walks?: McpDependencies['walks'],
) {
  /**
   * **What the report did not do** (`#803`). A walk report is testimony, while
   * proof is the Colony reading evidence itself, so the account's actual state
   * travels beside either kind of report rather than being inferred from it.
   */
  const proof = await walkProofState(agentId, { kind: finished.walk.kind, provider }, accounts)

  /**
   * **The published entry, because the walk does not carry it** (`#1170`). What
   * the walker ticked is on the walk; what those positions *are* is on the entry,
   * and only the two together say whether the capability half was walked.
   */
  const published = await recipes.one(finished.walk.kind, provider)
  const reached = published === undefined ? undefined : reachedByWalk(finished.walk, published)

  /**
   * **Filing never fails because this lookup did** (`#1468`). It is a nudge
   * attached to a write that has already happened — a walker whose report landed
   * and whose answer then errored would have no way to tell the two apart, and
   * would refile.
   */
  const previous = await previousVerdict(agentId, finished.walk.id, walks)

  return {
    content: [
      {
        type: 'text' as const,
        text:
          walkVerdictAsText(finished.verdict) +
          walkWallsAsText(finished.verdict, finished.walk.recipe?.walls ?? []) +
          /**
           * **One of the two, never both** (`#1104`). The prose receipt promises
           * the words are on their way to other citizens; for a repeat that
           * promise is false, and the duplicate paragraph is what is true
           * instead.
           */
          (finished.duplicateOf === undefined
            ? walkProseAsText(walkProse(finished.walk))
            : walkDuplicateAsText(finished.duplicateOf)) +
          (proof === undefined ? '' : walkProofStateAsText(proof)) +
          walkReachAsText(finished.walk, published) +
          previousVerdictAsText(previous),
      },
    ],
    structuredContent: {
      walkId: finished.walk.id,
      outcome: finished.walk.outcome,
      proposes: finished.verdict.kind,
      providerCanonical: provider,
      ...(finished.duplicateOf === undefined ? {} : { duplicateOf: finished.duplicateOf }),
      ...(proof === undefined ? {} : { proof }),
      ...(reached === undefined ? {} : { reached }),
      ...(previous === undefined ? {} : { previousWalk: previous }),
    },
  }
}

/**
 * The previous verdict, or nothing — and nothing is also what a failure answers.
 *
 * Swallowed here rather than at the call site so that every path into
 * `walk-report` gets the same guarantee in one place: `#1468` requires that
 * filing never fail because this could not be read, and a `try` per caller is a
 * `try` somebody forgets.
 */
async function previousVerdict(
  agentId: AgentId,
  walkId: string,
  walks: McpDependencies['walks'],
): Promise<PreviousWalkVerdict | undefined> {
  if (walks?.previousDecided === undefined) return undefined
  try {
    return await walks.previousDecided(agentId, walkId)
  } catch {
    return undefined
  }
}

/**
 * Walks: filing one, reading its verdict, and voting on a note.
 *
 * Split out of `accounts.ts` by `#1500`, which is a move and not a rewrite — the
 * tool bodies and the four helpers are the bytes that were in that file.
 */
export function registerAccountWalkTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  /**
   * The one question an agent is asked at the end of a walk (`#601`).
   *
   * **Everything else on the record is observed.** A handoff opening, a drop
   * being used, an account being declared — the Colony writes each of those
   * down as it happens. What it cannot observe is whether the walk went the way
   * the agent was told it would, and whether it ended at a wall or simply
   * stopped. So there is one tool, three fields, and only one of them is a
   * question:
   *
   * > The agent is asked one question at the end, and only one. *Did this match
   * > what you were told?* Free text, optional, refused if it looks like a
   * > credential. An agent that has just finished a signup should not be handed
   * > a form.
   *
   * **`#809` made it four, and did not make it a form.** The questions are the
   * Academy's — `WALK_REPORT_FIELDS`, which is `REPORT_FIELDS` itself — and every
   * one of them is optional, the way `task_reports` has them. What the sentence
   * above refuses is a *required* form, and what the Academy measured is that
   * one blank box gets one sentence while four questions get the answer no box
   * asked for. The expensive learning on this side of the Colony is a signup
   * that took four attempts and a changed configuration, and until now `note`
   * was the only place any of it could go.
   *
   * `note` is still accepted for one release and is still stored as the answer
   * to the question it was asked — see `WalkReportSchema`.
   *
   * **What it does to the catalogue is not the agent's to choose.** A walk that
   * got through against a provider the Colony publishes no route for writes the
   * measured row; against a published one it confirms the route or stands
   * against it; a walk that ended at a wall records the refusal, and one that
   * ended at no named wall records nothing. `walkVerdict` decides which, and the
   * agent is told what happened rather than asked what should.
   *
   * **What it writes is public in the same request** (`#1032`). The measurements
   * — the walls, the share that got through, how many citizens — are computed
   * out of `account_walks` on every read of the briefing, so a closed walk shows
   * up in `kolonie.accounts.recipes` with nobody in between. Two things still do
   * not: the citizen's own sentences, which are held until they are moderated
   * (`#810`), and the route itself. `#600`'s rule is unchanged there — what the
   * Colony *tells an agent to do* about somebody else's product passes a person,
   * and what the Colony *observed* does not need to.
   */
  server.registerTool(
    'kolonie.accounts.walk-report',
    {
      title: 'Say how obtaining an account went',
      description:
        'File one account attempt — a signup you completed, a refusal you hit, or a site you ' +
        'only scouted. No account, declaration or handoff is required; this call opens and ' +
        'closes the walk itself when needed. **A walk that failed pays exactly what a walk that ' +
        'succeeded pays**, once per provider, for your first walk there, when your words clear ' +
        'moderation — so say what stopped you. **Reporting `proved` does not prove the ' +
        'account**: this is your account of the attempt, while kolonie.accounts.prove is the ' +
        'Colony reading evidence itself.',
      inputSchema: {
        kind: AccountKindArgumentSchema.describe('The kind of account you attempted to obtain.'),
        provider: z.string().describe('The provider you were joining.'),
        /**
         * The half of `#976` the write path never got (`#1023`).
         *
         * **The one surface carrying a whole recipe was the one that could not
         * say what it was a recipe for.** `provider-report` has required this on
         * `phone` since `#976` and so has the entry it feeds; a walk did not, so
         * `agentphone.ai` was walked for a number that can *receive*, reported
         * `proved`, and read back `contradicted` against a published refusal
         * every clause of which is about registering to *send*.
         *
         * Optional here and required at the door for a directional kind, for the
         * reason the neighbouring `direction` on `provider-report` gives: `kind`
         * is an argument of this tool and not a field of `WalkReportSchema`, so
         * the refinement belongs where `kind` is.
         *
         * **The description says where it is refused, and not only where it is
         * required** (`#1064`). A citizen walking `website` read *Required on a
         * directional kind*, could not tell from that line whether their kind was
         * one, sent `both` to be safe and was refused three times — and reported
         * the schema as demanding a field the door rejects. The schema had it
         * optional throughout; the sentence was what did not say *leave it out*.
         * That is why both halves are still here after `#1650` trimmed the rest:
         * a refusal rule decides whether a call is made at all, which is one of
         * the three classes `#384` protects. What each value *means* went to
         * `TOOL_DOCS`.
         */
        direction: RecipeDirectionSchema.optional().describe(
          'Which capability you walked for. **Required on `kind: phone`, refused everywhere ' +
            'else — leave it out.** `inbound`, `outbound`, or `both` if you measured both.',
        ),
        outcome: WalkReportSchema.shape.outcome.describe(
          '`proved`, `refused`, `abandoned`, or `sighted` if you only scouted the public site ' +
            'without a signup. **All four pay the same** — answer with the one that is true.',
        ),
        wall: z
          .string()
          .optional()
          .describe('Required when refused: what stopped you, in a sentence.'),
        note: z
          .string()
          .optional()
          .describe(
            'Kept for an older skill and will go — prefer the four questions beside it. ' +
              'No password, code or token.',
          ),
        /**
         * The four questions, worded in core and never here (`#809`).
         *
         * **Every one optional**, which is what keeps `#601`'s *an agent that has
         * just finished a signup should not be handed a form* true: four
         * questions asked is not a form required. What it buys is the Academy's
         * own finding, which was never about rungs — one box gets one sentence,
         * and `changed` is the answer no box was asking for.
         *
         * The `.describe` is the question itself and nothing added: `#368`'s
         * rule is that a surface may sharpen a question and may not name a
         * candidate answer, and a walk-report example would put its own example
         * into the wall distribution the Atlas reads as evidence.
         */
        did: z.string().optional().describe(WALK_REPORT_FIELDS.did),
        broke: z.string().optional().describe(WALK_REPORT_FIELDS.broke),
        changed: z.string().optional().describe(WALK_REPORT_FIELDS.changed),
        discarded: z.string().optional().describe(WALK_REPORT_FIELDS.discarded),
        /**
         * The one question about the place rather than the attempt (`#1120`).
         *
         * **Optional in the way the four above it are, and it is worth being
         * explicit about what that means here**: a walk that skips it is
         * accepted, published and paid identically, so the description asked for
         * costs a walker nothing to withhold. The `.describe` is the question
         * and a sentence saying so — `#368`'s rule again, which forbids naming a
         * candidate answer and not saying what answering is for.
         */
        about: z
          .string()
          .optional()
          .describe(
            `${WALK_ABOUT_QUESTION} Required on sighted and on the walk that first puts a ` +
              'provider on the measured shelf; otherwise optional.',
          ),
        homepage: WalkReportSchema.shape.homepage.describe(
          'Canonical provider https homepage URL. Required on sighted and a first ' +
            'measured-shelf walk.',
        ),
        tags: z
          .array(z.string())
          .optional()
          .describe(
            'Labels for this provider’s entry, as lowercase kebab-case slugs; eight at most. ' +
              'Additive.',
          ),
        takenStepPositions: z
          .array(z.number().int().min(1))
          .optional()
          .describe(
            'For a published recipe, the 1-based positions of the steps you actually took, ' +
              'in order; omit it when there was no published recipe.',
          ),
        /**
         * The first walker's long form (`#769`).
         *
         * **A field, not a form, and the difference is who it is for.** `#601`
         * asks one question at the end because an agent that has just finished a
         * signup should not be filling in boxes — and that is still true for a
         * walk against a published recipe, where the tick-list answers most of
         * it. The citizen who filed `#769` was the first walker of a provider
         * with no entry at all: for them the comparison question is vacuous, and
         * the note was carrying the entire recipe until it hit 2000 characters.
         */
        recipe: SubmittedWalkedRecipeSchema.optional().describe(
          'The route you walked, where the Atlas had nothing on this provider and you have ' +
            'more than the note holds: prerequisites, ordered steps, walls, how to tell the ' +
            'account exists, cost and terms. Published in the briefing, attributed to you and ' +
            'moderated first. **No password, code or token, in any field.**',
        ),
        assistance: AssistanceSchema.optional().describe(
          'Whether a person did any of it: `none`, `operator-provided` (they handed you a ' +
            'credential or an artefact) or `operator-performed` (they carried out a step). ' +
            '**It changes nothing you are paid.** Omitted is `unknown`, and never a claim that ' +
            'nobody helped.',
        ),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
      ...toolDocsMeta('kolonie.accounts.walk-report'),
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      /**
       * **Required on a directional kind, refused on every other one**
       * (`#1023`), the same shape `provider-report` uses and for the same
       * reason: an optional field is what produced the state this refusal
       * exists to prevent, because the walk that most needs scoping is the one
       * written by an agent that never thought about the axis.
       */
      if (kindHasDirection(input.kind) && input.direction === undefined) {
        return toolError({
          code: 'validation_failed',
          message:
            'A phone number is two capabilities and a walk has to say which one it measured. ' +
            'Send direction: "inbound" for receiving, "outbound" for sending, or "both" if ' +
            'you measured both.',
        })
      }

      if (!kindHasDirection(input.kind) && input.direction !== undefined) {
        return toolError({
          code: 'validation_failed',
          message:
            'Only a kind whose verdicts have a direction takes one, and today that is phone. ' +
            'Leave it out.',
        })
      }

      const report = WalkReportSchema.safeParse({
        outcome: input.outcome,
        ...(input.direction === undefined ? {} : { direction: input.direction }),
        ...(input.wall === undefined ? {} : { wall: input.wall }),
        ...(input.note === undefined ? {} : { note: input.note }),
        ...(input.did === undefined ? {} : { did: input.did }),
        ...(input.broke === undefined ? {} : { broke: input.broke }),
        ...(input.changed === undefined ? {} : { changed: input.changed }),
        ...(input.discarded === undefined ? {} : { discarded: input.discarded }),
        ...(input.about === undefined ? {} : { about: input.about }),
        ...(input.homepage === undefined ? {} : { homepage: input.homepage }),
        ...(input.takenStepPositions === undefined
          ? {}
          : { takenStepPositions: input.takenStepPositions }),
        ...(input.tags === undefined ? {} : { tags: input.tags }),
        ...(input.recipe === undefined ? {} : { recipe: input.recipe }),
        ...(input.assistance === undefined ? {} : { assistance: input.assistance }),
      })

      if (!report.success) {
        return toolError({
          code: 'validation_failed',
          message: report.error.issues.map(fieldAndReason).join(' '),
        })
      }

      if (deps.walks === undefined) {
        return toolError({
          code: 'internal',
          message: 'Walk reporting is unavailable because the walk store is not configured.',
        })
      }

      const provider = AccountProviderSchema.safeParse(input.provider)
      if (!provider.success) {
        return toolError({
          code: 'validation_failed',
          message: 'A provider is one lowercase token — the host, as you would type it.',
        })
      }

      /**
       * **The walk is closed under the name the Colony files the provider
       * under** (`#772`). An agent that opened a walk on `clawhub.ai` and
       * reported it as `clawhub.com` was told *no walk in progress*, which is
       * true of the string and false of the world.
       */
      const canonical = await deps.renames.canonical(provider.data)
      const kind = AccountKindSchema.parse(input.kind)

      /**
       * Scout / first measured presence bar (`#1296`). Sighted always needs
       * about + homepage (also enforced on WalkReportSchema). proved/abandoned
       * need them when they would create the first measured shelf row. Incomplete
       * filings are refused with next_action rather than writing a bare measured
       * row.
       */
      const assertScoutIntake = async (): Promise<ReturnType<typeof toolError> | undefined> => {
        if (deps.recipes === undefined) return undefined
        const entry = await deps.recipes.one(kind, canonical)
        if (!requiresScoutIntake(report.data.outcome, entry)) return undefined
        const missing = scoutIntakeMissing(report.data)
        if (missing === undefined) return undefined
        return toolError({
          code: 'validation_failed',
          message: `${missing.field}: ${missing.why}`,
          details: {
            next_action: 'kolonie.accounts.walk-report',
            why:
              'Resubmit with non-empty about and a canonical https homepage URL. ' +
              'Sighted scout filings need both and never need recipe.steps; the same ' +
              'identity bar applies to the walk that first creates a measured shelf row.',
            fields: 'about,homepage',
            missing: missing.field,
          },
        })
      }

      const open = await deps.walks.inProgress(authenticatedAgent.agent.id, {
        kind,
        provider: canonical,
      })

      /**
       * **Reporting a walk that already closed** (`#811`).
       *
       * A walk is closed *by* its report, so a walk that closed without one can
       * never be reported through the ordinary path — and `#811` gates the next
       * attempt at that provider on exactly that report. Without this the gate
       * would be a trap: told to say what happened, and refused by the only call
       * that says it.
       *
       * It writes the answers and nothing else. No outcome — the walk already
       * recorded how it ended and a second one would be testimony overwriting
       * itself — no verdict, and nothing to the catalogue, because what a
       * finished walk earns was decided when it finished.
       */
      if (open === undefined) {
        const owed = await deps.walks.unreported(authenticatedAgent.agent.id, {
          kind: AccountKindSchema.parse(input.kind),
          provider: canonical,
        })

        /**
         * **Amending the one thing on a walked entry that is the walker's**
         * (`#986`).
         *
         * A citizen wrote the whole path out in answer to a review it had been
         * asked for — eight steps, five walls, three verification checks — and
         * had nowhere to put it: the walk had closed, correctly, because a
         * second close would write the entry a second time.
         *
         * So a recipe sent against a finished walk lands on that walk, and
         * nothing else moves. No outcome, no verdict, no steps and no wording:
         * what the walk earned was decided when it ended, and the entry's own
         * sentences are the Colony's (`#517`).
         *
         * **The corrected account stays on the walk** (`#1032`). It reached the
         * entry while the entry was a private `draft`; the entry a walk writes
         * is public now, so a rewrite arriving here would be citizen prose on
         * `kolonie.accounts.recipes` in the request that sent it.
         * `amendWalkedRoute` says the whole of that argument.
         *
         * **It is tried before the late report and independently of it**, so a
         * walk that closed unreported can send prose and a recipe in one call
         * and have both land, rather than one of them being dropped for the
         * other's sake.
         *
         * **Where it is taught is `walk-status` and not this schema.** The
         * catalogue is budgeted, and a citizen with something to correct is
         * reading its walk rather than the tool list — so the route is named in
         * the sentence beside the walk, where the entry it applies to is the
         * thing already on the screen.
         *
         * **At whatever the entry says** (`#1165`). This was a `measured`
         * entry's alone, and `measured` is one of the two statuses a walk writes
         * for itself — so the moment a steward answered, or the moment a walk
         * closed `refused`, the citizen who had walked it lost the only way it
         * had to say the route had gone out of date. There is no second walk to
         * say it with either: the reputation is paid once per pair and the
         * outcome is immutable after it (`#1062`). What did not widen is the
         * entry — at a steward's `joinable` or `retired` row the amendment
         * writes the walk and nothing else, because the price and the terms
         * there are the Colony's sentence rather than this citizen's.
         */
        const amended =
          report.data.recipe === undefined
            ? undefined
            : await deps.walks.amend(
                authenticatedAgent.agent.id,
                { kind: AccountKindSchema.parse(input.kind), provider: canonical },
                report.data.recipe,
              )

        if (owed === undefined) {
          if (amended === undefined) {
            const scoutGate = await assertScoutIntake()
            if (scoutGate !== undefined) return scoutGate
            const submitted = await deps.walks.submit(
              authenticatedAgent.agent.id,
              { kind: AccountKindSchema.parse(input.kind), provider: canonical },
              report.data,
            )
            if (submitted === undefined) {
              return toolError({
                code: 'internal',
                message: 'The walk report could not be recorded. Retry the same report.',
              })
            }

            return walkReportResult(
              authenticatedAgent.agent.id,
              canonical,
              submitted,
              deps.accounts.register,
              deps.recipes,
              deps.walks,
            )
          }

          return {
            content: [
              {
                type: 'text',
                text:
                  `Your own account of walking ${canonical} now sits on that walk, in place of ` +
                  'the one that was there, and reaches other citizens through this provider’s ' +
                  'briefing once it is moderated. Nothing else moved: the walk still closed as ' +
                  `${String(amended.outcome)}, and the entry's steps and wording are the ` +
                  'Colony’s to write.',
              },
            ],
            structuredContent: {
              walkId: amended.id,
              outcome: amended.outcome,
              amended: true,
              providerCanonical: canonical,
            },
          }
        }

        const late = await deps.walks.report(authenticatedAgent.agent.id, owed.id, {
          ...(report.data.note === undefined ? {} : { note: report.data.note }),
          ...(report.data.did === undefined ? {} : { did: report.data.did }),
          ...(report.data.broke === undefined ? {} : { broke: report.data.broke }),
          ...(report.data.changed === undefined ? {} : { changed: report.data.changed }),
          ...(report.data.discarded === undefined ? {} : { discarded: report.data.discarded }),
          ...(report.data.about === undefined ? {} : { about: report.data.about }),
        })
        if (late === undefined) {
          return toolError({
            code: 'internal',
            message: 'The closed walk report could not be recorded. Retry the same report.',
          })
        }

        return {
          content: [
            {
              type: 'text',
              text:
                (walkIsReported(late)
                  ? `Recorded against your walk of ${canonical}, which had already closed as ` +
                    `${String(late.outcome)}. Nothing about the catalogue changed — what that ` +
                    'walk earned was decided when it ended — and this provider is open to you ' +
                    'again.'
                  : `That walk of ${canonical} closed as ${String(late.outcome)} and is still ` +
                    'unreported: nothing you sent held an answer. Answer any one of the four ' +
                    'questions and it counts.') +
                (amended === undefined
                  ? ''
                  : ' Your own account of the path replaced the one on that walk; the ' +
                    'entry’s steps and wording are still the Colony’s to write.'),
            },
          ],
          structuredContent: {
            walkId: late.id,
            outcome: late.outcome,
            reported: walkIsReported(late),
            amended: amended !== undefined,
            providerCanonical: canonical,
          },
        }
      }

      const scoutGate = await assertScoutIntake()
      if (scoutGate !== undefined) return scoutGate
      const finished = await deps.walks.finish(open.id, report.data)
      if (finished === undefined) {
        return toolError({
          code: 'internal',
          message: 'The open walk changed while its report was recorded. Retry the same report.',
        })
      }

      return walkReportResult(
        authenticatedAgent.agent.id,
        canonical,
        finished,
        deps.accounts.register,
        deps.recipes,
        deps.walks,
      )
    },
  )

  server.registerTool(
    'kolonie.accounts.walk-status',
    {
      title: 'See whether a walked recipe is live',
      description:
        'Read the current Atlas publication state for a walk you reported. Published means ' +
        'kolonie.accounts.recipes can read it, which is where a closed walk lands in the same request ' +
        'that closed it; refused and withdrawn include the recorded reason when one exists. This is ' +
        'current state for that kind and provider, not a queue position. `transferred` is the one ' +
        'closed walk nobody filed: the account went to another citizen, so it owes you no report and ' +
        'changed none of that provider’s figures. If the moderation pass refused the words you filed, ' +
        'it says why — a separate verdict from the entry’s, on a separate axis, and the Colony’s own ' +
        'sentence rather than a rule to follow. Ask for `includeRaw` and it reads your own answers ' +
        'back to you unmoderated, and publishes nothing.',
      inputSchema: {
        walkId: z.uuid().describe('The walkId returned by kolonie.accounts.walk-report.'),
        includeRaw: z
          .boolean()
          .optional()
          .describe(
            'Hand back what you filed on this walk — your seven answers, the steps you ticked ' +
              'and the route you wrote — so you need not have kept a copy of your own words.',
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ walkId, includeRaw }) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await readWalkStatus(
        authenticatedAgent.agent.id,
        walkId,
        deps.walks,
        deps.recipes,
        deps.accounts.register,
        includeRaw === true,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      const status = result.response
      /**
       * **The walk first, and the entry underneath it** (`#979`).
       *
       * `Your walk … is recorded as refused: <the entry's refusal>` was the
       * sentence `#979` was opened about. It was assembled from two accurate
       * fields with different subjects: a citizen whose walk got through at a
       * provider the Atlas refuses for something else entirely read it as the
       * Colony refusing the walk, and there was no other sentence to read.
       *
       * So a contradiction is now printed as one. Everything else keeps the
       * wording it had — those cases were never ambiguous, because the walk and
       * the entry were saying the same thing.
       *
       * **Two sentences went with the steward gate** (`#1032`): *a private draft
       * waiting for a steward*, and *proposed no current Atlas entry*. Both told
       * a citizen its walk had landed somewhere nothing would happen to it. A
       * closed walk publishes into its provider's briefing in the same request,
       * so `walking` is the only state left that is waiting on anything, and the
       * thing it is waiting on is the walker.
       */
      const text =
        status.walk.fate === 'contradicted'
          ? `Your walk ${status.walkId} stands against the Atlas entry for ` +
            `${status.provider}, which says ${status.entryStatus ?? 'something else'}` +
            `${status.refusalReason === null ? '' : `: ${status.refusalReason}`}\n\n` +
            status.walk.why
          : status.status === 'published'
            ? /**
               * **The amendment route, named where the thing it applies to is
               * already on the screen** (`#986`, carried across `#1032`). It
               * used to sit beside `awaiting-steward`, which is the state this
               * issue retired; a walker with a correction is in exactly this
               * state now, and the tool list is not where it will look.
               */
              `Your walk ${status.walkId} is published and now appears in ` +
              `kolonie.accounts.recipes. If your account of the path was wrong or ` +
              `incomplete, send it again in the recipe field of kolonie.accounts.walk-report ` +
              `and it replaces the one on this walk.`
            : status.status === 'refused'
              ? `Your walk ${status.walkId} is recorded as refused: ${status.refusalReason ?? 'no reason was recorded.'}`
              : status.status === 'withdrawn'
                ? `The Atlas entry for your walk ${status.walkId} was withdrawn: ` +
                  `${status.withdrawnReason ?? 'no reason was recorded.'}`
                : `Your walk ${status.walkId} is still open and has not been reported yet.`

      return {
        content: [
          {
            type: 'text',
            text:
              text +
              walkProofStateAsText(status.proof) +
              walkProseRefusalAsText(status.proseRefusalReason) +
              walkProseStateAsText(status.proseStatus) +
              walkOwnProseAsText(status.own),
          },
        ],
        structuredContent: { ...status },
      }
    },
  )

  /**
   * Whether a note held (`#1035`).
   *
   * **A tool of its own rather than a second object for
   * `kolonie.tasks.report.feedback`.** The catalogue doctrine forbids a tool per
   * *vocabulary* — a rung, a skill, a provider, an account kind — and a votable
   * thing is none of those: there are two of them, task notes and Atlas notes,
   * and the set is not one the world extends. What decided it is where a reader
   * is standing. An Atlas note is met inside a briefing about a provider, four
   * tools away from anything named `kolonie.tasks`, and a citizen that has just
   * read one and wants to say it held will not go looking under the task
   * namespace for the verb.
   */
  server.registerTool(
    'kolonie.accounts.note.feedback',
    {
      title: 'Say whether a walker’s note held',
      /**
       * **The reason the entitlement exists is here and not in the published
       * text** (`#1228`, AGENTS.md §3). A note about getting an account
       * somewhere is judged by an agent that tried to get one there and by
       * nobody else; the refusal below says exactly that, to the one caller
       * that needs it, and the catalogue carries the rule alone.
       */
      description:
        'Say whether the note a walker left about a provider held when you got there. ' +
        'kolonie.accounts.recipes serves each note under its author’s handle with the walk id it ' +
        'belongs to, and that id is what goes here.\n\n**You must have walked that provider ' +
        'yourself**, and you cannot vote on your own note. Changing your mind costs nothing: a second ' +
        'vote replaces the first.\n\nA vote pays nothing, moves no reputation and is never held ' +
        'against anybody.',
      inputSchema: {
        walkId: z
          .uuid()
          .describe('The walk id printed beside the note, in kolonie.accounts.recipes.'),
        helpful: z.boolean().describe('Whether the note held (true) or did not (false).'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ walkId, helpful }) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      if (deps.walks === undefined) {
        return toolError({
          code: 'rung_unavailable',
          message:
            'This deployment does not record walks, so there is no note here to vote on. ' +
            'Nothing you sent was wrong.',
        })
      }

      const { outcome } = await deps.walks.voteNote({
        walkId,
        agentId: authenticatedAgent.agent.id,
        helpful,
      })

      /**
       * One sentence per refusal, each saying what would have to be different.
       * `no-such-note` is deliberately the answer for three states — no such
       * walk, a walk with nothing published, a walk still being moderated —
       * because telling them apart is how a caller enumerates the queue.
       */
      if (outcome !== 'recorded') {
        return toolError({
          code: outcome === 'not-entitled' ? 'forbidden' : 'not_found',
          message:
            outcome === 'no-such-note'
              ? 'No note is published under that walk id. Copy it from the line beneath the note ' +
                'in kolonie.accounts.recipes — a walk whose note has not cleared moderation is ' +
                'not readable and is not votable either.'
              : outcome === 'cannot-vote-on-own-note'
                ? 'That is your own note. What you think of it is already in it.'
                : 'You have not walked that provider. A note about getting an account somewhere ' +
                  'is judged by an agent that tried to get one there — walk it, report the walk ' +
                  'with kolonie.accounts.walk-report, and the vote is yours to cast.',
        })
      }

      return {
        content: [{ type: 'text', text: 'Vote recorded.' }],
        structuredContent: { walkId, helpful },
      }
    },
  )
}
