import { describe, expect, it, vi } from 'vitest'
import type { Log, ShareCloseReason } from '@kolonie-ai/core'
import { closeShareRow } from './browser-shares.js'

/**
 * Ending a share's row when the database drops the connection under it
 * (`#871`).
 *
 * **The production failure this is written against**, read out of Loki rather
 * than guessed at: `CONNECTION_ENDED` from `postgres:5432`, wrapped by drizzle
 * as `Failed query: update "browser_shares" …`. The statement never ran, so
 * nothing about the share was wrong — the connection was.
 */
describe('ending a share when the write fails', () => {
  const log = (): Log & { error: ReturnType<typeof vi.fn> } =>
    ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }) as unknown as Log & { error: ReturnType<typeof vi.fn> }

  const reason: ShareCloseReason = 'lost'

  it('writes once when the write succeeds', async () => {
    const close = vi.fn(async () => true)
    const logged = log()

    await closeShareRow({ close }, logged, 'a-share', reason)

    expect(close).toHaveBeenCalledTimes(1)
    expect(logged.error).not.toHaveBeenCalled()
  })

  /**
   * **The case the issue is about.** One dropped connection, one reconnect, and
   * the citizen reads `lost` rather than the `expired` that
   * `expireStaleShares` would have written at the window.
   */
  it('tries again when the connection went away, and says nothing when it works', async () => {
    const close = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(
        Object.assign(new Error('Failed query: update "browser_shares" …'), {
          cause: Object.assign(new Error('write CONNECTION_ENDED postgres:5432'), {
            code: 'CONNECTION_ENDED',
          }),
        }),
      )
      .mockResolvedValueOnce(true)
    const logged = log()

    await closeShareRow({ close }, logged, 'a-share', reason)

    expect(close).toHaveBeenCalledTimes(2)
    expect(logged.error).not.toHaveBeenCalled()
  })

  /**
   * **Rejection case.** Two attempts and no more — a loop here would sit on a
   * database that is genuinely down, on a path nobody is awaiting, for as long
   * as it stayed down.
   */
  it('gives up after the second failure and does not throw', async () => {
    const close = vi.fn(async () => {
      throw new Error('Failed query: update "browser_shares" …')
    })
    const logged = log()

    await expect(closeShareRow({ close }, logged, 'a-share', reason)).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledTimes(2)
  })

  /**
   * The log line is what the detector turns into an issue (`#407`), so it has
   * to say that the cheap answer was already tried — otherwise the next reader
   * proposes it.
   */
  it('records how many attempts were made, and the reason and share', async () => {
    const close = vi.fn(async () => {
      throw new Error('Failed query: update "browser_shares" …')
    })
    const logged = log()

    await closeShareRow({ close }, logged, 'a-share', reason)

    expect(logged.error).toHaveBeenCalledTimes(1)
    expect(logged.error.mock.calls[0]?.[2]).toEqual({
      event: 'browser.share.close-failed',
      shareId: 'a-share',
      reason: 'lost',
      attempts: 2,
    })
  })
})
