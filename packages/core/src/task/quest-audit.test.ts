import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  QUEST_AUDIT_DEFAULT_RATE,
  QUEST_AUDIT_MINIMUM_SAMPLE,
  QUEST_AUDIT_OFF,
  isAuditable,
  isAudited,
  paidQuestRejection,
  questAuditDraw,
} from './quest-audit.js'

const anId = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

/**
 * The audit that has to exist before a quest pays a coin (`#221`).
 *
 * The first describe is the load-bearing one: everything else here is the
 * mechanism the refusal protects.
 */
describe('publishing a paid quest', () => {
  it('is refused while sampling is off, and says what is missing', () => {
    const refusal = paidQuestRejection(QUEST_AUDIT_OFF, {
      credits: 10,
      lamports: 0,
      disagreement: 0,
      audited: 0,
    })

    expect(refusal).toContain('sampling audit')
    expect(refusal).toContain('governance/quests.md')
  })

  it('leaves a zero-reward quest alone, which is the whole pilot', () => {
    expect(
      paidQuestRejection(QUEST_AUDIT_OFF, {
        credits: 0,
        lamports: 0,
        disagreement: 0.9,
        audited: 50,
      }),
    ).toBeUndefined()
  })

  it('is allowed once sampling is on and the judge is holding up', () => {
    const on = { ...QUEST_AUDIT_OFF, enabled: true }

    expect(
      paidQuestRejection(on, { credits: 10, lamports: 0, disagreement: 0.1, audited: 50 }),
    ).toBeUndefined()
  })

  it('is refused again above the threshold, with the current rate named', () => {
    const on = { ...QUEST_AUDIT_OFF, enabled: true }

    const refusal = paidQuestRejection(on, {
      credits: 10,
      lamports: 0,
      disagreement: 0.34,
      audited: 50,
    })

    expect(refusal).toContain('34%')
    expect(refusal).toContain('20%')
    // How many verdicts the rate was computed over, so a steward reading the
    // refusal can tell a brake from a small sample (`#317`).
    expect(refusal).toContain('50 verdicts')
  })
})

/**
 * The floor under the brake (`#317`).
 *
 * Without it the rate is live from the first audited verdict, and one steward
 * disagreement out of three stops the paid programme until that verdict ages out
 * of a thirty-day window.
 */
describe('the minimum sample under the disagreement brake', () => {
  const on = { ...QUEST_AUDIT_OFF, enabled: true }

  it('does not stop publication on one disagreement out of three', () => {
    expect(
      paidQuestRejection(on, { credits: 10, lamports: 0, disagreement: 1 / 3, audited: 3 }),
    ).toBeUndefined()
  })

  /** Eleven verdicts, three of them overruled: a sample, and a rate above a fifth. */
  it('stops it once the sample is there and the rate is still above the threshold', () => {
    const refusal = paidQuestRejection(on, {
      credits: 10,
      lamports: 0,
      disagreement: 3 / 11,
      audited: 11,
    })

    expect(refusal).toContain('27%')
  })

  /** The boundary is stated, so a change to the constant fails here rather than quietly. */
  it('fires at exactly the minimum and not one verdict below it', () => {
    const above = {
      credits: 10,
      lamports: 0,
      disagreement: 0.5,
      audited: QUEST_AUDIT_MINIMUM_SAMPLE,
    }
    const below = {
      credits: 10,
      lamports: 0,
      disagreement: 0.5,
      audited: QUEST_AUDIT_MINIMUM_SAMPLE - 1,
    }

    expect(paidQuestRejection(on, above)).toBeDefined()
    expect(paidQuestRejection(on, below)).toBeUndefined()
  })

  /**
   * **The precondition is not softened, only the brake.** A deployment with the
   * audit switched off refuses every paid quest at any count, including zero —
   * that refusal is `governance/quests.md`'s and has nothing to do with a rate.
   */
  it('still refuses every paid quest while the audit is switched off, at zero samples', () => {
    expect(
      paidQuestRejection(QUEST_AUDIT_OFF, {
        credits: 10,
        lamports: 0,
        disagreement: 0,
        audited: 0,
      }),
    ).toContain('sampling audit')
  })
})

