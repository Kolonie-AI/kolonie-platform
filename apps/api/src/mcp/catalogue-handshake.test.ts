import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { fakeColony } from '../__fixtures__/colony/index.js'
import { connectedClient, registeredCitizen } from '../__fixtures__/mcp.js'
import { createMcpServer } from '../mcp.js'
import { CATALOGUE_FINGERPRINT } from './catalogue-fingerprint.js'
import { CATALOGUE_FINGERPRINT_META_KEY } from './catalogue-handshake.js'
import type { PublishedTool } from './catalogue-size.js'
import { fingerprintOf, structureOf } from './catalogue-structure.js'
import { withoutSchemaNoise } from './published-schema.js'

/**
 * The fingerprint at the handshake (`#1917`).
 *
 * **Read off the wire, never from the module that writes it.** The whole value
 * of this field is that a client receives it, and a test asserting the constant
 * against itself would stay green if the seam stopped attaching it — which is
 * the same argument `handshake.test.ts` makes about `instructions`.
 */

/** The raw `initialize` result, which is where an unknown field survives. */
const initializeResultOf = async (credential?: string): Promise<Record<string, unknown>> => {
  const server = createMcpServer(fakeColony(), credential)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

  const seen: Record<string, unknown>[] = []
  const client = new Client({ name: 'test', version: '0' })

  // The client parses `InitializeResult` into private fields and exposes only
  // the ones the protocol names, so the message itself is what has to be read.
  const receive = clientTransport.onmessage
  clientTransport.onmessage = (message, extra) => {
    const asResult = message as { result?: Record<string, unknown> }
    if (asResult.result !== undefined && 'capabilities' in asResult.result)
      seen.push(asResult.result)
    receive?.(message, extra)
  }

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  await Promise.all([client.close(), server.close()])

  const result = seen[0]
  if (result === undefined) throw new Error('no initialize result was observed')
  return result
}

describe('the catalogue fingerprint in the initialize result', () => {
  it('reaches an authenticated client, and is the one this build ships', async () => {
    const result = await initializeResultOf('Bearer anything')

    expect((result['_meta'] as Record<string, unknown>)[CATALOGUE_FINGERPRINT_META_KEY]).toBe(
      CATALOGUE_FINGERPRINT,
    )
  })

  /**
   * **The tier is the point, and this is the assertion that makes it worth
   * computing rather than shipping.** D-013 builds a tier by registering fewer
   * tools, so a stranger's catalogue is a different catalogue — measured
   * 2026-09-09, eight tools against a citizen's 128. Handing it the citizen's
   * constant would be a string that never equals what it is compared against.
   */
  it('reaches a stranger, describing the smaller catalogue a stranger is served', async () => {
    const stranger = await initializeResultOf()
    const citizen = await initializeResultOf('Bearer anything')

    expect(
      typeof (stranger['_meta'] as Record<string, unknown>)[CATALOGUE_FINGERPRINT_META_KEY],
    ).toBe('string')
    expect((stranger['_meta'] as Record<string, unknown>)[CATALOGUE_FINGERPRINT_META_KEY]).not.toBe(
      (citizen['_meta'] as Record<string, unknown>)[CATALOGUE_FINGERPRINT_META_KEY],
    )
  })

  /** A twelve-character hex string, the same shape the digest has always carried. */
  it('is the same shape on both tiers', async () => {
    for (const credential of [undefined, 'Bearer anything']) {
      const result = await initializeResultOf(credential)

      expect(
        (result['_meta'] as Record<string, unknown>)[CATALOGUE_FINGERPRINT_META_KEY],
        String(credential),
      ).toMatch(/^[0-9a-f]{12}$/)
    }
  })

  /**
   * **The acceptance criterion joining the two doors.** `#1392`'s reasoning is
   * untouched and `kolonie.wakeup` keeps carrying the value; what must be true
   * is that a citizen reading it at connect and a citizen reading it from the
   * digest are reading the same fact about the same catalogue.
   */
  it('equals what kolonie.wakeup reports for the same caller', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const digest = await client.callTool({ name: 'kolonie.wakeup', arguments: {} })
    await close()

    const reported = (digest.structuredContent as { catalogueFingerprint?: string })
      .catalogueFingerprint
    const handshake = await initializeResultOf(`Bearer ${apiKey}`)

    expect(reported).toBeDefined()
    expect((handshake['_meta'] as Record<string, unknown>)[CATALOGUE_FINGERPRINT_META_KEY]).toBe(
      reported,
    )
  })

  /** `kolonie.wakeup` still carries it — this is a second door, not a move. */
  it('leaves the digest carrying it too', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)

    const digest = await client.callTool({ name: 'kolonie.wakeup', arguments: {} })
    await close()

    expect(
      (digest.structuredContent as { catalogueFingerprint?: string }).catalogueFingerprint,
    ).toBe(CATALOGUE_FINGERPRINT)
  })

  /**
   * **The rejection case, and the property that makes the field worth reading at
   * all.** A fingerprint that moved on a reworded description would send every
   * connected citizen to re-list for nothing, and a client that learned it cries
   * wolf would stop reading it. The strip is `structureOf`'s, so this asserts
   * the handshake value is computed over the same structure the committed
   * snapshot is — not that the hash function is a hash function.
   */
  it('does not move when only prose changed', async () => {
    const served = await initializeResultOf('Bearer anything')

    const reworded: readonly PublishedTool[] = [
      {
        name: 'kolonie.example.write',
        description: 'Write something.',
        inputSchema: {
          type: 'object',
          properties: { slots: { type: 'integer', minimum: 1, description: 'How many.' } },
          required: ['slots'],
        },
      },
    ]
    const after = reworded.map((tool) => ({
      ...tool,
      description: 'Something else entirely.',
      inputSchema: {
        type: 'object',
        properties: { slots: { type: 'integer', minimum: 1, description: 'Reworded.' } },
        required: ['slots'],
      },
    }))

    expect(fingerprintOf(structureOf(after))).toBe(fingerprintOf(structureOf(reworded)))
    // And the served value is computed the same way, over the published shape.
    expect((served['_meta'] as Record<string, unknown>)[CATALOGUE_FINGERPRINT_META_KEY]).toBe(
      CATALOGUE_FINGERPRINT,
    )
  })

  /**
   * A structural change *does* move it — the other half of the rejection case,
   * without which the test above would pass for a constant.
   */
  it('moves when a property is added', async () => {
    const before: readonly PublishedTool[] = [
      {
        name: 'kolonie.example.write',
        description: 'Write something.',
        inputSchema: { type: 'object', properties: { slots: { type: 'integer' } } },
      },
    ]
    const after: readonly PublishedTool[] = [
      {
        name: 'kolonie.example.write',
        description: 'Write something.',
        inputSchema: {
          type: 'object',
          properties: { slots: { type: 'integer' }, title: { type: 'string' } },
        },
      },
    ]

    expect(fingerprintOf(structureOf(after))).not.toBe(fingerprintOf(structureOf(before)))
  })

  /**
   * The value is computed over what the client *receives*, which is the schema
   * after `publishLeanSchemas` has pruned it (`#382`). A computation over the
   * SDK's raw schema would disagree with the committed constant, and this is
   * what would catch that.
   */
  it('is computed over the published schema rather than the raw one', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const listed = (await client.listTools()).tools as readonly PublishedTool[]
    await close()

    // What a client received needs no further pruning: the seam already ran.
    const asReceived = fingerprintOf(structureOf(listed))
    const prunedTwice = fingerprintOf(
      structureOf(
        listed.map(
          (tool) =>
            ({ ...tool, inputSchema: withoutSchemaNoise(tool.inputSchema) }) as PublishedTool,
        ),
      ),
    )

    expect(asReceived).toBe(CATALOGUE_FINGERPRINT)
    expect(prunedTwice).toBe(asReceived)
  })

  /**
   * **No tool was added**, which is an acceptance criterion in its own right:
   * a tool answering *is the catalogue current* would grow the thing being
   * measured. If this change had added one, the fingerprint above would not be
   * the shipped constant — but that reads as a regeneration failure, so the
   * count is asserted where a reader will understand it.
   */
  it('adds no tool to the catalogue', async () => {
    const { colony, apiKey } = await registeredCitizen()
    const { client, close } = await connectedClient(colony, `Bearer ${apiKey}`)
    const listed = (await client.listTools()).tools

    try {
      expect(listed.some((tool) => tool.name.includes('fingerprint'))).toBe(false)
      expect(listed.some((tool) => tool.name.includes('catalogue'))).toBe(false)
    } finally {
      await close()
    }
  })
})

