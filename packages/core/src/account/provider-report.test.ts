import { describe, expect, it } from 'vitest'
import { ProviderReportRequestSchema } from './account.js'

/**
 * What a citizen may file about a provider that gave it nothing (`#298`, `#904`).
 *
 * **The shape is the whole gate here.** A provider report is the one surface
 * where a citizen makes a claim about a third party's product, and the only
 * moment the Colony can ask for the evidence is while the citizen is still
 * there to give it — afterwards the session is over and there is nobody to ask.
 */
describe('a report about a provider', () => {
  const report = (input: Record<string, unknown>) => ProviderReportRequestSchema.safeParse(input)

  const base = { kind: 'mailbox', provider: 'example.test' }

  /**
   * **The rejection case `#904` asks for.** Four of the five outcomes are
   * claims about somebody's business, and 10 of the 16 rows recorded by
   * 2026-08-14 carried no sentence at all.
   *
   * **`cannot-do-the-job` is on this list for a stronger reason than the other
   * three** (`#940`). Their evidence is an attempt somebody made and a reader
   * can repeat; this one's is a page somebody read, and without the sentence
   * there is no way to find the page — the claim would be uncontestable rather
   * than merely unsubstantiated.
   */
  it.each(['no-service', 'cannot-do-the-job', 'signup-refused', 'never-provisioned'])(
    'refuses %s with no reason, and says which field is missing',
    (outcome) => {
      const result = report({ ...base, outcome })

      expect(result.success).toBe(false)
      expect(result.error?.issues.some((issue) => issue.path.includes('reason'))).toBe(true)
    },
  )

  it.each(['no-service', 'cannot-do-the-job', 'signup-refused', 'never-provisioned'])(
    'takes %s once a sentence comes with it',
    (outcome) => {
      expect(
        report({
          ...base,
          outcome,
          reason: 'The form refuses an honest answer about being an agent.',
        }).success,
      ).toBe(true)
    },
  )

  /**
   * **`abandoned` is the one that may be filed wordless.** *I stopped* is a
   * true and complete statement about the citizen rather than about the
   * provider, so there is no third-party claim to substantiate.
   */
  it('takes abandoned with no reason', () => {
    expect(report({ ...base, outcome: 'abandoned' }).success).toBe(true)
  })

  it('takes abandoned with a reason too, since stopping somewhere is worth saying', () => {
    expect(
      report({ ...base, outcome: 'abandoned', reason: 'Signup wanted a number I cannot read.' })
        .success,
    ).toBe(true)
  })

  /**
   * Withdrawing removes the row, so there is nothing left for a sentence to be
   * about — and the required-reason rule must not make a withdrawal impossible.
   */
  it('takes a withdrawal with no reason, and refuses one carrying a reason', () => {
    expect(report({ ...base, outcome: null }).success).toBe(true)
    expect(report({ ...base, outcome: null, reason: 'Changed my mind.' }).success).toBe(false)
  })
})
