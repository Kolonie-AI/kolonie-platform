import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { connectedClient, registeredCitizen } from '../__fixtures__/mcp.js'
import {
  branchBudgetVerdict,
  budgetVerdict,
  CATALOGUE_BYTE_TOLERANCE,
  ceilingChangeVerdict,
  ceilingRaiseIsJustified,
  ceilingVerdict,
  floorChangeVerdict,
  floorMove,
  GRAMMAR_RECORD,
  heaviestTool,
  mainFloorRatchet,
  raiseIsJustified,
  type CatalogueBudget,
} from './catalogue-budget.js'
import { measureCatalogue, type PublishedTool } from './catalogue-size.js'
import { WARM_SET } from './defensive-prose.js'

/**
 * The ratchet, checked against the catalogue this build actually serves (`#889`).
 *
 * **Why the floor is measured here and not against the deployment.** `#888`
 * measures `mcp.kolonie.ai`, which is the honest number for an argument about
 * what citizens load. A gate cannot use it: CI has no deployment to reach and no
 * credential to reach one with, and a check that needs both is a check that gets
 * disabled the first week it is flaky. So this weighs the same catalogue built
 * from the suite's own dependencies — no database, no credential, no network —
 * and the two figures are allowed to differ while a release is in flight. What
 * this gate is for is the *diff*: the pull request adding a tool trips it before
 * the tool is ever deployed, which is the only moment the growth is cheap to
 * refuse.
 *
 * On 2026-08-14 they did not differ at all — this suite and `mcp.kolonie.ai`
 * both served 97 tools and 160,346 bytes, so the floor `#888` argued from and
 * the floor this gate holds are the same number. Expect that to come apart
 * between a merge and a deploy, and do not build anything on it.
 *
 * It lives in the suite rather than in a script for the reason `surface-size.ts`
 * gives: fixtures are deliberately kept out of `dist` (`scripts/check-dist.mjs`),
 * so a script would have to build the server differently from the way it is
 * served, and a measurement built differently from its subject is the defect the
 * measurement exists to prevent. `scripts/check-catalogue-budget.mjs` runs this
 * file with {@link REPORT_PATH} set and reads what it writes.
 */

/** Where the check asks for the JSON. Unset in an ordinary run, and then nothing is written. */
const REPORT_PATH = process.env['CATALOGUE_BUDGET_REPORT']

/**
 * The floor, read as data rather than imported as a module.
 *
 * `resolveJsonModule` would put the file in the api's build graph and its
 * contents in `dist`, which makes a number the check rewrites into a build
 * artefact. It is data for a gate, so it is read like data.
 */
const BUDGET_PATH = join(new URL('.', import.meta.url).pathname, 'catalogue-budget.json')
const budget = JSON.parse(readFileSync(BUDGET_PATH, 'utf8')) as CatalogueBudget

/** The catalogue a connected citizen is handed — the tier the budget is about. */
const servedCatalogue = async (): Promise<readonly PublishedTool[]> => {
  const { colony, apiKey } = await registeredCitizen()
  const citizen = await connectedClient(colony, `Bearer ${apiKey}`)

  try {
    return (await citizen.client.listTools()).tools as readonly PublishedTool[]
  } finally {
    await citizen.close()
  }
}

