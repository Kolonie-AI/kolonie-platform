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
 * unrecorded until the next feature quietly spent it. **A reduction costs
 * nobody a command** (`#1118`): `scripts/check-catalogue-budget.mjs` writes the
 * lower figure in the same run that measured it, and the workflow commits it on
 * a push to `main` (`#1266` — a pull request never writes the floor, so
 * concurrent branches cannot collide on it). What that removes is the window
 * where a saving is real, unrecorded, and available to the next feature.
 *
 * ## Raising it
 *
 * By hand, in a commit whose message names the record and says what the new tools
 * are vocabulary-free for. {@link raiseIsJustified} is what reads that message,
 * and it is a string test rather than a judgement: it cannot tell a real
 * justification from a plausible one, and it is not trying to. What it makes
 * impossible is raising the number *silently*, which is the only failure mode a
 * mechanism can address here.
 *
 * **`#889` wrote that rule and nothing enforced it.** `raiseIsJustified` was a
 * function with unit tests and no caller: the floor was a number in a file, and
 * editing it took whatever the editor was willing to type in the commit body,
 * checked by nobody. {@link floorChangeVerdict} is the caller `#1118` added — it
 * is handed the two versions of the floor and the message of the commit that
 * moved it, and it refuses a raise whose commit says nothing.
 * `scripts/check-catalogue-floor.mjs` reads that pair out of `git` and runs it,
 * which is why the rule now costs a sentence rather than describing one.
 */

import { toolBytesOf, type PublishedTool } from './catalogue-size.js'

