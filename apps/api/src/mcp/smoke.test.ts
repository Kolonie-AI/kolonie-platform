import { describe, expect, it } from 'vitest'
import { connectedClient, registeredCitizen } from '../__fixtures__/mcp.js'
import {
  DECLARED_INPUTS,
  SMOKE_ROUND_TRIPS,
  SMOKE_TOOLS,
  declaresInput,
  offeredButAbsent,
  renderSmokeReport,
  runSmoke,
  smokeDelivery,
  smokeFindingsToSettle,
  smokeIssue,
  smokeMarker,
  smokeSettlementComment,
  type OpenFinding,
  type ProbeResponse,
  type PublishedTool,
  type SmokeProbe,
  type SmokeResult,
} from './smoke.js'

/**
 * The check that would have caught `#1067`, and the tests that prove it does.
 *
 * There are two halves here and they are testing different things.
 *
 * **The catalogue half runs against a real client over a real transport.** That
 * is not thoroughness, it is the entire point: `#1067`'s suite was green because
 * every test exercised a stand-in that could not have the defect, and the defect
 * lived in the declaration between the stand-in and the wire. A test of
 * {@link declaresInput} against a hand-built tool list would repeat that mistake
 * exactly — it would assert that the function reads a schema, having supplied
 * the schema itself. So the schemas come from `createMcpServer` through
 * `tools/list`, and this file now fails in CI on the day somebody removes a
 * declared input, rather than after the deploy that shipped it.
 *
 * **The verdict half runs against fakes**, because a red result is a thing the
 * deployed Colony is not obliged to produce on demand. What is faked there is
 * the network. Never the assertions.
 */

const at = { revision: 'deadbeefcafe0000', endpoint: 'https://mcp.example/mcp' }

/** A probe over a real connected client — the seam a citizen actually crosses. */
const liveProbe = async (): Promise<{ probe: SmokeProbe; close: () => Promise<unknown> }> => {
  const { colony, apiKey } = await registeredCitizen()
  // The whole header, not the key: the server reads the credential exactly as a
  // citizen presents it, and a bare key lists the citizen tier and then answers
  // `unauthorized` to every call in it.
  const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

  return {
    probe: {
      listTools: async () => (await client.listTools()).tools as readonly PublishedTool[],
      call: async (name, args) => {
        try {
          const result = await client.callTool({ name, arguments: args })
          const text = (Array.isArray(result.content) ? result.content : [])
            .map((part: unknown) =>
              typeof part === 'object' && part !== null && 'text' in part
                ? String((part as { text: unknown }).text)
                : '',
            )
            .join('\n')
          return {
            ok: result.isError !== true,
            text,
            structured: result.structuredContent,
            // Same as the driver script: an `isError` answer carries its reason
            // in its text, and a red assertion with nothing quoted sends the
            // reader back to the log this check exists to replace.
            ...(result.isError === true ? { error: text.slice(0, 300) } : {}),
          }
        } catch (error) {
          return { ok: false, text: '', error: String(error) }
        }
      },
    },
    close,
  }
}

/**
 * A surface that stores what it is told and reports it back — the behaviour the
 * Colony was believed to have between `#1067` and `#1089`, and did not.
 *
 * `writes` says whether `profile.update` reaches storage. Setting it `false` is
 * the defect itself: every call answers `ok`, and nothing arrives.
 */
const fakeSurface = ({ writes = true, discoverable = false } = {}) => {
  const record = { discoverable }
  const calls: string[] = []

  const call: SmokeProbe['call'] = async (name, args) => {
    calls.push(name)
    if (name === 'kolonie.me') return { ok: true, text: 'me', structured: { ...record } }
    if (name === 'kolonie.profile.update') {
      if (writes && typeof args['discoverable'] === 'boolean') {
        record.discoverable = args['discoverable']
      }
      return { ok: true, text: 'Profile updated.' }
    }
    return { ok: true, text: 'fine' }
  }

  return { call, calls, record }
}

const fakeProbe = (over: Partial<SmokeProbe> = {}): SmokeProbe => ({
  listTools: async () => wholeCatalogue(),
  call: fakeSurface().call,
  ...over,
})

