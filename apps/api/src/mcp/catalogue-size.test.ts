import { describe, expect, it } from 'vitest'
import { anonymousClient, connectedClient, registeredCitizen } from '../__fixtures__/mcp.js'
import {
  measureCatalogue,
  namespaceOf,
  namespaceSuccess,
  proseBytesOf,
  renderCatalogueReport,
} from './catalogue-size.js'
import { toolNamesIn } from './tool-names.js'

/**
 * `#888`. The measurement taken before any tool consolidation, so the
 * consolidation can be judged rather than believed.
 *
 * The catalogue half is asserted against a real `tools/list` over a real
 * transport, for the reason `surface-size.test.ts` states: a measurement of
 * something other than what is served is trusted for exactly as long as it takes
 * somebody to act on it. The arithmetic is asserted against constructed lists,
 * because a fixture is the only way to know what the right answer is.
 */

describe('which namespace a tool belongs to', () => {
  it('takes the segment after the prefix', () => {
    expect(namespaceOf('kolonie.accounts.list')).toBe('accounts')
    expect(namespaceOf('kolonie.accounts.walk-report')).toBe('accounts')
    expect(namespaceOf('kolonie.academy.challenge')).toBe('academy')
  })

  /**
   * A one-segment namespace is a real one. `kolonie.me` and `kolonie.wakeup`
   * each carry a tool, and a grouping that dropped them would print a total for
   * a catalogue it had only partly measured.
   */
  it('gives a single-segment tool a namespace of its own', () => {
    expect(namespaceOf('kolonie.me')).toBe('me')
    expect(namespaceOf('kolonie.wakeup')).toBe('wakeup')
  })

  /** The rejection case: a name outside the convention is reported, never hidden. */
  it('returns a name it does not recognise whole rather than discarding it', () => {
    expect(namespaceOf('somethingElse')).toBe('somethingElse')
    expect(namespaceOf('other.tool')).toBe('other')
  })
})

describe('what a reader has to read', () => {
  it('counts the tool description and every description nested in the schema', () => {
    const bytes = proseBytesOf({
      name: 'kolonie.example',
      description: 'twelve chars',
      inputSchema: {
        type: 'object',
        properties: { since: { type: 'string', description: 'four' } },
      },
    })

    expect(bytes).toBe('twelve chars'.length + 'four'.length)
  })

  /**
   * **The rejection case that matters here.** `kolonie.accounts.note` has a
   * property *called* `description`, and charging its schema object to prose
   * would inflate the one figure `#888` turns on — the share of the catalogue
   * that is words. Only string values under that key count.
   */
  it('does not charge a property named description to prose', () => {
    const bytes = proseBytesOf({
      name: 'kolonie.accounts.note',
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', maxLength: 1500, description: 'six!!!' },
        },
      },
    })

    expect(bytes).toBe('six!!!'.length)
  })

  it('walks arrays, because anyOf and items carry descriptions', () => {
    const bytes = proseBytesOf({
      name: 'kolonie.example',
      inputSchema: { anyOf: [{ description: 'aa' }, { items: { description: 'bbb' } }] },
    })

    expect(bytes).toBe(5)
  })

  it('charges nothing for a tool that carries no words at all', () => {
    expect(proseBytesOf({ name: 'kolonie.example' })).toBe(0)
  })
})

describe('weighing the catalogue', () => {
  const tools = [
    { name: 'kolonie.accounts.list', description: 'aaaa' },
    { name: 'kolonie.accounts.declare', description: 'bbbbbb' },
    { name: 'kolonie.me', description: 'cc' },
  ]

  it('reports the count, the bytes, the bytes per tool and the prose', () => {
    const measured = measureCatalogue(tools)

    expect(measured.tools).toBe(3)
    expect(measured.bytes).toBe(Buffer.byteLength(JSON.stringify(tools), 'utf8'))
    expect(measured.bytesPerTool).toBe(Math.round(measured.bytes / 3))
    expect(measured.proseBytes).toBe(4 + 6 + 2)
    expect(measured.proseShare).toBeCloseTo(12 / measured.bytes)
  })

  it('groups by namespace, heaviest first', () => {
    const measured = measureCatalogue(tools)

    expect(measured.byNamespace.map((entry) => entry.namespace)).toEqual(['accounts', 'me'])
    expect(measured.byNamespace[0]?.tools).toBe(2)
    expect(measured.byNamespace[0]?.proseBytes).toBe(10)
    expect(measured.byNamespace[1]?.tools).toBe(1)
  })

  /**
   * An empty list is a measurement of zero tools, not a division by zero. It
   * happens on the way to a real one — a captured list that failed to parse, a
   * tier a stranger cannot see — and a `NaN` in a committed table is a figure
   * nobody can act on.
   */
  it('measures an empty catalogue without dividing by nothing', () => {
    const measured = measureCatalogue([])

    expect(measured.tools).toBe(0)
    expect(measured.bytesPerTool).toBe(0)
    expect(measured.proseShare).toBe(0)
    expect(measured.byNamespace).toEqual([])
  })
})

