import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
/** The page ceiling is the storage's to set, and the argument states it (`#1101`). */
import { PUBLISHED_WALKS_MAX_PAGE, type PublishedWalkPage } from '@kolonie-ai/db'
import {
  KNOWN_ACCOUNT_KINDS,
  AccountProviderSchema,
  AtlasCategorySlugSchema,
  WALK_PROSE_FIELDS,
  WALK_PROSE_QUESTIONS,
  BOOTSTRAP_TEMPLATES,
  BootstrapTemplateIdSchema,
  RecipeDirectionSchema,
  PERSON_SHAPED_WALLS,
  WALL_KINDS,
  WALLS_NO_OPERATOR_CAN_CLEAR,
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
  type ApiError,
} from '@kolonie-ai/core'
import { AccountKindArgumentSchema } from '../../accounts.js'
import { atlasEntryAsText, readAtlas } from '../../provider-recipes.js'
import { authenticate } from '../../authentication.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { toolDocsMeta } from '../tool-docs.js'
import type { HeldAccount } from '../../accounts.js'
import { SKILL_FOR_ACCOUNT_KIND } from '../../tasks.js'

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

/**
 * The Atlas read surface: `kolonie.accounts.recipes`, and the four helpers only
 * it uses.
 *
 * Split out of `accounts.ts` by `#1500`, which is a move and not a rewrite — the
 * tool body and the helpers are the bytes that were in that file. That every
 * helper here is used by this one tool is why the split is a move at all: there
 * was no shared module to establish first.
 */
export function registerAccountAtlasTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
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
         * The same two filters, aimed the one way nobody was aiming them
         * (`#1421`).
         *
         * **Grammar and not a new tool.** It sets `withWalls` to
         * `PERSON_SHAPED_WALLS` and `excludeWalls` to `terms-forbid-agents`, and
         * every argument of it is a wall kind that already exists — so a wall
         * added to the taxonomy tomorrow costs zero tools here, which is the
         * catalogue doctrine's own acceptance test.
         *
         * **What it buys is the classification, which is the part a citizen
         * could not work out.** `withWalls: ['human-check', 'identity-document',
         * 'approval-required', 'representation-required']` was always
         * expressible; knowing that those four and no others are the ones a
         * person can clear *and keep the account after* was not, and getting it
         * wrong in either direction is expensive. Include
         * `terms-forbid-agents` and a citizen queues an ask that must never be
         * made; leave out `representation-required` and it strikes off a
         * provider that would have worked.
         *
         * **It clears nothing.** Nothing here automates, solves or routes around
         * a human check — the whole point is that the person whose step it is
         * gets asked once instead of eight times.
         */
        needsAPerson: z
          .boolean()
          .optional()
          .describe(
            'Only providers standing behind a wall a person can clear and then hold the ' +
              'account: ' +
              `${PERSON_SHAPED_WALLS.join(', ')}. Providers whose terms forbid an ` +
              'agent-held account are **excluded** rather than listed — an operator signing ' +
              'up there would hold the account in their own name and lend it to you, which ' +
              'is not a way in. Nothing here clears, solves or routes around a check: it is ' +
              'the shelf you can ask one person about once, instead of discovering the same ' +
              'wall eight times. `payment-required` and `phone-verification` are ' +
              'deliberately absent — the Colony has a rung for each, so those are work you ' +
              'have not tried rather than work you cannot do.',
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
          /**
           * **`needsAPerson` widens rather than replaces** (`#1421`). A caller
           * that asked for both gets the union on `withWalls` and the union on
           * `excludeWalls`, and `wallsMatch` already settles the collision the
           * right way: `excludeWalls` wins, so a provider whose terms forbid an
           * agent account cannot be dragged back onto the list by a `withWalls`
           * a caller also passed.
           */
          withWalls:
            input.needsAPerson === true
              ? [...new Set([...(input.withWalls ?? []), ...PERSON_SHAPED_WALLS])]
              : input.withWalls,
          excludeWalls:
            input.needsAPerson === true
              ? [...new Set([...(input.excludeWalls ?? []), ...WALLS_NO_OPERATOR_CAN_CLEAR])]
              : input.excludeWalls,
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
        deps.vault.vault.share !== undefined,
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
                          /**
                           * **Who is reading, so the page never tells a citizen
                           * to write to itself** (`#1489`). The handles on an
                           * entry are frequently the reader's own — a citizen
                           * that walked a provider is exactly the citizen most
                           * likely to read it again.
                           */
                          authenticatedAgent.agent.profile.name,
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
}
