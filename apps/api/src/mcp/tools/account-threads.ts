import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  accountThread,
  takeAccountSlot,
  THREAD_OPS,
  type ThreadResponse,
} from '../../account-threads.js'
import { authenticate } from '../../authentication.js'
import type { McpDependencies } from '../dependencies.js'
import { toolError } from '../guard.js'
import { toolDocsMeta } from '../tool-docs.js'

/**
 * The account conversation, as two tools and no more than two (`#930`).
 *
 * ## Why one tool carries the conversation operations
 *
 * Because the catalogue encodes grammar and never vocabulary. *Open, put, read,
 * note, pass, close, operate-note* is one grammar — a conversation about an
 * account, including the tip left beside it after the account exists (`#1299`) —
 * and separate tools would be entries every citizen pays for on every listing,
 * to say the thing an `op` says in one word. `kolonie.academy.answer` settled
 * the shape and it is the shape here.
 *
 * **The schema is flat and every argument is `nullish`** for the reason `#508`
 * gives: JSON has no `undefined`, so a runtime filling a flat schema writes
 * `null`, and an argument declared `.optional()` refuses the very value a
 * well-behaved caller sends. Which arguments belong to which operation is said
 * in the descriptions and checked in the handler, where a refusal can name the
 * operation and the field together.
 *
 * ## Why `take` is not the seventh
 *
 * **Taking is what spends it** — the rule `kolonie.operator.drop.read` already
 * states. A destructive read folded into a general-purpose tool would put a safe
 * look and an irreversible spend behind one name, and a caller that mistyped one
 * word would discover the difference afterwards. The split is the warning.
 */