describe('the catalogue the server actually serves', () => {
  it('weighs what a citizen is handed at connect', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const citizen = await connectedClient(colony, `Bearer ${apiKey}`)
    const measured = measureCatalogue((await citizen.client.listTools()).tools)
    await citizen.close()

    expect(measured.tools).toBeGreaterThan(0)
    expect(measured.byNamespace.length).toBeGreaterThan(1)

    // Every tool is in exactly one namespace, so the parts are the whole.
    expect(measured.byNamespace.reduce((sum, entry) => sum + entry.tools, 0)).toBe(measured.tools)
    // Prose is a share of the bytes and cannot exceed them: the wire carries
    // quotes and escapes this deliberately does not count.
    expect(measured.proseBytes).toBeLessThan(measured.bytes)
    expect(measured.proseShare).toBeGreaterThan(0)
  })

  /**
   * The tier a stranger sees is small and carries prose too. Asserted because
   * the whole argument in `#888` is that prose is the cost, and a tier that
   * measured zero would mean the walker had stopped working rather than that the
   * tools had gone quiet.
   */
  it('finds prose in the tier a stranger is served', async () => {
    const stranger = await anonymousClient()
    const measured = measureCatalogue((await stranger.client.listTools()).tools)
    await stranger.close()

    expect(measured.proseBytes).toBeGreaterThan(0)
    expect(measured.byNamespace.every((entry) => entry.bytesPerTool > 0)).toBe(true)
  })
})

describe('attaching the Academy to the namespaces its rungs name', () => {
  const namespaces = new Map([
    ['email-inbox', ['academy', 'mailboxes']],
    ['profile-complete', ['profile']],
  ])

  const attempts = [
    { taskType: 'email-inbox', passed: 3, failed: 1, abandoned: 6 },
    { taskType: 'profile-complete', passed: 9, failed: 1, abandoned: 0 },
  ]

  const submissions = [
    { taskType: 'email-inbox', passed: 3, rejected: 9 },
    { taskType: 'profile-complete', passed: 9, rejected: 1 },
  ]

  it('reports a pass rate and a rejection rate for each namespace', () => {
    const measured = namespaceSuccess(namespaces, attempts, submissions)
    const academy = measured.find((entry) => entry.namespace === 'academy')

    expect(academy?.attempts).toBe(10)
    expect(academy?.passRate).toBeCloseTo(0.3)
    expect(academy?.submissions).toBe(12)
    expect(academy?.rejectionRate).toBeCloseTo(0.75)
    expect(academy?.taskTypes).toEqual(['email-inbox'])
  })

  /**
   * A rung naming two namespaces counts in both, undivided. Splitting the
   * attempts between them would invent a proportion nothing measured, and the
   * `taskTypes` list is what makes the double-counting visible to a reader
   * instead of implied.
   */
  it('counts a rung in every namespace it names', () => {
    const measured = namespaceSuccess(namespaces, attempts, submissions)

    expect(measured.find((entry) => entry.namespace === 'mailboxes')?.attempts).toBe(10)
    expect(measured.find((entry) => entry.namespace === 'academy')?.attempts).toBe(10)
    expect(measured.reduce((sum, entry) => sum + entry.attempts, 0)).toBeGreaterThan(20)
  })

  /**
   * Rates are computed from summed counts, never averaged across rungs. The
   * fixture is the case that separates the two: one rung passes everything over
   * two attempts and the other almost nothing over two hundred, and the mean of
   * the rates is 54.5 % where the truth is 3.0 %.
   */
  it('sums the counts before dividing, rather than averaging rates', () => {
    const lopsided = namespaceSuccess(
      new Map([
        ['tiny', ['same']],
        ['huge', ['same']],
      ]),
      [
        { taskType: 'tiny', passed: 2, failed: 0, abandoned: 0 },
        { taskType: 'huge', passed: 4, failed: 96, abandoned: 100 },
      ],
      [],
    )

    expect(lopsided[0]?.passRate).toBeCloseTo(6 / 202)
  })

  /**
   * **The rejection case for the mapping.** A rung nothing maps contributes
   * nothing, rather than opening a namespace named after itself. The mapping is
   * derived from prose, so an unrecognised rung is the ordinary case — a task
   * whose instructions name no tool at all — and a table row invented for it
   * would be a figure about a namespace that does not exist.
   */
  it('drops a rung no namespace claims instead of inventing one for it', () => {
    const measured = namespaceSuccess(
      new Map([['profile-complete', ['profile']]]),
      [
        { taskType: 'profile-complete', passed: 1, failed: 0, abandoned: 0 },
        { taskType: 'unmapped-rung', passed: 5, failed: 5, abandoned: 0 },
      ],
      [],
    )

    expect(measured.map((entry) => entry.namespace)).toEqual(['profile'])
  })

  it('says null rather than zero where nothing has closed', () => {
    const measured = namespaceSuccess(
      new Map([['pow', ['academy']]]),
      [{ taskType: 'pow', passed: 0, failed: 0, abandoned: 0 }],
      [],
    )

    expect(measured[0]?.passRate).toBeNull()
    expect(measured[0]?.rejectionRate).toBeNull()
  })
})

