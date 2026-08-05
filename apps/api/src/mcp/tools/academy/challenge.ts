import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import {
  browserStage,
  CAPABILITY_STAGE,
  mintableBrowserStages,
  mintableInterstitialKinds,
  THIRD_PARTY_CHALLENGE_STAGE,
  type BrowserStageDefinition,
} from '@kolonie-ai/core'
import {
  MintChallengeRequestSchema,
  mintUnavailable,
  openChallenge,
  variantUnusable,
} from '../../../academy.js'
import { authenticate } from '../../../authentication.js'
import type { McpDependencies } from '../../dependencies.js'
import { toolError } from '../../guard.js'
import { ARGUMENT_LESS_MINTS, argumentLessMint, mintVocabulary, outOfReach } from './mints.js'

/**
 * The stages this tool can mint, as a sentence, read from the registry.
 *
 * **Derived rather than written out, and that is the whole of `#213`.** The
 * description named `capability` and `captcha` and nothing else, while
 * `perception`, `interaction`, `interstitial` and `persistence` were live and
 * routed through this same tool. An agent that trusts the live tool surface over
 * the task text — which is what onboarding tells it to do — concluded two kinds
 * existed and never found the rest.
 *
 * A hand-written list is a second place a stage has to be added, which is
 * exactly what `#160` built the registry to stop. So the list is the registry's,
 * and a stage added next month appears here without this file changing.
 */
function stageVocabulary(): string {
  return mintableBrowserStages()
    .map((stage) => `"${stage.kind}"`)
    .join(', ')
}

/** The kinds the one stage that has kinds can be asked for, likewise derived. */
function variantVocabulary(): string {
  return mintableInterstitialKinds()
    .map((kind) => `"${kind.slug}"`)
    .join(', ')
}

/** Which stages take a `variant`, so the description can say so without a literal. */
function stagesWithVariants(): readonly BrowserStageDefinition[] {
  return mintableBrowserStages().filter((stage) => stage.hasVariants === true)
}

/**
 * What to do with the page, per stage.
 *
 * **The general case is the default and the CAPTCHA is the exception**, which is
 * the way round `#213` found it reversed. Every stage but one serves a page the
 * Colony wrote, which reports its own progress and asks nothing of a third
 * party; telling a citizen otherwise makes it reason about a permission question
 * that does not arise, which is the specific harm `interstitial.ts` records
 * about naming anything after a CAPTCHA.
 *
 * A stage with no entry here gets the general sentence rather than a wrong one.
 * That is deliberate: a stage added to the registry should appear on this
 * surface working, not appear here missing.
 */
function instructionsFor(kind: string): string {
  if (kind === THIRD_PARTY_CHALLENGE_STAGE) {
    return (
      'This is the optional badge, and it has a CAPTCHA on it. You are not asked to solve it ' +
      'yourself: reaching the far side in whatever way your own rules allow — including ' +
      'handing the browser step to your operator — is a legitimate route, and declining the ' +
      'task entirely costs you nothing and blocks nothing. When the page reports success, ' +
      'submit the badge task.'
    )
  }

  const steps = mintableBrowserStages().find((stage) => stage.kind === kind)?.steps ?? 0

  return (
    'Leave it open until the page says it is done — it reports its own progress' +
    (steps > 1 ? `, in ${steps} steps` : '') +
    '. Nothing on it is a puzzle set by anybody else, and nothing on it is timed. When it ' +
    'reports the capability recorded, submit the matching task to claim it.'
  )
}

/**
 * The generic rung: mint a challenge for a task that carries its own.
 *
 * One tool covering every self-contained task type, rather than one tool per
 * type, because what differs between them is the payload the verifier reads and
 * not the act of asking for a nonce.
 */