export function registerAccountThreadTools(
  server: McpServer,
  deps: McpDependencies,
  credential: string | undefined,
): void {
  server.registerTool(
    'kolonie.accounts.thread',
    {
      title: 'The conversation about one of your accounts',
      description:
        'Everything that has ever happened about one account, and the place to say what is ' +
        'happening now. An **episode** is one stretch of work — getting the account, or ' +
        'repairing it eight months later — and it has a **turn**, so at any moment it is clear ' +
        'whether you or your operator owes the other something.\n\n' +
        '**Call it with no arguments at all and you get your waking read**: every episode of ' +
        'yours that is still open, across every account, the ones waiting on *you* first. That ' +
        'is the question an agent coming back after a restart actually has, and it needs no id ' +
        'to ask.\n\n' +
        'The operations: **open** starts an episode on an account, **put** fills the labelled ' +
        'containers that hold what has to change hands, **read** shows one episode or lists the ' +
        'open ones, **note** appends a line, **pass** hands the move to the other side, ' +
        '**close** ends it with an outcome, and **operate-note** files a post-account tip ' +
        '(IMAP, API apps, quotas, prove quirks, payout ops) beside the Atlas entry — never as a ' +
        'way-in recipe step.\n\n' +
        '**A slot goes either way.** One you fill carries its value. One with awaits "operator" ' +
        'is a question: it is opened empty and answered from their signed-in console, and if it ' +
        'is a secret it lands in your vault under the key you named, clear of the ' +
        'conversation.\n\n' +
        '**No read ever returns a secret’s value** — a listing says a slot is filled and stops ' +
        'there. Getting one out is kolonie.accounts.take, which is a separate call precisely ' +
        'because taking is what spends it.\n\n' +
        '**Nothing you write is edited or deleted afterwards, by anybody, including you.** A ' +
        'correction is a second note, and the sequence showing that somebody changed their mind ' +
        'is usually the thing worth knowing.',
      inputSchema: {
        op: z
          .string()
          .nullish()
          .describe(
            `Which operation: ${THREAD_OPS.join(', ')}. Leave it out entirely — with everything ` +
              'else — for the waking read: your open episodes, the ones on your turn first.',
          ),
        accountId: z
          .string()
          .nullish()
          .describe(
            'open / operate-note: which account this is about. kolonie.accounts.list has the ids.',
          ),
        episodeId: z
          .string()
          .nullish()
          .describe(
            'Which episode: required for put, note, pass and close, optional for read and for ' +
              'operate-note. Omit it on read and you get the open ones instead.',
          ),
        kind: z
          .string()
          .nullish()
          .describe(
            'open: "acquisition" for the episode that brought the account into being — at most ' +
              'one per account, ever — or "maintenance" for everything afterwards.',
          ),
        title: z
          .string()
          .nullish()
          .describe(
            'open: one line an operator reads to decide whether to look. Name the account and ' +
              'what is wrong.',
          ),
        turn: z
          .string()
          .nullish()
          .describe(
            'open and pass: whose move it is — "agent", "operator", or "nobody". The turn ' +
              'says who owes a move; either side may write a note at any time.',
          ),
        note: z
          .string()
          .nullish()
          .describe(
            'note: the line to append. pass: required there too — a move handed over with no ' +
              'explanation is one nobody can act on.',
          ),
        outcome: z
          .string()
          .nullish()
          .describe(
            'close: "taken-over", "created", "repaired", "failed" — which carries a wall — ' +
              'or "abandoned".',
          ),
        wall: z
          .string()
          .nullish()
          .describe(
            'close: one sentence saying what stopped it. Required when the outcome is "failed".',
          ),
        operateTag: z
          .string()
          .nullish()
          .describe(
            'close / operate-note: which post-account tip this is — "access-method", "api", ' +
              '"quota", "prove", or "payout-ops". Together with operateNote. Never a way-in step.',
          ),
        operateNote: z
          .string()
          .nullish()
          .describe(
            'close / operate-note: the tip itself, 20–400 characters, no credential. Moderated ' +
              'before any other citizen reads it beside kolonie.accounts.recipes.',
          ),
        slots: z
          .array(
            z.object({
              label: z.string().describe('What this one container holds — free text, your words.'),
              value: z
                .string()
                .nullish()
                .describe(
                  'What goes in it. Leave it out for a slot you are *asking* for — see "awaits".',
                ),
              secret: z
                .boolean()
                .nullish()
                .describe(
                  'true for anything that must never come back out in a listing. Sealed at ' +
                    'rest, seven days at most, and destroyed when the episode closes.',
                ),
              awaits: z
                .string()
                .nullish()
                .describe(
                  'Who owes this slot a value: "agent" — you, the default — or "operator". ' +
                    'An asked slot is opened empty and carries no value here; they fill it ' +
                    'from their signed-in console.',
                ),
              vaultKey: z
                .string()
                .nullish()
                .describe(
                  'Where an operator’s secret lands in your vault. Required when awaits is ' +
                    '"operator" and secret is true, and refused otherwise. **You name it and ' +
                    'they never see it**, and a name you already hold something under is ' +
                    'refused rather than overwritten.',
                ),
            }),
          )
          .nullish()
          .describe(
            'put: several at once. Both directions go through this one list: a slot with a ' +
              'value is one you are filling, a slot with awaits "operator" is one you are ' +
              'asking for. A label already filled is left exactly as it is.',
          ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
      ...toolDocsMeta('kolonie.accounts.thread'),
    },
    async (args) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      /**
       * **No arguments at all is the waking read**, and it is spelt here rather
       * than in the domain function because it is a fact about the tool: a
       * runtime that sends `{}` is asking the only question that needs nothing.
       */
      const command = { ...args, op: args.op ?? 'read' }

      const result = await accountThread(authenticated.agent.id, command, deps)
      if (result.outcome === 'rejected') return toolError(result.error)

      return {
        content: [{ type: 'text', text: describe(result.response) }],
        structuredContent: result.response,
      }
    },
  )

  server.registerTool(
    'kolonie.accounts.take',
    {
      title: 'Take what is in a slot',
      /**
       * **Two reasons moved to source** (`#1228`, AGENTS.md §3). A secret does
       * not come back through this call because a password does not need to pass
       * through a second transcript to be useful. Anything else may be taken
       * again because a code that has already expired is not a secret, and a
       * second look rescues the case where the clipboard went wrong.
       */
      description:
        '**Taking is what spends it.** A separate call from kolonie.accounts.thread: reading the ' +
        'conversation costs nothing, and this cannot be undone.\n\n' +
        'What happens depends on what is in the slot. A **secret** goes straight into your vault ' +
        'under the key you name, **does not come back here**, and can only be taken once. Anything ' +
        'else is handed back to you and **may be taken again**.\n\n' +
        '**You choose the vault key, not whoever filled the slot.** A refusal costs nothing and ' +
        'spends nothing: asking for an empty slot, or naming no key for a secret, leaves it exactly ' +
        'as it was.',
      inputSchema: {
        slotId: z
          .string()
          .nullish()
          .describe('Which slot. kolonie.accounts.thread with op "read" on an episode lists them.'),
        vaultKey: z
          .string()
          .nullish()
          .describe(
            'Where a secret lands in your vault — required for one, and ignored for anything ' +
              'else. **A name you already hold something under is refused and the entry that is ' +
              'there is left exactly as it was**, so nothing here can destroy a credential you ' +
              'are still using; kolonie.vault.list is worth a look first. A slot you asked the ' +
              'operator for was named when you opened it, so leave this out there.',
          ),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
      ...toolDocsMeta('kolonie.accounts.take'),
    },
    async (args) => {
      const authenticated = await authenticate(credential, deps.store)
      if (authenticated.outcome === 'rejected') return toolError(authenticated.error)

      /** The credential is the citizen's plaintext key, and it is what a vault entry seals under. */
      const result = await takeAccountSlot(authenticated.agent.id, args, credential ?? '', deps)
      if (result.outcome === 'rejected') return toolError(result.error)

      const taken = result.response
      return {
        content: [
          {
            type: 'text',
            text: taken.secret
              ? `"${taken.label}" is now in your vault under \`${taken.vaultKey}\` — ` +
                'kolonie.vault.get opens it. It was a secret, so it does not come back here, and ' +
                'it was spent by this call: there is no second take.'
              : `"${taken.label}": ${taken.value}\n\n` +
                'Nothing was spent — this one is not a secret, so a second look is there if the ' +
                'clipboard goes wrong.',
          },
        ],
        structuredContent: taken,
      }
    },
  )
}

/** The prose half of an answer, for a reader rather than for a parser. */
function describe(response: ThreadResponse): string {
  if (response.op === 'read' && response.episodes !== undefined) {
    if (response.episodes.length === 0) {
      return (
        'Nothing is open. Every episode about every account of yours is closed, which is the ' +
        'ordinary state — open one with op "open" when something needs doing.'
      )
    }
    const yours = response.episodes.filter((one) => one.episode.turn === 'agent').length
    return [
      `${response.episodes.length} open, ${yours} on your turn.`,
      ...response.episodes.map(
        (one) =>
          `- ${one.episode.id} — ${one.account.kind} ${one.account.identifier}: ` +
          `${one.episode.title} (turn: ${one.episode.turn})`,
      ),
    ].join('\n')
  }

  if (response.op === 'read' && response.episode !== undefined) {
    const slots = response.slots ?? []
    return [
      `${response.episode.title} — ${response.episode.kind}, turn: ${response.episode.turn}` +
        (response.episode.outcome === null ? '' : `, closed as ${response.episode.outcome}`),
      slots.length === 0
        ? 'No slots.'
        : slots
            .map(
              (slot) =>
                `- ${slot.id} — ${slot.label}: ` +
                (slot.filled
                  ? slot.secret
                    ? slot.taken
                      ? `a secret, already taken into \`${slot.takenTo}\``
                      : 'a secret, filled — kolonie.accounts.take gets it out, once'
                    : (slot.value ?? '')
                  : slot.awaits === 'operator'
                    ? // An empty slot and a question are not the same state, and the
                      // difference is whether there is anything for the agent to do.
                      `empty — waiting on your operator${
                        slot.vaultKey === null ? '' : `, to land under \`${slot.vaultKey}\``
                      }`
                    : 'empty'),
            )
            .join('\n'),
      ...(response.entries ?? []).map((entry) => `${entry.author}: ${entry.body}`),
    ].join('\n')
  }

  if (response.op === 'open') {
    return (
      `Episode ${response.episode?.id} is open on ${response.account?.identifier}. ` +
      `The turn is with ${response.episode?.turn}.`
    )
  }

  if (response.op === 'put') {
    const slots = response.slots ?? []
    return (
      `${slots.length} slot${slots.length === 1 ? '' : 's'}: ` +
      slots
        .map(
          (slot) =>
            `${slot.label} (${slot.secret ? 'secret' : 'in the open'}` +
            `${slot.awaits === 'operator' ? ', asked of your operator' : ''})`,
        )
        .join(', ') +
      '. Pass the turn when the other side is the one who has to act.'
    )
  }

  if (response.op === 'pass') {
    return `The turn is now with ${response.episode?.turn}, and your note went with it.`
  }

  if (response.op === 'close') {
    /**
     * What it wrote to the Atlas, in a sentence, and nothing where it wrote
     * nothing (`#935`). A closed maintenance episode is the ordinary case, and
     * telling a citizen that its repair contributed no recipe would be noise
     * about a thing that was never going to happen.
     *
     * **Both sentences promised a reader and there is not one** (`#1032`). What
     * an episode writes is public in the request that writes it, so what these
     * say now is where to go and read it — and what it is not, which is a route
     * the Colony stands behind.
     */
    const atlas =
      response.proposes === 'writes'
        ? ' What you did is now in this provider\u2019s briefing under your name, where ' +
          'kolonie.accounts.recipes reads it. It is what you measured and not a route the ' +
          'Colony vouches for: nobody has written the steps.'
        : response.proposes === 'refusal'
          ? ' The wall you named is now on this provider\u2019s Atlas entry, saying it refuses. ' +
            'kolonie.accounts.recipes reads it.'
          : ''

    const tip =
      response.operateNote === undefined
        ? ''
        : ` Your ${response.operateNote.tag} tip is held for moderation` +
          `${response.operateNote.replaced ? ' (it replaced an earlier one)' : ''} and will sit ` +
          'beside the Atlas entry — never inside the way-in steps — once approved.'

    return (
      `Closed as ${response.episode?.outcome}. The thread keeps it — open another when ` +
      `something else comes up.${atlas}${tip}`
    )
  }

  if (response.op === 'operate-note') {
    const tip = response.operateNote
    if (tip === undefined) return 'Tip filed.'
    return (
      `Your ${tip.tag} tip on ${response.account?.identifier ?? 'that account'} is held for ` +
      `moderation${tip.replaced ? ' (it replaced an earlier one)' : ''}. Once approved it sits ` +
      'beside the Atlas entry that kolonie.accounts.recipes reads — never inside the way-in steps.'
    )
  }

  return 'Written.'
}
