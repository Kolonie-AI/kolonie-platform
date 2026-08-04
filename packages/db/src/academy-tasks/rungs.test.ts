import { describe, expect, it } from 'vitest'
import { ACADEMY_TASKS } from './index.js'

/**
 * The cheapest possible proof that rearranging three thousand lines changed
 * nothing.
 *
 * `academy-tasks.ts` held all 31 rungs in one array literal until #264 split it
 * into one file per rung. Every string, every id and every position was supposed
 * to survive that move byte-identical — and the one that would have hurt most is
 * an id, because a task's uuid is its identity in the seed: change one and the
 * next deploy inserts a second row for the same rung and orphans every
 * submission against the first.
 *
 * So the ids and their order are written down here, once, as they were before
 * the move. This list is **not** to be regenerated from `ACADEMY_TASKS` when it
 * fails; a failure means either a rung was added — in which case append to it and
 * say so — or the move lost something.
 *
 * No database: this is a question about the definitions, and `academy-tasks.test.ts`
 * beside it needs Postgres for the seed.
 */
const BEFORE_THE_SPLIT: readonly (readonly [type: string, id: string])[] = [
  ['profile-complete', 'a0000000-0000-4000-8000-000000000000'],
  ['heartbeat', 'a0000000-0000-4000-8000-000000000022'],
  // Added after the split (`#159`), so this list is no longer only what the array
  // literal held — it is what the Academy holds, which is what it was always for.
  ['memory-persistence', 'a0000000-0000-4000-8000-00000000002b'],
  ['autonomy-contract', 'a0000000-0000-4000-8000-00000000002a'],
  ['website-verify', 'a0000000-0000-4000-8000-000000000012'],
  ['vision-capability', 'a0000000-0000-4000-8000-000000000013'],
  ['browser-capability', 'a0000000-0000-4000-8000-000000000005'],
  ['key-signature', 'a0000000-0000-4000-8000-000000000006'],
  ['solana-wallet', 'a0000000-0000-4000-8000-00000000000b'],
  ['domain-verify', 'a0000000-0000-4000-8000-00000000000c'],
  /**
   * Added 2026-08-05 by `#244`, per the instruction above: a rung was added.
   *
   * Placed here rather than beside `website-verify`, which is where it belongs
   * conceptually, because this array's order also carries the *pays more the
   * further in* invariant — and this rung pays 3 while `website-verify` pays 1.
   */
  ['web-server-verify', 'a0000000-0000-4000-8000-000000000044'],
  ['raster', 'a0000000-0000-4000-8000-00000000001e'],
  // Added after the split (`#45`), directly above the four earning rungs that
  // require it — which is where it sits in the graph as well as in this array.
  ['vetting', 'a0000000-0000-4000-8000-00000000002d'],
  ['api-monetize', 'a0000000-0000-4000-8000-00000000001a'],
  ['bounty-hunter', 'a0000000-0000-4000-8000-00000000001b'],
  ['workflow-seller', 'a0000000-0000-4000-8000-00000000001c'],
  ['solana-trader', 'a0000000-0000-4000-8000-00000000001d'],
  ['proof-of-work', 'a0000000-0000-4000-8000-000000000008'],
  ['social-account', 'a0000000-0000-4000-8000-000000000009'],
  // Added after the split (`#206`), beside the other self-contained rungs.
  ['authenticator', 'a0000000-0000-4000-8000-00000000002e'],
  ['browser-captcha', 'a0000000-0000-4000-8000-000000000003'],
  ['browser-perception', 'a0000000-0000-4000-8000-000000000023'],
  ['browser-interaction', 'a0000000-0000-4000-8000-000000000024'],
  ['browser-interstitial', 'a0000000-0000-4000-8000-000000000025'],
  ['browser-persistence', 'a0000000-0000-4000-8000-000000000026'],
  ['email-inbox', 'a0000000-0000-4000-8000-000000000004'],
  ['email-send', 'a0000000-0000-4000-8000-000000000021'],
  ['github-account', 'a0000000-0000-4000-8000-000000000007'],
  ['image-model', 'a0000000-0000-4000-8000-000000000028'],
  ['prompt-injection', 'a0000000-0000-4000-8000-000000000029'],
  ['social-post', 'a0000000-0000-4000-8000-00000000000a'],
  ['account-persistence', 'a0000000-0000-4000-8000-000000000027'],
  ['domain-persistence', 'a0000000-0000-4000-8000-00000000000d'],
  ['github-contribution', 'a0000000-0000-4000-8000-000000000002'],
  ['code-contribution', 'a0000000-0000-4000-8000-00000000001f'],
]

describe('the Academy, after the split', () => {
  it('holds the same rungs, in the same order, under the same ids', () => {
    expect(ACADEMY_TASKS.map((task) => [task.type, task.id as string])).toEqual(
      BEFORE_THE_SPLIT.map((row) => [...row]),
    )
  })

  it('holds thirty-four of them', () => {
    expect(ACADEMY_TASKS).toHaveLength(34)
    expect(BEFORE_THE_SPLIT).toHaveLength(34)
  })

  /**
   * One file per rung, named for its `type` exactly as the definition spells it,
   * is the property that makes two agents editing two rungs edit two files. A
   * rung added to `index.ts` without its own file would pass every test above.
   */
  it('has a file per rung, named for its type', async () => {
    const { readdir } = await import('node:fs/promises')
    const here = new URL('.', import.meta.url)
    const files = (await readdir(here)).filter(
      (name) => name.endsWith('.ts') && !name.endsWith('.test.ts'),
    )

    expect(files.toSorted()).toEqual(
      [...ACADEMY_TASKS.map((task) => `${task.type}.ts`), 'index.ts', 'shared.ts'].toSorted(),
    )
  })
})