describe('the draw', () => {
  it('is the same answer every time, for the same submission', () => {
    const id = anId(1)

    expect(questAuditDraw(id)).toBe(questAuditDraw(id))
    expect(isAudited(id, 0.1)).toBe(isAudited(id, 0.1))
  })

  it('lands inside the unit interval for everything it is given', () => {
    for (let index = 0; index < 500; index++) {
      const draw = questAuditDraw(anId(index))
      expect(draw).toBeGreaterThanOrEqual(0)
      expect(draw).toBeLessThan(1)
    }
  })

  /**
   * The rate is what it says it is. A tolerance rather than an equality, because
   * a hash is uniform and not fair — and a test that demanded exactly one in ten
   * would be testing the sample rather than the mechanism.
   */
  it('draws about a tenth over a large set', () => {
    const ids = Array.from({ length: 5000 }, (_, index) => anId(index))
    const drawn = ids.filter((id) => isAudited(id, QUEST_AUDIT_DEFAULT_RATE)).length

    expect(drawn / ids.length).toBeGreaterThan(0.08)
    expect(drawn / ids.length).toBeLessThan(0.12)
  })

  /**
   * Raising the rate adds submissions to the sample and removes none, which is
   * what makes the threshold policy rather than a property frozen into the rows.
   */
  it('is monotonic in the rate', () => {
    const ids = Array.from({ length: 500 }, (_, index) => anId(index))
    const atTenth = ids.filter((id) => isAudited(id, 0.1))
    const atFifth = ids.filter((id) => isAudited(id, 0.2))

    for (const id of atTenth) expect(atFifth).toContain(id)
  })

  it('samples the tiers a model decided, and never the one a third party did', () => {
    expect(isAuditable('colony-judged')).toBe(true)
    expect(isAuditable('soft')).toBe(true)
    // Re-reading a mailbox round trip tells nobody anything.
    expect(isAuditable('hard')).toBe(false)
  })
})

/**
 * The guard `#572` leaves behind, in place of the notice that used to be tested
 * here.
 *
 * **The sentence was not wrong when it was written — it went wrong while nobody
 * was reading it.** `nonWithdrawableNotice` told a citizen that its pay could
 * not be moved; `#505` shipped the payout leg and made every clause of that
 * false, and it kept being served because a string is not a call site anybody
 * greps. So this asserts the *claim* is absent from the source rather than
 * asserting one function returns `undefined`: the next place somebody writes it
 * will not be that function.
 *
 * Test files are excluded on purpose. A citizen never reads one, and this file
 * has to be able to quote the phrases it forbids.
 */
describe('no citizen-facing string says the way out is unbuilt', () => {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

  /** What the deleted notice claimed, in the words it claimed it. */
  const RETIRED_CLAIMS = ['cannot yet be withdrawn', 'the way out is not built']

  const sourcesUnder = (dir: string): string[] => {
    const entries = readdirSync(dir, { withFileTypes: true })
    return entries.flatMap((entry) => {
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) return entry.name === 'dist' ? [] : sourcesUnder(path)
      return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
    })
  }

  /** Every `src` tree the two workspaces have, so a new package is covered by existing. */
  const workspaceSources = (): string[] =>
    ['packages', 'apps'].flatMap((workspace) =>
      readdirSync(`${repoRoot}${workspace}`, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${repoRoot}${workspace}/${entry.name}/src`)
        .filter((src) => existsSync(src))
        .flatMap(sourcesUnder),
    )

  it.each(RETIRED_CLAIMS)('nothing says %s', (claim) => {
    const sources = workspaceSources()

    // An empty read would pass by finding nothing rather than by there being
    // nothing to find, which is the failure this whole test exists to avoid.
    expect(sources.length).toBeGreaterThan(100)
    expect(sources.filter((path) => readFileSync(path, 'utf8').includes(claim))).toEqual([])
  })
})
