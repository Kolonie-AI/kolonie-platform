import { describe, expect, it } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { CALL_HOUR_MS } from './call-hours.js'
import { diagnose, diagnoseColony } from './diagnose.js'
import { FindingSchema } from './finding.js'
import { ORIGIN, bucket, busyAndProductive, cartographer, input } from './__fixtures__/windows.js'
import { POLLING_MIN_HOURS } from './thresholds.js'

const kinds = (input: Parameters<typeof diagnose>[0]) => diagnose(input).map((f) => f.kind)

/**
 * The six deterministic doctor signatures (`#836`).
 *
 * The two tests this file exists for are the rejection cases, and they are worth
 * naming before anything else: a productive citizen must produce no
 * `polling-loop` and no `no-progress`, and a two-hour run must produce nothing
 * at all. Everything else here is arithmetic that would fail loudly. Those two
 * would fail quietly, in the direction of accusing somebody.
 */
describe('the doctor rules', () => {
  describe('the Cartographer window', () => {
    it('reproduces the observation it was written for', () => {
      const found = diagnose(cartographer())
      const loop = found.find((finding) => finding.kind === 'polling-loop')

      expect(loop?.severity).toBe('serious')
      expect(loop?.scope).toBe('agent')
      expect(loop?.evidence.routeKeys).toEqual(['/v1/tasks'])
      expect(loop?.evidence.figures['hours']).toBe(30)
      expect(loop?.evidence.figures['calls']).toBe(8_790)
      expect(loop?.evidence.figures['callsPerHour']).toBe(293)
    })

    /**
     * The baseline is taken from the two quiet hours before the loop, not from
     * the loop. A rule that computed it over the whole window would find 293
     * perfectly ordinary and return nothing — silently, on exactly the episode
     * this package was written for.
     */
    it('computes the baseline from outside the run', () => {
      const loop = diagnose(cartographer()).find((finding) => finding.kind === 'polling-loop')

      expect(loop?.evidence.figures['baselineCallsPerHour']).toBe(10.5)
    })

    it('finds the bytes half of the same observation', () => {
      const reads = diagnose(cartographer()).find((finding) => finding.kind === 'oversized-reads')

      expect(reads?.severity).toBe('serious')
      expect(reads?.evidence.figures['bytesOut']).toBe(345_042_000)
    })

    it('suggests an interval materially larger than the one being used', () => {
      const loop = diagnose(cartographer()).find((finding) => finding.kind === 'polling-loop')
      const observed = loop?.evidence.figures['observedIntervalSeconds'] ?? 0

      expect(observed).toBeGreaterThan(0)
      expect(loop?.retryAfterSeconds ?? 0).toBeGreaterThan(observed * 2)
    })
  })

  /**
   * **The rejection case.** A citizen working just as hard and getting
   * somewhere. There is no threshold that separates this from a loop — only the
   * *no state change* condition does, and this test is what keeps it there.
   */
  describe('a busy, productive citizen', () => {
    it('is not accused of looping and is not told it has made no progress', () => {
      const found = kinds(busyAndProductive())

      expect(found).not.toContain('polling-loop')
      expect(found).not.toContain('no-progress')
    })

    it('is not accused of anything else either', () => {
      expect(diagnose(busyAndProductive())).toEqual([])
    })
  })

  /**
   * **The second rejection case.** The boundary is tested rather than assumed:
   * two hours is a burst, three is a pattern.
   */
  describe('the run-length boundary', () => {
    const highHours = (count: number) =>
      Array.from({ length: count }, (_, index) => bucket({ hour: index, calls: 300 }))

    it('says nothing about two consecutive hours at a high rate', () => {
      expect(kinds(input({ hours: highHours(POLLING_MIN_HOURS - 1) }))).not.toContain(
        'polling-loop',
      )
    })

    it('says something about three', () => {
      expect(kinds(input({ hours: highHours(POLLING_MIN_HOURS) }))).toContain('polling-loop')
    })

    /**
     * Consecutive means the clock and not the array. Three rows with a gap
     * between them are not three consecutive hours, and a rule that read the
     * array would call a citizen that worked at 09:00, 14:00 and 19:00 a loop.
     */
    it('does not treat rows with gaps between them as a run', () => {
      const scattered = [
        bucket({ hour: 0, calls: 300 }),
        bucket({ hour: 5, calls: 300 }),
        bucket({ hour: 10, calls: 300 }),
      ]

      expect(kinds(input({ hours: scattered }))).not.toContain('polling-loop')
    })
  })

  describe('an empty window', () => {
    it('produces no findings and does not throw', () => {
      expect(diagnose(input())).toEqual([])
    })

    it('produces no findings for a citizen that registered and has never called', () => {
      expect(
        diagnose(
          input({
            progress: {
              registeredAt: ORIGIN.toISOString(),
              lastProgressAt: null,
              firstPassAt: null,
              skillsHeld: 0,
            },
          }),
        ),
      ).toEqual([])
    })
  })

  describe('retry-storm', () => {
    const failing = (count: number, kind: 'client' | 'server') =>
      Array.from({ length: count }, (_, index) =>
        bucket({
          hour: index,
          calls: 40,
          ok: 4,
          ...(kind === 'client' ? { clientErrors: 36 } : { serverErrors: 36 }),
        }),
      )

    it('calls a 4xx storm the citizen’s, and tells it to read the refusal', () => {
      const found = diagnose(input({ hours: failing(3, 'client') })).find(
        (finding) => finding.kind === 'retry-storm',
      )

      expect(found?.scope).toBe('agent')
      expect(found?.recommendation).toBe('read-the-refusal')
    })

    /**
     * **The split that matters.** A 5xx is the Colony's own defect, and a
     * citizen must never be told it is misbehaving because an endpoint is
     * throwing. The subject is the route, not the citizen.
     */
    it('calls a 5xx storm the Colony’s, and names the route rather than the citizen', () => {
      const one = input({ hours: failing(3, 'server') })
      const found = diagnose(one).find((finding) => finding.kind === 'retry-storm')

      expect(found?.scope).toBe('colony')
      expect(found?.subject).toBe('/v1/tasks')
      expect(found?.subject).not.toBe(one.subject)
      expect(found?.recommendation).toBe('the-colony-is-looking')
    })

    it('says nothing about a route with two refused calls in an hour', () => {
      const quiet = [
        bucket({ hour: 0, calls: 2, ok: 0, clientErrors: 2 }),
        bucket({ hour: 1, calls: 2, ok: 0, clientErrors: 2 }),
        bucket({ hour: 2, calls: 2, ok: 0, clientErrors: 2 }),
      ]

      expect(kinds(input({ hours: quiet }))).not.toContain('retry-storm')
    })
  })

  describe('no-progress', () => {
    const working = Array.from({ length: 5 }, (_, index) => bucket({ hour: index, calls: 20 }))

    it('fires when the record has stood still while the citizen worked', () => {
      const found = diagnose(
        input({
          hours: working,
          now: new Date(ORIGIN.getTime() + 8 * CALL_HOUR_MS),
          progress: {
            registeredAt: new Date(ORIGIN.getTime() - 50 * CALL_HOUR_MS).toISOString(),
            lastProgressAt: new Date(ORIGIN.getTime() - CALL_HOUR_MS).toISOString(),
            firstPassAt: new Date(ORIGIN.getTime() - 40 * CALL_HOUR_MS).toISOString(),
            skillsHeld: 2,
          },
        }),
      ).find((finding) => finding.kind === 'no-progress')

      expect(found?.severity).toBe('concern')
      expect(found?.recommendation).toBe('take-the-next-rung')
    })

    /**
     * A citizen that made three calls and went to sleep has not made progress
     * either, and telling it so would be the Colony reporting somebody's absence
     * back to them as a problem.
     */
    it('says nothing about a citizen that made a handful of calls and stopped', () => {
      const barely = [bucket({ hour: 0, calls: 3 })]

      expect(
        kinds(
          input({
            hours: barely,
            now: new Date(ORIGIN.getTime() + 8 * CALL_HOUR_MS),
            progress: {
              registeredAt: new Date(ORIGIN.getTime() - 50 * CALL_HOUR_MS).toISOString(),
              lastProgressAt: new Date(ORIGIN.getTime() - CALL_HOUR_MS).toISOString(),
              firstPassAt: new Date(ORIGIN.getTime() - 40 * CALL_HOUR_MS).toISOString(),
              skillsHeld: 2,
            },
          }),
        ),
      ).not.toContain('no-progress')
    })
  })

  describe('stalled-arrival', () => {
    const lookedAround = [bucket({ hour: 0, calls: 8 })]

    it('fires for a citizen that arrived, looked around and stopped', () => {
      const found = diagnose(
        input({ hours: lookedAround, now: new Date(ORIGIN.getTime() + 10 * CALL_HOUR_MS) }),
      ).find((finding) => finding.kind === 'stalled-arrival')

      expect(found?.severity).toBe('notice')
      expect(found?.recommendation).toBe('finish-arriving')
    })

    it('says nothing about a citizen that has passed something', () => {
      expect(
        kinds(
          input({
            hours: lookedAround,
            now: new Date(ORIGIN.getTime() + 10 * CALL_HOUR_MS),
            progress: {
              registeredAt: ORIGIN.toISOString(),
              lastProgressAt: ORIGIN.toISOString(),
              firstPassAt: ORIGIN.toISOString(),
              skillsHeld: 1,
            },
          }),
        ),
      ).not.toContain('stalled-arrival')
    })

    /** An agent between runs is not an agent that left. */
    it('says nothing about a citizen that called an hour ago', () => {
      expect(
        kinds(
          input({ hours: lookedAround, now: new Date(ORIGIN.getTime() + CALL_HOUR_MS + 60_000) }),
        ),
      ).not.toContain('stalled-arrival')
    })
  })

  describe('deprecated-route', () => {
    const onTheOldOne = input({
      hours: [bucket({ hour: 0, routeKey: '/v1/old', calls: 5 })],
      now: new Date(ORIGIN.getTime() + 2 * CALL_HOUR_MS),
      deprecatedRoutes: { '/v1/old': '/v1/new' },
    })

    it('names the replacement beside the route it replaces', () => {
      const found = diagnose(onTheOldOne).find((finding) => finding.kind === 'deprecated-route')

      expect(found?.evidence.routeKeys).toEqual(['/v1/old', '/v1/new'])
      expect(found?.severity).toBe('notice')
    })

    it('says nothing when the Colony has superseded nothing', () => {
      expect(
        kinds(input({ hours: [bucket({ hour: 0, routeKey: '/v1/old', calls: 5 })] })),
      ).not.toContain('deprecated-route')
    })

    describe('across the Colony', () => {
      const caller = (n: number) => ({
        ...onTheOldOne,
        subject: `2222222${n}-2222-4222-8222-222222222222`,
      })

      it('says nothing about two citizens', () => {
        expect(diagnoseColony([caller(1), caller(2)])).toEqual([])
      })

      it('reports the route, not the citizens, once three are on it', () => {
        const [found] = diagnoseColony([caller(1), caller(2), caller(3)])

        expect(found?.scope).toBe('colony')
        expect(found?.subject).toBe('/v1/old')
        expect(found?.evidence.figures['citizens']).toBe(3)
      })

      /**
       * The promise this whole package is built to keep. A colony-scoped finding
       * exists to be read by operations, and it must not become a way of asking
       * which citizens are doing something.
       */
      it('names no citizen anywhere in what it returns', () => {
        const subjects = [caller(1), caller(2), caller(3)]
        const serialised = JSON.stringify(diagnoseColony(subjects))

        for (const each of subjects) expect(serialised).not.toContain(each.subject)
      })
    })
  })

  describe('what every finding carries', () => {
    const everything = diagnose(cartographer())

    it('parses as a Finding, with a window on each', () => {
      for (const finding of everything) {
        expect(FindingSchema.parse(finding)).toBeTruthy()
        expect(Date.parse(finding.since)).toBeLessThanOrEqual(Date.parse(finding.until))
      }
    })

    /**
     * Evidence is numbers, route keys and timestamps. Asserted mechanically
     * rather than by reading the rules, because the way this breaks is somebody
     * adding one helpful string to one rule two years from now — and by then the
     * evidence is being shown to a model (`#840`), where a string with an
     * author other than the Colony is a different kind of problem entirely.
     */
    it('carries no free text in evidence', () => {
      const routeKeys = new Set(cartographer().hours.map((hour) => hour.routeKey))

      for (const finding of everything) {
        for (const value of Object.values(finding.evidence.figures)) {
          expect(typeof value).toBe('number')
          expect(Number.isFinite(value)).toBe(true)
        }
        for (const key of finding.evidence.routeKeys) expect(routeKeys.has(key)).toBe(true)
      }
    })

    it('orders the most serious first', () => {
      const order = ['serious', 'concern', 'notice']
      const positions = everything.map((finding) => order.indexOf(finding.severity))

      expect(positions).toEqual([...positions].sort((a, b) => a - b))
    })

    it('carries a confidence between zero and one', () => {
      for (const finding of everything) {
        expect(finding.confidence).toBeGreaterThanOrEqual(0)
        expect(finding.confidence).toBeLessThanOrEqual(1)
      }
    })
  })

  /**
   * **This package can write nothing, and the type system is not what says so —
   * this test is.**
   *
   * The rule is that no file under `doctor/` imports the database, the LLM
   * gateway or a clock. It is asserted by reading the source for the same reason
   * `origins.test.ts` reads the source: the way it breaks is a convenient import
   * added years from now by somebody who never read this comment, and no
   * exercise of any code path would notice.
   */
  describe('the rules reach nothing', () => {
    const forbidden = [
      { pattern: /@kolonie-ai\/db/, what: 'the database' },
      { pattern: /\bnew Date\(\s*\)/, what: 'a clock of its own' },
      { pattern: /Date\.now\(/, what: 'a clock of its own' },
      { pattern: /\bfetch\(/, what: 'the network' },
      { pattern: /\bgateway\b/i, what: 'the LLM gateway' },
    ]

    it('imports no database, no gateway, and reads no clock', async () => {
      const directory = fileURLToPath(new URL('.', import.meta.url))
      const offenders: string[] = []

      const walk = async (path: string): Promise<void> => {
        for (const entry of await readdir(path, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            await walk(`${path}${entry.name}/`)
            continue
          }
          // Fixtures and tests are allowed a clock — they are not shipped, and a
          // fixture that could not build a date could not build a window.
          if (!entry.name.endsWith('.ts')) continue
          if (entry.name.endsWith('.test.ts') || path.includes('__fixtures__')) continue

          const source = await readFile(`${path}${entry.name}`, 'utf8')
          /**
           * Comments are stripped before the scan, for the reason
           * `check:fixtures` strips them before hashing: this file's own
           * paragraphs say *never `new Date()`* and *the LLM gateway*, and a
           * check that sent somebody to a file for explaining the rule it obeys
           * is a check people learn to ignore.
           */
          const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
          for (const { pattern, what } of forbidden) {
            if (pattern.test(code)) offenders.push(`${entry.name} reaches ${what}`)
          }
        }
      }

      await walk(directory)
      expect(offenders).toEqual([])
    })
  })
})