/** Every declared field present, so a fake passes unless a test breaks it. */
const wholeCatalogue = (): readonly PublishedTool[] => {
  const byTool = new Map<string, Record<string, unknown>>()
  for (const { tool, field } of DECLARED_INPUTS) {
    byTool.set(tool, { ...byTool.get(tool), [field]: {} })
  }
  const named = new Set<string>([...SMOKE_TOOLS, ...byTool.keys(), 'kolonie.profile.update'])
  for (const { tool } of SMOKE_ROUND_TRIPS) named.add(tool)

  return [...named].map((name) => ({ name, inputSchema: { properties: byTool.get(name) ?? {} } }))
}

describe('what the deployed surface must publish', () => {
  /**
   * **The `#1067` regression, asked of the real server.**
   *
   * `discoverable` was declared nowhere in `profile.update`'s input schema. An
   * MCP input schema strips what it does not declare, so the field was accepted,
   * answered for with `Profile updated.`, and written nowhere — for every
   * citizen, until `#1089` added one line. Nine searches answered *nobody*.
   *
   * This is the assertion that would have been red the day it shipped.
   */
  it('declares every input the smoke check depends on', async () => {
    const { probe, close } = await liveProbe()
    const published = await probe.listTools()

    for (const { tool, field } of DECLARED_INPUTS) {
      expect(declaresInput(published, tool, field), `${tool} must declare ${field}`).toBe(true)
    }

    await close()
  })

  it('offers every tool a citizen cannot work without', async () => {
    const { probe, close } = await liveProbe()

    expect(offeredButAbsent(await probe.listTools())).toEqual([])

    await close()
  })

  /**
   * The round trips are a named list rather than *everything offered*, and the
   * names have to exist or the list is a check against nothing. Reachability is
   * the deploy's business; that the names are real is this file's.
   */
  it('offers every tool the round trips call', async () => {
    const { probe, close } = await liveProbe()
    const published = await probe.listTools()

    expect(
      offeredButAbsent(
        published,
        SMOKE_ROUND_TRIPS.map((one) => one.tool),
      ),
    ).toEqual([])

    await close()
  })

  /**
   * **The whole check, against the real server, through a real client.**
   *
   * Every assertion the deploy will make, made here first: the catalogue, the
   * declarations, the six round trips, and `discoverable` written through
   * `profile.update` and read back through `me`. Nothing is faked but the
   * network.
   *
   * This is the test that is red on the day `#1067` is reintroduced — in either
   * of its halves, the declaration going missing or the write not arriving —
   * rather than the deploy being the thing that finds out.
   */
  it('passes end to end against the server the citizen is served', async () => {
    const { probe, close } = await liveProbe()

    const result = await runSmoke(probe, at)

    expect(result.assertions.filter((one) => !one.ok)).toEqual([])
    expect(result.ok).toBe(true)

    await close()
  })

  /**
   * **Rejection case for the naming itself.** `#1067` was silent, so a probe
   * that cannot tell a missing declaration from a present one is worse than no
   * probe. A field the schema does not carry must read as absent.
   */
  it('reads an undeclared field as absent', async () => {
    const { probe, close } = await liveProbe()
    const published = await probe.listTools()

    expect(declaresInput(published, 'kolonie.profile.update', 'discoverabel')).toBe(false)
    expect(declaresInput(published, 'kolonie.no.such.tool', 'bio')).toBe(false)

    await close()
  })
})

