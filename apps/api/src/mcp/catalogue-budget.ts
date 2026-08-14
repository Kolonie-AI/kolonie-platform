/**
 * The catalogue is held to a budget, and the budget is a ratchet (`#889`).
 *
 * ## Why this gates where `surface-size.ts` reports
 *
 * `#388` refused a hard ceiling and this does not reopen that: a ceiling is a
 * number somebody picks, and new tools have to be able to exist. **A ratchet is
 * not a ceiling.** It carries no opinion about how big the catalogue should be —
 * it says only that today's size is the size, and that growing past it is an act
 * somebody performs deliberately rather than one that happens because no single
 * pull request ever added more than a namespace. That is how the surface reached
 * 97 tools and 160,346 bytes without anybody deciding it should.
 *
 * The rule it enforces is
 * [the catalogue encodes grammar, never vocabulary](https://github.com/Kolonie-AI/kolonie-docs/blob/main/state/decisions/the-catalogue-encodes-grammar-never-vocabulary.md)
 * (`kolonie-docs#346`), whose acceptance test is that **a new rung costs zero new
 * tools**. A rung added as a `kind` moves nothing here. A rung added as a tool
 * trips it, which is the whole point.
 *
 * ## No headroom, in either direction
 *
 * The budget is the last committed measurement exactly. **Slack in a budget gets
 * spent**, and then the next figure is argued from the spent one rather than from
 * the measurement — which is how a limit becomes a floor for the next limit.
 *
 * Shrinking trips it too, and that is deliberate rather than an oversight. A
 * ratchet that only caught growth would let a consolidation's saving sit
 * unrecorded until the next feature quietly spent it. The cost is one command
 * after a consolidation; {@link budgetVerdict} names that command in the message
 * it returns, and `--write` **only ever lowers** — there is no argument that
 * raises the floor for you.
 *
 * ## Raising it
 *
 * By hand, in a commit whose message names the record and says what the new tools
 * are vocabulary-free for. {@link raiseIsJustified} is what reads that message,
 * and it is a string test rather than a judgement: it cannot tell a real
 * justification from a plausible one, and it is not trying to. What it makes
 * impossible is raising the number *silently*, which is the only failure mode a
 * mechanism can address here.
 */

/** The floor, as committed. Every field carries the measurement it came from. */
export interface CatalogueBudget {
  /** Tools in the authenticated `tools/list`. */
  readonly tools: number
  /** Bytes of the same list, serialised the way the server publishes it. */
  readonly bytes: number
  /** The date the figures were measured, `YYYY-MM-DD`. */
  readonly measuredAt: string
  /** The command that produced them, so a reader can reproduce rather than trust. */
  readonly command: string
}

/** What a measurement is doing relative to the floor. */
export type BudgetDirection = 'over' | 'at' | 'under'

/** The verdict, with the arithmetic that produced it kept visible. */
export interface BudgetVerdict {
  readonly within: boolean
  readonly direction: BudgetDirection
  /** Measured minus budgeted. Negative after a consolidation. */
  readonly tools: number
  readonly bytes: number
  /** One line, addressed to whoever is reading a failed check. */
  readonly message: string
}

/** What the budget is compared against — the two totals and nothing else. */
export interface CatalogueTotals {
  readonly tools: number
  readonly bytes: number
}

/**
 * The record the commit message has to name to raise the floor.
 *
 * Spelled out rather than assembled from parts, so that grepping the repository
 * for the slug finds this check as well as the prose that cites it.
 */
export const GRAMMAR_RECORD = 'the-catalogue-encodes-grammar-never-vocabulary'

/**
 * Compare a measurement against the floor.
 *
 * **Bytes and tools are both binding, and either one alone fails it.** A change
 * that removes a tool and adds 9 KB of prose to the survivors has not made the
 * catalogue cheaper, and a count on its own would call it a saving.
 */
export function budgetVerdict(measured: CatalogueTotals, budget: CatalogueBudget): BudgetVerdict {
  const tools = measured.tools - budget.tools
  const bytes = measured.bytes - budget.bytes

  if (tools > 0 || bytes > 0) {
    return {
      within: false,
      direction: 'over',
      tools,
      bytes,
      message:
        `The catalogue grew past its budget: ${measured.tools} tools and ${measured.bytes} bytes ` +
        `against a floor of ${budget.tools} and ${budget.bytes} (measured ${budget.measuredAt}). ` +
        `If the growth is a new rung, it belongs in a \`kind\` enum and costs zero tools — see ${GRAMMAR_RECORD}. ` +
        'If it is a genuinely new verb, raise the floor by hand in a commit that names that record ' +
        'and says what the new tools are vocabulary-free for.',
    }
  }

  if (tools < 0 || bytes < 0) {
    return {
      within: false,
      direction: 'under',
      tools,
      bytes,
      message:
        `The catalogue is smaller than its budget by ${-tools} tools and ${-bytes} bytes, ` +
        'and the floor has not come down with it. Run `node scripts/check-catalogue-budget.mjs --write`, ' +
        'which lowers it and can do nothing else. A saving nobody records is one the next feature spends.',
    }
  }

  return {
    within: true,
    direction: 'at',
    tools,
    bytes,
    message: `The catalogue is exactly its budget: ${measured.tools} tools, ${measured.bytes} bytes.`,
  }
}

/**
 * Whether a commit message justifies raising the floor.
 *
 * Two things, both cheap to check and neither of them a judgement: it names
 * {@link GRAMMAR_RECORD}, and it says what the new tools are **vocabulary-free**
 * for — the word the record turns on, so writing it means having read it.
 *
 * **This cannot tell a real justification from a plausible one**, and a
 * determined author gets past it in one line. It is not built against that
 * author. It is built against the ordinary case where the floor moves because a
 * check was failing and moving it was the quickest way to a green run, which is
 * exactly the case a sentence somebody had to type stops.
 */
export function raiseIsJustified(commitMessage: string): boolean {
  const text = commitMessage.toLowerCase()
  return text.includes(GRAMMAR_RECORD) && text.includes('vocabulary-free')
}
