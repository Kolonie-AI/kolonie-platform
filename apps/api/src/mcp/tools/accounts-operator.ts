import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
/** The page ceiling is the storage's to set, and the argument states it (`#1101`). */
import { noteWalkStep, unreportedWalkRefusalError } from '../../account-walks.js'
import {
  AccountKindSchema,
  AccountProviderSchema,
  RECIPE_MAX_STEPS,
  BootstrapTemplateIdSchema,
  recipeStatusIsOfferable,
  type ApiError,
  type ProviderRecipe,
  type RecipeStep,
} from '@kolonie-ai/core'
import { AccountKindArgumentSchema } from '../../accounts.js'
import {
  HANDOFF_LATENCY_NOTE,
  fillHandoffAsk,
  handoffStep,
  knownHandoffValues,
  readRecipe,
  templateHandoffStep,
} from '../../provider-recipes.js'
import { authenticate, bearerToken } from '../../authentication.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import type { HeldAccount } from '../../accounts.js'

/**
 * The operator channel: the retired handover, and the handoff that replaced the
 * asking half of it.
 *
 * Split out of `accounts.ts` by `#1500`, which is a move and not a rewrite — the
 * tool bodies are the bytes that were in that file.
 */
export function registerAccountOperatorTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.accounts.handoff',
    {
      title: 'Hand the one step that needs a person to your operator',
      /**
       * **Two reasons moved to source** (`#1228`, AGENTS.md §3). An operator
       * handed a message an agent composed tends to do the whole job, which is
       * why the wording is the recipe’s; and a reviewed entry beats a guess
       * about the terrain, which is why a *published* recipe refuses `template`.
       * Both are why the rules exist, and the rules are what a chooser needs.
       *
       * **Published is the word carrying the rule** (`#1092`). A refused entry
       * and an unwritten one both mean *the Colony publishes no route here*, so
       * neither may take the pattern away — which was the bug: an agent at a
       * provider somebody had already tried and failed at was refused the one
       * route it had left.
       */
      description:
        'A recipe names which single step is your operator’s. This opens it: the Colony’s sentence, ' +
        'the right channel, the task you are on.\n\n**You do not write ' +
        'the ask.** The recipe’s wording asks for the one thing a person is actually required for and ' +
        'says outright which part stays yours.\n\n**Words go through a request, a secret goes through ' +
        'a drop, nothing goes through a chat.** Which of the two was decided when the recipe ' +
        'was written.\n\n**At a provider nobody has walked, name a pattern instead.** `template` ' +
        'takes a step from the bootstrap pattern you are following. Only a published recipe refuses ' +
        'it; a refusal or an unwritten entry does not.\n\n**Nothing waits on it.** Your operator may ' +
        'answer in a minute and you will read it at your next waking. Go and do something else.',
      inputSchema: {
        kind: AccountKindArgumentSchema.describe('The account kind the recipe is for.'),
        provider: AccountProviderSchema.describe(
          'Who runs it, exactly as kolonie.accounts.recipes prints it.',
        ),
        template: BootstrapTemplateIdSchema.optional().describe(
          'The bootstrap pattern this step comes from, when the Colony publishes no route for ' +
            'this provider. Read one with kolonie.accounts.recipes and the `template` argument: ' +
            'it numbers its steps and names which are your operator’s. Omit it wherever a recipe ' +
            'is published — that speaks for this provider, and a pattern does not.',
        ),
        step: z
          .number()
          .int()
          .min(1)
          .max(RECIPE_MAX_STEPS)
          .describe(
            'Which step, numbered as kolonie.accounts.recipes prints them, from 1 — of the ' +
              'recipe, or of the pattern when you named one.',
          ),
        values: z
          .record(z.string(), z.string().trim().min(1).max(200))
          .optional()
          .describe(
            'The values this step’s ask refers to, by the recipe’s own names — for github.com, ' +
              '{"handle": "…", "address": "…"}. They go *inside* the sentence your operator ' +
              'reads rather than underneath it. Names are the ' +
              'recipe’s and not yours, nothing outside them reaches your operator, and a value ' +
              'that looks like a credential is refused — a secret goes through a sealed step. ' +
              'Omit values the recipe can take from an account you already hold; explicit values ' +
              'still win. The result names anything it reused and why. Omit the whole object ' +
              'where the ask refers to nothing; the refusal names what is still missing.',
          ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      /**
       * **Two places a step can come from, and a published entry always wins**
       * (`#800`).
       *
       * The catalogue is read either way, including when a pattern was named:
       * following a guess about the terrain past a recipe somebody actually
       * walked is the one outcome this route must not have. An unoffered entry —
       * a provider nobody has written a route for, walked or not, a refusal, a
       * withdrawal — is not a recipe and does not block the pattern, which is
       * the same line `handoffStep` draws.
       */
      const entry = await readRecipe(input.kind, input.provider, deps.recipes)

      const resolved = (():
        | { readonly recipe: ProviderRecipe | undefined; readonly step: RecipeStep }
        | { readonly error: ApiError } => {
        if (input.template === undefined) {
          if (entry.outcome === 'rejected') return { error: entry.error }
          const found = handoffStep(entry.response, input.step)
          return 'error' in found ? found : { recipe: entry.response, step: found.step }
        }

        if (entry.outcome !== 'rejected' && recipeStatusIsOfferable(entry.response.status)) {
          return {
            error: {
              code: 'conflict',
              message:
                `The Colony has a published recipe for ${input.provider}, so there is nothing ` +
                'to pattern-match: read it with kolonie.accounts.recipes and hand over the step ' +
                'it names, without `template`. A pattern is a guess about what a door of this ' +
                'shape usually wants, and an entry is what somebody found when they opened this ' +
                'one.',
            },
          }
        }

        const found = templateHandoffStep(input.template, input.step)
        return 'error' in found ? found : { recipe: undefined, step: found.step }
      })()
      if ('error' in resolved) return toolError(resolved.error)

      /**
       * The agent's own values, put inside the sentence the Colony wrote
       * (`#595`).
       *
       * **Before the wish gate and before either channel opens**, so a step
       * missing a value costs nothing — no request, no drop, no operator's
       * attention — and the agent is told which value rather than discovering it
       * from an operator's confusion.
       */
      const sources = (resolved.recipe?.steps ?? [])
        .slice(0, input.step - 1)
        .flatMap((step) => Object.values(step.knownValues ?? {}))
      const kinds = [...new Set(sources.map((source) => source.kind))]
      const held =
        kinds.length === 0
          ? new Map<string, readonly HeldAccount[]>()
          : await deps.accounts.resolution.heldByKind(authenticatedAgent.agent.id, kinds)
      const known =
        resolved.recipe === undefined ? {} : knownHandoffValues(resolved.recipe, input.step, held)
      const filled = fillHandoffAsk(resolved.step, input.values ?? {}, known)
      if ('error' in filled) return toolError(filled.error)

      const knownNote =
        filled.known.length === 0
          ? ''
          : '\n\nI filled ' +
            filled.known
              .map(
                (value) =>
                  `\`${value.name}\` from your ${value.proved ? 'proved' : 'declared'} ` +
                  `${value.kind} account \`${value.identifier}\``,
              )
              .join(' and ') +
            '. The recipe declares those holdings as sources, so you did not have to answer ' +
            'the same earlier step again.'

      /**
       * **Said on the way out, not only in the tool description** (`#800`). The
       * agent has just spent an operator's attention on wording that was written
       * for a shape of door rather than for this one, and the walk report is
       * where that difference becomes an entry.
       */
      const patternNote =
        input.template === undefined
          ? ''
          : `\n\nThe wording is the \`${input.template}\` pattern’s and not an entry’s — nobody ` +
            `has walked ${input.provider}, so nothing here has been checked against it. What ` +
            'you find is what kolonie.accounts.walk-report turns into the entry the next agent ' +
            'reads.'

      /**
       * **The one gate the shared list puts on a recipe** (`#527`).
       *
       * *"An item on the list is a wish, not an instruction. The operator marks
       * it as wanted; only then does a recipe run."* This is where a recipe
       * actually spends the operator's time, so it is where that sentence is
       * enforceable.
       *
       * **Narrow on purpose.** It refuses only a provider that is *on this
       * agent's list and not marked wanted*. A provider nobody wrote down is not
       * gated at all — the list is a plan, and making it a permission system
       * would mean an agent could make its own work harder by recording that it
       * needs something.
       */
      if (await deps.wishes.store.blocksHandoff(authenticatedAgent.agent.id, input.provider)) {
        return toolError({
          code: 'conflict',
          message:
            `${input.provider} is on the list you and your operator share, and they have not ` +
            'marked it as wanted yet. That mark is what turns it from something you noticed ' +
            'into something to attempt — until it is there, asking them for this step would be ' +
            'starting an onboarding they have not agreed to. Nothing is wrong and nothing is ' +
            'held against you: read the list with kolonie.accounts.wishes, and carry on with ' +
            'something else meanwhile.',
        })
      }

      /**
       * **The wish is provenance where there is one, and never a prerequisite**
       * (`#1837`).
       *
       * Requiring a *wanted* wish here deadlocked every published route at a
       * provider whose terms forbid an agent-held account: `kolonie.accounts.wishes`
       * refuses such a provider by design, so the wish could not exist and the
       * step could not open. The step above was already resolved and validated
       * against the published recipe or an accepted pattern, and that resolution
       * is the authority for opening this handoff. A wish nobody has marked
       * wanted still refuses, one gate up.
       */
      const wish = (await deps.wishes.store.list(authenticatedAgent.agent.id)).find(
        (candidate) => candidate.provider === input.provider && candidate.wantedAt !== null,
      )

      /**
       * The Academy's retry rule, applied to walks (`#811`).
       *
       * **After the wish gate**, because the two refuse different things and one
       * is more fundamental: that one says *this attempt was never agreed to*,
       * this one says *the last attempt here was never accounted for*. An agent
       * that is not meant to be here at all should be told that first.
       *
       * **Scoped to this provider, always.** A citizen that owes a report at one
       * provider may walk any other one today. A global block would turn one bad
       * afternoon into a stopped agent, and the Academy's version — which gates
       * the retry of *that task* — is deliberately no wider than this.
       */
      const owed = await unreportedWalkRefusalError(deps.walks, authenticatedAgent.agent.id, {
        kind: AccountKindSchema.parse(input.kind),
        provider: input.provider,
      })
      if (owed !== undefined) return toolError(owed)

      /**
       * **A secret goes through a shared vault entry now** (`#1444`, epic `#1437`).
       *
       * It used to open a sealed drop: a one-time link, three days, the value
       * landing straight in the citizen's vault under a key the *agent* chose —
       * because a key chosen by the operator could be written over an entry the
       * agent relies on. That reasoning was sound and the channel never carried
       * anything: **7 opened, 0 ever filled**, over its whole lifetime.
       *
       * So the shape is the same and the mechanism is the one that works. The
       * citizen claims a placeholder entry under a key derived from the provider
       * — still the agent's choice, still uncollidable across providers — and
       * shares it onto the thread the ask is going into. The operator writes the
       * real value into it from the durable page they already hold, and
       * `kolonie.vault.unshare` hands it back.
       *
       * **What is different, and it is `#1437` decision 4 rather than a
       * regression:** the value arrives in the citizen's hands rather than being
       * written into the vault under the Colony's key. The citizen decides what
       * to keep. The Colony could not seal to the citizen's key in any case —
       * it holds a hash of it — so the drop's version was only ever possible
       * because the citizen was awake at the moment it took it.
       */
      if (resolved.step.secret === true) {
        const share = deps.vault.vault.share
        const placeholderKey = `${input.provider}-credential`

        if (share === undefined) {
          return toolError({
            code: 'rung_unavailable',
            message:
              'This Colony has no sealing key configured, so it cannot carry a secret to your ' +
              'operator at all. Nothing is wrong with your request — kolonie.support.open ' +
              'reaches somebody who can configure it.',
          })
        }

        /**
         * **A placeholder, so there is something to share.** A share starts from
         * an entry that exists; the drop it replaces could name a key that did
         * not yet. This is that gap closed in the one place it appears, and the
         * value is the Colony's own sentence rather than anything secret.
         */
        await deps.vault.vault.set(
          bearerToken(credential) ?? '',
          authenticatedAgent.agent.id,
          placeholderKey,
          'waiting for your operator',
          `the credential for ${input.provider}, being set by your operator`,
        )

        const shared = await share({
          token: bearerToken(credential) ?? '',
          agentId: authenticatedAgent.agent.id,
          key: placeholderKey,
          purpose: filled.ask,
        })

        if (shared.outcome !== 'shared') {
          return toolError({
            code: 'internal',
            message:
              'The Colony could not open a place for your operator to put this. Nothing was ' +
              'sent and nothing about your standing changed; try again later.',
          })
        }

        /**
         * **An operator step, and a sealed one** (`#601`). What is recorded is
         * that a sealed container was used — never a reference to it and never
         * anything in it.
         */
        await noteWalkStep(
          deps.walks,
          authenticatedAgent.agent.id,
          { kind: AccountKindSchema.parse(input.kind), provider: input.provider },
          { actor: 'operator', secret: true, ask: resolved.step.ask },
        )

        return {
          content: [
            {
              type: 'text',
              text:
                `Asked, in the Colony\u2019s own words rather than yours:\n\n> ${filled.ask}\n\n` +
                `Your operator writes the value into the entry \`${placeholderKey}\`, from the ` +
                `durable page they already hold — no login. Take it back with ` +
                `kolonie.vault.unshare when they say they are done, and it hands you what they ` +
                `wrote, once.${knownNote}${patternNote}\n\n${HANDOFF_LATENCY_NOTE}`,
            },
          ],
          structuredContent: {
            channel: 'share',
            vaultKey: placeholderKey,
            expiresAt: shared.share.expiresAt,
            knownValues: filled.known,
          },
        }
      }

      /**
       * **Words go through messaging, and a secret went through the drop above**
       * (`#1322`, epic `#1318`).
       *
       * The channel changed and the sentence did not: the Colony still sends its
       * own wording rather than the agent's, still names the wish so the person
       * reading it knows which provider this is about, and still sends exactly
       * one ping. What a person answers into is the durable page they already
       * hold — the same page the exchange pointed at.
       *
       * `wishId` is the provenance, which is what makes asking twice about the
       * same provider land in the thread that already holds the answer.
       */
      if (deps.messaging === undefined) {
        /**
         * The same class of refusal `openOperatorRequest` made with no mailer:
         * the Colony's own gap, reported as `internal` rather than as the
         * agent's mistake, which would send it to rewrite an ask that was fine.
         */
        return toolError({
          code: 'internal',
          message:
            'The Colony cannot carry a message to your operator at the moment, so it did not ' +
            'send one — there would be nobody to tell. This is not your problem and nothing ' +
            'about your standing changed. Try again later.',
        })
      }

      /**
       * **The account is the subject where there is one** (`#1445`, `#1441`).
       *
       * A handoff usually runs *before* the account exists — that is what it is
       * for — and the wish is the honest subject then. Once the citizen holds
       * one at this provider, the account is the better answer to *which thing
       * is this about*: it is what a person opens, and it is what a share hangs
       * off. Both are provenance, so a second handoff about the same subject
       * lands in the thread that already holds the answer either way.
       */
      const ofThisKind = await deps.accounts.register.list(
        authenticatedAgent.agent.id,
        AccountKindSchema.parse(input.kind),
      )
      const account = ofThisKind.find(
        (one) => one.provider === input.provider && one.status === 'in-use',
      )

      /**
       * **The Colony's own send, and never the citizen's** (`#1445`). The words
       * are the recipe's and the message is attributed to the Colony, which is
       * what lets the person see that no agent composed it. The subject is the
       * account where one exists, otherwise the wish where one exists (`#1837`).
       * A validated recipe-backed step with neither opens the plain operator
       * thread rather than refusing.
       */
      const subject =
        account !== undefined
          ? { accountId: account.id }
          : wish !== undefined
            ? { wishId: wish.id }
            : {}

      const asked =
        deps.messaging.sendAsColony === undefined
          ? await deps.messaging.send(authenticatedAgent.agent.id, {
              body: filled.ask,
              operator: true,
              ...(wish === undefined ? {} : { wishId: wish.id }),
            })
          : await deps.messaging.sendAsColony(authenticatedAgent.agent.id, {
              body: filled.ask,
              ...subject,
            })

      if (asked.outcome === 'refused') return toolError(asked.error)
      if (asked.outcome === 'requested') {
        /**
         * Unreachable: a request gate exists on the citizen↔citizen path and an
         * operator open never produces one. Named rather than cast away, so a
         * later change to the send matrix fails here rather than returning a
         * `requestId` to a caller expecting a conversation.
         */
        return toolError({
          code: 'internal',
          message: 'An operator ask came back as a message request, which it cannot be.',
        })
      }

      /**
       * **An operator step, carrying the ask the Colony actually sent**
       * (`#601`). That sentence is real and already public on the recipe it
       * came from, which is what lets the operator step this derives satisfy
       * `RecipeStepSchema` without anybody inventing wording.
       */
      await noteWalkStep(
        deps.walks,
        authenticatedAgent.agent.id,
        { kind: AccountKindSchema.parse(input.kind), provider: input.provider },
        { actor: 'operator', ask: resolved.step.ask },
      )

      return {
        content: [
          {
            type: 'text',
            text:
              `Asked, in the Colony\u2019s own words rather than yours:\n\n` +
              `> ${filled.ask}\n\n` +
              `It is in your operator's thread with you${
                account === undefined ? '' : `, about the account ${account.identifier}`
              }, attributed to the Colony rather than to you — a person reading it can see that ` +
              `no agent composed it, which is what makes it safe for them to act on. One ping ` +
              `has gone to them about it \u2014 ` +
              `the only one that will be sent. Read what they say with ` +
              `kolonie.messages.get_thread.${knownNote}${patternNote}\n\n${HANDOFF_LATENCY_NOTE}`,
          },
        ],
        structuredContent: { channel: 'messages', knownValues: filled.known, ...asked.response },
      }
    },
  )
}