describe('running the check', () => {
  it('is green when the surface answers', async () => {
    const result = await runSmoke({ ...fakeProbe(), listTools: async () => wholeCatalogue() }, at)

    expect(result.ok).toBe(true)
    expect(result.assertions.filter((one) => !one.ok)).toEqual([])
    expect(result.revision).toBe(at.revision)
  })

  /**
   * **The rejection case the issue asks for, in `#1067`'s exact shape.** A tool
   * declared but missing the field: green suite, green deploy, silent write.
   */
  it('is red when a tool does not declare a field it is written with', async () => {
    const stripped = wholeCatalogue().map((tool) =>
      tool.name === 'kolonie.profile.update'
        ? { name: tool.name, inputSchema: { properties: { bio: {} } } }
        : tool,
    )

    const result = await runSmoke({ ...fakeProbe(), listTools: async () => stripped }, at)
    const failed = result.assertions.filter((one) => !one.ok)

    expect(result.ok).toBe(false)
    expect(failed).toHaveLength(1)
    expect(failed[0]?.name).toContain('discoverable')
    // The diagnosis and not only the verdict: the sentence `#1089` had to work
    // out by hand belongs on the issue this files.
    expect(failed[0]?.detail).toMatch(/strips what it does not declare/)
  })

  it('is red when a tool a citizen needs is not offered at all', async () => {
    const without = wholeCatalogue().filter((tool) => tool.name !== 'kolonie.wakeup')

    const result = await runSmoke({ ...fakeProbe(), listTools: async () => without }, at)
    const failed = result.assertions.filter((one) => !one.ok)

    expect(result.ok).toBe(false)
    expect(failed.map((one) => one.detail).join()).toContain('kolonie.wakeup')
  })

  it('is red when a round trip answers an error', async () => {
    const surface = fakeSurface()
    const result = await runSmoke(
      {
        listTools: async () => wholeCatalogue(),
        call: async (name, args): Promise<ProbeResponse> =>
          name === 'kolonie.wakeup'
            ? { ok: false, text: '', error: 'the database refused the connection' }
            : surface.call(name, args),
      },
      at,
    )
    const failed = result.assertions.filter((one) => !one.ok)

    expect(result.ok).toBe(false)
    expect(failed).toHaveLength(1)
    expect(failed[0]?.detail).toContain('refused the connection')
  })

  /**
   * **`#1067` end to end, and the assertion the earlier ones cannot make.**
   *
   * The declaration probe catches a field the schema never published. This
   * catches the other half: a field published, accepted, answered `Profile
   * updated.` for — and written nowhere. That is what production did for every
   * citizen, and no green suite noticed.
   */
  it('is red when a write is accepted and does not arrive', async () => {
    const surface = fakeSurface({ writes: false })

    const result = await runSmoke(
      { listTools: async () => wholeCatalogue(), call: surface.call },
      at,
    )
    const failed = result.assertions.filter((one) => !one.ok)

    expect(result.ok).toBe(false)
    expect(failed).toHaveLength(1)
    expect(failed[0]?.name).toContain('reads back')
    expect(failed[0]?.detail).toContain('accepted and did not arrive')
  })

  /**
   * Writing the value it already holds would pass against a surface that stores
   * nothing, so the check writes the opposite of what `me` reported.
   */
  it('writes the opposite of what it read, whichever it read', async () => {
    for (const discoverable of [true, false]) {
      const surface = fakeSurface({ discoverable })
      const result = await runSmoke(
        { listTools: async () => wholeCatalogue(), call: surface.call },
        at,
      )

      expect(result.ok, `starting from ${discoverable}`).toBe(true)
    }
  })

  /** The check's own side effect must not be mistakable for a citizen's setting. */
  it('leaves the smoke citizen as it found it', async () => {
    for (const discoverable of [true, false]) {
      const surface = fakeSurface({ discoverable })
      await runSmoke({ listTools: async () => wholeCatalogue(), call: surface.call }, at)

      expect(surface.record.discoverable).toBe(discoverable)
    }
  })

  it('is red when `me` reports no `discoverable` to read back', async () => {
    const result = await runSmoke(
      {
        listTools: async () => wholeCatalogue(),
        call: async (name) =>
          name === 'kolonie.me'
            ? { ok: true, text: 'me', structured: { handle: 'canary' } }
            : { ok: true, text: 'fine' },
      },
      at,
    )
    const failed = result.assertions.filter((one) => !one.ok)

    expect(result.ok).toBe(false)
    expect(failed).toHaveLength(1)
    expect(failed[0]?.detail).toContain('nothing written can be read back')
  })

  /**
   * A surface that cannot be listed makes every assertion after it meaningless,
   * so it is the one early return — and it still returns a result, because a
   * smoke check that throws produces no issue and no summary.
   */
  it('stops at the tool list and still reports, when the endpoint is not there', async () => {
    const result = await runSmoke(
      {
        ...fakeProbe(),
        listTools: async () => {
          throw new Error('ECONNREFUSED')
        },
      },
      at,
    )

    expect(result.ok).toBe(false)
    expect(result.assertions).toHaveLength(1)
    expect(result.assertions[0]?.detail).toContain('ECONNREFUSED')
  })

  /** An endpoint answering with an empty catalogue is a deploy that is not up. */
  it('is red when the tool list is empty', async () => {
    const result = await runSmoke({ ...fakeProbe(), listTools: async () => [] }, at)

    expect(result.ok).toBe(false)
    expect(result.assertions[0]?.name).toBe('the tool list answers')
  })

  /**
   * **It writes about nothing but itself.** Not a permission somebody remembered
   * to set — a property of the round trips, which is why it is asserted here: the
   * only tool called that writes is `profile.update`, and the only record
   * `profile.update` can reach is the caller's own.
   */
  it('calls no tool that could write about another citizen', async () => {
    const surface = fakeSurface()

    await runSmoke({ listTools: async () => wholeCatalogue(), call: surface.call }, at)

    expect(surface.calls).toEqual([
      ...SMOKE_ROUND_TRIPS.map((one) => one.tool),
      'kolonie.me',
      'kolonie.profile.update',
      'kolonie.me',
      'kolonie.profile.update',
    ])
    // Named, not *everything offered*: `credential.rotate` takes no arguments,
    // so a blind sweep would succeed at invalidating the key mid-pass.
    expect(surface.calls).not.toContain('kolonie.credential.rotate')
    expect(surface.calls).not.toContain('kolonie.account.erase')
    expect(surface.calls).not.toContain('kolonie.academy.challenge')
  })
})