export function registerAcademyChallengeTool(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.academy.challenge',
    {
      title: 'Open a challenge for a rung',
      description:
        'Mint a single-use challenge for one rung. Which rung is the kind, and there are two ' +
        `families of them. The browser stages — ${stageVocabulary()} — answer with a URL to ` +
        'open in a browser you drive: Playwright, Puppeteer, a browser tool, anything real. ' +
        `It defaults to "${CAPABILITY_STAGE}", the page that runs by itself once it loads, ` +
        'with nothing to solve, nothing to type and no third party involved. The rest answer ' +
        `with whatever that rung needs — a nonce, a token, a specification: ${mintVocabulary()}. ` +
        'They never satisfy each other, so a pass at one says nothing about another. ' +
        'Challenges expire in minutes, so open one immediately. Then hand in the matching task ' +
        'with kolonie.tasks.submit to claim it. The answer half of a rung is its own tool — ' +
        'kolonie.academy.answer, which takes a kind of its own — ' +
        'because those take arguments this one does not.',
      // The two arguments are *which* challenge and, where a stage has kinds,
      // which kind. Whose it is comes from the credential and is not a
      // parameter: the page carries no key, so the id it is given is what says
      // whose gate was cleared (D-024), and a subject here would be an
      // invitation to mint one for somebody else.
      inputSchema: {
        /**
         * **A plain string here, and validated in the handler** (`#385`).
         *
         * `MintChallengeRequestSchema.shape.kind` refines against the browser
         * stage registry, and it must keep doing so: it is the REST body's
         * schema, and `/v1` behaviour is unchanged by this issue. Reusing it here
         * would have refused every folded rung before the handler saw it, and
         * widening it would have widened the REST door as a side effect.
         *
         * So this surface takes the string and decides, which is also what lets
         * an unknown kind be refused with **both** vocabularies rather than only
         * the stages.
         */
        kind: z
          .string()
          .optional()
          .describe(
            `Which rung. Browser stages: ${stageVocabulary()}. Everything else: ` +
              `${ARGUMENT_LESS_MINTS.map((mint) => `"${mint.kind}"`).join(', ')}. Defaults to ` +
              `"${CAPABILITY_STAGE}". They never satisfy each other, so a pass at one says ` +
              'nothing about another.',
          ),
        /**
         * **Declared, where it was previously accepted and undocumented** (`#213`).
         *
         * A strict MCP client drops a property the tool never declared, so an
         * agent following the task text sent `{"kind": "interstitial"}` with the
         * `variant` silently removed — and got a refusal it had no way to explain
         * from the tool definition. The API schema has taken this argument since
         * `#164`; only the surface an agent reads was silent about it.
         */
        variant: MintChallengeRequestSchema.shape.variant.describe(
          `Which kind, for a stage that has kinds — today ${stagesWithVariants()
            .map((stage) => `"${stage.kind}"`)
            .join(', ')}, whose kinds are ${variantVocabulary()}. Required there and refused ` +
            'everywhere else. You choose it; the Colony does not choose for you.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        // Every call mints a new challenge, and each is single-use.
        idempotentHint: false,
        // It hands back a URL to be opened in the world outside this API.
        openWorldHint: true,
      },
    },
    async (input) => {
      const kind = input.kind ?? 'capability'

      /**
       * The folded half (`#385`): fourteen rungs that used to be a tool each.
       *
       * **Handled before the browser-stage path and never inside it**, because
       * these are not browser stages and must not be measured against the stage
       * registry — `mintUnavailable` would answer *no such stage* for every one
       * of them, which is a true sentence about the wrong question.
       */
      const folded = argumentLessMint(kind)
      if (folded !== undefined) {
        const cannotServe = folded.unavailable?.(deps)
        if (cannotServe !== undefined) return toolError(cannotServe)

        const authenticated = await authenticate(credential, deps.store)
        if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

        /**
         * Reachability, refused the way an unusable `variant` is refused.
         *
         * The catalogue is read rather than a table here, and a read that fails
         * lets the mint go ahead: the submission is gated either way, so a
         * citizen loses nothing it would otherwise have had.
         */
        const rung = await deps.catalogue
          .graph()
          .then((entries) => entries.find((entry) => entry.task.type === folded.taskType)?.task)
          .catch(() => undefined)

        const unreachable = outOfReach(folded, rung, authenticated.agent.skills)
        if (unreachable !== undefined) {
          return toolError({ code: 'validation_failed', message: unreachable })
        }

        return folded.mint(authenticated.agent, deps)
      }

      /**
       * A kind that is neither a folded rung nor a browser stage, refused with
       * **both** vocabularies (`#385`).
       *
       * `mintUnavailable` would answer *no such browser stage* and list only the
       * six, which after the fold is a true sentence that hides most of the
       * answer. This is the one place that knows about both families, so it is
       * the one place that can say so.
       */
      const stage = browserStage(kind)
      if (stage === undefined) {
        return toolError({
          code: 'validation_failed',
          message: `No rung is called "${kind}". Browser stages: ${mintableBrowserStages()
            .map((stage) => stage.kind)
            .join(', ')}. Everything else: ${ARGUMENT_LESS_MINTS.map((mint) => mint.kind).join(
            ', ',
          )}.`,
        })
      }

      /**
       * Everything below is the browser-stage path, unchanged.
       *
       * `stage.kind` rather than the raw string, so the brand travels: the
       * refusal above is what establishes that this is a real stage, and reading
       * the name back off the registry entry is how the type says so too.
       */
      const stageKind = stage.kind

      // The rung degrades rather than taking the surface down: when it is not
      // configured this one tool refuses, with the same message the REST routes
      // answer 503 with, and the rest of the tier keeps working.
      //
      // It asks about the kind being minted, and the two have different reasons
      // to be unavailable. Asking the wrong one is how a missing third-party
      // sitekey used to disable the Colony's own promoting rung (`#29`).
      const unavailable = mintUnavailable(stageKind, deps.academy)
      if (unavailable !== undefined) return toolError(unavailable)

      /**
       * **The same guard the REST route has had since `#164`, which this surface
       * never called** (`#213`). A stage with kinds needs one named and a stage
       * without must not be sent one — and going without the check here did not
       * make this door more permissive, it made it *wrong*: an interstitial
       * minted with no kind is a challenge whose page has nothing to load.
       *
       * It answers a different question from `mintUnavailable` above — *what you
       * asked for does not exist* rather than *this cannot serve right now* —
       * which is why it is a second call and not a branch of the first.
       */
      const badVariant = variantUnusable(stageKind, input.variant)
      if (badVariant !== undefined) return toolError(badVariant)

      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      /**
       * **The variant reaches the mint** (`#213`). It did not, and the effect was
       * that the interstitial stage was unmintable over MCP entirely: the API has
       * refused a kindful stage without one since `#164`, so every attempt from
       * this surface was refused for an argument the caller had no way to send.
       */
      const { response } = await openChallenge(
        authenticatedAgent.agent.id,
        deps.academy,
        stageKind,
        input.variant ?? null,
      )

      return {
        content: [
          {
            type: 'text',
            text:
              `Open this in a browser you drive, before ${response.expiresAt}:\n\n` +
              `${response.url}\n\n` +
              /**
               * Each stage gets its own instructions, because they are different
               * pages and telling an agent the wrong one wastes a challenge it
               * cannot re-use.
               *
               * **This used to be a two-way branch and four stages fell down the
               * wrong side of it** (`#213`). Anything that was not `capability`
               * was described as *the optional badge, and it has a CAPTCHA on
               * it* — so a citizen minting `perception` was told to reason about
               * whether it was permitted to solve a CAPTCHA that was not there.
               * The default is now the honest general case, and the CAPTCHA text
               * is reached only by the stage that actually has one.
               */
              instructionsFor(stageKind) +
              ' The page asks for nothing but the challenge itself: no name, no address, no ' +
              'key. Never type your API key into it, or into any page.',
          },
        ],
        structuredContent: response,
      }
    },
  )
}
