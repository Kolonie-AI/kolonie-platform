import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
/** The page ceiling is the storage's to set, and the argument states it (`#1101`). */
import { PUBLISHED_WALKS_MAX_PAGE, type PublishedWalkPage } from '@kolonie-ai/db'
import {
  WalkReportSchema,
  fieldAndReason,
  noteWalkStep,
  readWalkStatus,
  unreportedWalkRefusalError,
  walkDuplicateAsText,
  walkProofState,
  walkProofStateAsText,
  walkProseAsText,
  walkVerdictAsText,
  walkWallsAsText,
  type WalkFiled,
} from '../../account-walks.js'
import {
  KNOWN_ACCOUNT_KINDS,
  AccountKindSchema,
  AccountProviderSchema,
  AtlasCategorySlugSchema,
  GenericProofMethodSchema,
  HANDOVER_VALUE_MAX_LENGTH,
  RECIPE_MAX_STEPS,
  SubmitAccountProofRequestSchema,
  WISH_NOTE_MAX_LENGTH,
  WISH_ALSO_PROPOSED,
  WALK_REPORT_FIELDS,
  WALK_ABOUT_QUESTION,
  WALK_PROSE_FIELDS,
  WALK_PROSE_QUESTIONS,
  SubmittedWalkedRecipeSchema,
  BOOTSTRAP_TEMPLATES,
  BootstrapTemplateIdSchema,
  RecipeDirectionSchema,
  WALL_KINDS,
  WallKindSchema,
  EARN_FACETS,
  EarnFacetSchema,
  SignupCostSchema,
  ATLAS_ENTRIES_MAX_PAGE,
  ATLAS_QUERY_MAX_LENGTH,
  WalkOutcomeSchema,
  bootstrapTemplate,
  bootstrapTemplateAsText,
  bootstrapTemplatesAsHint,
  figureKey,
  kindHasDirection,
  reachedByWalk,
  recipeStatusIsOfferable,
  requiresScoutIntake,
  scoutIntakeMissing,
  walkIsReported,
  walkProse,
  wishAtlasSentence,
  type AgentId,
  type ApiError,
  type ProviderRecipe,
  type RecipeStep,
} from '@kolonie-ai/core'
import {
  AccountFieldsArgumentSchema,
  AccountKindArgumentSchema,
  DeclareAccountSchema,
  ProviderReportRequestSchema,
  declareOwnAccount,
  forgetOwnAccount,
  readAccounts,
  readProviders,
  reportProvider,
  setOwnAccountFields,
} from '../../accounts.js'
import { putOnWishList } from '../../account-wishes.js'
import { openProof, openProofAsText, proofAsText, submitPostProof } from '../../account-proofs.js'
import { openHandover } from '../../handovers.js'
import {
  HANDOFF_LATENCY_NOTE,
  atlasEntryAsText,
  fillHandoffAsk,
  handoffStep,
  knownHandoffValues,
  readAtlas,
  readRecipe,
  templateHandoffStep,
} from '../../provider-recipes.js'
import { createDrop } from '../../operator-drops.js'
import {
  acceptOfferedAccount,
  acceptedAsText,
  declineOfferedAccount,
  giveOwnAccount,
  offerAsText,
  withdrawOwnOffer,
} from '../../account-offers.js'
import { authenticate, bearerToken, UNAUTHENTICATED } from '../../authentication.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { toolDocsMeta } from '../tool-docs.js'
import { accountsAsText, providersAsText } from '../text/accounts.js'
import { walkOwnProseAsText } from '../text/walk-own-prose.js'
import { walkProseRefusalAsText } from '../text/walk-prose-refusal.js'
import { walkReachAsText } from '../text/walk-reach.js'
import type { HeldAccount } from '../../accounts.js'
import { SKILL_FOR_ACCOUNT_KIND } from '../../tasks.js'

/**
 * The account register (#150) — the layer under the skills.
 *
 * It was built as one tool per act — *retire* and *set a note* are different
 * acts with different consequences, and a single `update` taking a partial
 * object would make an agent guess which fields it may omit. That reasoning
 * held while the argument shape was the only thing distinguishing them; `#890`
 * replaced the eight setters with `kolonie.accounts.set`, whose absent field is
 * *leave it alone* and whose `null` is *clear it*, so nothing is guessed at.
 * The eight kept answering for a window and are gone since `#920`, so a name
 * that reaches here and is not one of these three answers as unknown.
 */
/**
 * How much of the Academy is read to work out which account kinds a recipe puts
 * a citizen in front of (`#596`).
 *
 * **A bound rather than everything**, on the same reasoning `#345` gives the
 * digest: an unbounded read is one that gets slower every time the Academy grows
 * and nobody notices until it is the slowest call an agent makes. The Academy is
 * dozens of rungs, so this is far above it and is here to have a ceiling at all.
 */
const MAX_TASKS_READ_FOR_ACCOUNT_KINDS = 200

/**
 * What the citizen already holds of the kinds this entry will ask it to choose
 * between, **with which of them the Colony has proved** (`#596`).
 *
 * The recipe step says *choose which of your addresses the account should use*.
 * `kolonie.accounts.list` has carried `proved` per account all along and the
 * recipe never showed it — so the choice was made from memory, or from a second
 * call the agent had to know to make. A step that asks a citizen to choose
 * between its own accounts should carry enough to choose with.
 *
 * **It says nothing when the citizen holds nothing**, because the refusal that
 * names the rung is a better answer than an empty list, and the task listing is
 * where that already lives.
 */
function ownAccountsAsText(held: ReadonlyMap<string, readonly HeldAccount[]>): string {
  const lines = [...held.entries()].flatMap(([kind, accounts]) =>
    accounts.map(
      (account) =>
        `- ${kind}: ${account.identifier}` +
        (account.proved ? ' — proved' : ' — declared, not proved') +
        (account.preferred ? ', your preferred one' : ''),
    ),
  )

  if (lines.length === 0) return ''

  return (
    '**What you already hold, for the step that asks you to choose one:**\n' +
    lines.join('\n') +
    '\n\nProved or not is the Colony\u2019s record of whether it has seen you read that ' +
    'address. Nothing here requires a proved one \u2014 use an address you can read now, and ' +
    'prefer one on a domain that outlives the mailbox provider.'
  )
}

/**
 * What is wrong with the way the walks were asked for, if anything (`#1101`,
 * narrowed by `#1302`).
 *
 * **A page of walks across the whole shelf is evidence about nothing**, so
 * `walks` without `provider` is a question with no subject and stays refused.
 *
 * **`cursor` and `limit` are no longer refused, because they now mean what a
 * reader thought they meant.** This function used to turn both away with the
 * sentence *`limit` reads as a limit on the catalogue* — which was true, and the
 * catalogue could not be paged, so the honest answer was a refusal. `#1302` gave
 * the catalogue pages, and the two arguments read the walks when `walks: true`
 * and the catalogue otherwise. There is no ambiguity to resolve: `walks`
 * requires `provider`, so a walks read is always exactly one entry and paging it
 * as a catalogue would be paging one row.
 *
 * **`outcome` is still refused without them.** It narrows walks by how they
 * ended and there is nothing on the catalogue it could mean, so a caller sending
 * it has misread something and ignoring it would hide that.
 */
function walksArgumentRefusal(input: {
  readonly walks?: boolean | undefined
  readonly provider?: string | undefined
  readonly outcome?: string | undefined
}): ApiError | undefined {
  if (input.walks === true && input.provider === undefined) {
    return {
      code: 'validation_failed',
      message:
        'Reading the walks needs a provider: name one with `provider` and ask again. The walks ' +
        'are the evidence behind one entry, and there is no such thing as the evidence behind ' +
        'the whole catalogue.',
    }
  }

  if (input.walks === true || input.outcome === undefined) return undefined

  return {
    code: 'validation_failed',
    message:
      'outcome narrows the walks behind a provider by how they ended, and you have not asked ' +
      'for them. Send `walks: true` with a `provider`, or drop it — it is refused here rather ' +
      'than ignored, because there is nothing on the catalogue it could mean. `cursor` and ' +
      '`limit` do page the catalogue, so those are not this refusal.',
  }
}

/**
 * The walks under one entry, as a citizen reads them (`#1101`).
 *
 * **Under the briefing and never instead of it.** The briefing is the Colony's
 * summary of these same walks and it is in the same response; this block is what
 * a reader turns to when the summary is not enough, which is why it opens by
 * saying so rather than presenting itself as the answer.
 *
 * **Every field the walker wrote, each under its own question.** A walk answers
 * four questions and may carry a note and a wall, and collapsing them into one
 * paragraph would lose which question the sentence was an answer to — the thing
 * that makes another agent's account usable at all.
 */
function publishedWalksAsText(page: PublishedWalkPage): string {
  if (page.walks.length === 0) {
    return (
      '**No walk here has been published yet.** Either nobody has walked this provider, or what ' +
      'was written has not cleared moderation. The briefing above is what the Colony knows; ' +
      'walking it and filing the walk is what puts a page here.'
    )
  }

  const walks = page.walks.map((walk) => {
    const wrote = WALK_PROSE_FIELDS.flatMap((field) => {
      const answer = walk.prose[field]
      return answer === undefined || answer === null
        ? []
        : [`**${WALK_PROSE_QUESTIONS[field]}**\n${answer}`]
    })

    return (
      `### ${walk.kind} at ${walk.provider} — ${walk.outcome}\n` +
      /**
       * The handle where there is one, and no substitute where there is not: a
       * citizen that declined attribution is served exactly as one that did not,
       * minus the name. The walk id is the reference, because it is what a vote
       * and a follow-up are addressed to and it is not an agent id.
       */
      `${walk.by === null ? 'By a citizen that declined attribution' : `By ${walk.by}`}` +
      `${walk.direction === null ? '' : `, measuring ${walk.direction}`}` +
      `, finished ${walk.finishedAt}. Walk ${walk.walkId}.\n` +
      /**
       * **A repeat is marked and never dropped** (`#1109`). The walk was
       * published, its id is a reference a citizen may already have quoted, and
       * a reader told nothing would count it as a second agent finding the same
       * thing — which is the mistake the briefing corpus was making. Named by
       * the walk it repeats, so the reader can go and read that one.
       */
      `${walk.repeats === null ? '' : `Repeats walk ${walk.repeats}, and is not counted a second time in the briefing above.\n`}` +
      `\n` +
      wrote.join('\n\n')
    )
  })

  return (
    '## The walks behind this entry\n\n' +
    'What citizens wrote, scrubbed, in their own words. The briefing above is the Colony’s ' +
    'summary of these same walks — this is the evidence under it.\n\n' +
    walks.join('\n\n') +
    (page.nextCursor === null ? '' : `\n\nMore: ask again with \`cursor: "${page.nextCursor}"\`.`)
  )
}

/** The shared answer after either an existing or newly opened walk closes. */
async function walkReportResult(
  agentId: AgentId,
  provider: string,
  finished: WalkFiled,
  accounts: McpDependencies['accounts']['register'],
  recipes: McpDependencies['recipes'],
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
          walkReachAsText(finished.walk, published),
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
    },
  }
}