describe('the verdict, where somebody will read it', () => {
  const red: SmokeResult = {
    ...at,
    ok: false,
    assertions: [
      { name: 'the tool list answers', ok: true },
      { name: '`kolonie.profile.update` declares `discoverable`', ok: false, detail: 'stripped' },
    ],
  }

  /** The criterion is *without opening a workflow log*, and both places render Markdown. */
  it('renders a table naming the deploy and every assertion', () => {
    const report = renderSmokeReport(red)

    expect(report).toContain('| --- | --- |')
    expect(report).toContain(at.revision)
    expect(report).toContain(at.endpoint)
    expect(report).toContain('❌')
    expect(report).toContain('the tool list answers')
  })

  it('says on a red report that nothing was rolled back', () => {
    expect(renderSmokeReport(red)).toMatch(/rolled back/i)
  })

  /**
   * **Rolling nothing back is a decision and not an omission.** A red smoke
   * check has established that something does not answer, never that the
   * previous build answered better, and it holds no judgement about which of two
   * states is worse.
   */
  it('says on a green report what it did and did not assert', () => {
    const report = renderSmokeReport({ ...red, ok: true, assertions: [red.assertions[0]!] })

    expect(report).toContain('green')
    expect(report).toMatch(/nothing about what any citizen holds/i)
    expect(report).not.toMatch(/rolled back/i)
  })

  it('files an issue naming the deploy and the failing assertion', () => {
    const issue = smokeIssue(red)

    expect(issue.title).toContain('deadbeef')
    expect(issue.body).toContain('discoverable')
    expect(issue.body).toContain('1 assertion(s) failed')
  })

  /**
   * The marker on the **first line** and nothing above it (`#1161`, and `#946`
   * before it) — so the next red deploy reopens this rather than filing a second
   * one, and an issue that merely quotes the marker is never adopted.
   */
  it('puts the marker on the first line, per revision', () => {
    const issue = smokeIssue(red)

    expect(issue.body.split('\n')[0]).toBe(smokeMarker(at.revision))
    expect(smokeMarker('other')).not.toBe(smokeMarker(at.revision))
  })

  /**
   * **Labels are not rendered here, on purpose**, and this asserts the absence.
   *
   * They are named literally in the workflow, one `--label` flag each, where
   * `scripts/github-issue-labels.test.ts` can read them and hold them against
   * the vocabulary the repositories keep. Returning a list from here would put
   * the names somewhere that check cannot see — which is precisely how
   * `needs-triage` went on being applied after it was deleted (`#687`).
   */
  it('renders no labels, leaving them to the workflow the vocabulary check reads', () => {
    expect(smokeIssue(red)).not.toHaveProperty('labels')
  })

  /**
   * **The closing comment carries the result** — the criterion that makes this
   * delivery rather than throughput. `#1067` merged, closed as completed, and
   * did nothing; a closure is a fact about a merge until a deploy says
   * otherwise.
   */
  it('writes a green verdict back onto the issue the deploy shipped', () => {
    const delivery = smokeDelivery({ ...red, ok: true, assertions: [red.assertions[0]!] })

    expect(delivery).toContain('deadbeef')
    expect(delivery).toContain(at.endpoint)
    expect(delivery).toMatch(/shipped and answering/i)
  })

  it('names the failing assertions when the deploy shipped onto a red surface', () => {
    const delivery = smokeDelivery(red)

    expect(delivery).toContain('deadbeef')
    expect(delivery).toContain('`kolonie.profile.update` declares `discoverable`')
    expect(delivery).toContain('stripped')
    expect(delivery).toContain('1 of 2')
  })

  /**
   * **A red deploy does not reopen the issue it shipped.** The check establishes
   * that the surface is wrong, never that this change is what made it wrong —
   * and reopening on that evidence would put the wrong thread on somebody's
   * board. The finding is a separate issue, which is what `smokeIssue` is for.
   */
  it('says on a red verdict that nothing was reopened and nothing rolled back', () => {
    const delivery = smokeDelivery(red)

    expect(delivery).toMatch(/not.*reopened/i)
    expect(delivery).toMatch(/rolled back/i)
  })

  /**
   * The comment goes on the issue and must not read as a verdict on it: green
   * says the surface answers, and says nothing about whether what the issue
   * asked for was actually built.
   */
  it('claims nothing about the issue’s own acceptance criteria', () => {
    expect(smokeDelivery({ ...red, ok: true, assertions: [red.assertions[0]!] })).toMatch(
      /nothing about whether this issue’s own acceptance criteria are met/i,
    )
  })
})