/** The floor, as committed. Every field carries the measurement it came from. */
export interface CatalogueBudget {
  /** Tools in the authenticated `tools/list`. */
  readonly tools: number
  /** Bytes of the same list, serialised the way the server publishes it. */
  readonly bytes: number
  /**
   * The heaviest single non-exempt tool, which no tool may exceed (`#1235`).
   *
   * A third figure rather than a fourth file: it is measured in the same run,
   * moves under the same ratchet, and is judged from the same commit — and a
   * second file would be a second commit for one decision.
   */
  readonly heaviest: ToolWeight
  /** The date the figures were measured, `YYYY-MM-DD`. */
  readonly measuredAt: string
  /** The command that produced them, so a reader can reproduce rather than trust. */
  readonly command: string
  /**
   * Why the floor stands where it does, when the last move was a raise
   * (`#1317`).
   *
   * **The commit message is still what {@link raiseIsJustified} reads**, and
   * this field changes nothing about that check. What it fixes is that the floor
   * had nowhere to be repaired. `d33a421b` raised the floor with a message that
   * justified the raise in substance and paraphrased the record's name instead
   * of writing it, so {@link floorChangeVerdict} refused it — and because that
   * verdict is computed against the *last* commit to touch this file, the
   * refusal stood on `main` for every later commit, with no honest edit
   * available to clear it. A file that can only be repaired by a diff nobody
   * meant is a file with no repair.
   *
   * So a raise states its own justification here, and a follow-up commit that
   * writes this field moves no figure — the verdict reads `unchanged`, which is
   * the truth about that commit.
   *
   * **Optional, and dropped by a lowering.** `scripts/check-catalogue-budget.mjs`
   * rewrites this file from a measurement, and a measurement knows nothing about
   * why the previous floor was raised. A justification outliving the figure it
   * justified is worse than an absent one.
   */
  readonly raisedFor?: string
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
 * Bytes a pull request may grow against its merge base before the gate fails
 * (`#1266`).
 *
 * Absolute, not a percentage: a percentage of a growing surface grows with it,
 * which is the slack this design refuses. **It does not accumulate** — each
 * branch is measured against its merge base, and `main`'s ratchet still records
 * the exact figure after every merge. Ten branches at +900 B each still merge
 * to a floor that is the exact sum, not ten forgiven kilobytes.
 *
 * Tools stay at zero: `+1 tool` still fails, and {@link raiseIsJustified} is
 * still how the floor is raised. This tolerance is for the byte-only edits the
 * old gate reddened — a wall `kind`, a clarified sentence — that added no tool
 * and still failed on the prose documenting them.
 */
export const CATALOGUE_BYTE_TOLERANCE = 1024

/**
 * Compare a measurement against the floor.
 *
 * **Bytes and tools are both binding, and either one alone fails it.** A change
 * that removes a tool and adds 9 KB of prose to the survivors has not made the
 * catalogue cheaper, and a count on its own would call it a saving.
 *
 * This is the comparison a push to `main` runs. A pull request uses
 * {@link branchBudgetVerdict} against its merge base instead (`#1266`), so a
 * later merge cannot retro-fail an open branch by re-lowering the committed
 * floor underneath it.
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
        'and the floor has not come down with it. `node scripts/check-catalogue-budget.mjs` lowers it ' +
        'in the same run that measured it, and can do nothing else. ' +
        'A saving nobody records is one the next feature spends.',
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
 * Compare a pull-request head against its merge base (`#1266`).
 *
 * **Tools stay at zero.** One added tool fails, with the same way-out the floor
 * names. **Bytes get {@link CATALOGUE_BYTE_TOLERANCE}.** Growth at or under it
 * passes; past it fails, naming the tolerance and the delta. **A shrink is
 * reported and not failed** — `main` records the saving on merge, in the same
 * run that measures it. No branch writes `catalogue-budget.json`.
 */
export function branchBudgetVerdict(
  measured: CatalogueTotals,
  base: CatalogueTotals,
): BudgetVerdict {
  const tools = measured.tools - base.tools
  const bytes = measured.bytes - base.bytes

  if (tools > 0) {
    return {
      within: false,
      direction: 'over',
      tools,
      bytes,
      message:
        `The catalogue grew by ${tools} tool${tools === 1 ? '' : 's'} and ${bytes} bytes ` +
        `against its merge base (${base.tools} tools, ${base.bytes} bytes). ` +
        `If the growth is a new rung, it belongs in a \`kind\` enum and costs zero tools — see ${GRAMMAR_RECORD}. ` +
        'If it is a genuinely new verb, raise the floor by hand in a commit that names that record ' +
        'and says what the new tools are vocabulary-free for.',
    }
  }

  if (bytes > CATALOGUE_BYTE_TOLERANCE) {
    return {
      within: false,
      direction: 'over',
      tools,
      bytes,
      message:
        `The catalogue grew by ${bytes} bytes against its merge base ` +
        `(${base.tools} tools, ${base.bytes} bytes), past the tolerance of ` +
        `${CATALOGUE_BYTE_TOLERANCE} bytes. Tools are unchanged. ` +
        'Cut the prose, or raise the floor by hand in a commit that names ' +
        `${GRAMMAR_RECORD} and says what the growth is vocabulary-free for.`,
    }
  }

  if (tools < 0 || bytes < 0) {
    return {
      within: true,
      direction: 'under',
      tools,
      bytes,
      message:
        `The catalogue is smaller than its merge base by ${-tools} tools and ${-bytes} bytes. ` +
        'Reported, not committed — `main` records the saving on merge.',
    }
  }

  if (bytes > 0) {
    return {
      within: true,
      direction: 'at',
      tools,
      bytes,
      message:
        `The catalogue grew by ${bytes} bytes against its merge base, ` +
        `within the ${CATALOGUE_BYTE_TOLERANCE}-byte tolerance. Tools unchanged.`,
    }
  }

  return {
    within: true,
    direction: 'at',
    tools,
    bytes,
    message: `The catalogue matches its merge base: ${measured.tools} tools, ${measured.bytes} bytes.`,
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

/** Which way a commit moved the floor. */
export type FloorMove = 'raised' | 'lowered' | 'unchanged'

/**
 * Which way the floor moved between two committed versions of it.
 *
 * **Either number moving up is a raise**, including the case where the other one
 * moved down. A commit that drops a tool and adds 9 KB to the survivors has
 * raised the byte floor, and the rule that governs raises applies to it — the
 * same asymmetry {@link budgetVerdict} enforces against a measurement, applied
 * here to the committed figures instead.
 */
export function floorMove(from: CatalogueTotals, to: CatalogueTotals): FloorMove {
  if (to.tools > from.tools || to.bytes > from.bytes) return 'raised'
  if (to.tools < from.tools || to.bytes < from.bytes) return 'lowered'
  return 'unchanged'
}

/** Whether a commit was allowed to move the floor the way it did. */
export interface FloorChangeVerdict {
  readonly allowed: boolean
  readonly move: FloorMove
  /** One line, addressed to whoever is reading a failed check. */
  readonly message: string
}

/**
 * Judge a commit that moved the floor (`#1118`).
 *
 * Three cases, and only one of them can fail. **Lowering needs no permission** —
 * it is the ratchet doing what it is for, and the run that measures a smaller
 * catalogue writes the smaller figure itself. **Unchanged is not a change** and
 * is not asked to justify itself. **Raising needs the sentence**
 * {@link raiseIsJustified} looks for, and a commit that does not carry it is
 * refused.
 *
 * This runs **after the fact, against history**, which is what makes it possible
 * at all: a check that ran before the commit existed would be asked to read a
 * message nobody had written yet. The cost of reading history instead is that
 * the refusal arrives one commit late — on the branch, in the pull request,
 * where amending is still ordinary.
 */
export function floorChangeVerdict(
  from: CatalogueTotals,
  to: CatalogueTotals,
  commitMessage: string,
): FloorChangeVerdict {
  const move = floorMove(from, to)

  if (move === 'unchanged') {
    return { allowed: true, move, message: 'The floor did not move.' }
  }

  if (move === 'lowered') {
    return {
      allowed: true,
      move,
      message:
        `The floor came down to ${to.tools} tools and ${to.bytes} bytes. ` +
        'A reduction needs no justification — recording it is the point of the ratchet.',
    }
  }

  if (raiseIsJustified(commitMessage)) {
    return {
      allowed: true,
      move,
      message:
        `The floor was raised to ${to.tools} tools and ${to.bytes} bytes, ` +
        `in a commit naming ${GRAMMAR_RECORD}.`,
    }
  }

  return {
    allowed: false,
    move,
    message:
      `The floor was raised from ${from.tools} tools and ${from.bytes} bytes to ` +
      `${to.tools} and ${to.bytes}, in a commit that does not say why. ` +
      `Raising it takes a commit message naming ${GRAMMAR_RECORD} and saying what the new ` +
      'tools are vocabulary-free for. If the growth is a new rung it belongs in a `kind` enum ' +
      'and costs zero tools, and the floor should not move at all.',
  }
}

/**
 * The ceiling: what any one tool may weigh (`#1235`).
 *
 * ## Why a sum was not enough
 *
 * Both figures above are sums, and **a sum permits any single tool**. A new tool
 * of 7,000 bytes passes the floor as long as something else shrank by 7,000. On
 * 2026-08-18 the floor was raised six times in one day, once per pull request:
 * the gate recorded the growth and did nothing to shape it. Measured the same
 * day, the heaviest tool was `kolonie.academy.answer` at 7,668 bytes against a
 * median of 1,600 — nearly five times it, and nothing said that was unusual,
 * because nothing measured a tool against anything but the total.
 *
 * `#388` refused a hard ceiling *for the surface*, on the ground that a whole
 * surface has to be allowed to grow with the Colony. That reasoning is right and
 * does not carry down: **one tool has no such claim.**
 *
 * ## Nobody picks the number
 *
 * The ceiling is the current heaviest non-exempt tool, and it only comes down —
 * the mechanism `#1118` gave the floor, applied to the maximum instead of the
 * sum. It starts where the catalogue already is, so it accuses nothing that
 * exists today, and every rewrite that lightens the worst tool lightens the
 * ceiling with it. A new tool has to fit under whatever the worst one currently
 * is, which gets stricter for free.
 *
 * ## `WARM_SET` is exempt, and that is the difference between a rule and a trap
 *
 * The thirteen tools of `defensive-prose.ts`'s warm set are exempt from cutting,
 * so nothing may edit them. The heaviest of them is `kolonie.register` at 3,678
 * bytes: a ceiling that counted it could never fall below 3,678 however much the
 * rest improved, and the ratchet would seize halfway down. Exempting them lets
 * the ceiling reach the median.
 *
 * The exempt set is a parameter of {@link heaviestTool} rather than an import,
 * so that this module states the rule and `defensive-prose.ts` remains the one
 * place the membership is written.
 *
 * ## Raising it
 *
 * As with the floor, by hand, in a commit naming {@link GRAMMAR_RECORD} — and
 * additionally **naming the tool**. That is not decoration: the ceiling's whole
 * question is why *this* tool is worth more than every other tool in the Colony,
 * and a commit that cannot name it has not asked the question.
 */

/** One tool's weight, and which tool it is. Provenance, so a refusal can name it. */
export interface ToolWeight {
  readonly name: string
  /** Bytes of that tool's published entry. */
  readonly bytes: number
}

/** What a measured heaviest tool is doing relative to the ceiling. */
export type CeilingDirection = 'over' | 'at' | 'under' | 'renamed'

/** The verdict, with the arithmetic that produced it kept visible. */
export interface CeilingVerdict {
  readonly within: boolean
  readonly direction: CeilingDirection
  /** Measured minus committed. Negative after a rewrite. */
  readonly bytes: number
  /** One line, addressed to whoever is reading a failed check. */
  readonly message: string
}

/**
 * The heaviest tool the ceiling is about — the heaviest one that is not exempt.
 *
 * Ties go to the name that sorts first, so that two tools of equal weight cannot
 * make the committed figure depend on the order the server happened to register
 * them in. `undefined` when every tool is exempt, which is a fixture rather than
 * a catalogue and is the caller's to interpret.
 */
export function heaviestTool(
  tools: readonly PublishedTool[],
  exempt: readonly string[],
): ToolWeight | undefined {
  const spared = new Set(exempt)
  let heaviest: ToolWeight | undefined

  for (const tool of tools) {
    if (spared.has(tool.name)) continue
    const bytes = toolBytesOf(tool)
    if (heaviest === undefined) heaviest = { name: tool.name, bytes }
    else if (bytes > heaviest.bytes) heaviest = { name: tool.name, bytes }
    else if (bytes === heaviest.bytes && tool.name < heaviest.name) {
      heaviest = { name: tool.name, bytes }
    }
  }

  return heaviest
}

/**
 * Compare the heaviest non-exempt tool against the committed ceiling.
 *
 * **Over is the refusal this exists for**, and it names the tool as well as the
 * two figures, because *which* tool is the only thing the author can act on.
 *
 * **Under is not a pass**, for the reason the floor gives: a saving nobody
 * records is one the next feature spends, and here it would be spent by a tool
 * nobody weighed against it. `scripts/check-catalogue-budget.mjs` writes the
 * lower figure in the run that measured it, so this costs nobody a decision.
 *
 * **A different tool at the same weight is `renamed`**, and also not a pass. The
 * number would still be right and the name beside it would be wrong — and that
 * name is what the raise rule reads and what a refusal quotes, so a stale one is
 * a check pointing at the wrong tool.
 */
export function ceilingVerdict(measured: ToolWeight, budget: CatalogueBudget): CeilingVerdict {
  const bytes = measured.bytes - budget.heaviest.bytes

  if (bytes > 0) {
    return {
      within: false,
      direction: 'over',
      bytes,
      message:
        `\`${measured.name}\` weighs ${measured.bytes} bytes, past the ceiling of ` +
        `${budget.heaviest.bytes} set by \`${budget.heaviest.name}\` (measured ${budget.measuredAt}). ` +
        'No tool may be heavier than the heaviest one already published. Cut it to fit, ' +
        `or raise the ceiling by hand in a commit naming ${GRAMMAR_RECORD}, naming ` +
        `\`${measured.name}\`, and saying why that tool is worth more than every other tool ` +
        'in the Colony.',
    }
  }

  if (bytes < 0) {
    return {
      within: false,
      direction: 'under',
      bytes,
      message:
        `The heaviest tool is \`${measured.name}\` at ${measured.bytes} bytes, ` +
        `${-bytes} under the committed ceiling of ${budget.heaviest.bytes}, ` +
        'and the ceiling has not come down with it. `node scripts/check-catalogue-budget.mjs` ' +
        'lowers it in the same run that measured it.',
    }
  }

  if (measured.name !== budget.heaviest.name) {
    return {
      within: false,
      direction: 'renamed',
      bytes,
      message:
        `The ceiling is still ${budget.heaviest.bytes} bytes, but \`${measured.name}\` sets it ` +
        `now rather than \`${budget.heaviest.name}\`. The name is what a refusal quotes and what ` +
        'a raise has to name, so it is recorded rather than inferred. ' +
        '`node scripts/check-catalogue-budget.mjs` writes it.',
    }
  }

  return {
    within: true,
    direction: 'at',
    bytes,
    message: `The heaviest tool is \`${measured.name}\`, at the ceiling of ${measured.bytes} bytes.`,
  }
}

/**
 * Whether a commit message justifies raising the ceiling.
 *
 * The floor's sentence plus the tool's name. **The name is the substantive
 * half**: {@link raiseIsJustified} can be satisfied by an author who has read the
 * record, and this can only be satisfied by one who knows which tool they are
 * making an exception for. Like the floor's, it is a string test and cannot tell
 * a real justification from a plausible one — and like the floor's, what it makes
 * impossible is the raise nobody had to think about.
 */
export function ceilingRaiseIsJustified(commitMessage: string, tool: string): boolean {
  const text = commitMessage.toLowerCase()
  return raiseIsJustified(commitMessage) && text.includes(tool.toLowerCase())
}

/**
 * Which way a commit moved the ceiling.
 *
 * **Bytes only.** A commit where a different tool became the heaviest at the same
 * weight has moved the ceiling nowhere, and asking it to justify itself would
 * charge a rewrite for bookkeeping it did not choose.
 */
export function ceilingMove(from: ToolWeight, to: ToolWeight): FloorMove {
  if (to.bytes > from.bytes) return 'raised'
  if (to.bytes < from.bytes) return 'lowered'
  return 'unchanged'
}

/**
 * Judge a commit that moved the ceiling — the counterpart of
 * {@link floorChangeVerdict}, and read from history by the same script.
 *
 * Three cases and only one can fail, exactly as with the floor: lowering is the
 * ratchet working, unchanged is not a change, and raising needs the sentence.
 */
export function ceilingChangeVerdict(
  from: ToolWeight,
  to: ToolWeight,
  commitMessage: string,
): FloorChangeVerdict {
  const move = ceilingMove(from, to)

  if (move === 'unchanged') {
    return { allowed: true, move, message: 'The per-tool ceiling did not move.' }
  }

  if (move === 'lowered') {
    return {
      allowed: true,
      move,
      message:
        `The per-tool ceiling came down to ${to.bytes} bytes, set by \`${to.name}\`. ` +
        'A reduction needs no justification.',
    }
  }

  if (ceilingRaiseIsJustified(commitMessage, to.name)) {
    return {
      allowed: true,
      move,
      message:
        `The per-tool ceiling was raised to ${to.bytes} bytes for \`${to.name}\`, ` +
        `in a commit naming both it and ${GRAMMAR_RECORD}.`,
    }
  }

  return {
    allowed: false,
    move,
    message:
      `The per-tool ceiling was raised from ${from.bytes} bytes to ${to.bytes}, ` +
      'in a commit that does not say why. Raising it takes a commit message naming ' +
      `${GRAMMAR_RECORD}, naming \`${to.name}\`, and saying why that tool is worth more than ` +
      'every other tool in the Colony. If it cannot be said, the tool is too big.',
  }
}
