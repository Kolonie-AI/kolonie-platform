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
 *
 * ## The per-tool ceiling was here and is gone (`#1518`)
 *
 * `#1235` added a second guard beside the sums: no single tool may weigh more
 * than the heaviest one already published, because **a sum permits any single
 * tool** — a 7,000-byte tool passes the floor as long as something else shrank
 * by 7,000. That reasoning was sound and the number is worth keeping in view if
 * anybody rebuilds it: on 2026-08-18 the heaviest tool was 7,668 bytes against a
 * median of 1,600, and nothing measured a tool against anything but the total.
 *
 * **It was removed on 2026-08-21 by the operator's decision**, on a cost that had
 * inverted. It moved four times and three of those were hand-raises; two came on
 * one day, each for a single member of a closed enum — `WallKindSchema` is
 * serialised three times inside `kolonie.accounts.recipes`, so one 22-character
 * value cost the heaviest tool ~70 bytes and a written justification. So the
 * ceiling taxed exactly the vocabulary
 * `the-catalogue-encodes-grammar-never-vocabulary` tells authors to prefer.
 *
 * The floor is untouched, and the difference is the one this module already
 * argues: since `#1465` the sums are measured on `main` and committed there, so
 * an author never types one. The ceiling never gained that — it was, in
 * `check-catalogue-budget.mjs`'s own words, *"a sentence rather than a
 * measurement"*, and a sentence somebody types on a branch is what was costing.
 *
 * **What is lost is real**: nothing now measures one tool against the others.
 * The operator watches it by hand for this phase. Whoever wants the guard back
 * has the argument in `#1235` already made, and the way back is a ratchet that
 * lives on `main` like the floor's rather than a second figure on a branch.
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
 * What `main` should do about a measurement, floor in hand (`#1465`).
 *
 * ## The number stopped being authored on a branch
 *
 * Until `#1465` a branch that grew the surface edited
 * `apps/api/src/mcp/catalogue-budget.json` itself, and that made the file
 * collide with every other branch doing the same. The resolution was never *pick
 * a side*: it is `main`'s value plus this branch's delta, which git cannot
 * compute — so a careless rebase landed a floor **below** what the branch
 * actually served, green on the branch and red on `main` for everybody. `#1422`
 * lost three rebases to it in one afternoon and `#1456` reddened `main`.
 *
 * The floor was always a *measurement*, and a measurement is the one kind of
 * number nobody should be typing. So `main` writes it, in the run that measured
 * it, in both directions — {@link branchBudgetVerdict} already judges the branch
 * against its merge base and never reads this file, so nothing on a branch has
 * any reason to touch it.
 *
 * ## What a branch still owes, and it is the half only a person can supply
 *
 * **The sentence.** A raise is a decision and still costs one: this refuses to
 * write a raise whose landing message does not satisfy {@link raiseIsJustified}.
 * That is the same test {@link branchBudgetVerdict} runs against the pull
 * request's title and body, and under a squash queue those are the same text —
 * which is exactly why the two can now agree. A branch that went green on its
 * own gate lands green here, and `#1379`'s failure — justified on the branch,
 * refused on `main` because the squash rewrote the message — has nothing left to
 * bite.
 *
 * **A lowering costs nothing**, as it has since `#1118`. A saving is bookkeeping
 * and demanding a sentence for one is how savings go unrecorded.
 *
 * ## What this deliberately does not do
 *
 * It does not judge whether the justification is *true*, any more than
 * {@link raiseIsJustified} does. It stops the floor moving in silence, which is
 * the only thing a mechanism can stop here.
 */
export type MainRatchetOutcome = 'raised' | 'lowered' | 'at' | 'refused'

/** What `main` should write, and what to say about it. */
export interface MainRatchetVerdict {
  readonly outcome: MainRatchetOutcome
  /** The sums to commit. Present on a move, absent otherwise. */
  readonly totals?: CatalogueTotals
  /**
   * The justification to record in `raisedFor`, on a raise. Absent on a
   * lowering, which knows nothing about why the previous floor stood where it
   * did (`#1317`).
   */
  readonly raisedFor?: string
  readonly message: string
}