/**
 * **A commit-keyed finding has to be able to end** (`#1790`).
 *
 * `#1789` was filed for deploy `418dfea9` after six MCP calls hit transient
 * origin 502s. The very next deploy, `b8bb30d7`, deployed green and smoked
 * green against the same surface — and the finding stayed Ready until somebody
 * closed it by hand, because the workflow held the clearing evidence and had no
 * rule that read it.
 *
 * The evidence is deliberately both halves. Health alone says a process is
 * listening; only a green MCP smoke says the surface a citizen speaks to
 * answers, and that is the claim the finding made falsely.
 */
describe('settling an earlier revision’s smoke finding', () => {
  const older = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const healthyRevision = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

  const finding = (revision: string, run?: string): OpenFinding => ({
    number: 1789,
    body: [
      smokeMarker(revision),
      ...(run === undefined ? [] : [`<!-- smoke-run: ${run} -->`]),
    ].join('\n'),
  })

  const healthy = {
    revision: healthyRevision,
    run: { id: '33362034880', url: 'urn:kolonie:run:33362034880' },
    deployJob: 'deploy to the VPS',
    smokeJob: 'smoke the deployed MCP surface',
  }

  it('closes an earlier revision’s finding once a later deploy and smoke are both green', () => {
    const settled = smokeFindingsToSettle({
      deployOk: true,
      smokeOk: true,
      revision: healthyRevision,
      open: [finding(older)],
    })

    expect(settled.map((one) => one.number)).toEqual([1789])
    expect(settled[0]?.revision).toBe(older)
  })

  /**
   * **Never on health alone, and never on a red smoke.** A deploy that shipped
   * and left the surface not answering is the exact state the finding records,
   * so a deploy-green/smoke-red run must leave it open.
   */
  it('keeps the finding when the later deploy is green and its smoke is red', () => {
    expect(
      smokeFindingsToSettle({
        deployOk: true,
        smokeOk: false,
        revision: healthyRevision,
        open: [finding(older)],
      }),
    ).toEqual([])
  })

  it('keeps the finding when the smoke is green and the deploy is not', () => {
    expect(
      smokeFindingsToSettle({
        deployOk: false,
        smokeOk: true,
        revision: healthyRevision,
        open: [finding(older)],
      }),
    ).toEqual([])
  })

  /**
   * The identity is the commit key and nothing looser. A watch finding about
   * something else is not this workflow's to close, whatever colour today's
   * deploy is.
   */
  it('leaves an unrelated watch finding untouched', () => {
    const unrelated: OpenFinding = {
      number: 1234,
      body: '<!-- watch-finding: smoke-unconfigured -->',
    }
    const other: OpenFinding = {
      number: 1235,
      body: '<!-- watch-finding: main-workflow-red:ci -->',
    }

    expect(
      smokeFindingsToSettle({
        deployOk: true,
        smokeOk: true,
        revision: healthyRevision,
        open: [unrelated, other, finding(older)],
      }).map((one) => one.number),
    ).toEqual([1789])
  })

  /** A body whose first line is not the marker is never adopted (`#946`). */
  it('does not adopt an issue that merely quotes a marker', () => {
    expect(
      smokeFindingsToSettle({
        deployOk: true,
        smokeOk: true,
        revision: healthyRevision,
        open: [{ number: 42, body: `discussion of ${smokeMarker(older)}` }],
      }),
    ).toEqual([])
  })

  /**
   * A green run with nothing open settles nothing, so running the same green
   * deploy twice writes once and then says nothing — the idempotence the
   * workflow depends on rather than a counter it keeps.
   */
  it('settles nothing when no commit-keyed finding is open', () => {
    expect(
      smokeFindingsToSettle({
        deployOk: true,
        smokeOk: true,
        revision: healthyRevision,
        open: [],
      }),
    ).toEqual([])
  })

  /**
   * The current revision's own finding is settled only by its own green smoke,
   * which is the state this branch is in: the smoke that just passed is this
   * revision's.
   */
  it('settles the current revision’s own finding when its own smoke is green', () => {
    expect(
      smokeFindingsToSettle({
        deployOk: true,
        smokeOk: true,
        revision: healthyRevision,
        open: [finding(healthyRevision)],
      }).map((one) => one.revision),
    ).toEqual([healthyRevision])
  })

  it('carries the run recorded on the finding, where it recorded one', () => {
    const settled = smokeFindingsToSettle({
      deployOk: true,
      smokeOk: true,
      revision: healthyRevision,
      open: [finding(older, 'urn:kolonie:run:33330000000')],
    })

    expect(settled[0]?.run?.url).toBe('urn:kolonie:run:33330000000')
  })

  describe('the comment it closes with', () => {
    it('names the old revision and run, and the new revision and run', () => {
      const [settled] = smokeFindingsToSettle({
        deployOk: true,
        smokeOk: true,
        revision: healthyRevision,
        open: [finding(older, 'urn:kolonie:run:33330000000')],
      })

      const comment = smokeSettlementComment(settled!, healthy)

      expect(comment).toContain(older.slice(0, 8))
      expect(comment).toContain('urn:kolonie:run:33330000000')
      expect(comment).toContain(healthyRevision.slice(0, 8))
      expect(comment).toContain(healthy.run.url)
    })

    it('names the deploy job and the smoke job that carried the evidence', () => {
      const [settled] = smokeFindingsToSettle({
        deployOk: true,
        smokeOk: true,
        revision: healthyRevision,
        open: [finding(older)],
      })

      const comment = smokeSettlementComment(settled!, healthy)

      expect(comment).toContain('deploy to the VPS')
      expect(comment).toContain('smoke the deployed MCP surface')
    })

    /** Deterministic: the same inputs render the same sentence, every run. */
    it('renders the same text for the same evidence', () => {
      const [settled] = smokeFindingsToSettle({
        deployOk: true,
        smokeOk: true,
        revision: healthyRevision,
        open: [finding(older)],
      })

      expect(smokeSettlementComment(settled!, healthy)).toBe(
        smokeSettlementComment(settled!, healthy),
      )
    })

    /** Nothing here is a rollback, and the comment must not read as one. */
    it('says the deploy that cleared it was a later one, not a revert', () => {
      const [settled] = smokeFindingsToSettle({
        deployOk: true,
        smokeOk: true,
        revision: healthyRevision,
        open: [finding(older)],
      })

      expect(smokeSettlementComment(settled!, healthy)).toMatch(/nothing was rolled back/i)
    })

    it('says which run could not be named when the finding recorded none', () => {
      const [settled] = smokeFindingsToSettle({
        deployOk: true,
        smokeOk: true,
        revision: healthyRevision,
        open: [finding(older)],
      })

      expect(smokeSettlementComment(settled!, healthy)).toMatch(/recorded no run/i)
    })
  })
})

/**
 * The run that filed a finding has to be recorded on it, or a later settlement
 * cannot name it (`#1790`).
 */
describe('the finding records the run that filed it', () => {
  const red: SmokeResult = {
    ...at,
    ok: false,
    assertions: [{ name: 'the tool list answers', ok: false, detail: 'origin 502' }],
  }

  it('carries the run marker under the finding marker', () => {
    const issue = smokeIssue(red, { id: '1', url: 'urn:kolonie:run:1' })
    const [first, second] = issue.body.split('\n')

    expect(first).toBe(smokeMarker(at.revision))
    expect(second).toBe('<!-- smoke-run: urn:kolonie:run:1 -->')
  })

  it('files exactly as before when no run is given', () => {
    expect(smokeIssue(red).body.split('\n')[1]).toBe('')
  })
})