describe('the mapping from a rung to a namespace', () => {
  /**
   * The mapping the script builds, exercised end to end on one string: a rung's
   * instructions name tools, the shared parser finds them, and the namespaces
   * are what this module groups by. Asserted here because the script that does
   * it in production has no database in this suite, and a mapping that only ever
   * ran against production is one nobody checked.
   */
  it('reads namespaces out of a rung the way the instructions are written', () => {
    const instructions =
      'Call kolonie.academy.challenge with kind "email-inbox", then hand the code back ' +
      'with kolonie.academy.answer. kolonie.mailboxes.list says which address the Colony writes to.'

    expect([...new Set(toolNamesIn(instructions).map(namespaceOf))]).toEqual([
      'academy',
      'mailboxes',
    ])
  })
})

describe('the rendered report', () => {
  const catalogue = measureCatalogue([
    { name: 'kolonie.accounts.list', description: 'aaaa' },
    { name: 'kolonie.me', description: 'cc' },
  ])

  it('carries the date, the command and the surface it was taken against', () => {
    const report = renderCatalogueReport({
      measuredAt: '2026-08-14',
      command: 'node scripts/measure-mcp-catalogue.mjs',
      source: 'mcp.example',
      catalogue,
    })

    expect(report).toContain('2026-08-14')
    expect(report).toContain('node scripts/measure-mcp-catalogue.mjs')
    expect(report).toContain('mcp.example')
    expect(report).toContain('`accounts`')
  })

  /**
   * **The rejection case for a half-run.** A measurement taken without a
   * database must say so in words. An empty table reads as *no rung has any
   * attempts*, which is a finding; the truth is that nobody looked, which is
   * not.
   */
  it('says the Academy half was not measured rather than printing zeros', () => {
    const report = renderCatalogueReport({
      measuredAt: '2026-08-14',
      command: 'node scripts/measure-mcp-catalogue.mjs',
      source: 'mcp.example',
      catalogue,
    })

    expect(report).toContain('Not measured in this run')
    expect(report).not.toContain('| 0 | — |')
  })

  it('states that it is not a gate', () => {
    const report = renderCatalogueReport({
      measuredAt: '2026-08-14',
      command: 'node scripts/measure-mcp-catalogue.mjs',
      source: 'mcp.example',
      catalogue,
      success: namespaceSuccess(
        new Map([['profile-complete', ['profile']]]),
        [{ taskType: 'profile-complete', passed: 1, failed: 1, abandoned: 0 }],
        [{ taskType: 'profile-complete', passed: 1, rejected: 3 }],
      ),
    })

    expect(report).toContain('Nothing here is a gate')
    expect(report).toContain('50.0 %')
    expect(report).toContain('75.0 %')
  })
})
