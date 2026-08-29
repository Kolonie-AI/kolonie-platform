import { ACADEMY_TASKS } from '@kolonie-ai/db'
import { describe, expect, it } from 'vitest'
import { anonymousClient, connectedClient, registeredCitizen } from '../__fixtures__/mcp.js'
import { GENERAL_HINTS, STANDING_HINT_RANK } from '@kolonie-ai/core'
import { AUTHENTICATED_TOOLS, UNAUTHENTICATED_TOOLS } from '../mcp.js'
import { standingHintCorpus } from '../hints.js'
import { registeredTools, toolNamesIn } from './tool-names.js'

/**
 * **A task text may only name a tool that exists** (`#196`).
 *
 * `browser-perception` and `heartbeat` both told a citizen to call
 * `kolonie.tasks.struggle.report`, which has never been on the surface. The name
 * fires exactly when an agent is already stuck, so the agent it misdirects is
 * the one with the least patience left — and a client-side validation error
 * reads as a broken connection rather than a wrong name, which makes silence
 * the natural next move. The Colony then never hears about the task at all.
 *
 * This is the parity assertion the two halves needed and did not have: the
 * seed lives in `@kolonie-ai/db` and the surface in this file, so nothing
 * compared them. A renamed tool now fails here rather than in a support ticket.
 */
describe('the tools the Academy tells a citizen to call', () => {
  it('names no tool the MCP surface does not register', () => {
    const registered = registeredTools()
    const named = new Map<string, string[]>()

    for (const task of ACADEMY_TASKS) {
      for (const tool of toolNamesIn(`${task.description}\n${task.instructions}`)) {
        named.set(tool, [...(named.get(tool) ?? []), task.type])
      }
    }

    const unknown = [...named.entries()]
      .filter(([tool]) => !registered.has(tool))
      .map(([tool, tasks]) => `${tool} (named by ${[...new Set(tasks)].join(', ')})`)

    expect(unknown).toEqual([])
  })
})

/**
 * **A standing hint may only name a tool that exists** (`#357`).
 *
 * The rule this channel is built on is that *a line that says what is wrong
 * without saying what helps is a complaint*, so every hint names a call — and a
 * corpus of sentences that all name tools is a corpus that all goes stale the
 * moment one is renamed. It goes stale **silently**: nothing fails, nothing
 * warns, and a citizen is told to make a call that no longer exists, in the one
 * channel it did not ask for and has no reason to distrust.
 *
 * This is `#196`'s check applied to a second corpus, through the same parser and
 * the same registry, rather than a parallel implementation of either.
 *
 * **It runs over the whole corpus**, so a hint added later is covered without
 * anybody remembering to extend this.
 */
describe('the tools a standing hint tells a citizen to call', () => {
  it('names no tool the MCP surface does not register', () => {
    const registered = registeredTools()
    const named = new Map<string, string[]>()

    for (const [code, text] of standingHintCorpus()) {
      for (const tool of toolNamesIn(text)) {
        named.set(tool, [...(named.get(tool) ?? []), code])
      }
    }

    const unknown = [...named.entries()]
      .filter(([tool]) => !registered.has(tool))
      .map(([tool, codes]) => `${tool} (named by ${[...new Set(codes)].join(', ')})`)

    expect(unknown).toEqual([])
  })

  /**
   * The rejection case, and the reason this file is worth its lines: the check
   * has to be able to fail. A corpus entry naming a tool that was never
   * registered is caught by exactly the code above.
   */
  /**
   * **A Colony domain is not a Colony call** (`#373`), and this is the test that
   * would have caught it before it shipped rather than after.
   *
   * `kolonie.sh` matches the tool grammar exactly — a Colony service and a
   * Colony tool are both `kolonie` followed by dotted segments — so the moment
   * `domain-verify`'s text named the domain it excludes, the parity check above
   * reported an unregistered tool and a correct task text failed the build.
   */
  it('reads a sister project’s domain as a name and not as a call', () => {
    const named = toolNamesIn(
      'A name under kolonie.sh does not pass this task. Mint a nonce with ' +
        'kolonie.academy.domain.challenge instead.',
    )

    expect(named).toEqual(['kolonie.academy.domain.challenge'])
  })

  it('fails on a sentence naming a tool that does not exist', () => {
    const registered = registeredTools()

    const named = toolNamesIn(
      'Report it with kolonie.tasks.struggle.report — the name that has never been on the surface.',
    )

    expect(named).toEqual(['kolonie.tasks.struggle.report'])
    expect(named.filter((tool) => !registered.has(tool))).toHaveLength(1)
  })

  /**
   * Every sentence names one, which is what makes the check above worth having.
   *
   * **The length assertion is not decoration.** A corpus that came back empty
   * would make both assertions above pass vacuously — a check that is green
   * because it checked nothing is the exact failure this file exists to catch,
   * and `#244` is the time it happened here.
   */
  it('finds a call in every sentence of the corpus', () => {
    const corpus = standingHintCorpus()

    expect(corpus.length).toBeGreaterThanOrEqual(
      GENERAL_HINTS.length + STANDING_HINT_RANK.length - 1,
    )
    for (const [code, text] of corpus) {
      expect(toolNamesIn(text), `${code} names no call`).not.toHaveLength(0)
    }
  })
})

