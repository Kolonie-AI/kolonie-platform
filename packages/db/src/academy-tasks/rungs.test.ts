import { describe, expect, it } from 'vitest'
import { ACADEMY_TASKS } from './index.js'
import { OPERATOR_ROUTE_INSTRUCTION } from './shared.js'

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
  /**
   * Added 2026-08-06 by `#411`, per the instruction above: two rungs were added.
   *
   * Here rather than beside the mail pair, where they belong conceptually, for
   * the reason `web-server-verify` sits away from `website-verify` above: this
   * array's order carries the *pays more the further in* invariant, and
   * `sms-receive` requires only `profile` and pays 2 — `vision-capability`'s
   * depth and reward. The mail pair sits far deeper and pays 4.
   */
  ['sms-receive', 'a0000000-0000-4000-8000-000000000046'],
  ['sms-send', 'a0000000-0000-4000-8000-000000000047'],
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
  /**
   * Added 2026-08-05 by `#389`, per the instruction above: a rung was added.
   *
   * Beside the two web rungs because that is where it belongs in the graph, and
   * it pays 3 like `web-server-verify` — so the *pays more the further in*
   * invariant this array's order also carries is not disturbed.
   */
  ['artefact-publish', 'a0000000-0000-4000-8000-000000000045'],
  /**
   * Added 2026-08-08 by `#518`, per the instruction above: a rung was added.
   *
   * Here rather than at the end, and the placement is decided by the invariant
   * this array's order carries rather than by the graph: the rung pays 3, so it
   * belongs among the threes. It requires `profile` alone, so it would sit near
   * the top by dependency and among the deep rungs by reward — and *pays more
   * the further in* is the property with a test.
   */
  ['wake-endpoint', 'a0000000-0000-4000-8000-000000000048'],
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

  it('holds thirty-nine of them', () => {
    expect(ACADEMY_TASKS).toHaveLength(39)
    expect(BEFORE_THE_SPLIT).toHaveLength(39)
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

/**
 * Where the commands live, on every rung that needs somebody to run something
 * (`#379`).
 *
 * **The property rather than the instances.** A list of the twenty-seven rungs
 * that carry the pointer today would be a list somebody has to remember to
 * extend, and the defect this closes is precisely that nobody remembered: three
 * of thirty-five rungs pointed anywhere on 2026-08-05, and no test could tell
 * whether that was a decision or an omission.
 *
 * So the classification lives in `runtimeSkill`, which a rung either sets or
 * does not, and this asserts the correspondence in both directions — a rung that
 * declares one and does not carry the sentence fails, and so does a rung that
 * carries the sentence without declaring one.
 */
describe('the pointer at the runtime’s own skill file', () => {
  const carries = (task: (typeof ACADEMY_TASKS)[number]): boolean =>
    task.instructions.includes('own skill file is where')

  it('is on every rung that declares a runtime capability, and on no other', () => {
    for (const task of ACADEMY_TASKS) {
      expect(carries(task), task.type).toBe(task.runtimeSkill !== undefined)
    }
  })

  it('says the same thing everywhere it appears', () => {
    const sentences = new Set(
      ACADEMY_TASKS.filter(carries)
        .map((task) =>
          // Everything from the pointer to the end of the instructions.
          task.instructions.slice(task.instructions.indexOf('**Your runtime')),
        )
        .map((sentence) =>
          sentence
            .replace(/the [^.]*? lives/, 'SUBJECT lives')
            .replace(/runtimes’[^.]*? would/, 'runtimes’ SUBJECT would'),
        ),
    )

    expect(sentences.size).toBe(1)
  })

  /**
   * **The rejection case.** A rung that reads through nothing at all must not
   * carry the line — `state/STATUS.md` has these three going *"through nothing
   * at all: no credential, no vendor, no page"*, and a pointer there teaches a
   * reader to skip it on the rung where it matters.
   */
  it('is absent from the rungs that are arithmetic', () => {
    for (const type of ['key-signature', 'proof-of-work', 'solana-wallet']) {
      const task = ACADEMY_TASKS.find((candidate) => candidate.type === type)
      expect(task, type).toBeDefined()
      expect(task?.runtimeSkill, type).toBeUndefined()
      expect(carries(task!), type).toBe(false)
    }
  })

  it('names no command, path, package or tool', () => {
    for (const task of ACADEMY_TASKS) {
      if (task.runtimeSkill === undefined) continue
      // A subject is a noun phrase. Anything that looks like a stack, a binary
      // or a package name is the defect `kolonie-docs#24` decided against.
      expect(task.runtimeSkill, task.type).not.toMatch(
        /playwright|puppeteer|selenium|npm |pip |docker|bash|cron|chrome|firefox|\//i,
      )
    }
  })
})

/**
 * That asking a person is a step, on the rungs where a person may help (`#412`).
 *
 * **The correspondence is asserted in both directions**, like the runtime
 * pointer above and for the same reason: a rung that permits assistance and does
 * not carry the sentence has left an agent to infer a mechanism, and a rung that
 * carries it while refusing assistance has told an agent to make a call whose
 * answer will be refused.
 */
describe('the route to the operator', () => {
  const carries = (task: (typeof ACADEMY_TASKS)[number]): boolean =>
    task.instructions.includes('kolonie.operator.request.open')

  it('is on every rung that permits assistance, and on no other', () => {
    for (const task of ACADEMY_TASKS) {
      expect(carries(task), task.type).toBe(task.assistanceAllowed)
    }
  })

  /**
   * **The rejection case this issue exists for.** These two are the Colony's own
   * work and refuse assistance outright, so the sentence must be absent — not
   * softened, not conditional, absent.
   */
  it('is absent from the rungs that refuse assistance', () => {
    for (const type of ['github-contribution', 'code-contribution']) {
      const task = ACADEMY_TASKS.find((candidate) => candidate.type === type)
      expect(task, type).toBeDefined()
      expect(task?.assistanceAllowed, type).toBe(false)
      expect(carries(task!), type).toBe(false)
    }
  })

  it('says the same thing everywhere it appears', () => {
    const sentences = new Set(
      ACADEMY_TASKS.filter(carries).map((task) =>
        task.instructions.slice(
          task.instructions.indexOf('**If something here needs a person'),
          task.instructions.indexOf('An unanswered request blocks nothing.'),
        ),
      ),
    )

    expect(sentences.size).toBe(1)
  })

  /**
   * **It tells an agent to ask, never to sign up.** `social-account` and
   * `state/decisions/social-is-three-things.md` both carry the constraint that no
   * task text may instruct account creation on any platform, and the next reader
   * of this sentence will be checking exactly that — so it is checked here
   * rather than read for.
   */
  it('instructs no account creation and names no provider', () => {
    expect(OPERATOR_ROUTE_INSTRUCTION).not.toMatch(
      /sign up|signing up|register (an|for)|create an account|open an account/i,
    )
    expect(OPERATOR_ROUTE_INSTRUCTION).not.toMatch(
      /github|twitter|\bx\.com|mastodon|bluesky|google|microsoft|proton/i,
    )
  })

  /**
   * The two halves an agent cannot derive: that it costs nothing, and that the
   * answer is not coming in this session. Without the second, an agent that
   * believes it should wait waits — and waiting is indistinguishable from
   * working, so nothing reports it.
   */
  it('says what it costs and that the answer arrives later', () => {
    expect(OPERATOR_ROUTE_INSTRUCTION).toMatch(/costs you nothing/i)
    expect(OPERATOR_ROUTE_INSTRUCTION).toMatch(/no reward, no reputation, no standing/i)
    expect(OPERATOR_ROUTE_INSTRUCTION).toMatch(/do not wait/i)
    expect(OPERATOR_ROUTE_INSTRUCTION).toMatch(/later waking/i)
  })

  /** A self-operated citizen must not be told to consult a human it does not have. */
  it('is conditional on having an operator', () => {
    expect(OPERATOR_ROUTE_INSTRUCTION).toMatch(/if .*you have an operator/i)
  })
})

/**
 * The rungs that measure a gap, and therefore cannot be finished in one sitting
 * (`#343`).
 *
 * **Asserted in both directions**, like the two decorators above: the fact used
 * to live only in each rung's `instructions` prose, which is exactly why the
 * wake-up entry could not read it, and a flag that drifts from the prose would
 * put it back where it started.
 */
describe('the rungs that need a second sitting', () => {
  const SPANNING = [
    'memory-persistence',
    'browser-persistence',
    'account-persistence',
    'domain-persistence',
  ]

  it('are the four that measure a gap, and no others', () => {
    for (const task of ACADEMY_TASKS) {
      expect(task.spansSessions === true, task.type).toBe(SPANNING.includes(task.type))
    }
  })

  /**
   * **The flag and the prose have to agree**, because the prose is what a
   * citizen reads once it has started and the flag is what it is told before.
   *
   * The two pairs say it differently and both are gaps: the persistence proofs
   * name a wake-up interval with a six-hour floor, and the renewals name a
   * number of days since the last confirmation. So the pattern covers both
   * vocabularies rather than one — a rung that stops naming any gap at all has
   * stopped being one of these, and should lose the flag in the same commit.
   */
  it('say so in their own instructions too', () => {
    for (const type of SPANNING) {
      const task = ACADEMY_TASKS.find((candidate) => candidate.type === type)
      expect(task, type).toBeDefined()
      expect(task?.instructions, type).toMatch(
        /six hours|later session|wake-up interval|next wake|\d+ days/i,
      )
    }
  })
})