export function mainFloorRatchet(
  measured: CatalogueTotals,
  budget: CatalogueBudget,
  landingMessage?: string,
): MainRatchetVerdict {
  const verdict = budgetVerdict(measured, budget)

  if (verdict.direction === 'under') {
    return {
      outcome: 'lowered',
      totals: { tools: measured.tools, bytes: measured.bytes },
      message:
        `The floor has come down to ${measured.tools} tools and ${measured.bytes} bytes, ` +
        'committed to main below. Nothing to do.',
    }
  }

  if (verdict.direction === 'at') return { outcome: 'at', message: verdict.message }

  if (landingMessage !== undefined && raiseIsJustified(landingMessage)) {
    return {
      outcome: 'raised',
      totals: { tools: measured.tools, bytes: measured.bytes },
      raisedFor: landingMessage.trim(),
      message:
        `The floor has gone up to ${measured.tools} tools and ${measured.bytes} bytes ` +
        `(+${verdict.tools} tools, +${verdict.bytes} bytes), committed to main below. ` +
        `The commit that landed names ${GRAMMAR_RECORD} and says what the growth is ` +
        'vocabulary-free for, which is what a raise costs; the figure itself is measured ' +
        'and was not typed by anybody.',
    }
  }

  return {
    outcome: 'refused',
    message:
      `The catalogue grew past its floor by ${verdict.tools} tools and ${verdict.bytes} bytes ` +
      `(${measured.tools} tools, ${measured.bytes} bytes against ${budget.tools} and ` +
      `${budget.bytes}), and the commit that landed does not say why. ` +
      `A raise is written here automatically, but only for a message naming ${GRAMMAR_RECORD} ` +
      'and saying what the growth is vocabulary-free for. Nothing is committed, and the floor ' +
      'stands where it was.',
  }
}

/**
 * Whether this run is one whose verdict may **fail** a build (`#1567`).
 *
 * ## The eviction this exists to stop
 *
 * `#1561` removes a database column. Its diff under `apps/api/src/mcp/` is
 * empty. It was evicted from the merge queue **four times in ninety minutes**,
 * every time on `catalogue-budget.test.ts` reporting *the catalogue grew by 2
 * tools* — two tools added by other pull requests that had already merged. It
 * could not have caused it and could not have fixed it. It was the thing in the
 * queue when the figure went stale.
 *
 * ## Why a merge group cannot answer the question this check asks
 *
 * The check asks *what did this change add to the catalogue*. In a merge group
 * the served catalogue is `main` **plus every entry ahead of you**, so the
 * difference against any committed figure is what several changes added
 * together. No verdict about *this entry* can be drawn from it, whatever the
 * figure it is compared with.
 *
 * **That is the operative reason, and it is not the one `#1567` gives.** The
 * issue argues that a merge group has no pull request to write a justification
 * in. That is true of the event *payload* and not of the run:
 * `.github/actions/catalogue-floor-pr-text` reads the number out of the queue
 * ref and fetches the title and body over the API (`#1545`), so the text is
 * there. Fixing the floor job (`#1566`) does not close this either — it narrows
 * the window to one queue cycle and leaves the trap armed inside it. What is
 * wrong is the *measurement*, not the justification and not the freshness.
 *
 * ## So: position A, and what is given up by it
 *
 * The gate belongs on the pull request, where an author is present and where the
 * comparison is against that branch's own merge base. A merge group only re-runs
 * what the branch already answered.
 *
 * What is given up is the case position B would catch: what a *combination* of
 * entries serves, which is the only thing a merge group can see. Nobody has
 * claimed that is what this check is for, and it would need a per-entry base the
 * queue does not hand out. If somebody wants it, it is a different check with a
 * different name and it is not required.
 *
 * The figure is still **measured and reported** in a merge group. What stops is
 * failing a build for it.
 */
export function catalogueBudgetBinds(eventName: string | undefined): boolean {
  return eventName !== 'merge_group'
}

/**
 * **The other thing it can be, said out loud** (`#1567`).
 *
 * A required check must not be able to fail for a reason outside the change
 * under test, and on a pull request this one still can: the floor is committed by
 * a job on `main`, and while that job cannot land the figure — or in the one
 * queue cycle it lags by even when it can (`#1566`) — a branch that added no tool
 * is measured against a number that predates `main`.
 *
 * The check cannot tell the two apart from where it stands: *this branch added a
 * tool* and *this branch added nothing and the floor is behind* produce the same
 * arithmetic. So it says which the reader should check and how, rather than
 * asserting the one it cannot know. That is the whole remedy available without
 * a per-entry base the queue does not hand out.
 */
const NOT_YOURS =
  'If this branch adds no tool of its own, the floor may simply be behind `main` — compare ' +
  '`git show origin/main:apps/api/src/mcp/catalogue-budget.json` with what `main` serves. ' +
  'A floor trailing the surface is `#1566` and is nothing this branch can fix.'

/**
 * The remedy sentence, which must not ask for a place that is not there
 * (`#1567`).
 *
 * **`undefined` and `''` are different answers and this is where the difference
 * pays.** `undefined` means *no pull request was readable from this run at all*
 * — an ordinary local `npm run check`, where a message saying *say so in this
 * pull request* names a thing the caller has none of and cannot make. `''` means
 * *there is one and it says nothing*, which is the case the sentence was written
 * for and where it is exactly right.
 *
 * This is the same shape as `#1379`: a verdict reached against text that is
 * absent at the moment of judging. There it reddened `main`; here it printed a
 * remedy a reader could not take.
 */