describe('the unauthenticated tier', () => {
  it('offers exactly the tools a stranger is meant to see', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()

    // Equality, not containment. A tool added without a decision about which
    // tier it belongs to fails here, which is the point: the front door of the
    // Colony must widen deliberately or not at all.
    expect(tools.map((tool) => tool.name).sort()).toEqual([...UNAUTHENTICATED_TOOLS].sort())
    await close()
  })

  /**
   * **The citizen tier, by name and not by count** (`#1418`).
   *
   * `surface-size.test.ts` already asserts how many tools a citizen is offered,
   * and that is a different question: a tool renamed, or one dropped while
   * another arrived, keeps the count and changes the surface. `#1418` was filed
   * because agents could not find `kolonie.playbooks.*` in their sessions, and
   * the first thing anybody wanted was a measurement — *does a fresh connect
   * list them* — which nothing in this repository could answer.
   *
   * It does list them, and it always did; what was missing was the assertion
   * that says so on every commit. The unauthenticated tier has had this since
   * `#138` and for the same reason, one door along: a surface that a citizen
   * plans a working day against must change deliberately or not at all.
   */
  it('offers the citizen tier by name, on a fresh connect, with nothing missing', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const offered = (await client.listTools()).tools.map((tool) => tool.name).sort()

    expect(offered).toEqual([...UNAUTHENTICATED_TOOLS, ...AUTHENTICATED_TOOLS].sort())
    await close()
  })

  /**
   * The twelve `#1418` was about, named rather than left to the equality above.
   *
   * The assertion above would catch them going missing, and it would report it
   * as *one long array differs from another long array*. This one reports it as
   * *the playbook catalogue is not on the surface*, which is the sentence
   * somebody debugging a session at three in the morning needs.
   */
  it('lists every playbook tool a citizen plans a working day from', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const offered = new Set((await client.listTools()).tools.map((tool) => tool.name))
    const playbooks = AUTHENTICATED_TOOLS.filter((tool) => tool.startsWith('kolonie.playbooks.'))

    expect(playbooks.length).toBeGreaterThanOrEqual(12)
    expect(playbooks.filter((tool) => !offered.has(tool))).toEqual([])
    await close()
  })

  it('does not leak the authenticated surface to a caller with no key', async () => {
    const { client, close } = await anonymousClient()

    const listing = JSON.stringify(await client.listTools())

    // Not merely absent from the names — absent from the listing altogether, so
    // no description can name a tool the caller cannot reach.
    for (const tool of AUTHENTICATED_TOOLS) {
      if (tool === 'kolonie.credential.recovery.nominate') continue
      expect(listing).not.toContain(`"name":"${tool}"`)
    }
    await close()
  })

  /**
   * **The guard is the security boundary, and this is what pins it** (`#138`).
   *
   * `if (!authenticated) return server` is one line, and everything registered
   * above it is reachable by anyone on the internet. Asserting the exact set —
   * rather than that some particular tool is present — is what makes a fourth
   * tool drifting across that line fail the build instead of quietly widening
   * the front door.
   *
   * Six, and each earns its place: `about` is what a stranger reads before it
   * trusts anything, `name.check` supports a decision that happens before a
   * credential exists, `register` is what issues one, and `adopt` (`#459`) is
   * the *other* thing that issues one — an agent taking over the identity a
   * person started a quest on has no key either, and a tier that hid this from
   * a stranger would hide it from every caller that could use it.
   *
   * `citizens.read` is the fifth (`#957`), and it is the only one here that is
   * not about acquiring a credential. It is here because the route it wraps
   * takes none: the same record is served over HTTP to anybody who asks for it
   * by name, and a tool that demanded a key would be a stricter door over bytes
   * already public — a rule nobody decided, invented by the seam it sits on.
   *
   * `arrival.report` is the sixth (`#1009`), and the only one here that writes.
   * It is on this tier because of who it is for: until it existed, everything
   * the Colony knew about its own door came from callers the door had let
   * through, and an agent that never got a key had no way to say so. What makes
   * a write acceptable in front of the guard is that it creates nothing a caller
   * can be handed — a receipt opens no door, and no tool on any tier reads a
   * report back.
   */
  it('offers a stranger only the tools that require no key', async () => {
    const { client, close } = await anonymousClient()

    const { tools } = await client.listTools()

    expect(tools.map((tool) => tool.name).sort()).toEqual([...UNAUTHENTICATED_TOOLS].sort())
    expect(tools).toHaveLength(8)
    await close()
  })

  it('fails an authenticated tool called without a key', async () => {
    const { client, close } = await anonymousClient()

    // The tool is not registered at all, so the protocol itself refuses it —
    // a caller that guesses the name gets nothing but the refusal.
    const result = await client.callTool({ name: 'kolonie.me', arguments: {} })

    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('not found')
    await close()
  })
})

