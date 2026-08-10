import { describe, expect, it } from 'vitest'
import { attributionSweep, type AttributionOutcome } from './attribution.js'
import type { Log } from './loop.js'
import { runnerLoops } from './runner-loops.js'
import { badgeSweep } from './sweeps.js'

describe('the badge runner loop set', () => {
  const silent: Log = { info: () => undefined, error: () => undefined }

  it('starts every loop named in the health report', () => {
    const loops = runnerLoops({
      badges: badgeSweep(async () => ({})),
      attribution: attributionSweep(async (): Promise<AttributionOutcome> => ({
        read: 0,
        confirmed: 0,
        unreadable: 0,
      })),
      log: silent,
      badgeIntervalMs: 60_000,
      attributionIntervalMs: 60_000,
    })

    const timers = loops.map((loop) => loop.start())
    timers.forEach(clearInterval)

    expect(loops.filter((loop) => !loop.health().running).map((loop) => loop.name)).toEqual([])
  })
})