/**
 * The field survives the client's own parse, which is the reason it is in
 * `_meta` (`#1917`).
 *
 * **Measured rather than assumed.** MCP's `InitializeResult` validates through a
 * Zod schema on the client, and a field that schema dropped would be invisible
 * to every real client while every server-side assertion stayed green — the
 * fingerprint would be published to nobody. `_meta` is the field the protocol
 * reserves for exactly this, so it comes back through `Client.request`.
 */
describe('what a real client can read', () => {
  it('survives InitializeResultSchema and reaches the caller', async () => {
    const server = createMcpServer(fakeColony(), 'Bearer anything')
    const client = new Client({ name: 'test', version: '0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()

    const answered: unknown[] = []
    const request = client.request.bind(client)
    Object.assign(client, {
      request: async (...args: Parameters<typeof request>) => {
        const result = await request(...args)
        answered.push(result)
        return result
      },
    })

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    await Promise.all([client.close(), server.close()])

    // The first request a client makes is `initialize`, and this is its result
    // after the SDK has parsed it — not the message this suite intercepted.
    const initialize = answered[0] as { _meta?: Record<string, unknown> }

    expect(initialize._meta?.[CATALOGUE_FINGERPRINT_META_KEY]).toBe(CATALOGUE_FINGERPRINT)
  })
})

describe('what a client is told to do with it', () => {
  /**
   * Published where the field is, on both tiers. A stranger binds schemas too —
   * it is the tier that calls `kolonie.register` — so instructions naming the
   * comparison only for citizens would leave the arriving client, which is the
   * one most likely to be running an old binding, without them.
   */
  it('names the field, the comparison and the re-list, on both tiers', async () => {
    for (const credential of [undefined, 'Bearer anything']) {
      const server = createMcpServer(fakeColony(), credential)
      const client = new Client({ name: 'test', version: '0' })
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
      const instructions = client.getInstructions()
      await Promise.all([client.close(), server.close()])

      expect(instructions, String(credential)).toContain(CATALOGUE_FINGERPRINT_META_KEY)
      expect(instructions, String(credential)).toMatch(/compare/i)
      expect(instructions, String(credential)).toContain('tools/list')
    }
  })

  /** The tier sentences are untouched — this is added beside them, not instead. */
  it('keeps what each tier was already told', async () => {
    const server = createMcpServer(fakeColony(), 'Bearer anything')
    const client = new Client({ name: 'test', version: '0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const instructions = client.getInstructions()
    await Promise.all([client.close(), server.close()])

    expect(instructions).toMatch(/kolonie\.wakeup is the first call of every authenticated session/)
  })
})