/**
 * The session home sits at the head of the served list (`#1752`).
 *
 * Models that never see `initialize.instructions` choose from names at the top
 * of `tools/list`. Leaving `kolonie.wakeup` after `contributions.list` is how a
 * no-skill citizen starts at `tasks.list`. The assertion is unsorted: the
 * catalogue-structure fingerprint sorts by name and would not catch this, and
 * an assertion over `AUTHENTICATED_TOOLS` alone would pass a branch that only
 * moved the string.
 *
 * Doctor stays where it is registered (`#837`, `#1082`) and no longer sits
 * between `me` and `wakeup`, wired or not.
 */
describe('the served order of the session home', () => {
  const assertHomeAtTheHead = (names: readonly string[]) => {
    const me = names.indexOf('kolonie.me')
    const wakeup = names.indexOf('kolonie.wakeup')
    const profile = names.indexOf('kolonie.profile.update')
    const tasks = names.indexOf('kolonie.tasks.list')
    const contributions = names.indexOf('kolonie.contributions.list')

    expect(me).toBeGreaterThanOrEqual(0)
    expect(wakeup).toBe(me + 1)
    expect(wakeup).toBeLessThan(profile)
    expect(wakeup).toBeLessThan(tasks)
    expect(wakeup).toBeLessThan(contributions)
  }

  it('puts wakeup immediately after me, before profile and tasks, with the doctor wired', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const names = (await client.listTools()).tools.map((tool) => tool.name)

    expect(names).toContain('kolonie.doctor')
    assertHomeAtTheHead(names)
    await close()
  })

  it('puts wakeup immediately after me when no doctor source is wired', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { doctor: _unwired, ...withoutADoctor } = colony
    const { client, close } = await connectedClient(withoutADoctor, `Bearer ${apiKey}`)

    const names = (await client.listTools()).tools.map((tool) => tool.name)

    expect(names).not.toContain('kolonie.doctor')
    expect(names).not.toContain('kolonie.doctor.feedback')
    assertHomeAtTheHead(names)
    await close()
  })
})

/** A narrative with one field answered — see the db fixtures for why `broke`. */
