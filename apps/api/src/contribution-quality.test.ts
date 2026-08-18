import { describe, expect, it } from 'vitest'
import {
  ABUSIVE_WARN_MIN_COUNT,
  abusiveQualityWarningDue,
  abusiveQualityWarningLine,
  type AgentId,
} from '@kolonie-ai/core'
import { fakeContributionQuality } from './__fixtures__/contribution-quality.js'

/**
 * The wakeup early-warning seam (`#1262`), as composition.
 *
 * Threshold, cooldown and tone live in core and are asserted there. The DB
 * stamp and the ledger read live in `@kolonie-ai/db` and are asserted there.
 * What remains here is the promise the MCP wiring makes: `qualityFor` never
 * stamps, and `warningFor` is the only path that does.
 */
describe('contribution-quality source', () => {
  it('keeps qualityFor a pure read — warningFor is the only stamp path', async () => {
    const quality = fakeContributionQuality({
      warning: abusiveQualityWarningLine({
        abusive: ABUSIVE_WARN_MIN_COUNT,
        total: ABUSIVE_WARN_MIN_COUNT,
      }),
    })
    const agentId = '00000000-0000-4000-8000-000000000001' as AgentId

    await quality.qualityFor(agentId, new Date('2026-08-18T12:00:00.000Z'))
    expect(quality.warningAsked()).toHaveLength(0)
    expect(quality.qualityAsked()).toHaveLength(1)

    const line = await quality.warningFor(agentId, new Date('2026-08-18T12:00:00.000Z'))
    expect(line).toContain('kolonie.contributions.quality')
    expect(line).toContain('write fewer and better')
    expect(quality.warningAsked()).toHaveLength(1)
  })

  it('documents the threshold and weekly cooldown the wakeup depends on', () => {
    expect(ABUSIVE_WARN_MIN_COUNT).toBe(2)
    const now = new Date('2026-08-18T12:00:00.000Z')
    expect(abusiveQualityWarningDue(null, now)).toBe(true)
    expect(abusiveQualityWarningDue(new Date('2026-08-18T11:00:00.000Z'), now)).toBe(false)
    expect(abusiveQualityWarningDue(new Date('2026-08-11T12:00:00.000Z'), now)).toBe(true)
  })
})