function sayWhy(justification: string | undefined): string {
  return justification === undefined
    ? `say so where this lands: the pull request title or body must name ${GRAMMAR_RECORD} ` +
        'and say what the growth is vocabulary-free for. To weigh it before there is a pull ' +
        'request, put the text in CATALOGUE_FLOOR_PR_TEXT for one run.'
    : `say so in this pull request: name ${GRAMMAR_RECORD} in the title or body and say what ` +
        'the growth is vocabulary-free for.'
}

/**
 * Compare a pull-request head against its merge base (`#1266`).
 *
 * **Tools stay at zero.** One added tool fails unless the branch justifies it.
 * **Bytes get {@link CATALOGUE_BYTE_TOLERANCE}.** Growth at or under it passes;
 * past it fails, unless the branch justifies it. **A shrink is reported and not
 * failed** — `main` records the saving on merge, in the same run that measures
 * it. No branch writes `catalogue-budget.json`.
 *
 * ## The way out this names, it now takes (`#1307`)
 *
 * Until `#1307` both failing branches printed *raise the floor by hand in a
 * commit that names the record* and then ignored whether anybody had. The
 * verdict compares head against merge base, so editing the floor file moved the
 * measurement and not the comparison, and an author who followed the second
 * remedy was told the same thing again. **The only remedy that worked was the
 * first one** — cut the prose — which for a genuinely new verb is not a remedy
 * at all: `tools > 0` failed outright with a way-out that led nowhere, so a
 * justified tool addition could not pass this gate by any route.
 *
 * So the gate reads `justification` and calls {@link raiseIsJustified} on it,
 * exactly as {@link floorChangeVerdict} does on `main`.
 *
 * **What that text is, is the point.** It is the pull request's own title and
 * body, not a commit message from somewhere in the branch — because this repo
 * squash-merges, and the body is what becomes the commit message on `main`. So
 * the sentence this gate accepts is the same sentence `floorChangeVerdict` will
 * be handed when the branch lands: passing here means the merge passes there,
 * and a justification typed to get past this check is one that stays in the
 * history. A gate that accepted a different text would let a branch go green and
 * redden `main` on merge, which is the failure `#1317` spent a commit repairing.
 *
 * **Omitted, nothing changes.** A caller that passes no justification gets the
 * pre-`#1307` behaviour, which is the honest default for a run that has no pull
 * request to read one from.
 */
export function branchBudgetVerdict(
  measured: CatalogueTotals,
  base: CatalogueTotals,
  justification?: string,
): BudgetVerdict {
  const tools = measured.tools - base.tools
  const bytes = measured.bytes - base.bytes
  const justified = justification !== undefined && raiseIsJustified(justification)

  if (tools > 0) {
    if (justified) {
      return {
        within: true,
        direction: 'over',
        tools,
        bytes,
        message:
          `The catalogue grew by ${tools} tool${tools === 1 ? '' : 's'} and ${bytes} bytes ` +
          `against its merge base (${base.tools} tools, ${base.bytes} bytes), and this ` +
          `branch says why: it names ${GRAMMAR_RECORD} and what the growth is vocabulary-free for. ` +
          'Nothing on this branch writes the floor: main measures it and commits it ' +
          'when this lands (`#1465`).',
      }
    }

    return {
      within: false,
      direction: 'over',
      tools,
      bytes,
      message:
        `The catalogue grew by ${tools} tool${tools === 1 ? '' : 's'} and ${bytes} bytes ` +
        `against its merge base (${base.tools} tools, ${base.bytes} bytes). ` +
        `If the growth is a new rung, it belongs in a \`kind\` enum and costs zero tools — see ${GRAMMAR_RECORD}. ` +
        `If it is a genuinely new verb, ${sayWhy(justification)} The floor itself ` +
        'is not yours to edit — main measures it and commits it when this lands (`#1465`). ' +
        NOT_YOURS,
    }
  }

  if (bytes > CATALOGUE_BYTE_TOLERANCE) {
    if (justified) {
      return {
        within: true,
        direction: 'over',
        tools,
        bytes,
        message:
          `The catalogue grew by ${bytes} bytes against its merge base ` +
          `(${base.tools} tools, ${base.bytes} bytes), past the tolerance of ` +
          `${CATALOGUE_BYTE_TOLERANCE} bytes, and this branch says why: it names ` +
          `${GRAMMAR_RECORD} and what the growth is vocabulary-free for. Tools are unchanged. ` +
          'Nothing on this branch writes the floor: main measures it and commits it ' +
          'when this lands (`#1465`).',
      }
    }

    return {
      within: false,
      direction: 'over',
      tools,
      bytes,
      message:
        `The catalogue grew by ${bytes} bytes against its merge base ` +
        `(${base.tools} tools, ${base.bytes} bytes), past the tolerance of ` +
        `${CATALOGUE_BYTE_TOLERANCE} bytes. Tools are unchanged. ` +
        `Cut the prose, or ${sayWhy(justification)} ` +
        'The floor itself is not yours to edit — main measures it and commits it when this ' +
        'lands (`#1465`). ' +
        NOT_YOURS,
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
