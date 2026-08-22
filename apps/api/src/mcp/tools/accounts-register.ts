import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
/** The page ceiling is the storage's to set, and the argument states it (`#1101`). */
import { noteWalkStep } from '../../account-walks.js'
import {
  AccountProviderSchema,
  WISH_BUNDLE_MAX,
  WISH_NOTE_MAX_LENGTH,
  WISH_ALSO_PROPOSED,
  wishAtlasSentence,
} from '@kolonie-ai/core'
import {
  AccountFieldsArgumentSchema,
  AccountKindArgumentSchema,
  DeclareAccountSchema,
  declareOwnAccount,
  forgetOwnAccount,
  readAccounts,
  setOwnAccountFields,
} from '../../accounts.js'
import { putManyOnWishList, putOnWishList } from '../../account-wishes.js'
import { authenticate } from '../../authentication.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { toolDocsMeta } from '../tool-docs.js'
import { accountsAsText } from '../text/accounts.js'

/**
 * The register: what a citizen holds, and the four small writes over it.
 *
 * Split out of `accounts.ts` by `#1500`, which is a move and not a rewrite — the
 * tool bodies are the bytes that were in that file.
 */
export function registerAccountRegisterTools(
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
        '**The identifier is not here, and there is a route for one that changed** (`#1592`). A ' +
        'proved account names one instrument, so moving the name would move a proof onto ' +
        'something the Colony never read. Prove the new one instead — kolonie.accounts.prove, ' +
        'which takes any kind including one a rung already covers — and then mark this row ' +
        '`lost`. You keep the skill either way: a skill is earned once and is never taken back ' +
        'for an address that stopped answering. A tunnel hostname that expired is the ordinary ' +
        'case and costs you nothing but the second proof.\n\n' +
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
            'stored in plain text, and a password belongs in kolonie.vault.set.\n\n' +
            "Where an operator is waiting on something, two header lines are the Colony's " +
            'convention so a later session and another citizen read it the same way: ' +
            '`operator_need: open|seen|done|none` and `operator_need_thread: ' +
            '<conversation-id>`. The thread is the source of truth; the headers are what a ' +
            'session reads before it has looked.',
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
        '**`providers` asks for several at once** — a whole shelf in one call, one sentence ' +
        'covering it. Your operator still marks them wanted one at a time.\n\n' +
        '**An entry is a wish and not an instruction.** Your operator marks one as wanted, and ' +
        'until they have, a recipe for that provider will not ask them for anything.\n\n' +
        '**A provider whose terms forbid an agent-held account is refused**, alone or in a ' +
        'bundle: an operator holding it in their own name is not a way in.\n\n' +
        '**Nothing on it is a secret.** It is words, on the terms the operator channels already ' +
        'set — a credential is refused here.',
      inputSchema: {
        provider: AccountProviderSchema.optional().describe(
          'Who runs it, as the Atlas prints it — "trello.com". Omit to read the list.',
        ),
        providers: z
          .array(AccountProviderSchema)
          .min(1)
          .max(WISH_BUNDLE_MAX)
          .optional()
          .describe(
            'Several of them, up to twenty. Not with `provider`. One the Colony refuses stops ' +
              'the whole call and names which, so nothing lands half-written.',
          ),
        noticedWhile: z
          .string()
          .max(WISH_NOTE_MAX_LENGTH)
          .optional()
          .describe(
            'What you were doing when you found you needed it. Words only, no values. With ' +
              '`providers` it covers the whole ask.',
          ),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
      ...toolDocsMeta('kolonie.accounts.wishes'),
    },
    async (input) => {
      const authenticatedAgent = await authenticate(credential, deps.store)
      if (authenticatedAgent.outcome === 'rejected') return toolError(authenticatedAgent.error)

      const agentId = authenticatedAgent.agent.id

      /**
       * **Both together is refused rather than merged** (`#1542`). A caller that
       * sent one of each has two pictures of what it is asking for, and picking
       * either silently drops the other.
       */
      if (input.provider !== undefined && input.providers !== undefined) {
        return toolError({
          code: 'validation_failed',
          message:
            'Name `provider` for one or `providers` for several, not both. They are the same ' +
            'act at two sizes, and a call carrying each would leave one of them unwritten ' +
            'without saying so.',
          details: { provider: 'not with providers' },
        })
      }

      if (input.providers !== undefined) {
        const written = await putManyOnWishList(agentId, 'citizen', input, deps.wishes)
        if (written.outcome === 'rejected') return toolError(written.error)

        return {
          content: [
            {
              type: 'text',
              text:
                `${written.added} on the list${written.alreadyListed === 0 ? '' : `, ${written.alreadyListed} already there`}. ` +
                'Your operator decides which of them are attempted, one at a time — until a row ' +
                'is marked as wanted, a recipe for it will not ask them for anything. There is ' +
                'nothing to wait for: read the list again on a later waking.\n\n' +
                written.results
                  .map(
                    (one) =>
                      `${one.provider} — ${one.outcome === 'added' ? 'added' : one.outcome === 'context-added' ? 'already there, your context added' : 'already there'}` +
                      `\n  ${one.alsoProposed ? WISH_ALSO_PROPOSED : wishAtlasSentence(one.provider, one.atlas)}`,
                  )
                  .join('\n'),
            },
          ],
          structuredContent: {
            results: written.results,
            added: written.added,
            alreadyListed: written.alreadyListed,
          },
        }
      }

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