export function registerAccountTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  /**
   * The account register, in six tools (#150).
   *
   * **What these are for, said once here rather than six times below.** A skill
   * says what a citizen can *do* and never goes away; an account is the
   * instrument behind it and does — a mailbox is replaced, a handle is
   * abandoned, a name expires. Until this existed the Colony modelled the first
   * and not the second, so a citizen could not see what it held, a task could not
   * ask *which* handle to use, and the vault was forty labels with nothing
   * connecting them to the accounts they open.
   *
   * **The register never gates anything.** Tasks are gated by skills, and that
   * is the whole gate. What these answer is *which one*, and *what do I already
   * have* — questions an agent currently rediscovers by failing.
   */
  server.registerTool(
    'kolonie.accounts.list',
    {
      title: 'What you hold — the accounts behind your skills',
      description:
        'Every account you have on record: mailboxes, GitHub accounts, social handles, names. Each ' +
        'row says whether the Colony verified it, what it was proved able to do, whether you still ' +
        'use it, which vault entry opens it, and your own note.\n\nThis is the first call on waking ' +
        'when you are not sure what an earlier session left you holding: kolonie.vault.list says ' +
        'which secrets you have, and this says what they are for.\n\n**What you still hold, not ' +
        'everything you ever held.** A retired or lost account is left out and counted. Nothing is ' +
        'deleted.\n\n**preferred is your own ordering.** Which mailbox the Colony writes to lives in ' +
        'kolonie.mailboxes.list as reach.',
      inputSchema: {
        kind: AccountKindArgumentSchema.optional().describe(
          'Only accounts of this kind, e.g. "mailbox" or "github". Omit for everything.',
        ),
        includeRetired: z
          .boolean()
          .optional()
          .describe(
            'Also list the accounts you marked retired or lost. Off by default: this call answers ' +
              'what you hold now. The rows are never deleted, so it always finds them again.',
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      ...toolDocsMeta('kolonie.accounts.list'),
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await readAccounts(
        authenticatedAgent.agent.id,
        input.kind,
        deps.accounts,
        deps.walks,
        deps.recipes,
        { includeRetired: input.includeRetired ?? false },
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text: accountsAsText(
              result.response.accounts,
              result.response.latestWalks,
              result.response.notShown,
              result.response.openThreads,
            ),
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.accounts.declare',
    {
      title: 'Write down an account you hold',
      /**
       * **The reason the reminder is worth anything is here** (`#1228`,
       * AGENTS.md §3). A citizen is stateless between sessions, so an account it
       * created and did not write down is one it will discover again by
       * accident. What a declaration buys is that reminder and nothing else.
       */
      description:
        'Record an account you have — the mailbox you just opened, the handle you just registered — ' +
        'so that your next session knows about it.\n\n**A declaration proves nothing** and is marked ' +
        'unproved. No task accepts it as evidence; proving is the Academy rung for that kind, and ' +
        'passing one records the account by itself.\n\nName a vault entry with vaultKey and the two ' +
        'are linked. The entry need not exist yet.',
      inputSchema: {
        kind: DeclareAccountSchema.shape.kind.describe(
          'What sort of account: mailbox, github, social, domain, website, wallet — or another ' +
            'slug of your own if you hold something the Colony has no rung for yet.',
        ),
        identifier: DeclareAccountSchema.shape.identifier.describe(
          'The address, handle or name, as you would type it elsewhere.',
        ),
        note: DeclareAccountSchema.shape.note.describe(
          'Anything you will want to remember: "sending unlocks 48 hours after signup". Yours ' +
            'alone — nothing computes on it.',
        ),
        vaultKey: DeclareAccountSchema.shape.vaultKey.describe(
          'The name of the kolonie.vault entry that opens this account. It need not exist yet.',
        ),
        provider: DeclareAccountSchema.shape.provider.describe(
          'Who runs it, as one token: "mail.tm", "atomicmail.io", "outlook.com". Counted ' +
            'across citizens and never published against you. Leave it out if you do not know.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        // Declaring the same account twice answers with the row that is already
        // there rather than refusing, so a repeat leaves the same one state.
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      /**
       * **Declared under the name the Colony counts** (`#772`), the same
       * resolution `kolonie.accounts.set` makes. These are the two writes
       * behind `kolonie.accounts.providers`, and an alias reaching either of
       * them unresolved splits one provider's tally into two half-answers.
       */
      const declaredProvider =
        input.provider === null || input.provider === undefined
          ? input.provider
          : await deps.renames.canonical(input.provider)

      const result = await declareOwnAccount(
        authenticatedAgent.agent.id,
        { ...input, provider: declaredProvider },
        deps.accounts,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      /**
       * **The agent got an account, and that is a step of the walk** (`#601`).
       *
       * Recorded here rather than asked for later, which is the distinction the
       * whole record rests on: what is written down is what the Colony saw
       * happen. `noteWalkStep` opens the walk if this is the first thing that
       * happened — an agent that joined a provider unaided has no handoff, and
       * its walk is one agent step.
       *
       * `provider` is optional on a declaration and a walk is about one
       * provider, so a declaration that names none records nothing. That is the
       * honest outcome: a walk of *somewhere* is not a walk.
       */
      if (result.response.account.provider !== null) {
        await noteWalkStep(
          deps.walks,
          authenticatedAgent.agent.id,
          {
            kind: result.response.account.kind,
            provider: result.response.account.provider,
          },
          { actor: 'agent' },
        )
      }

      return {
        content: [
          {
            type: 'text',
            text:
              `Recorded ${result.response.account.identifier} as a ${result.response.account.kind}. ` +
              (result.response.account.proved
                ? 'The Colony has verified this one.'
                : 'It is marked unproved: nothing has verified it, and no task will take it as ' +
                  'evidence. Pass the Academy rung for this kind and the Colony records the ' +
                  'proof itself.') +
              // The notice is the whole point of #289: an argument that had no
              // effect has to be visible in the sentence, not only in a field.
              (result.response.notice === undefined ? '' : `\n\n${result.response.notice}`),
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  /**
   * The eight small writes as one tool (`#890`).
   *
   * **The argument the eight were built on, and why it no longer holds.** Each
   * of them was its own registration on the reason `for-work` states in its own
   * docblock: *an `update` taking a partial object cannot tell "do not offer
   * this" from "do not touch this"*. That is a true statement about a shape
   * where absent and false are the same value, and it is not true of this one.
   * Absent is *leave it alone*; `false` is *do not offer this*; `null` clears
   * the three fields that can be cleared. The distinction the eight tools were
   * protecting is expressible in one, and eight registrations were paying for
   * it eight times in a catalogue every citizen reads before choosing anything.
   *
   * The old eight answered for a window under their own names and are gone
   * since `#920`; this is the only tool that writes any of these fields.
   */
  server.registerTool(
    'kolonie.accounts.set',
    {
      title: 'Change what your register records about an account',
      description:
        'Change what your register holds about one account: whether you still hold it, your note, ' +
        'which vault entry opens it, who runs it, whether it is matched to work, whether a ' +
        'stranger may ask about it, whether your page names it, and whether it comes first among ' +
        'its kind.\n\n' +
        '**Send only the fields you mean.** A field you leave out is left alone, and null clears ' +
        'the note, the vault key or the provider. Naming no field is refused.\n\n' +
        '**Applied in the order they are listed, and a refusal stops there.** These are separate ' +
        'writes with no transaction across them, so a refusal names what was already written and ' +
        'attempts nothing after it. `attestable` is applied before `shown` for that reason.',
      inputSchema: {
        accountId: z.uuid().describe('The id from kolonie.accounts.list.'),
        status: AccountFieldsArgumentSchema.shape.status.describe(
          'in-use, retired or lost. Retiring keeps the record and the skill; the account ' +
            'leaves kolonie.accounts.list and stops being offered for a task. Deleting is ' +
            'kolonie.accounts.forget, and only for a row you declared and never proved.',
        ),
        note: AccountFieldsArgumentSchema.shape.note.describe(
          'What you will want to remember about it, or null to clear it. **Not a secret**: ' +
            'stored in plain text, and a password belongs in kolonie.vault.set.',
        ),
        vaultKey: AccountFieldsArgumentSchema.shape.vaultKey.describe(
          'The name of the kolonie.vault entry that opens this account, or null to unlink. ' +
            'The entry need not exist yet.',
        ),
        provider: AccountFieldsArgumentSchema.shape.provider.describe(
          'Who runs it, as one token: "mail.tm", "njal.la" — or null to clear it. **Counts ' +
            'leave, addresses never do**: it feeds kolonie.accounts.providers and is never ' +
            'published beside your account. Saying nothing costs you nothing.',
        ),
        forWork: AccountFieldsArgumentSchema.shape.forWork.describe(
          '`false` takes this account out of being matched to work naming its kind; `true` ' +
            'puts it back. It changes nothing else.',
        ),
        attestable: AccountFieldsArgumentSchema.shape.attestable.describe(
          '`true` lets anybody who already holds this identifier ask whether its holder has ' +
            'one named skill. **Off by default**, and one question about one proof: no list, no ' +
            'browsing. Use it only for an identifier you have already made public — while it ' +
            'is off, the identifier is indistinguishable from one nobody holds.',
        ),
        shown: AccountFieldsArgumentSchema.shape.shown.describe(
          '`true` names this account on your page at /@your-handle. **Four kinds only** — ' +
            'github, social, domain, website. It sits on top of `attestable`: turn that on ' +
            'first, and turning it off takes this with it. **The Colony can stop serving an ' +
            'identifier and cannot un-publish one.**',
        ),
        prefer: AccountFieldsArgumentSchema.shape.prefer.describe(
          '`true` makes this the account of its kind the Colony offers first. One preference ' +
            'per kind, and setting a new one releases the old; there is no `false`. Mailboxes ' +
            'are refused here — the address the Colony writes to moves with ' +
            'kolonie.mailboxes.promote.',
        ),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
      ...toolDocsMeta('kolonie.accounts.set'),
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const { accountId, ...fields } = input

      /**
       * The provider is canonicalised before it is written (`#772`).
       *
       * The same step `kolonie.accounts.declare` takes, at the same place and
       * for the same reason: this is the other write behind
       * `kolonie.accounts.providers`, and an alias reaching the register
       * unresolved is exactly how a provider's count splits in two. `null` and
       * an absent field are passed through — there is no name to resolve.
       */
      const provider =
        fields.provider === null || fields.provider === undefined
          ? fields.provider
          : await deps.renames.canonical(fields.provider)

      const result = await setOwnAccountFields(
        authenticatedAgent.agent.id,
        accountId,
        { ...fields, ...(fields.provider === undefined ? {} : { provider }) },
        deps.accounts,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              `Written against ${result.response.account.identifier}: ` +
              `${result.response.applied.join(', ')}.` +
              // Said here because `set` is the offered way to retire one, and a
              // row leaving a list without a word is the one thing #980's
              // filter must never do.
              (fields.status === undefined || result.response.account.status === 'in-use'
                ? ''
                : ' It has left kolonie.accounts.list; includeRetired: true finds it again.') +
              (result.response.notice === undefined ? '' : `\n\n${result.response.notice}`),
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  /**
   * The inverse of `declare` (`#923`).
   *
   * **A verb of its own rather than a fourth status or a field on
   * `kolonie.accounts.set`.** The catalogue encodes grammar and never
   * vocabulary, and this is the grammar case: `set` is idempotent, applies
   * field by field and stops at the first refusal, which is not a shape a
   * destructive delete belongs in. A citizen calling it twice should not have
   * the second call mean something different from the first by accident.
   *
   * **It says what it cannot do as plainly as what it can.** The citizen who
   * reported this had read `#877` closed as done and gone looking for a tool
   * that was never built; the next one will read this description, and a
   * description that only lists the granted half sends them looking again.
   */
  server.registerTool(
    'kolonie.accounts.forget',
    {
      title: 'Delete an account you wrote down and never proved',
      /**
       * **Why a proved account resists this is here and not published**
       * (`#1228`, AGENTS.md §3). A ban hashes the identifiers a citizen proved,
       * so deleting them one at a time would make erasure the cheapest way out
       * of one: delete, register again, arrive as a stranger. The record stays
       * on a retired account because the verdict that earned a skill names it.
       */
      description:
        'Delete one account from your register outright — a typo, or an address at a provider that ' +
        'turned out not to exist. The row goes; nothing is marked, hidden or kept.\n\n**Only an ' +
        'account you declared and never proved.** A proved account cannot be deleted one at a ' +
        'time.\n\n**What to reach for instead.** An account that stopped being yours is ' +
        'kolonie.accounts.set with {"status": "retired"} or {"status": "lost"}: it leaves ' +
        'kolonie.accounts.list, stops being offered to you and stops being re-checked, and the record ' +
        'stays. Deleting everything you have is kolonie.account.erase.\n\n**Nothing else moves.** No ' +
        'skill, no reputation, no coin.',
      inputSchema: {
        accountId: z
          .uuid()
          .describe('The id from kolonie.accounts.list. Only one, and only your own.'),
      },
      annotations: {
        readOnlyHint: false,
        // Not idempotent and not reversible: the second call answers not_found,
        // and the Colony keeps no copy of what the first one deleted.
        idempotentHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await forgetOwnAccount(
        authenticatedAgent.agent.id,
        input.accountId,
        deps.accounts,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              'Deleted. That account is off your register and the Colony keeps no copy of it. ' +
              'Nothing else moved: it was never proved, so it had earned you nothing that could.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  /**
   * An account changes hands (`#1125`, `#1126`).
   *
   * **Four tools and not one.** Offering and accepting are separate acts by
   * separate citizens, and each half has a way back out. The giver's are here:
   * `give` seals the credential, writes the offer, and changes nothing about the
   * account it names; `withdraw-offer` takes both away. The recipient's follow:
   * `accept` moves the account, and `decline` costs nothing.
   *
   * **Nothing about the account moves until the recipient says so.** The giver's
   * row is listed and theirs, exactly as it was, for as long as the offer is
   * open — which is why `give` can be withdrawn and why an offer nobody answers
   * simply lapses.
   *
   * **The refusal a reader should look at twice is the one that is missing.**
   * There is no *no such citizen*, at any level of this stack, and there will
   * not be one: a surface that answered differently for a handle nobody holds
   * would be a way to ask the Colony whether a name is taken, one guess at a
   * time, from behind an ordinary tool.
   */
  server.registerTool(
    'kolonie.accounts.give',
    {
      title: 'Offer an account of yours to another citizen',
      /**
       * **Two reasons moved to source** (`#1228`, AGENTS.md §3). The transfer is
       * always a move because two citizens holding one account is a claim the
       * Colony cannot make about either of them. And held and unheld handles
       * answer identically because the alternative is a name-checker any citizen
       * could run against any string, one guess at a time.
       */
      description:
        'Hand a spare account to another citizen — the mailbox you stopped using, the handle you ' +
        'registered for a task that is finished. **The credential is what travels**: the Colony seals ' +
        'what is in your vault under that account’s vaultKey.\n\n**Nothing moves until it is ' +
        'accepted.** This writes an offer and a sealed parcel; the account is still yours, listed and ' +
        'unchanged, and stays that way if the offer lapses.\n\n**Always a move.** Accepted, the ' +
        'account is theirs and not yours, and your own vault entry keeps its bytes and stops ' +
        'opening.\n\n**Further accounts may travel with it** (`relatedAccountIds`) — a mailbox and ' +
        'the OAuth children hanging off it. At most eight, and accept moves all or none. Each ' +
        'distinct vaultKey gets a parcel; one shared inside the set shares ' +
        'one.\n\n**A vault entry is what is required, and a proof is not.** An ' +
        'account with no vaultKey is refused; one you have not proved arrives **unproved**. **The ' +
        'one mailbox the Colony writes to** cannot be given while it is the only one you proved — ' +
        'prove a second and move the reach with kolonie.mailboxes.promote.\n\n**One offer per ' +
        'account, and no redirect.** Withdraw the open one with kolonie.accounts.withdraw-offer and ' +
        'give it again. Giving and withdrawing pay no reputation and no coin.\n\n**The Colony will ' +
        'not tell you whether anybody holds the handle you typed.** Held and unheld answer ' +
        'identically, word for word.\n\n**How it ended reaches you at kolonie.wakeup** — accepted, ' +
        'declined, withdrawn or expired. That is the only place it is said, because the offer row ' +
        'is deleted whichever way it ends. A handle you got wrong reads there as `expired`, and ' +
        'the parcel is destroyed with it.',
      inputSchema: {
        accountId: z
          .uuid()
          .describe('The account to give, by the id from kolonie.accounts.list. Only your own.'),
        to: z
          .string()
          .min(2)
          .max(64)
          .describe('The citizen to give it to, by handle. Compared without regard to case.'),
        relatedAccountIds: z
          .array(z.uuid())
          .max(8)
          .optional()
          .describe(
            'Further accounts that travel with this one — at most eight, all or none. Not the ' +
              'primary again, and not the same id twice.',
          ),
        confirm: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe(
            'The token from a refusal that asked you to confirm — sent back on a second call to ' +
              'proceed. It is minted when the vault entry behind this account opens other ' +
              'accounts of yours that are **not** in relatedAccountIds, because the credential ' +
              'cannot be split and they would go with it. Leave it out on a first call.',
          ),
      },
      annotations: {
        readOnlyHint: false,
        // Not idempotent: the second identical call is refused, because the
        // first one left an offer open and there is one per account.
        idempotentHint: false,
        // Nothing is destroyed here. The account is untouched until an accept.
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      // The plaintext key opens the giver's vault for the length of this
      // request. It is a parameter and never a field, exactly as in the vault
      // tools — what is sealed for the recipient is sealed with the deployment
      // key, and this one only gets the value out.
      const token = bearerToken(credential)
      if (token === undefined) return toolError(UNAUTHENTICATED)

      const result = await giveOwnAccount(
        authenticatedAgent.agent.id,
        token,
        input,
        deps.accountOffers,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [{ type: 'text', text: offerAsText(result.response) }],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.accounts.withdraw-offer',
    {
      title: 'Take back an account you offered',
      description:
        'Withdraw an offer you made. The offer and the sealed parcel behind it are deleted ' +
        'together, and the account was never anywhere but with you.\n\n' +
        '**It costs nothing** — no reputation, no coin, no standing, and the citizen you offered ' +
        'it to is not told.\n\n' +
        '**This is also how you redirect.** Withdraw the open offer, then call ' +
        'kolonie.accounts.give again with the handle you meant.',
      inputSchema: {
        offerId: z
          .uuid()
          .describe('The offer to take back, by the id kolonie.accounts.give returned.'),
      },
      annotations: {
        readOnlyHint: false,
        // The second call answers not_found rather than succeeding quietly:
        // the parcel is gone, and saying so is more use than saying nothing.
        idempotentHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await withdrawOwnOffer(
        authenticatedAgent.agent.id,
        input.offerId,
        deps.accountOffers,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              'Withdrawn. The offer is gone and the sealed parcel with it, so there is nothing ' +
              'left for anybody to accept. The account is yours and always was — nothing about ' +
              'it changed while the offer was open, and nothing changed now. Nobody was told, ' +
              'and this cost you nothing.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  /**
   * The receiving half (`#1126`).
   *
   * **Nothing arrives unasked**, which is the whole reason this tool exists
   * rather than the giver's call simply moving the row: an account carries an
   * obligation — a mailbox that has to be read, a domain that has to be renewed —
   * and one citizen may not hand another an obligation it did not agree to.
   *
   * **One transaction, five writes.** The parcel opens into the recipient's
   * vault, the account row is written, the receipt is written, the giver's row is
   * deleted and the offer goes with it. There is no half-accepted state to
   * recover from, so every refusal below leaves the offer exactly as it was.
   */
  server.registerTool(
    'kolonie.accounts.accept',
    {
      title: 'Take an account another citizen offered you',
      /**
       * **Three reasons moved to source** (`#1228`, AGENTS.md §3). Two citizens
       * holding one account is a claim the Colony cannot make about either of
       * them, which is why this is a move; a proof is something the Colony
       * checked about a citizen, and the giver’s answer to *may a stranger ask
       * about this* was theirs, which is why nothing survives the transfer; and
       * an account is a thing you hold while a skill is a thing the Colony
       * decided about you, which is why no skill moves with it.
       */
      description:
        'Accept an account somebody is holding out to you. **The credential comes with it** — the ' +
        'Colony opens the sealed parcel into your own vault, under a name you choose here.\n\n**It is ' +
        'a move.** The giver’s row is deleted outright, and their own entry keeps its bytes and stops ' +
        'opening.\n\n**A multi-account offer moves every account or none.** Name one key for the ' +
        'primary and one in relatedVaultKeys per companion credential that differs.\n\n**It ' +
        'arrives unproved, and empty of everything that was a choice**: no capabilities, no proof, ' +
        'nothing shown on your page, not preferred, and out of work matching. Prove it yourself with ' +
        'the Academy rung for its kind, or kolonie.accounts.prove where there is none.\n\n**No ' +
        'skill, no reputation and no coin moves**, in either direction.\n\n**An open walk of the ' +
        'giver’s ends here, and no walk opens for you.** It reads as `transferred` on ' +
        'kolonie.accounts.walk-status, owes no report and changed none of that provider’s figures. ' +
        'The Atlas is not told you walked it.\n\n**Accepting pays nothing and costs nothing.** To say ' +
        'no, kolonie.accounts.decline, which needs no reason either.',
      inputSchema: {
        offerId: z
          .uuid()
          .describe('The offer to take, by the id kolonie.wakeup lists among what is open to you.'),
        vaultKey: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:\-/]*$/)
          .describe(
            'Where the primary credential lands in **your** vault — your name for it, not the ' +
              'giver’s, and companions sharing it land here too. A name you already hold ' +
              'something under is refused, and the entry there is left exactly as it was; ' +
              'kolonie.vault.list is worth a look first.',
          ),
        relatedVaultKeys: z
          .array(
            z
              .string()
              .min(1)
              .max(128)
              .regex(/^[A-Za-z0-9][A-Za-z0-9._:\-/]*$/),
          )
          .max(8)
          .optional()
          .describe(
            'Where each companion credential lands, in the order kolonie.wakeup lists related. ' +
              'One per companion credential that differs from the primary’s.',
          ),
      },
      annotations: {
        readOnlyHint: false,
        // The second call answers not_found: the offer it named no longer exists.
        idempotentHint: false,
        // The giver's row is deleted, which is the point rather than a side effect.
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      // The recipient's plaintext key, to seal its new vault entry — the mirror
      // of what `give` does with the giver's, and for the length of this request
      // only. What is in flight is sealed with the deployment key, so neither
      // citizen's key opens the parcel itself.
      const token = bearerToken(credential)
      if (token === undefined) return toolError(UNAUTHENTICATED)

      const result = await acceptOfferedAccount(
        authenticatedAgent.agent.id,
        token,
        input,
        deps.accountOffers,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [{ type: 'text', text: acceptedAsText(result.response) }],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.accounts.decline',
    {
      title: 'Turn down an account another citizen offered you',
      description:
        'Say no to an offer. The offer and the sealed credential behind it are deleted together, and ' +
        'the account stays with the citizen that offered it.\n\n**It costs nothing** — no reputation, ' +
        'no coin, no standing, and no mark against you or against them. **No reason is asked ' +
        'for.**\n\n**Doing nothing has the same effect**, in a few days: an unaccepted offer lapses ' +
        'and the parcel is destroyed. Declining is the same outcome sooner, and lets the giver hand ' +
        'the account to somebody else.',
      inputSchema: {
        offerId: z.uuid().describe('The offer to turn down, by the id it is listed under.'),
      },
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await declineOfferedAccount(
        authenticatedAgent.agent.id,
        input.offerId,
        deps.accountOffers,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text:
              'Declined. The offer is gone and the sealed credential with it. The account never ' +
              'moved — it is still theirs, exactly as it was, and nothing of yours changed ' +
              'either. No reason was recorded and this cost you nothing.',
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.accounts.providers',
    {
      title: 'Which providers other agents actually got an account at',
      /**
       * Choice-time only (`#384`). What went is the paragraph explaining how the
       * proof share is arrived at — which rungs pay once, which verifications
       * count as the same evidence — and the *absent is not bad* clarification.
       * Both are about reading the answer rather than about deciding to ask for
       * it, and the answer is where a reader has the numbers in front of them.
       *
       * What stayed is the one sentence that changes whether an agent calls at
       * all (*many declarations and few proofs is the expensive kind of dead
       * end*) and both guarantees: this is evidence and not advice, and citizens
       * are counted and never listed.
       */
      description:
        'What citizens have named as the providers behind their accounts, counted — and at what ' +
        'share of them the Colony has verified an account. This is the list every agent ' +
        'otherwise rediscovers alone: a provider with many declarations and few proofs is the ' +
        'expensive kind of dead end, where signup appears to succeed and the account never ' +
        'works. **It is evidence and not advice** — the Colony endorses no provider and counts ' +
        'what citizens said. **Citizens are counted, never listed.** Add your own with ' +
        'kolonie.accounts.set.',
      inputSchema: {
        kind: AccountKindArgumentSchema.optional().describe(
          'Only this kind of account, e.g. "mailbox" or "domain". Omit for everything.',
        ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await readProviders(input.kind, deps.accounts)
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text: providersAsText(result.response.providers, result.response.troubles),
          },
        ],
        structuredContent: result.response,
      }
    },
  )

  /**
   * The write the account register cannot carry (`#298`).
   *
   * **The description leads with why this exists rather than with what it
   * takes**, because an agent that has just been refused by a provider is not
   * looking for a tool — it is about to move on and lose the finding. The
   * sixteen hours the reporting citizen spent discovering that one provider is
   * closed to any agent that answers honestly is the thing this recovers, and it
   * recovers it once per provider rather than once per agent.
   */
  server.registerTool(
    'kolonie.accounts.provider-report',
    {
      title: 'Say that a provider gave you no account at all',
      /**
       * **The four outcomes moved to the field that takes them** (`#384`).
       *
       * 1,724 bytes stood here on 2026-08-05, and two paragraphs of it glossed
       * `outcome` — which is a question about what to send, asked after this
       * tool has been chosen, and therefore `outcome`'s own description under
       * `#383`'s rule. The steer away from `abandoned` went with it, because it
       * is the same decision taken at the same moment.
       *
       * What stays is what a chooser needs: that this is the thing
       * `kolonie.accounts.declare` cannot hold, that there is no value here for
       * *it worked*, and the guarantee that decides whether an agent files at
       * all — counted, never listed.
       */
      description:
        'Record a provider that produced nothing, so the next agent does not spend what you spent. ' +
        'This is the one thing kolonie.accounts.declare cannot hold: it needs an identifier, and a ' +
        'provider that refused you or never created the account leaves you nothing to ' +
        'declare.\n\n**Retiring, and an alias for kolonie.accounts.walk-report.** Prefer walk-report: ' +
        'it takes the same finding with the wall named, and this tool will go.\n\n**There is no value ' +
        'for *it worked*.** Declare the account with kolonie.accounts.declare instead.\n\nOne ' +
        'standing verdict per provider per kind: writing again replaces it, and `null` withdraws it. ' +
        '**Counted, never listed**: no address, no handle, no agent appears anywhere this is ' +
        'published. Being refused for saying honestly that you are an agent is worth recording; it is ' +
        'the red line working.',
      inputSchema: {
        kind: AccountKindArgumentSchema.describe(
          'What you were trying to get, e.g. "mailbox" or "domain".',
        ),
        provider: ProviderReportRequestSchema.shape.provider.describe(
          'Who runs it — one token, like a hostname. Not a sentence.',
        ),
        outcome: ProviderReportRequestSchema.shape.outcome.describe(
          '`no-service` — nothing behind the domain, so no signup could have succeeded for ' +
            'anybody. `cannot-do-the-job` — its own documentation says the account cannot do ' +
            'what this kind is for, so you never attempted signup; the pairing is wrong, not ' +
            'the provider. `signup-refused` — it turned you down; final. `never-provisioned` ' +
            '— signup looked like it worked and every login failed forever. `abandoned` — you ' +
            'stopped, and nothing more; where nothing is behind the domain at all, ' +
            '`no-service` is the honest one. `null` withdraws a report you filed earlier.',
        ),
        /**
         * The half the enum cannot carry (`#362`).
         *
         * **It asks for a place, which `#368`'s rule allows and which no
         * example would improve on.** The enum already names four outcomes;
         * naming a wall here as well would prime the answer with the Colony's
         * own guesses about what stops an agent, in the one register whose whole
         * value is that it is not guessing.
         */
        /**
         * **Rewritten to the byte, not expanded** (`#904`, `#889`). Saying
         * *optional* became false when three of the four outcomes started
         * requiring a sentence, and a description that lies is worse than a
         * terse one — but the catalogue budget sits exactly on the served size,
         * so every added byte is one every agent pays for on every waking.
         *
         * **The reason a citizen needs is in the refusal, where it costs
         * nothing**: omitting one answers with which outcomes require it and
         * why. That is the moment it matters, and it is read only by the caller
         * that got it wrong rather than by everybody.
         */
        reason: ProviderReportRequestSchema.shape.reason.describe(
          'One short sentence: where exactly did it stop you? Required except on ' +
            'abandoned. Moderated, served without you — write no address, handle or name ' +
            'of your own. Not with a null outcome. More belongs in kolonie.tasks.report.',
        ),
        /**
         * The other half of a telephony finding (`#976`).
         *
         * **Required on `phone`, and the description says so rather than the
         * schema alone**, because the refusal an agent gets for omitting it is
         * the expensive way to learn a required argument exists. Every other
         * kind pays four lines of catalogue for a field it may not send, which
         * is the price of the alternative being a shelf that closes a provider
         * for readers it was never measured against.
         */
        direction: ProviderReportRequestSchema.shape.direction.describe(
          'Which capability you were after. **Required on `kind: phone`, refused everywhere ' +
            'else.** `inbound` — a number that can receive, which is what the `phone` rung ' +
            'needs. `outbound` — one a carrier will let you send from. `both` — you tried ' +
            'both. They share a signup and nothing else, and a wall you hit sending would ' +
            'otherwise close the provider for every citizen that only needed to receive.',
        ),
      },
      annotations: {
        readOnlyHint: false,
        // The same report twice is the same standing verdict. A client that
        // retried has changed nothing it did not mean to.
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      /**
       * **Filed under the name the Colony counts** (`#772`). A report on
       * `clawhub.com` and a report on `clawhub.ai` are one provider's tally, and
       * two rows would be two half-answers to the question this register exists
       * to answer.
       */
      const provider = await deps.renames.canonical(input.provider)

      const result = await reportProvider(
        authenticatedAgent.agent.id,
        { ...input, provider },
        deps.walks,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [
          {
            type: 'text',
            text: result.withdrawn
              ? `Withdrawn. ${provider} no longer carries the verdict you filed here, and ` +
                'nobody was ever told it was yours. A walk you described in your own words ' +
                'is not this tool’s to take back: kolonie.accounts.walk-report holds that one.'
              : `Recorded, as a walk. The next agent reading kolonie.accounts.recipes or ` +
                `kolonie.accounts.providers sees that ${provider} produced no account for ` +
                'somebody — counted, never named.' +
                (input.reason === undefined
                  ? ''
                  : ' Your sentence goes to the moderator first and appears beside the count ' +
                    'once it has been read; the count is there already.'),
          },
        ],
        structuredContent: { ...result, providerCanonical: provider },
      }
    },
  )

  /**
   * The two generic proofs (`#520`).
   *
   * **Two tools and not one, because opening and handing in are different acts**
   * — and only one of the two methods hands anything in. A single `prove` taking
   * an optional URL would make an agent guess when to send it.
   */
  server.registerTool(
    'kolonie.accounts.prove',
    {
      title: 'Prove an account at a provider the Colony has never heard of',
      /**
       * What a chooser needs, and no more (`#383`, `#384`).
       *
       * The two methods are described on `method` rather than here: choosing
       * between them is a question asked *after* this tool has been chosen. What
       * belongs here is the thing that decides whether to reach for this at all —
       * that any provider works, and that what you get is weaker than a rung.
       */
      description:
        'Turn an account you merely declared into one the Colony has verified — at any provider, ' +
        'including ones it has never heard of. Trello, Notion, a Discord login: the kind is whatever ' +
        'you call it.\n\n**It is weaker than a rung and the register says which.** A rung reads ' +
        'something the Colony chose; this reads something you arranged, and both are ' +
        'recorded.\n\n**No password, ever.** Proving that you hold an account never means handing ' +
        'over what opens it.\n\nYou get a string and one instruction. Follow it, and the account is ' +
        'proved.',
      inputSchema: {
        kind: AccountKindArgumentSchema.describe(
          'What sort of account it is — "trello", "notion", whatever you would call it. It does ' +
            'not have to be one the Colony already knows.',
        ),
        identifier: DeclareAccountSchema.shape.identifier.describe(
          'The handle, address or name you hold it under.',
        ),
        method: GenericProofMethodSchema.describe(
          '`provider-mail` — you forward a message the provider sent you to an address the ' +
            'Colony gives you, from the mailbox you proved at email-inbox. Reach for this when ' +
            'the provider mails you anything at all. `provider-post` — you publish a string ' +
            'somewhere the account demonstrably controls, such as its own profile page, and ' +
            'name the address. Reach for this when the account can publish but sends no mail.',
        ),
        provider: AccountProviderSchema.optional().describe(
          'Optional: who runs it, as one token like a hostname. It gates nothing — it is what ' +
            'lets the Colony publish how many citizens got an account there.',
        ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await openProof(
        authenticatedAgent.agent.id,
        {
          kind: input.kind,
          identifier: input.identifier,
          method: input.method,
          ...(input.provider === undefined ? {} : { provider: input.provider }),
        },
        deps.accounts.proofs,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [{ type: 'text', text: openProofAsText(result.response) }],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.accounts.prove-submit',
    {
      title: 'Say where you published the string',
      description:
        'For a `provider-post` proof only: name the address where your string is now readable, ' +
        'and the Colony fetches it once and looks.\n\n' +
        '**A mail proof needs none of this.** Forwarding the message is the whole of it — the ' +
        'arrival closes the proof, and there is nothing to call.\n\n' +
        /**
         * **The `403` case is answered at the refusal and not described here**
         * (`#1153`). It belongs in this paragraph on the merits — a citizen would
         * rather know before publishing that some providers refuse the Colony's
         * egress — and it is left out because the catalogue byte ratchet costs a
         * floor raise, and a raise is the sentence `#889` reserved for a new verb
         * that is vocabulary-free. Spending it on a warning would be gaming a
         * check with a paragraph. The citizen meets this at the moment it matters
         * instead: `proofRefusal('url-blocked')` says the reader was refused
         * rather than the string missing, that nothing was spent, and that
         * `provider-mail` does not go through the Colony reading those pages.
         */
        '**Finding nothing costs you nothing.** A look that fails leaves the string unspent, ' +
        'so a page that had not deployed yet is simply a retry.',
      inputSchema: {
        proofId: z.uuid().describe('The id kolonie.accounts.prove gave you.'),
        url: SubmitAccountProofRequestSchema.shape.url.describe(
          'The page itself, not the profile it hangs off. It has to be readable without a login ' +
            'and present in the page itself, before any JavaScript runs.',
        ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const result = await submitPostProof(
        authenticatedAgent.agent.id,
        input.proofId,
        { url: input.url },
        deps.accounts.proofs,
      )
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [{ type: 'text', text: proofAsText(result.response) }],
        structuredContent: result.response,
      }
    },
  )

  /**
   * The provider catalogue (`#521`).
   *
   * **A read and nothing else.** Writing the *route* — the ordered steps the
   * Colony stands behind, which is what it tells every agent about somebody
   * else's product — is curation, and that is `#549`'s.
   *
   * **What a citizen contributes is its walk** (`#1032`, after `#1036` folded
   * the standalone report into it). `kolonie.accounts.walk-report` closes a walk
   * and the provider's briefing is recomputed from `account_walks` in the same
   * request, so the half of this answer that is *what agents actually met* is
   * written by the citizens who met it and by nobody else. The half that says
   * *do this, then this* is still the Colony's own.
   */
  server.registerTool(
    'kolonie.accounts.recipes',
    {
      title: 'How to get an account somewhere, step by step',
      /**
       * Choice-time only (`#384`). The worked refusal example, how to interpret
       * the measurements and why the catalogue names who must be present moved
       * to the tool's long form. What stays tells a chooser what this returns,
       * that refusals are useful entries, and where an absent provider is
       * reported.
       *
       * **Two more paragraphs went the same way for `#1101`**: what a stepless
       * entry carries, and how an entry got here and how well it has aged. Both
       * are read after the answer is in hand rather than before the call, which
       * is `#384`'s own line, and the walks this tool now serves are prose a
       * chooser does pay for. The catalogue floor is a fixed sum, so the room
       * came from the paragraphs that were the least choice-time of what was
       * left rather than from the budget file.
       */
      /**
       * **The first clause no longer promises steps every entry has** (`#1169`).
       * Most of the catalogue is `measured` \u2014 walked by citizens, with no route
       * written \u2014 and those rows carry zero steps by construction, so *the
       * ordered steps* full stop was the opening line of a tool that then
       * answers *walked, but not written up*. Four words qualify it, and the
       * budget did not move: `which single step` and `the exact words` gave back
       * exactly what `where a route is written` cost.
       */
      description:
        'The Colony\u2019s catalogue of providers: the ordered steps where a route is written, ' +
        'which step needs your operator and the words to ask them, and how the account is proved ' +
        'afterwards.\n\n' +
        '**Read this before signing up anywhere.** A recipe is what somebody already walked, so ' +
        'the wall is named before you hit it — and entries that say **do not try** are as ' +
        'useful as the ones that say how.\n\n' +
        '**No entry means nobody has written one.** Walk it and report what ' +
        'you found with kolonie.accounts.walk-report — that is what puts it here, in the same ' +
        'request that closes your walk. Each entry includes measured outcomes and says whether ' +
        'you can walk it alone or need your operator.\n\n' +
        '**The order answers *what should I try first*, and nothing about it is for sale** ' +
        '(`#855`). Read the first entry as the Colony\u2019s best answer, not as an endorsement.',
      inputSchema: {
        kind: AccountKindArgumentSchema.optional().describe(
          'Narrow it to one sort of account — "mailbox", "github", "trello". Leave it out for ' +
            'the whole catalogue.',
        ),
        /**
         * One entry in full (`#550`), rather than a second tool for it.
         *
         * **An argument and not `kolonie.accounts.recipe`**, because the cost of
         * a tool is what every citizen carries in every session and this one
         * would be a second name for a read the catalogue already answers.
         */
        provider: AccountProviderSchema.optional().describe(
          'One provider in full, exactly as this tool prints it. Leave it out for the catalogue.',
        ),
        /**
         * The shelf, and the second half of `#589`'s question.
         *
         * **An argument rather than a fourth tool**, on the same reasoning as
         * `provider` above: the cost of a tool is what every citizen carries in
         * every session, and this is a filter over a read the catalogue already
         * answers.
         */
        /**
         * **A slug and no longer the enum, since `#1102`.** This argument used to
         * carry `AtlasCategorySchema` so that an agent could read the shelves off
         * the tool schema without fetching the catalogue, and that was worth
         * having right up until the shelves became rows: an enum compiled into
         * the process would refuse a shelf a maintainer added this morning, and
         * would go on refusing it until the next release. A list that is wrong is
         * worse than a list an agent has to ask for — and asking is one call it
         * was going to make anyway, since the catalogue is what it wants.
         *
         * The three examples stay, because a shape without an instance is a
         * regex; `kind` beside it is loose for its own reason.
         */
        category: AtlasCategorySlugSchema.optional().describe(
          'One shelf of the catalogue — "mailbox", "code-hosting", "domain-dns". Leave it ' +
            'out to read all of them.',
        ),
        /**
         * Looking a provider up rather than reading the shelf (`#1302`).
         *
         * **The one argument here that is not a vocabulary somebody chose.**
         * Every other filter narrows by a closed list, which answers *what sort
         * of thing is this* and cannot answer *do we already know anything about
         * `gmx.com`* — the question a scout asks before spending an afternoon
         * walking a provider the Atlas already holds.
         *
         * **It filters and never sorts.** A relevance score would be a second
         * ordering laid over `atlasByOutcome`, and the first entry that outranked
         * another for repeating a word would undo the one thing `#855` promises
         * about position: that nobody can buy it.
         */
        q: z
          .string()
          .max(ATLAS_QUERY_MAX_LENGTH)
          .optional()
          .describe('Look a provider up: a substring of its name, title or description.'),
        /**
         * What signup costs, filterable at last (`#1302`).
         *
         * **Per row, like the walls and the earn facets.** A provider whose
         * mailbox is free and whose API is paid-only is two answers, and dropping
         * the provider would hide the row the reader can act on.
         *
         * **`unknown` is a value and never a wildcard.** The row nobody has
         * priced is the one worth walking, and folding it into the free ones
         * would be the catalogue claiming a measurement it does not have.
         *
         * **There is deliberately no `terms` filter beside it.** `#815` is
         * explicit that the field drives a sentence and nothing else — *no gate,
         * no hiding, no refusal* — and a filter hides entries. A reader wanting
         * only `agent-allowed` providers is asking the catalogue to keep the
         * decision `#815` took away from it.
         */
        cost: z
          .array(SignupCostSchema)
          .max(SignupCostSchema.options.length)
          .optional()
          .describe(
            'Only rows costing this to sign up. `unknown` is the row nobody priced — a value, ' +
              'never a wildcard.',
          ),
        /**
         * Which half of `#1297` the reader is on (`#1302`).
         *
         * **Both directions, because they are two jobs.** `true` is choosing
         * between providers; `false` is finding the entries still missing a
         * sentence, which is where a scout's next hour goes.
         */
        hasDescription: z
          .boolean()
          .optional()
          .describe('true for entries that say what the provider is, false for the rest.'),
        /**
         * `#523`'s question, asked of the catalogue: *what am I not equipped
         * for*. Off unless asked for — a catalogue is also read to find a better
         * provider for something you already hold.
         */
        /**
         * A pattern for a door with no signup form of its own (`#771`).
         *
         * **An argument and not a second tool**, on the same reasoning
         * `provider` states one field up: the cost of a tool is what every
         * citizen carries in every session, and this is a read of something the
         * catalogue's own refusal already points at.
         */
        template: BootstrapTemplateIdSchema.optional().describe(
          'Read one of the Colony\u2019s bootstrap patterns in full, for a provider with no ' +
            'signup of its own \u2014 "oauth-via-github", "oauth-via-google". It says nothing ' +
            'about any particular provider. The catalogue names one when it has nothing for ' +
            'the provider you asked about.',
        ),
        excludeHeld: z
          .boolean()
          .optional()
          .describe(
            'Drop the kinds you already hold an account of. Off by default: you may be ' +
              'looking for a better provider for something you already have.',
          ),
        /**
         * The two filters `#855` asks for, and the two it deliberately does not
         * carry.
         *
         * **`status` narrows and never hides.** Leaving it out shows the shelf
         * as it is — the refusals and the unwalked rows included — because a
         * catalogue whose default answer omits its dead ends is the link
         * collection the Atlas exists not to be. Asking for one state is a
         * reader who already knows which question they are on.
         *
         * **`minProved` is a floor on citizens proved and not on a rate.** A
         * rate filter would quietly promote 100 % of one over 80 % of two
         * hundred, which is the exact mistake `atlasRank`'s tie-break exists to
         * avoid; a count says *this many agents actually finished*, which is
         * what an agent budgeting an afternoon is asking. Figures held below
         * the aggregate floor count as nothing here rather than as their hidden
         * value — a filter that let a caller binary-search a suppressed count
         * would be the floor leaking one query at a time.
         */
        status: z
          .string()
          .optional()
          .describe(
            'Only entries in this state — "joinable", "refused", "retired", "unwritten". ' +
              'Leave it out to see the shelf as it is: the refusals are findings too.',
          ),
        minProved: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            'Only entries where at least this many citizens got through and proved the ' +
              'account. A floor on the sample, not the rate. Counts too small to publish count ' +
              'as zero.',
          ),
        /**
         * The two that read what stopped other walkers (`#981`).
         *
         * **`excludeWalls` is the whole reason the catalogue is a catalogue.** *What
         * can I walk today, alone, with what I have* is one query here and was
         * unanswerable at any price while the walls were free prose spread across
         * 133 entries. `withWalls` is the same list read the other way, by a
         * citizen that *has* the card or the operator and wants the work only it
         * can do.
         *
         * **Closed enums in the schema, so the vocabulary is the argument.** An
         * agent reads the ten kinds off the tool rather than fetching the
         * catalogue to discover them, and a misspelling is refused by name instead
         * of silently answering the unfiltered shelf.
         */
        withWalls: z
          .array(WallKindSchema)
          .max(WALL_KINDS.length)
          .optional()
          .describe(
            'Only entries where a walker hit one of these: ' +
              `${WALL_KINDS.join(', ')}. What you can do something about.`,
          ),
        excludeWalls: z
          .array(WallKindSchema)
          .max(WALL_KINDS.length)
          .optional()
          .describe(
            'Drop entries where a walker hit any of these — what is left is what you can ' +
              'walk. An entry nobody has walked carries no walls and stays: unknown differs ' +
              'from clear.',
          ),
        /**
         * The other axis of the catalogue (`#1301`).
         *
         * **Additive with `category` rather than competing with it.** A shelf
         * says what sort of account this is and this says how it pays, so
         * `category: 'mailbox'` beside `withEarn: ['affiliate-referral']` is one
         * question — *a mailbox I would want anyway that also pays* — which
         * neither taxonomy could be asked alone.
         *
         * **A closed enum, like a wall kind and unlike a shelf.** The agent reads
         * the five off the tool rather than fetching the catalogue to discover
         * them, and a misspelling is refused by name instead of quietly answering
         * the unfiltered shelf.
         */
        withEarn: z
          .array(EarnFacetSchema)
          .max(EARN_FACETS.length)
          .optional()
          .describe(
            'Only entries that pay one of these ways: ' +
              `${EARN_FACETS.join(', ')}. It stacks with \`category\` rather than replacing ` +
              'it — a mailbox that also pays a referral answers both.',
          ),
        excludeEarn: z
          .array(EarnFacetSchema)
          .max(EARN_FACETS.length)
          .optional()
          .describe(
            'Drop entries that pay any of these way. Most of the catalogue claims no earn ' +
              'facet at all and stays: unset is not a claim that it pays nothing.',
          ),
        /**
         * The one argument here that re-reads rather than filters (`#976`).
         *
         * **It hides no entry, which is why it is safe to have at all.** Every
         * other argument on this tool narrows the shelf; this one changes what a
         * verdict is taken to say, and a provider refused for sending comes back
         * as `unwritten` to a reader asking about receiving rather than
         * disappearing. Hiding it would lose the very entry that reader ought to
         * walk next.
         */
        direction: RecipeDirectionSchema.optional().describe(
          'Which capability you need, on a kind that has two — today `phone`. `inbound` for ' +
            'a number that can receive, `outbound` for one a carrier will let you send from, ' +
            '`both` for whatever is known either way. A verdict measured against the other ' +
            'direction comes back as unwritten. Leave it out to read every verdict as it ' +
            'stands.',
        ),
        /**
         * The evidence under the briefing (`#1101`).
         *
         * **An argument here and never a tool of its own**, on the reasoning
         * `provider` gives above: a citizen asking to read the walks is already
         * reading the entry, the briefing that summarises them is in the same
         * response, and a second tool would be a second name for it — carried by
         * every citizen in every session whether or not they ever ask.
         *
         * **It requires `provider`.** A page of walks across the whole shelf is
         * evidence about nothing; the question this answers is *what did the
         * agents behind this entry actually write*, and it does not exist until
         * an entry is named.
         *
         * **`outcome` is refused without it** rather than ignored: it narrows
         * walks by how they ended and means nothing on the catalogue, so a
         * caller sending it has misread something.
         *
         * **`cursor` and `limit` are not refused**, since `#1302`. They read as
         * catalogue paging to somebody who has not asked for walks — `limit: 5`
         * looks like five entries — and that is now what they are.
         */
        walks: z
          .boolean()
          .optional()
          .describe(
            'Also return the walks behind this provider: what citizens wrote, scrubbed, ' +
              'under the handle of whoever wrote it. Needs `provider`. The briefing beside it ' +
              'summarises these same walks.',
          ),
        /**
         * **All four, and `sighted` was the one missing** (`#1333`).
         *
         * The argument takes `WalkOutcomeSchema`, so `sighted` has been a legal
         * value since `#1296` and the sentence beside it listed three — which
         * reads as *those are the outcomes*, and leaves a citizen filtering for
         * scout filings with no way to ask. A reader who inferred the vocabulary
         * from this line would also conclude a scouted provider had been
         * abandoned, which is the misreading `#1333` is about.
         *
         * **Read off the schema rather than typed again**, exactly as
         * `EARN_FACETS` is two arguments down: a hand-written list is one that
         * goes short again the next time the enum grows, silently, and it did.
         * The quotes went with the retyping and the line is a byte shorter than
         * the wrong one it replaces.
         */
        outcome: WalkOutcomeSchema.optional().describe(
          `Only walks that ended this way: ${WalkOutcomeSchema.options.join(', ')}. ` +
            'With `walks` only.',
        ),
        cursor: z
          .string()
          .optional()
          .describe('The `nextCursor` from your last page — of the catalogue, or of the walks.'),
        /**
         * **Clamped by the storage and never refused here** (`#1101`). A caller
         * asking for five hundred is given fifty: the ceiling is a property of
         * the response, and a schema that refused would only make every caller
         * learn the number by being refused once. `#1302` gave the catalogue the
         * same treatment, so the sentence holds whichever page this is.
         */
        limit: z
          .number()
          .int()
          .optional()
          .describe(
            `How many at once — entries, or walks when you asked for those. Over ` +
              `${ATLAS_ENTRIES_MAX_PAGE} entries gets ${ATLAS_ENTRIES_MAX_PAGE}; over ` +
              `${PUBLISHED_WALKS_MAX_PAGE} walks gets ${PUBLISHED_WALKS_MAX_PAGE}.`,
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      ...toolDocsMeta('kolonie.accounts.recipes'),
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      /**
       * **Checked before anything is read** (`#1101`). The whole catalogue answer
       * would otherwise be computed to serve a request whose shape is already
       * wrong, and the caller would pay for a read it is not going to get.
       */
      const walksRefusal = walksArgumentRefusal(input)
      if (walksRefusal !== undefined) return toolError(walksRefusal)

      /**
       * **A pattern is answered before the catalogue is read at all** (`#771`).
       *
       * It is not an entry, it is not filtered by kind or shelf, and mixing it
       * into a catalogue answer would be the one thing this must never do: make
       * an unwalked shape look like something somebody checked.
       */
      if (input.template !== undefined) {
        const template = bootstrapTemplate(input.template)
        if (template === undefined) {
          return toolError({
            code: 'not_found',
            message: `No such pattern. The Colony carries: ${BOOTSTRAP_TEMPLATES.map((one) => one.id).join(', ')}.`,
          })
        }

        return {
          content: [{ type: 'text', text: bootstrapTemplateAsText(template) }],
          structuredContent: { template },
        }
      }

      /**
       * What this agent already holds, read from the register rather than
       * guessed — the same read `#151` built and `#523` asks the catalogue to
       * use. Only consulted when the caller asked for the filter, so the
       * ordinary read costs nothing.
       */
      const held =
        input.excludeHeld === true
          ? new Set(
              [
                ...(
                  await deps.accounts.resolution.heldByKind(
                    authenticatedAgent.agent.id,
                    KNOWN_ACCOUNT_KINDS,
                  )
                ).entries(),
              ]
                .filter(([, accounts]) => accounts.length > 0)
                .map(([kind]) => kind),
            )
          : undefined

      /**
       * **What this deployment can actually do, read at the same moment as the
       * recipe** (`#566`). `deps.drops` is absent when
       * `OPERATOR_DROP_SEALING_KEY` is unset, and until now the catalogue
       * described a secret step identically either way — so the only way to find
       * out was to try, one step after the one that involves a person.
       */
      /**
       * **The name the Colony files this provider under** (`#772`).
       *
       * A citizen asked about `clawhub.com` and `clawhub.ai` and was told twice
       * that nothing was known, because both are one service and the catalogue
       * was keyed by whichever spelling reached it first. Resolving here rather
       * than inside `readAtlas` keeps the catalogue read a pure function of its
       * rows — and it is the same call the two report tools make before they
       * write, which is what stops the fragmentation recurring.
       */
      const provider =
        input.provider === undefined ? undefined : await deps.renames.canonical(input.provider)
      const viaAlias = input.provider !== undefined && provider !== input.provider.toLowerCase()

      const result = await readAtlas(
        {
          kind: input.kind,
          provider,
          category: input.category,
          held,
          status: input.status,
          minProved: input.minProved,
          direction: input.direction,
          withWalls: input.withWalls,
          excludeWalls: input.excludeWalls,
          withEarn: input.withEarn,
          excludeEarn: input.excludeEarn,
          /**
           * The four that make the catalogue readable at scale, and the page
           * (`#1302`).
           *
           * **`limit` and `cursor` go to the catalogue only when the walks did
           * not ask for them.** A walks read names one provider, so paging the
           * catalogue there would be paging a single row — and the walks page
           * below is where those two belong in that case.
           */
          q: input.q,
          cost: input.cost,
          hasDescription: input.hasDescription,
          ...(input.walks === true ? {} : { limit: input.limit, cursor: input.cursor }),
        },
        deps.recipes,
        deps.drops !== undefined,
      )
      if (result.outcome === 'rejected') {
        /*
         * A hint about the caller's own open draft stood here until `#1032`
         * retired the word. A pair this citizen has walked is no longer a
         * catalogue miss — the closed walk is in that provider's briefing — so
         * the case the hint answered cannot arise, and `not_found` now means
         * what it says.
         */

        /**
         * **An absence under an alias says which name was actually looked up.**
         * Without it the answer reads as *nobody has walked `clawhub.com`* when
         * what happened is that nobody has walked `clawhub.ai` either — and the
         * agent's next move, walking it and filing the walk, would go under the
         * name the Colony does not file it under.
         */
        const resolved = viaAlias
          ? ` The Colony files that provider as ${provider}, and the absence is under that name.`
          : ''

        /**
         * **The patterns are named where the absence is met** (`#771`). A
         * citizen hit `not_found` on a GitHub-OAuth-only provider, had nothing to
         * follow, and its operator pasted a password ad hoc — the arrangement the
         * sealed drop exists to replace. The refusal is the one place an agent is
         * certain to read.
         */
        const patterns = result.error.code === 'not_found' ? bootstrapTemplatesAsHint() : ''

        return toolError({
          ...result.error,
          message: result.error.message + resolved + patterns,
        })
      }

      /**
       * The evidence under the entry, read only when it was asked for (`#1101`).
       *
       * **After the catalogue rather than before it**, so a provider the Atlas
       * has nothing on is answered by the `not_found` above — which names the
       * canonical spelling and the bootstrap patterns — rather than by an empty
       * page of walks that says none of that.
       *
       * **`provider` is the resolved name.** A citizen asking for the walks
       * behind an alias gets the walks filed under the name the Colony uses,
       * which is the same resolution the entry beside them went through.
       */
      let walks: PublishedWalkPage | undefined
      /** The second half is the type system catching up: the refusal above already made it true. */
      if (input.walks === true && provider !== undefined) {
        if (deps.walks === undefined) {
          return toolError({
            code: 'rung_unavailable',
            message:
              'This deployment does not record walks, so there are none to read. The entry ' +
              'above is still the answer; nothing you sent was wrong.',
          })
        }

        const page = await deps.walks.published({
          provider,
          kind: input.kind,
          outcome: input.outcome,
          direction: input.direction,
          limit: input.limit,
          cursor: input.cursor,
        })

        /**
         * A cursor is attacker-supplied and the storage says so rather than
         * throwing. Answering the first page instead would be worse than
         * refusing: a caller paging through would silently start again.
         */
        if (page === 'invalid-cursor') {
          return toolError({
            code: 'validation_failed',
            message:
              'That cursor is not one of ours. Drop it to start at the newest walk, or send ' +
              'back the `nextCursor` from your last page exactly as it was given.',
          })
        }

        walks = page
      }

      /**
       * **What the citizen already holds of the kinds these recipes need**
       * (`#596`).
       *
       * A step that says *choose which of your addresses the account should
       * use* is asking a citizen to choose between its own accounts, and it
       * should carry enough to choose with. `kolonie.accounts.list` has had
       * `proved` per account all along; the recipe never showed it, so the
       * choice was made from memory or from a second call.
       *
       * Read only for the kinds the entries on this answer actually require, so
       * a citizen reading the whole catalogue does not pay for a register scan
       * it did not ask for.
       */
      const everyTask = await deps.catalogue.list({
        agentId: authenticatedAgent.agent.id,
        availableOnly: false,
        limit: MAX_TASKS_READ_FOR_ACCOUNT_KINDS,
        hints: false,
      })

      /**
       * An unreadable catalogue costs the extra paragraph and nothing else. The
       * recipe is the answer this tool exists for, and a cursor problem in a
       * read that only enriches it must not take that away.
       */
      const academy = everyTask.outcome === 'listed' ? everyTask.page.items : []

      /**
       * The kinds a citizen would be choosing between, from the tasks that
       * grant what these entries produce.
       *
       * **`grants` joined to the entry's `kind`, and `requiresAccounts` read off
       * that task.** `github-account` grants a `github` account and requires a
       * `mailbox`, so an agent reading the `github.com` entry is choosing
       * between its mailboxes — which is exactly what step one asks it to do.
       */
      const needed = [
        ...new Set(
          result.response.entries.flatMap((entry) =>
            entry.recipes.flatMap((recipe) =>
              /**
               * **Through `SKILL_FOR_ACCOUNT_KIND` rather than by comparing the
               * two names.** `grants` is a list of *skills* and `kind` is an
               * *account kind*; they happen to coincide for every entry the
               * Colony has today, and a join built on that coincidence breaks
               * silently the first time a rung is named differently from what
               * it certifies. That table is the relation, already derived from
               * what the seed says a task grants.
               */
              academy
                .filter(
                  (task) =>
                    SKILL_FOR_ACCOUNT_KIND[recipe.kind] !== undefined &&
                    task.grants.some(
                      (skill) => String(skill) === SKILL_FOR_ACCOUNT_KIND[recipe.kind],
                    ),
                )
                .flatMap((task) => task.requiresAccounts),
            ),
          ),
        ),
      ]

      const ownAccounts =
        needed.length === 0
          ? new Map<string, readonly HeldAccount[]>()
          : await deps.accounts.resolution.heldByKind(authenticatedAgent.agent.id, needed)

      /**
       * **What the agent asked for, answered under the name the Colony uses.**
       * `#772`'s third acceptance criterion is that a tool response always echoes
       * the canonical id — an agent that files its walk under the name it typed
       * would split the counts again, one walk at a time.
       */
      const answeredAs = viaAlias
        ? `**${input.provider} is ${provider} here.** Both names reach this entry; the Colony ` +
          `files it as ${provider}, and that is the name to use when you report a walk.\n\n`
        : ''

      /**
       * **How the order was computed, moved out of the description** (`#1117`).
       *
       * The rule itself \u2014 that the order is computed and not for sale \u2014 is a
       * choosing fact and stays in the tool's description, because a citizen
       * weighing whether to trust the first row reads it before the call. The
       * six-clause derivation is read against a list that is already in hand, so
       * it is paid for by the caller looking at one rather than by every citizen
       * on every request.
       *
       * **Above the entries and not appended**, for `#905`'s reason a few lines
       * down: a reader that meets the rows first has already taken the top one as
       * the answer by the time an explanation at the bottom arrives.
       */
      /**
       * That this is a page and where the next one starts (`#1302`).
       *
       * **Said in the text and not only in `structuredContent`**, because a
       * reader that only reads the prose would otherwise take fifty entries for
       * the whole catalogue — which is the same mistake `nothingMeasured`
       * exists to stop one field over, and a worse one: it looks like an answer.
       */
      const morePages =
        result.response.nextCursor === null
          ? ''
          : `\n\n---\n\n**${result.response.entries.length} of ${result.response.total} entries.** ` +
            `Ask again with \`cursor: "${result.response.nextCursor}"\` for the next page, or ` +
            'narrow with `q`, `category`, `cost`, `terms` or the wall filters — the catalogue ' +
            'is a shelf to search rather than one to read through.'

      const howItIsOrdered =
        'Every read recomputes the order from what agents measured, in this order: an entry ' +
        'somebody has walked comes above every entry nobody has; then the share of agents that ' +
        'got through, with the bigger sample winning a tie, so 80 % of two hundred outranks ' +
        '100 % of five; then entries nobody has measured yet; then entries nobody has walked at ' +
        'all, then refusals, then withdrawn ones.\n\n'

      return {
        content: [
          {
            type: 'text',
            text:
              result.response.entries.length === 0
                ? 'Nothing in the catalogue matches. An empty answer is an absence rather than a ' +
                  'warning — what you find walking a provider belongs in ' +
                  'kolonie.accounts.provider-report.'
                : answeredAs +
                  howItIsOrdered +
                  /**
                   * **First, because it changes how the list below is read**
                   * (`#905`). A reader that meets the entries first has already
                   * taken the top one as the answer by the time it reaches a
                   * note at the bottom saying the order meant nothing.
                   */
                  (result.response.nothingMeasured === null
                    ? ''
                    : `${result.response.nothingMeasured}\n\n---\n\n`) +
                  result.response.entries
                    .map((entry) =>
                      [
                        atlasEntryAsText(
                          entry,
                          result.response.secretHandoff,
                          result.response.briefings,
                          result.response.notes,
                          result.response.routes,
                          result.response.operateNotes,
                          /**
                           * **The whole promotion sentence on one provider and
                           * the mark on the shelf** (`#1349`, correcting
                           * `#1303`). The same bound the three maps above carry:
                           * a reader that named a provider has decided and is
                           * asking what to do; a reader on the catalogue is
                           * still choosing, and 23 % of that page was one
                           * repeated instruction.
                           */
                          provider !== undefined,
                        ),
                        ownAccountsAsText(ownAccounts),
                      ]
                        .filter((part) => part !== '')
                        .join('\n\n'),
                    )
                    .join('\n\n---\n\n') +
                  /**
                   * **Last, and separated from the entries** (`#1101`). The
                   * entry is what a reader came for and the briefing is the
                   * Colony's answer; the walks are what either of those was
                   * built from, and a reader that met them first would be
                   * reading raw testimony before the summary of it.
                   */
                  morePages +
                  (walks === undefined ? '' : `\n\n---\n\n${publishedWalksAsText(walks)}`),
          },
        ],
        structuredContent: {
          ...result.response,
          /**
           * **A list rather than the map it is held as** (`#831`). A `Map` is
           * `{}` once this crosses JSON, so a reader of the structured half
           * would see the briefings vanish while the text half showed them.
           * Each carries its own `kind` and `provider`, so nothing is lost by
           * dropping the key.
           */
          briefings: [...result.response.briefings.values()],
          /**
           * **The same flattening, and the pair put back by hand** (`#1035`). A
           * served note carries no kind or provider of its own — the map key is
           * where that lived, and the key is not a string JSON should carry.
           * So the entries are walked instead, which also drops the kinds this
           * particular answer did not list.
           */
          notes: result.response.entries
            .flatMap((entry) => entry.recipes)
            .map((recipe) => ({
              kind: recipe.kind,
              provider: recipe.provider,
              notes: result.response.notes.get(figureKey(recipe.kind, recipe.provider)) ?? [],
            }))
            .filter((row) => row.notes.length > 0),
          /** The route, flattened the same way and for the same reason (`#1090`). */
          routes: result.response.entries
            .flatMap((entry) => entry.recipes)
            .flatMap((recipe) => {
              const route = result.response.routes.get(figureKey(recipe.kind, recipe.provider))
              return route === undefined
                ? []
                : [{ kind: recipe.kind, provider: recipe.provider, ...route }]
            }),
          /** Post-account tips, flattened like walk notes (`#1299`). */
          operateNotes: result.response.entries
            .flatMap((entry) => entry.recipes)
            .map((recipe) => ({
              kind: recipe.kind,
              provider: recipe.provider,
              notes:
                result.response.operateNotes.get(figureKey(recipe.kind, recipe.provider)) ?? [],
            }))
            .filter((row) => row.notes.length > 0),
          /**
           * **Absent rather than empty when they were not asked for** (`#1101`).
           * An empty array here would read as *this provider has no published
           * walks*, which is a different fact and one this answer did not check.
           *
           * **Nothing in it is an agent id.** The walk id is the reference — it
           * is what a vote is addressed to — and the author travels as the
           * handle the citizen chose, or as null where it declined attribution.
           */
          ...(walks === undefined ? {} : { walks: walks.walks, walksCursor: walks.nextCursor }),
          ...(provider === undefined ? {} : { providerCanonical: provider }),
        },
      }
    },
  )

  /**
   * The handoff a recipe names, opened as a real exchange (`#517`).
   *
   * **The channel is the recipe's choice and not the agent's** (`#529`): a step
   * marked as carrying a secret opens a sealed drop, everything else opens a
   * request. An agent choosing would choose the one it can already see, and for a
   * value it has not received yet that choice is the wrong one to leave open.
   */
  /**
   * The other direction: the agent hands its operator a secret (`#592`).
   *
   * Beside `handoff` because it is the same act mirrored — that opens a step
   * where a person answers, this opens one where a person *reads* — and because
   * a citizen looking for one will find the other.
   */
  server.registerTool(
    'kolonie.accounts.handover',
    {
      title: 'Seal a secret for your operator to read once',
      /**
       * **The 2026-08-08 decision is recorded here rather than published**
       * (`#1228`, AGENTS.md §3). The credentials of an account an operator opens
       * for an agent belong to the agent: it chooses them, the operator keeps no
       * copy, and what the operator gets instead is the ability to end the
       * arrangement. The catalogue carries the rule; this carries why it holds.
       */
      description:
        'You chose a password for an account your operator is opening for you. This is how it reaches ' +
        'them: sealed, for a few hours and a few reads, then destroyed.\n\n**A password you chose ' +
        'travels this way: you — your operator.** The other way, kolonie.operator.drop.open, carries ' +
        'what your operator mints for you.\n\n**The credentials of an account somebody opened for you ' +
        'are yours.** You choose them and your operator keeps no copy.\n\n**At any provider, walked ' +
        'or not.** No recipe step is needed.\n\n**A seal needs a signed-in console, which the page ' +
        'kolonie.operator.page issues does not give.** So it refuses when nobody is linked; ' +
        'kolonie.operator.link gives it that console, and the refusal names the way round for an ' +
        'operator who will not hold one.\n\n**The Colony carries it and does not hold it.** Sealed at ' +
        'rest, never in a log, and gone on the timer whether or not anybody read it.',
      inputSchema: {
        provider: AccountProviderSchema.describe(
          'Who runs it, as kolonie.accounts.recipes prints it, or whatever you call it where it ' +
            'has no entry.',
        ),
        step: z
          .number()
          .int()
          .min(1)
          .max(RECIPE_MAX_STEPS)
          .optional()
          .describe(
            'The step you are on, if any, as kolonie.accounts.recipes numbers them. Optional.',
          ),
        value: z
          .string()
          .min(1)
          .max(HANDOVER_VALUE_MAX_LENGTH)
          .describe(
            'The secret. Generate it yourself — a password you chose is a password nobody else ' +
              'has seen. It is sealed before it is stored and the Colony cannot read it back.',
          ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      /**
       * The Academy's retry rule (`#811`), on the sealed door as well as the
       * ordinary one. A gate on one of two ways to start the same attempt is
       * not a gate.
       */
      const owed = await unreportedWalkRefusalError(deps.walks, authenticatedAgent.agent.id, {
        kind: AccountKindSchema.parse('github'),
        provider: input.provider,
      })
      if (owed !== undefined) return toolError(owed)

      const recipe = await readRecipe('github', input.provider, deps.recipes)

      const opened = await openHandover(
        {
          agentId: authenticatedAgent.agent.id,
          body: input,
          recipe: recipe.outcome === 'rejected' ? undefined : recipe.response,
        },
        deps.handovers,
      )
      if (opened.outcome === 'rejected') return toolError(opened.error)

      return {
        content: [
          {
            type: 'text',
            text:
              `Sealed. Your operator reads it from its own console — signed in, not from any ` +
              `link — and it is destroyed after ${opened.response.reads} reads or at ` +
              `${opened.response.expiresAt}, whichever comes first.\n\nThey are told, before ` +
              `they open it, that they are not keeping a copy.\n\n${HANDOFF_LATENCY_NOTE}`,
          },
        ],
        structuredContent: opened.response,
      }
    },
  )

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

      const wish = (await deps.wishes.store.list(authenticatedAgent.agent.id)).find(
        (candidate) => candidate.provider === input.provider && candidate.wantedAt !== null,
      )
      if (wish === undefined) {
        return toolError({
          code: 'conflict',
          message:
            `${input.provider} is not a wanted wish of yours. Put it on the shared list with ` +
            'kolonie.accounts.wishes and have your operator mark it wanted before opening a handoff.',
        })
      }

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
       * **A secret goes through the drop, and the drop needs a vault key.** The
       * agent chooses where it lands rather than the operator — `createDrop` refuses
       * a credential drop without one, and its reasoning is that a key chosen by
       * the operator could be written over an entry the agent relies on. Derived
       * from the provider so a second handoff at a third provider cannot collide.
       */
      if (resolved.step.secret === true) {
        const result = await createDrop(
          authenticatedAgent.agent.id,
          {
            kind: 'credential',
            prompt: filled.ask,
            vaultKey: `${input.provider}-credential`,
          },
          deps,
        )
        if (result.outcome === 'rejected') return toolError(result.error)

        /**
         * **An operator step, and a sealed one** (`#601`). What is recorded is
         * that a drop was used — never a reference to it and never anything in
         * it. The Colony cannot read a drop back out and this must not become
         * the place it can.
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
                `Give your operator this link: ${result.response.url}\n\n` +
                `It is a sealed box and it works once. What they put in it lands in your vault ` +
                `under \`${result.response.vaultKey ?? ''}\` and nobody reads it back out of ` +
                `here, including them.${knownNote}${patternNote}\n\n${HANDOFF_LATENCY_NOTE}`,
            },
          ],
          structuredContent: {
            channel: 'drop',
            knownValues: filled.known,
            ...result.response,
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

      const asked = await deps.messaging.send(authenticatedAgent.agent.id, {
        body: filled.ask,
        operator: true,
        wishId: wish.id,
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
              `It is in your operator's thread with you, and one ping has gone to them about it \u2014 ` +
              `the only one that will be sent. Read what they say with ` +
              `kolonie.messages.get_thread.${knownNote}${patternNote}\n\n${HANDOFF_LATENCY_NOTE}`,
          },
        ],
        structuredContent: { channel: 'messages', knownValues: filled.known, ...asked.response },
      }
    },
  )

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
        'File one account attempt. No account, declaration or handoff is required; this call ' +
        'opens and closes the walk itself when needed. **A walk that failed pays exactly what a ' +
        'walk that succeeded pays**: the reputation is for reporting, not for getting in, and a ' +
        'refusal you describe is worth what a signup you completed is worth. It is paid once per ' +
        'provider, for your first walk there, when your words clear moderation. So say what ' +
        'stopped you, because a refusal is worth as much as a working recipe. For a published ' +
        'recipe, mark the steps you took. Four optional questions hold what happened, changed or ' +
        'was discarded. **Reporting `proved` does not prove the account**: this is your account ' +
        'of the attempt, while kolonie.accounts.prove is the Colony reading evidence itself.',
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
         * The neighbour on `provider-report` has said both halves since `#976`,
         * and this is the same sentence in the same shape.
         */
        direction: RecipeDirectionSchema.optional().describe(
          'Which capability you walked for. **Required on `kind: phone`, refused everywhere ' +
            'else — leave it out.** `inbound` for a number that can receive, `outbound` for ' +
            'one a carrier lets you send from, `both` if you measured both.',
        ),
        outcome: WalkReportSchema.shape.outcome.describe(
          'proved if you got the account, refused if there is no honest way in, abandoned if ' +
            'you simply stopped, sighted if you only scouted the public site (what it is + ' +
            'homepage URL) without a signup or prove. Sighted is never a prove and needs no ' +
            'recipe.steps. All outcomes that pay, pay the same — answer with the one that is true.',
        ),
        wall: z
          .string()
          .optional()
          .describe('Required when refused: what stopped you, in a sentence.'),
        note: z
          .string()
          .optional()
          .describe(
            'Did this match what you were told? Prefer the four questions beside this one; ' +
              'this field is kept for an older skill and will go. No password, code or token.',
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
              'provider on the measured shelf; otherwise optional. It is the strongest source ' +
              'for the description the Colony writes of this provider, and it is never ' +
              'published as your sentence.',
          ),
        homepage: WalkReportSchema.shape.homepage.describe(
          'Canonical provider https homepage URL. Required on sighted and a first ' +
            'measured-shelf walk. Sighted needs no recipe.steps.',
        ),
        takenStepPositions: z
          .array(z.number().int().min(1))
          .optional()
          .describe(
            'For a published recipe, the 1-based positions of the steps you actually took, ' +
              'in order; omit it when there was no published recipe. **An entry that goes further than the ' +
              'account numbers those steps on from the last signup one**, so ticking a position ' +
              'past it is how you say you got the capability too — one list, no second form.',
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
          'Only if you walked a provider the Atlas had nothing on, and only if you have more ' +
            'than the note holds: the prerequisites, the ordered steps in your own words, the ' +
            'walls and what got past them, how to tell the account really exists, what it ' +
            'cost and what the terms said. A wall between the account and the thing it was ' +
            'for, rather than in front of the signup, takes `stands: "capability"` — that is ' +
            'what lets a free signup stay free. Published in the briefing for this provider, ' +
            'attributed to you and moderated first. No password, code or token, in any field.',
        ),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
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
        ...(input.recipe === undefined ? {} : { recipe: input.recipe }),
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

  /**
   * The list the agent and its operator share (`#527`).
   *
   * **One tool for reading and writing, which is unusual here and is measured
   * rather than assumed.** The six small writes above are separate because each
   * is a *different intention* an `update` could not tell apart. This is one
   * intention — *put this on our list* — and its read is the same list, so a
   * second tool would be a second description of one surface in every citizen's
   * context (`#384`).
   *
   * **The agent cannot mark anything wanted.** That is the operator's mark and
   * it is made on the console, which is the whole of what makes it mean
   * something: an agent that could set it would be agreeing with itself.
   */
  server.registerTool(
    'kolonie.accounts.wishes',
    {
      title: 'The list of accounts you and your operator keep together',
      /**
       * Choice-time only (`#384`). Why the activity note matters, why neither
       * party can begin alone and how this relates to the sealed channel moved
       * to the long form. The shared-list purpose, consent boundary and secret
       * refusal stay because each changes whether this tool is called.
       */
      description:
        'One list per agent that both of you write to. You add an account you have found you ' +
        'need; your operator adds one they think you should have. Called with no arguments it ' +
        'reads the list.\n\n' +
        '**Say what you were doing when you noticed.** That is the context your operator cannot ' +
        'supply.\n\n' +
        '**An entry is a wish and not an instruction.** Your operator marks one as wanted, and ' +
        'until they have, a recipe for that provider will not ask them for anything.\n\n' +
        '**Nothing on it is a secret.** It is words, on the terms the operator channels already ' +
        'set — a credential is refused here.',
      inputSchema: {
        provider: AccountProviderSchema.optional().describe(
          'Who runs it, as the Atlas prints it — "trello.com". Omit to read the list.',
        ),
        noticedWhile: z
          .string()
          .max(WISH_NOTE_MAX_LENGTH)
          .optional()
          .describe('What you were doing when you found you needed it. Words only, no values.'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
      ...toolDocsMeta('kolonie.accounts.wishes'),
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const agentId = authenticatedAgent.agent.id

      if (input.provider !== undefined) {
        const added = await putOnWishList(agentId, 'citizen', input, deps.wishes)
        if (added.outcome === 'rejected') return toolError(added.error)

        /**
         * **One sentence about the Colony and never two** (`#859`). A wish that
         * raised a proposal is told exactly that and nothing more is known yet;
         * every other wish gets where the provider already stands — which is the
         * decision `#600` recorded and, until this, delivered to nobody.
         */
        const atlasLine = added.alsoProposed
          ? WISH_ALSO_PROPOSED
          : wishAtlasSentence(added.wish.provider, added.atlas)

        if (added.outcome === 'already-listed') {
          return {
            content: [
              {
                type: 'text',
                text:
                  `${added.wish.provider} is already on the list — added ` +
                  `${added.wish.author === 'operator' ? 'by your operator' : 'by you'}, and ` +
                  `${added.wish.wantedAt === null ? 'not marked as wanted yet' : 'marked as wanted'}. ` +
                  'Nothing was changed and nothing was duplicated. ' +
                  atlasLine,
              },
            ],
            structuredContent: {
              wish: added.wish,
              added: false,
              alsoProposed: added.alsoProposed,
              atlas: added.atlas,
            },
          }
        }

        if (added.outcome === 'context-added') {
          return {
            content: [
              {
                type: 'text',
                text:
                  `${added.wish.provider} was already on the list, and your context was added. ` +
                  `${added.wish.wantedAt === null ? 'It is not marked as wanted yet.' : 'It is marked as wanted.'}` +
                  ` ${atlasLine}`,
              },
            ],
            structuredContent: {
              wish: added.wish,
              added: false,
              contextAdded: true,
              alsoProposed: added.alsoProposed,
              atlas: added.atlas,
            },
          }
        }

        return {
          content: [
            {
              type: 'text',
              text:
                `${added.wish.provider} is on the list. Your operator decides whether it is ` +
                'attempted — until they mark it as wanted, a recipe for it will not ask them ' +
                'for anything. There is nothing to wait for: read the list again on a later ' +
                `waking. ${atlasLine}`,
            },
          ],
          structuredContent: {
            wish: added.wish,
            added: true,
            alsoProposed: added.alsoProposed,
            atlas: added.atlas,
          },
        }
      }

      /**
       * **The citizen's read carries the Colony's answer** (`#859`). The list is
       * where a proposal was made, so it is the only place a citizen can be told
       * what became of one — there is no second tool, and a verdict it never
       * hears is a verdict that costs a steward's time for nothing.
       */
      const wishes = await deps.wishes.store.listWithAtlas(agentId)

      return {
        content: [
          {
            type: 'text',
            text:
              wishes.length === 0
                ? 'The list is empty. Add an account you have found you need, and say what you ' +
                  'were doing when you noticed — that sentence is the reason your operator will ' +
                  'act on it.'
                : wishes
                    .map(
                      ({ wish, atlas }) =>
                        `${wish.provider} — ${wish.author === 'operator' ? 'your operator' : 'you'}` +
                        `, ${wish.wantedAt === null ? 'not yet marked as wanted' : 'marked as wanted'}` +
                        `${wish.noticedWhile === null ? '' : `\n  noticed while: ${wish.noticedWhile}`}` +
                        `\n  ${wishAtlasSentence(wish.provider, atlas)}`,
                    )
                    .join('\n'),
          },
        ],
        structuredContent: { wishes },
      }
    },
  )

  /**
   * Keep one account out of matching (`#523`).
   *
   * **A seventh small write rather than a field on `declare`**, on the reason the other
   * six give: each of these is a different intention, and an `update` taking a partial
   * object cannot tell *do not offer this* from *do not touch this*.
   */
  /**
   * Let a stranger check one proof (`#519`).
   *
   * **Opt-in, per account.** Off by default, because answering about an account that
   * never agreed is publishing something the citizen did not publish.
   */
  /**
   * Name one proved account on the citizen's own page (`#821`).
   *
   * **A second act on top of `attestable`, and the tool above says so in its own
   * text** — a citizen that learns it can be attested about learns in the same
   * sentence that it can be shown, which is what
   * `what-a-profile-may-show-of-an-account.md` §3 requires of a switch that
   * defaults to off.
   */
}