describe('the committed budget', () => {
  it('carries the date and the command that produced it', () => {
    // AGENTS.md §7: a measurement without its provenance is a number somebody
    // typed. The floor moves by hand, so this is the only thing standing between
    // a reader and a figure with no history.
    expect(budget.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(budget.command).toContain('check-catalogue-budget.mjs')
    expect(budget.tools).toBeGreaterThan(0)
    expect(budget.bytes).toBeGreaterThan(0)
  })

  /**
   * `#1317`: the floor stood raised by a commit whose message justified it in
   * substance and did not name the record, and nothing on disk said why the
   * number was what it was. The field is optional because a lowering drops it —
   * present, it has to name the record, or it is decoration.
   */
  it('says why it stands where it does, naming the record, when it says anything', () => {
    if (budget.raisedFor === undefined) return

    expect(budget.raisedFor).toContain(GRAMMAR_RECORD)
    expect(budget.raisedFor).toContain('vocabulary-free')
  })

  it('carries the tool the per-tool ceiling is set by, not only its weight', () => {
    // A ceiling with no name is a number nobody can act on: the refusal quotes
    // the name and the raise rule reads it (`#1235`).
    expect(budget.heaviest.name).toMatch(/^kolonie\./)
    expect(budget.heaviest.bytes).toBeGreaterThan(0)
    expect(budget.heaviest.bytes).toBeLessThan(budget.bytes)
    expect(WARM_SET).not.toContain(budget.heaviest.name)
  })
})

describe('a measurement against the floor', () => {
  it('passes when it is exactly the floor, and reports no headroom', () => {
    const verdict = budgetVerdict({ tools: budget.tools, bytes: budget.bytes }, budget)

    expect(verdict.within).toBe(true)
    expect(verdict.direction).toBe('at')
    expect(verdict.tools).toBe(0)
    expect(verdict.bytes).toBe(0)
  })

  /**
   * **The rejection case `#889` asks for: a stub tool must fail the check.**
   *
   * One tool, with the shortest description anybody would write, is the cheapest
   * growth there is — and it is the shape every namespace arrived in. If the
   * ratchet does not catch this it catches nothing, because nobody adds a
   * catalogue at once.
   */
  it('fails on one added stub tool', () => {
    const stub: PublishedTool = { name: 'kolonie.stub', description: 'A stub.' }
    const measured = measureCatalogue([stub])

    const verdict = budgetVerdict(
      { tools: budget.tools + measured.tools, bytes: budget.bytes + measured.bytes },
      budget,
    )

    expect(verdict.within).toBe(false)
    expect(verdict.direction).toBe('over')
    expect(verdict.tools).toBe(1)
    expect(verdict.bytes).toBeGreaterThan(0)
    // The message has to name the way out, or the next author's cheapest move is
    // to edit the number.
    expect(verdict.message).toContain(GRAMMAR_RECORD)
    expect(verdict.message).toContain('`kind`')
  })

  it('fails on prose that grew without the tool count moving', () => {
    // A consolidation that removes a tool and moves its prose onto the survivors
    // has saved nothing. A count-only budget would call it a win.
    const verdict = budgetVerdict({ tools: budget.tools, bytes: budget.bytes + 9_000 }, budget)

    expect(verdict.within).toBe(false)
    expect(verdict.direction).toBe('over')
    expect(verdict.tools).toBe(0)
    expect(verdict.bytes).toBe(9_000)
  })

  /**
   * **Shrinking fails too, and that is the ratchet rather than a bug.**
   *
   * A saving nobody records is one the next feature spends without anybody
   * noticing it was spent. Since `#1118` nobody pays for it: the check writes
   * the lower figure in the same run, and the message names the command that
   * did rather than one to go and run.
   */
  it('fails when the catalogue shrank and the floor did not follow', () => {
    const verdict = budgetVerdict({ tools: budget.tools - 3, bytes: budget.bytes - 4_000 }, budget)

    expect(verdict.within).toBe(false)
    expect(verdict.direction).toBe('under')
    expect(verdict.tools).toBe(-3)
    expect(verdict.bytes).toBe(-4_000)
    expect(verdict.message).toContain('check-catalogue-budget.mjs')
  })
})

/**
 * The pull-request half of the gate (`#1266`).
 *
 * A branch is judged against its merge base, not against the committed floor
 * file — so a later merge cannot re-lower the floor underneath an open branch
 * and retro-fail it. Tools stay at zero; bytes get {@link CATALOGUE_BYTE_TOLERANCE}.
 */
describe('a pull request against its merge base', () => {
  const base = { tools: 110, bytes: 189_523 }

  it('exports the absolute tolerance the workflow reads', () => {
    expect(CATALOGUE_BYTE_TOLERANCE).toBe(1024)
  })

  /** The acceptance cases the issue names: +52 and +95 with no tool change. */
  it('passes under the tolerance with no tool change', () => {
    for (const growth of [52, 95, CATALOGUE_BYTE_TOLERANCE]) {
      const verdict = branchBudgetVerdict({ tools: base.tools, bytes: base.bytes + growth }, base)

      expect(verdict.within, `+${growth} B`).toBe(true)
      expect(verdict.direction).toBe('at')
      expect(verdict.tools).toBe(0)
      expect(verdict.bytes).toBe(growth)
      expect(verdict.message).toContain(String(CATALOGUE_BYTE_TOLERANCE))
    }
  })

  it('fails past the tolerance, naming it and the delta', () => {
    const growth = CATALOGUE_BYTE_TOLERANCE + 1
    const verdict = branchBudgetVerdict({ tools: base.tools, bytes: base.bytes + growth }, base)

    expect(verdict.within).toBe(false)
    expect(verdict.direction).toBe('over')
    expect(verdict.tools).toBe(0)
    expect(verdict.bytes).toBe(growth)
    expect(verdict.message).toContain(String(CATALOGUE_BYTE_TOLERANCE))
    expect(verdict.message).toContain(String(growth))
  })

  /** Tools stay at zero even when the byte growth would fit the tolerance. */
  it('fails on one added tool, however small the byte delta', () => {
    const verdict = branchBudgetVerdict({ tools: base.tools + 1, bytes: base.bytes + 40 }, base)

    expect(verdict.within).toBe(false)
    expect(verdict.direction).toBe('over')
    expect(verdict.tools).toBe(1)
    expect(verdict.message).toContain(GRAMMAR_RECORD)
    expect(verdict.message).toContain('`kind`')
  })

  /** A shrink is reported and not failed — `main` records it on merge. */
  it('passes a shrink against the merge base without asking for a write-back', () => {
    const verdict = branchBudgetVerdict({ tools: base.tools - 1, bytes: base.bytes - 400 }, base)

    expect(verdict.within).toBe(true)
    expect(verdict.direction).toBe('under')
    expect(verdict.message).toContain('main')
    expect(verdict.message).not.toContain('check-catalogue-budget.mjs')
  })

  it('passes an exact match', () => {
    const verdict = branchBudgetVerdict(base, base)

    expect(verdict.within).toBe(true)
    expect(verdict.direction).toBe('at')
    expect(verdict.tools).toBe(0)
    expect(verdict.bytes).toBe(0)
  })

  /**
   * `#1307`: both failing branches printed *raise the floor by hand in a commit
   * that names the record* and then never read one. The verdict compares head
   * against merge base, so editing the floor file moved the measurement and not
   * the comparison — an author who followed the printed remedy was told the same
   * thing again, and a genuinely new verb had no route past this gate at all.
   */
  describe('the way out it prints, it takes (#1307)', () => {
    const justified =
      'Add kolonie.accounts.walk-status.\n\n' +
      `A new verb, so the floor rises. Under ${GRAMMAR_RECORD} ` +
      'the growth is vocabulary-free: it names no provider, kind or wall — those stay in the core enums.'
    const unjustified = 'Add kolonie.accounts.walk-status.\n\nNew tool, floor bumped.'

    it('passes a tool addition the pull request justifies', () => {
      const verdict = branchBudgetVerdict(
        { tools: base.tools + 1, bytes: base.bytes + 900 },
        base,
        justified,
      )

      expect(verdict.within).toBe(true)
      expect(verdict.tools).toBe(1)
      // Still reported as growth. Justified is not the same as unchanged, and a
      // reader of the sticky comment is owed the number either way.
      expect(verdict.direction).toBe('over')
      expect(verdict.message).toContain(GRAMMAR_RECORD)
    })

    it('passes byte growth past the tolerance the pull request justifies', () => {
      const verdict = branchBudgetVerdict(
        { tools: base.tools, bytes: base.bytes + CATALOGUE_BYTE_TOLERANCE + 4_000 },
        base,
        justified,
      )

      expect(verdict.within).toBe(true)
      expect(verdict.direction).toBe('over')
      expect(verdict.bytes).toBe(CATALOGUE_BYTE_TOLERANCE + 4_000)
    })

    it('still fails when the pull request says nothing', () => {
      const tools = branchBudgetVerdict(
        { tools: base.tools + 1, bytes: base.bytes + 900 },
        base,
        unjustified,
      )
      const bytes = branchBudgetVerdict(
        { tools: base.tools, bytes: base.bytes + CATALOGUE_BYTE_TOLERANCE + 4_000 },
        base,
        unjustified,
      )

      expect(tools.within).toBe(false)
      expect(bytes.within).toBe(false)
    })

    /**
     * The same two tokens `floorChangeVerdict` is held to, because this repo
     * squash-merges: the body this gate reads is the message that gate is
     * handed. A branch gate accepting a looser test would go green and redden
     * `main` on merge.
     */
    it('holds the branch to the same test the floor gate applies on main', () => {
      const half = `A new verb. See ${GRAMMAR_RECORD}.`
      const other = 'A new verb, and the growth is vocabulary-free.'

      for (const text of [half, other]) {
        expect(raiseIsJustified(text)).toBe(false)
        expect(
          branchBudgetVerdict({ tools: base.tools + 1, bytes: base.bytes }, base, text).within,
          text,
        ).toBe(false)
      }

      expect(raiseIsJustified(justified)).toBe(true)
    })

    /** Omitted, the gate is what it was before `#1307`. */
    it('fails as before when no justification is passed at all', () => {
      expect(branchBudgetVerdict({ tools: base.tools + 1, bytes: base.bytes }, base).within).toBe(
        false,
      )
    })

    /** A shrink was never failing, and a justification does not make it growth. */
    it('leaves a shrink alone whatever the pull request says', () => {
      const verdict = branchBudgetVerdict(
        { tools: base.tools - 1, bytes: base.bytes - 400 },
        base,
        justified,
      )

      expect(verdict.within).toBe(true)
      expect(verdict.direction).toBe('under')
    })
  })
})

/**
 * `#1465`: the floor stopped being a number anybody types.
 *
 * Every branch that grew the surface used to edit the same integer, so two of
 * them conflicted by construction and the resolution — `main`'s value plus this
 * branch's delta — is one git cannot compute. What made that dangerous rather
 * than tedious is that getting it wrong is *green on the branch*: the branch
 * gate weighs head against merge base and never reads the file at all.
 */
describe('what main does with a measurement (#1465)', () => {
  const floor: CatalogueBudget = {
    tools: 121,
    bytes: 217_025,
    heaviest: { name: 'kolonie.accounts.recipes', bytes: 6214 },
    measuredAt: '2026-08-20',
    command: 'node scripts/check-catalogue-budget.mjs',
  }

  const justified =
    'Let a walker file tags on walk-report\n\n' +
    `A new verb, so the floor rises. Under ${GRAMMAR_RECORD} the growth is ` +
    'vocabulary-free: it names no provider, kind or wall.'
  const unjustified = 'Let a walker file tags on walk-report\n\nFloor bumped.'

  it('writes a raise the landing commit justifies, with the figure it measured', () => {
    const verdict = mainFloorRatchet(
      { tools: floor.tools + 1, bytes: floor.bytes + 1493 },
      floor,
      justified,
    )

    expect(verdict.outcome).toBe('raised')
    expect(verdict.totals).toEqual({ tools: floor.tools + 1, bytes: floor.bytes + 1493 })
    expect(verdict.message).toContain(String(floor.bytes + 1493))
  })

  /**
   * The sentence is recorded where a later reader can find it, which is the
   * `#1317` repair: the floor's own file says why it stands where it does,
   * rather than only a commit somewhere behind it.
   */
  it('records the justification on the raise it writes', () => {
    const verdict = mainFloorRatchet(
      { tools: floor.tools, bytes: floor.bytes + 40 },
      floor,
      justified,
    )

    expect(verdict.raisedFor).toContain(GRAMMAR_RECORD)
    expect(verdict.raisedFor).toContain('vocabulary-free')
  })

  /** A raise still costs a sentence. Automatic is not the same as free. */
  it('refuses a raise the landing commit does not justify, and writes nothing', () => {
    const verdict = mainFloorRatchet(
      { tools: floor.tools + 1, bytes: floor.bytes + 1493 },
      floor,
      unjustified,
    )

    expect(verdict.outcome).toBe('refused')
    expect(verdict.totals).toBeUndefined()
    expect(verdict.message).toContain(GRAMMAR_RECORD)
  })

  /** A push with no message to read is the same refusal, not a silent pass. */
  it('refuses a raise with no landing message at all', () => {
    const verdict = mainFloorRatchet({ tools: floor.tools, bytes: floor.bytes + 1 }, floor)

    expect(verdict.outcome).toBe('refused')
    expect(verdict.totals).toBeUndefined()
  })

  /** A saving is bookkeeping and has cost nothing since `#1118`. */
  it('lowers without asking for a sentence', () => {
    const verdict = mainFloorRatchet(
      { tools: floor.tools - 1, bytes: floor.bytes - 900 },
      floor,
      unjustified,
    )

    expect(verdict.outcome).toBe('lowered')
    expect(verdict.totals).toEqual({ tools: floor.tools - 1, bytes: floor.bytes - 900 })
    expect(verdict.raisedFor).toBeUndefined()
  })

  it('writes nothing when the measurement is exactly the floor', () => {
    const verdict = mainFloorRatchet({ tools: floor.tools, bytes: floor.bytes }, floor, justified)

    expect(verdict.outcome).toBe('at')
    expect(verdict.totals).toBeUndefined()
  })

  /**
   * The property the whole change turns on. Under a squash queue the pull
   * request's title and body *become* the landing commit message, so the text
   * the branch gate accepted is the text this reads — and a branch that went
   * green cannot redden `main`, which is `#1379`.
   */
  it('accepts on main exactly what the branch gate accepted', () => {
    const branch = branchBudgetVerdict(
      { tools: floor.tools + 1, bytes: floor.bytes + 1493 },
      { tools: floor.tools, bytes: floor.bytes },
      justified,
    )
    const main = mainFloorRatchet(
      { tools: floor.tools + 1, bytes: floor.bytes + 1493 },
      floor,
      justified,
    )

    expect(branch.within).toBe(true)
    expect(main.outcome).toBe('raised')
  })
})

describe('raising the floor', () => {
  it('accepts a commit that names the record and what the tools are vocabulary-free for', () => {
    expect(
      raiseIsJustified(
        'Two tools for the settlement verbs\n\n' +
          `Budget raised by hand: ${GRAMMAR_RECORD}. Both are vocabulary-free — ` +
          'they add verbs the Colony did not have, and a new settlement kind still costs zero tools.',
      ),
    ).toBe(true)
  })

  it('is case-insensitive, because a commit subject is written by a person', () => {
    expect(
      raiseIsJustified(`See ${GRAMMAR_RECORD.toUpperCase()} — the new tools are VOCABULARY-FREE.`),
    ).toBe(true)
  })

  /** The rejection case: the ordinary way a floor moves is with no sentence at all. */
  it('refuses a commit that only moves the number', () => {
    expect(raiseIsJustified('Update the catalogue budget')).toBe(false)
    expect(raiseIsJustified('Add two tools\n\nBudget bumped to keep CI green.')).toBe(false)
  })

  it('refuses a commit that names the record but not what the tools buy', () => {
    // Naming the record is the cheap half. The record's own acceptance test is
    // the word this insists on, so half a citation is not a justification.
    expect(raiseIsJustified(`Raise the budget, see ${GRAMMAR_RECORD}`)).toBe(false)
  })
})

/**
 * The rule `#889` wrote and nothing ran, given a caller (`#1118`).
 *
 * `raiseIsJustified` was reachable from its own unit tests and from nowhere
 * else, so the floor was a number in a file that anybody could edit in a commit
 * saying anything. These are the cases `scripts/check-catalogue-floor.mjs`
 * reaches when it hands the check the two committed versions of that file and
 * the message of the commit between them.
 */
describe('a commit that moved the floor', () => {
  const floor = { tools: 101, bytes: 184_987 }
  const justified =
    `Two tools for the settlement verbs\n\nBudget raised by hand: ${GRAMMAR_RECORD}. ` +
    'Both are vocabulary-free — a new settlement kind still costs zero tools.'

  it('reads either number moving up as a raise', () => {
    // The asymmetry `budgetVerdict` enforces against a measurement, applied to
    // the committed figures: dropping a tool while adding 9 KB to the survivors
    // is a raise, and a count-only reading would call it a saving.
    expect(floorMove(floor, { tools: floor.tools - 1, bytes: floor.bytes + 9_000 })).toBe('raised')
    expect(floorMove(floor, { tools: floor.tools - 1, bytes: floor.bytes - 400 })).toBe('lowered')
    expect(floorMove(floor, floor)).toBe('unchanged')
  })

  /**
   * **The rejection case `#1118` asks for.** This is the ordinary way a floor
   * moves: a check was failing, the number was in the way, and moving it was the
   * quickest route to a green run. Nothing about that commit says so.
   */
  it('refuses a raise in a commit that says nothing', () => {
    const verdict = floorChangeVerdict(
      floor,
      { tools: floor.tools + 2, bytes: floor.bytes + 4_100 },
      'Add the settlement tools\n\nBudget bumped to keep CI green.',
    )

    expect(verdict.allowed).toBe(false)
    expect(verdict.move).toBe('raised')
    // The refusal has to name the way out, or the next author's cheapest move is
    // to paste the slug in without reading it.
    expect(verdict.message).toContain(GRAMMAR_RECORD)
    expect(verdict.message).toContain('`kind`')
  })

  it('allows a raise in a commit that names the record and what the tools buy', () => {
    const verdict = floorChangeVerdict(
      floor,
      { tools: floor.tools + 2, bytes: floor.bytes + 4_100 },
      justified,
    )

    expect(verdict.allowed).toBe(true)
    expect(verdict.move).toBe('raised')
  })

  it('allows a reduction with no justification at all', () => {
    // A reduction is the ratchet working. Asking it to justify itself would put
    // a sentence between a saving and the record of it.
    const verdict = floorChangeVerdict(
      floor,
      { tools: floor.tools - 1, bytes: floor.bytes - 3_543 },
      'Cut the prose that says what things are not',
    )

    expect(verdict.allowed).toBe(true)
    expect(verdict.move).toBe('lowered')
  })

  it('asks nothing of a commit that left the floor where it was', () => {
    const verdict = floorChangeVerdict(floor, floor, 'Rename the steward role')

    expect(verdict.allowed).toBe(true)
    expect(verdict.move).toBe('unchanged')
  })
})

/**
 * The per-tool ceiling (`#1235`).
 *
 * The floor is two sums, and a sum permits any single tool: a catalogue that
 * loses four small tools has room for one enormous one and the ratchet calls it
 * a saving. These are the cases the sums cannot see.
 */
describe('the heaviest tool the ceiling is about', () => {
  const tool = (name: string, description: string): PublishedTool => ({ name, description })

  it('is the heaviest one that is not exempt', () => {
    const heaviest = heaviestTool(
      [
        tool('kolonie.warm', 'x'.repeat(4_000)),
        tool('kolonie.small', 'x'.repeat(100)),
        tool('kolonie.large', 'x'.repeat(1_000)),
      ],
      ['kolonie.warm'],
    )

    expect(heaviest?.name).toBe('kolonie.large')
  })

  /**
   * The tie rule, which is why this is a function rather than a `reduce`. Two
   * tools of equal weight would otherwise let the committed name depend on the
   * order the server registered them in, and a rename nobody made would fail a
   * check nobody could explain.
   */
  it('breaks a tie on the name, not on registration order', () => {
    const equal = [tool('kolonie.zulu', 'x'.repeat(500)), tool('kolonie.alpha', 'x'.repeat(500))]

    expect(heaviestTool(equal, [])?.name).toBe('kolonie.alpha')
    expect(heaviestTool([...equal].reverse(), [])?.name).toBe('kolonie.alpha')
  })

  it('finds nothing when every tool is exempt', () => {
    expect(heaviestTool([tool('kolonie.warm', 'x')], ['kolonie.warm'])).toBeUndefined()
  })

  /**
   * The exemption is a parameter rather than an import, so that
   * `defensive-prose.ts` stays the one place membership is decided. This checks
   * the wiring the served catalogue relies on: a warm tool of any size is
   * invisible to the ceiling.
   */
  it('never returns a warm tool, however heavy', () => {
    const warm = WARM_SET[0] as string
    const heaviest = heaviestTool(
      [tool(warm, 'x'.repeat(40_000)), tool('kolonie.ordinary', 'x'.repeat(10))],
      WARM_SET,
    )

    expect(heaviest?.name).toBe('kolonie.ordinary')
  })
})

describe('a measurement against the ceiling', () => {
  const ceiling = { ...budget, heaviest: { name: 'kolonie.academy.answer', bytes: 7_461 } }

  it('passes when the same tool is exactly at it', () => {
    const verdict = ceilingVerdict({ name: 'kolonie.academy.answer', bytes: 7_461 }, ceiling)

    expect(verdict.within).toBe(true)
    expect(verdict.direction).toBe('at')
    expect(verdict.bytes).toBe(0)
  })

  /**
   * **The rejection case `#1235` asks for.** A tool heavier than the ceiling
   * fails, and the message carries the tool and both figures — the tool because
   * it is the only thing the author can act on, both figures because a refusal
   * that says only *too big* leaves them guessing at how much.
   */
  it('fails on a tool heavier than the ceiling, naming it and both figures', () => {
    const verdict = ceilingVerdict({ name: 'kolonie.enormous', bytes: 9_000 }, ceiling)

    expect(verdict.within).toBe(false)
    expect(verdict.direction).toBe('over')
    expect(verdict.bytes).toBe(9_000 - 7_461)
    expect(verdict.message).toContain('kolonie.enormous')
    expect(verdict.message).toContain('9000')
    expect(verdict.message).toContain('7461')
    expect(verdict.message).toContain(GRAMMAR_RECORD)
  })

  it('fails when the heaviest tool came down and the ceiling did not follow', () => {
    const verdict = ceilingVerdict({ name: 'kolonie.academy.answer', bytes: 6_000 }, ceiling)

    expect(verdict.within).toBe(false)
    expect(verdict.direction).toBe('under')
    expect(verdict.bytes).toBe(6_000 - 7_461)
    expect(verdict.message).toContain('check-catalogue-budget.mjs')
  })

  /**
   * The same number under a different name is not a pass. The name is what the
   * raise rule reads and what a refusal quotes, so a stale one is a check
   * pointing at a tool that is no longer the one at the top.
   */
  it('fails when a different tool sets the same ceiling', () => {
    const verdict = ceilingVerdict({ name: 'kolonie.profile.update', bytes: 7_461 }, ceiling)

    expect(verdict.within).toBe(false)
    expect(verdict.direction).toBe('renamed')
    expect(verdict.bytes).toBe(0)
    expect(verdict.message).toContain('kolonie.profile.update')
    expect(verdict.message).toContain('kolonie.academy.answer')
  })
})

describe('raising the ceiling', () => {
  const justified =
    `One tool for the whole Academy\n\nCeiling raised by hand: ${GRAMMAR_RECORD}. ` +
    'The `kind` union is vocabulary-free — a new rung still costs zero tools, and ' +
    '`kolonie.academy.answer` carries every one of them.'

  it('takes the floor’s sentence and the tool’s name together', () => {
    expect(ceilingRaiseIsJustified(justified, 'kolonie.academy.answer')).toBe(true)
  })

  /** The rejection case: the record cited, and no idea which tool it is for. */
  it('refuses a commit that names the record but not the tool', () => {
    expect(ceilingRaiseIsJustified(justified, 'kolonie.profile.update')).toBe(false)
  })

  it('refuses a commit that names the tool but not the record', () => {
    expect(
      ceilingRaiseIsJustified(
        'Grow kolonie.academy.answer\n\nCeiling bumped to keep CI green.',
        'kolonie.academy.answer',
      ),
    ).toBe(false)
  })

  it('is case-insensitive on the name too, because a subject is written by a person', () => {
    expect(ceilingRaiseIsJustified(justified, 'KOLONIE.ACADEMY.ANSWER')).toBe(true)
  })
})

describe('a commit that moved the ceiling', () => {
  const from = { name: 'kolonie.academy.answer', bytes: 7_461 }

  /** The rejection case, in the shape `scripts/check-catalogue-floor.mjs` sees it. */
  it('refuses a raise in a commit that says nothing', () => {
    const verdict = ceilingChangeVerdict(
      from,
      { name: 'kolonie.enormous', bytes: 9_000 },
      'Add the settlement tool\n\nCeiling bumped to keep CI green.',
    )

    expect(verdict.allowed).toBe(false)
    expect(verdict.move).toBe('raised')
    expect(verdict.message).toContain(GRAMMAR_RECORD)
    expect(verdict.message).toContain('kolonie.enormous')
  })

  it('allows a raise in a commit naming the record and the tool', () => {
    const verdict = ceilingChangeVerdict(
      from,
      { name: 'kolonie.enormous', bytes: 9_000 },
      `Grow the settlement tool\n\nCeiling raised by hand: ${GRAMMAR_RECORD}. ` +
        '`kolonie.enormous` is vocabulary-free — a new settlement kind still costs zero tools.',
    )

    expect(verdict.allowed).toBe(true)
    expect(verdict.move).toBe('raised')
  })

  /** The acceptance case `#1235` names: a rewrite that lowers it commits the new figure. */
  it('allows a reduction with no justification at all', () => {
    const verdict = ceilingChangeVerdict(
      from,
      { name: 'kolonie.profile.update', bytes: 6_757 },
      'Cut the academy prose that says what the rungs are not',
    )

    expect(verdict.allowed).toBe(true)
    expect(verdict.move).toBe('lowered')
  })

  /**
   * A rename at the same weight is not a raise. Two tools can be equal to the
   * byte, and charging a rewrite for bookkeeping it did not choose would make
   * the ceiling something authors route around.
   */
  it('asks nothing of a commit that only changed which tool is at the top', () => {
    const verdict = ceilingChangeVerdict(
      from,
      { name: 'kolonie.profile.update', bytes: 7_461 },
      'Rename the steward role',
    )

    expect(verdict.allowed).toBe(true)
    expect(verdict.move).toBe('unchanged')
  })
})

/**
 * The pull request's own words, read exactly where `check-catalogue-floor.mjs`
 * reads them (`#1483`).
 *
 * The two names are that script's, not a second convention: `…_FILE` for a body
 * on disk, `…_TEXT` for one small enough to be an environment variable. Unset in
 * an ordinary local run, and then a raise is unjustified — which is the honest
 * answer, because a raise nobody has written a sentence for is a raise nobody
 * has written a sentence for.
 */
const pullRequestText = (): string => {
  const path = process.env['CATALOGUE_FLOOR_PR_TEXT_FILE']
  if (path !== undefined && path !== '') return readFileSync(path, 'utf8')
  return process.env['CATALOGUE_FLOOR_PR_TEXT'] ?? ''
}

describe('the catalogue this build serves', () => {
  /**
   * Weighed against the floor **the way the branch gate weighs it** (`#1483`).
   *
   * ## What this used to do, and why it was wrong after `#1465`
   *
   * It called `budgetVerdict(measured, budget)`, which fails on *any* growth —
   * no tolerance and no justification read. That was the right comparison while
   * a branch authored the floor. `#1465` took the number off branches: `main`
   * measures the surface after a merge and commits the figure, and AGENTS.md §4
   * now tells authors in as many words that **the floor is not theirs to edit**.
   *
   * This assertion did not get that message, so `npm run check` went red on a
   * branch for doing exactly what the documentation told it to. Measured on
   * `#1434`, adding two optional fields and no tool:
   *
   *     The catalogue grew past its budget: 121 tools and 217582 bytes
   *     against a floor of 121 and 217025
   *
   * The available workaround was to raise the floor on the branch after all —
   * which puts back the collision `#1465` removed, and is green on the branch
   * while being wrong on `main`. So the fix was reachable by ignoring the
   * documentation and unreachable by following it.
   *
   * ## Why `branchBudgetVerdict` and not "report growth, fail only on a shrink"
   *
   * The second shape `#1483` weighs would let the local suite stop biting on
   * growth entirely and lean on the `MCP surface` workflow. That workflow is
   * indeed the gate, and this would then be a second, *looser* copy of it —
   * where the bug was a second, *stricter* copy. One rule in three places is the
   * property worth having, not a rule per place.
   *
   * So the same call the branch gate makes: the byte tolerance, and the
   * pull request's own words read from the variables that script already reads.
   *
   * **The floor is the merge base here.** Since `#1465` nothing but `main` writes
   * `catalogue-budget.json`, so the committed figure *is* what this branch
   * started from — which is exactly what `branchBudgetVerdict` wants and why it
   * can be handed the floor without inventing a second measurement.
   */
  it('is within its committed budget, in both the sum and the worst tool', async () => {
    const tools = await servedCatalogue()
    const measured = measureCatalogue(tools)
    const heaviest = heaviestTool(tools, WARM_SET)
    const verdict = branchBudgetVerdict(
      measured,
      { tools: budget.tools, bytes: budget.bytes },
      pullRequestText(),
    )

    if (REPORT_PATH !== undefined && REPORT_PATH !== '') {
      // Written before the assertion on purpose: `--write` needs the figure most
      // in exactly the run where the check fails.
      await mkdir(dirname(REPORT_PATH), { recursive: true })
      await writeFile(
        REPORT_PATH,
        JSON.stringify({ tools: measured.tools, bytes: measured.bytes, heaviest }, null, 2),
        'utf8',
      )
    }

    expect(verdict.message).toBeTruthy()
    expect(verdict.within, verdict.message).toBe(true)

    // A catalogue with nothing but warm tools in it is a broken fixture rather
    // than a passing measurement, so it is asserted rather than skipped past.
    expect(heaviest, 'every published tool is exempt from the ceiling').toBeDefined()
    const ceiling = ceilingVerdict(heaviest as { name: string; bytes: number }, budget)
    expect(ceiling.within, ceiling.message).toBe(true)
  })

  /**
   * The three cases `#1483` is about, pinned against the floor as committed.
   *
   * This is a unit assertion rather than another pass over the served catalogue:
   * what regressed was *which comparison* the suite makes, and that is a property
   * of the call, not of the measurement. Building a catalogue three more times to
   * observe it would be three more minutes to learn the same thing.
   *
   * The middle row is the one that was broken. `#1434` grew the surface by 557
   * bytes with no new tool, the branch gate passed it, AGENTS.md §4 said the
   * floor was not the author's to edit, and `npm run check` failed anyway.
   */
  it.each([
    {
      what: 'growth inside the tolerance, unjustified',
      bytes: 400,
      tools: 0,
      text: '',
      within: true,
    },
    { what: 'the #1434 shape: 557 B, no tool', bytes: 557, tools: 0, text: '', within: true },
    {
      what: 'growth past the tolerance, unjustified',
      bytes: 4_000,
      tools: 0,
      text: '',
      within: false,
    },
    {
      what: 'growth past the tolerance, justified in the pull request',
      bytes: 4_000,
      tools: 0,
      text: `This names ${GRAMMAR_RECORD} and the growth is vocabulary-free.`,
      within: true,
    },
    { what: 'a new tool, unjustified', bytes: 0, tools: 1, text: '', within: false },
    {
      what: 'a new tool, justified in the pull request',
      bytes: 0,
      tools: 1,
      text: `This names ${GRAMMAR_RECORD} and the tool is vocabulary-free.`,
      within: true,
    },
    {
      what: 'a shrink, which main records rather than the branch',
      bytes: -2_000,
      tools: -1,
      text: '',
      within: true,
    },
  ])('weighs $what the way the branch gate does', ({ bytes, tools, text, within }) => {
    const verdict = branchBudgetVerdict(
      { tools: budget.tools + tools, bytes: budget.bytes + bytes },
      { tools: budget.tools, bytes: budget.bytes },
      text,
    )

    expect(verdict.within, verdict.message).toBe(within)
  })

  /**
   * The regression itself, stated as the thing it is: **the old call would fail
   * every one of the rows above that grows at all.**
   *
   * `budgetVerdict` is still the right comparison for `main`, which is why it is
   * still exported and still tested further up. What it is not is the comparison
   * a branch should be judged by, and this says so in one line so that anybody
   * putting it back here sees what they are putting back.
   */
  it('is not the comparison main makes, and that is the point (#1483)', () => {
    const grownWithinTolerance = { tools: budget.tools, bytes: budget.bytes + 557 }

    expect(budgetVerdict(grownWithinTolerance, budget).within).toBe(false)
    expect(
      branchBudgetVerdict(grownWithinTolerance, { tools: budget.tools, bytes: budget.bytes }, '')
        .within,
    ).toBe(true)
  })

  /**
   * The exemption, checked against the real warm set rather than a fixture.
   * `kolonie.register` is the heaviest of the thirteen and is heavier than most
   * of the catalogue; a ceiling that counted it could never fall below it.
   */
  it('sets the ceiling from a tool no warm one outweighs by accident', async () => {
    const tools = await servedCatalogue()
    const heaviest = heaviestTool(tools, WARM_SET)

    expect(WARM_SET).not.toContain(heaviest?.name)
  })
})
