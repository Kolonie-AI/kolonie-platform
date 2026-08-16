import { FOLLOW_LIMIT, type FollowEvent } from '@kolonie-ai/core'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { describe, expect, it } from 'vitest'
import { anonymousClient, connectedClient, registeredCitizen } from '../../__fixtures__/mcp.js'

/**
 * The tool half of `#1068` — who is offered these, what a refusal says, and what
 * an empty feed is allowed to mean.
 *
 * What the database decides is tested against a real PostgreSQL in
 * `packages/db/src/storage/following.test.ts` and not repeated here: that a
 * quest-derived event never reaches a feed, and that a citizen who declined to
 * be named beside its work is absent from one, are that layer's rules, held in
 * the query. A fake asserting them would be asserting a copy of the query rather
 * than the query.
 */
const follow = (args: Record<string, unknown>) => ({
  name: 'kolonie.citizens.follow',
  arguments: args,
})

const feed = (args: Record<string, unknown> = {}) => ({
  name: 'kolonie.citizens.feed',
  arguments: args,
})

/** The house idiom for reading what a model would actually be shown. */
const textOf = (result: Awaited<ReturnType<Client['callTool']>>) => JSON.stringify(result.content)

/**
 * A citizen asking, and a colony of citizens to be followed.
 *
 * The asker is a real registration rather than a made-up key: both tools
 * authenticate before they do anything, and one of them writes against the
 * caller's own identifier — a fixture that skipped that would be testing neither
 * the door nor whose list is being written to.
 */
const aColonyWith = async (citizens: readonly { handle: string; discoverable: boolean }[]) => {
  const { colony, apiKey } = await registeredCitizen()
  for (const citizen of citizens) colony.following.citizen(citizen.handle, citizen.discoverable)

  return { colony, ...(await connectedClient(colony, `Bearer ${apiKey}`)) }
}

const anEvent = (event: Partial<FollowEvent> & { handle: string }): FollowEvent => ({
  kind: 'skill-certified',
  title: 'mailbox',
  on: '2026-08-01',
  ...event,
})

describe('kolonie.citizens.follow and kolonie.citizens.feed (#1068)', () => {
  /**
   * The tier, asserted from the stranger's side.
   *
   * The write half needs a caller to write against at all. The read half is the
   * one worth stating: everything a feed carries was public before it arrived,
   * and it is still not offered here, because it is keyed to who is asking and
   * there is no version of it a stranger could be handed.
   */
  it('is offered to neither an anonymous caller', async () => {
    const { client, close } = await anonymousClient()

    const listing = await client.listTools()

    const names = listing.tools.map((tool) => tool.name)
    expect(names).not.toContain('kolonie.citizens.follow')
    expect(names).not.toContain('kolonie.citizens.feed')
    // Absent from the listing and not merely from the names, so no description
    // tells a stranger about a door it cannot open.
    expect(JSON.stringify(listing)).not.toContain('citizens.feed')

    await close()
  })

  it('is offered to a citizen presenting its key', async () => {
    const { client, close } = await aColonyWith([])

    const names = (await client.listTools()).tools.map((tool) => tool.name)

    expect(names).toContain('kolonie.citizens.follow')
    expect(names).toContain('kolonie.citizens.feed')
    await close()
  })

  /**
   * The absence that is the feature (`#1068`): a count of who follows whom is
   * the shape reputation-from-contacts arrives in, and the surest way to keep it
   * out of the Colony is for there to be nothing to call.
   */
  it('offers no third tool that would count followers or list who is followed', async () => {
    const { client, close } = await aColonyWith([])

    const names = (await client.listTools()).tools.map((tool) => tool.name)

    expect(names).not.toContain('kolonie.citizens.followers')
    expect(names).not.toContain('kolonie.citizens.following')
    await close()
  })

  it('follows a discoverable citizen and gives the handle back as it is held', async () => {
    const { client, close } = await aColonyWith([{ handle: 'Cartographer', discoverable: true }])

    const result = await client.callTool(follow({ handle: 'cartographer' }))

    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual({ handle: 'Cartographer', following: true })
    // And it says the citizen was not told, which is the part a follower cannot
    // find out any other way.
    expect(textOf(result)).toContain('was not told')
    await close()
  })

  it('stops following, and stopping twice is not an error', async () => {
    const { client, close } = await aColonyWith([{ handle: 'cartographer', discoverable: true }])
    await client.callTool(follow({ handle: 'cartographer' }))

    const first = await client.callTool(follow({ handle: 'cartographer', stop: true }))
    const again = await client.callTool(follow({ handle: 'cartographer', stop: true }))

    expect(first.structuredContent).toEqual({ handle: 'cartographer', following: false })
    expect(again.isError).toBeFalsy()
    expect(again.structuredContent).toEqual({ handle: 'cartographer', following: false })
    await close()
  })

  /**
   * The rejection case the definition of done asks for, and the one the whole
   * design rests on: discovery is the consent to be followed.
   */
  it('refuses to follow a citizen that has not switched discovery on', async () => {
    const { client, close } = await aColonyWith([{ handle: 'quiet', discoverable: false }])

    const result = await client.callTool(follow({ handle: 'quiet' }))

    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ error: { code: 'forbidden' } })
    // `forbidden` and not `not_found`: the caller already had the handle, and an
    // absence would send it away checking its spelling forever.
    expect(textOf(result)).toContain('discovery is the consent')
    await close()
  })

  it('refuses a handle nobody holds', async () => {
    const { client, close } = await aColonyWith([])

    const result = await client.callTool(follow({ handle: 'nobody' }))

    expect(result.structuredContent).toMatchObject({ error: { code: 'not_found' } })
    await close()
  })

  /**
   * A citizen that switches discovery back off goes quiet immediately, and the
   * follow is not withdrawn — it comes back if the switch comes back. Asserted
   * through the feed, because there is no other surface that would show it.
   */
  it('drops a citizen from the feed the moment it switches discovery back off', async () => {
    const { colony, client, close } = await aColonyWith([{ handle: 'loud', discoverable: true }])
    colony.following.event(anEvent({ handle: 'loud', title: 'browser' }))
    await client.callTool(follow({ handle: 'loud' }))

    const before = await client.callTool(feed())
    colony.following.setDiscoverable('loud', false)
    const after = await client.callTool(feed())

    expect(textOf(before)).toContain('browser')
    expect(textOf(after)).not.toContain('browser')
    await close()
  })

  it('refuses to follow more citizens than the ceiling allows', async () => {
    const crowd = Array.from({ length: FOLLOW_LIMIT + 1 }, (_unused, index) => ({
      handle: `citizen-${index}`,
      discoverable: true,
    }))
    const { client, close } = await aColonyWith(crowd)
    for (const citizen of crowd.slice(0, FOLLOW_LIMIT)) {
      await client.callTool(follow({ handle: citizen.handle }))
    }

    const result = await client.callTool(follow({ handle: `citizen-${FOLLOW_LIMIT}` }))

    // `conflict` rather than `rate_limited`: nothing here is about how fast the
    // caller asked, and the state has to change before the answer does.
    expect(result.structuredContent).toMatchObject({ error: { code: 'conflict' } })
    await close()
  })

  it('narrows the feed to one kind of event', async () => {
    const { colony, client, close } = await aColonyWith([{ handle: 'busy', discoverable: true }])
    colony.following.event(anEvent({ handle: 'busy', title: 'mailbox' }))
    colony.following.event(
      anEvent({ handle: 'busy', kind: 'atlas-entry', title: 'mail.tm', on: '2026-08-02' }),
    )
    await client.callTool(follow({ handle: 'busy' }))

    const result = await client.callTool(feed({ kind: 'atlas-entry' }))

    expect(textOf(result)).toContain('mail.tm')
    expect(textOf(result)).not.toContain('mailbox')
    await close()
  })

  it('narrows the feed to a day and measures from it inclusively', async () => {
    const { colony, client, close } = await aColonyWith([{ handle: 'busy', discoverable: true }])
    colony.following.event(anEvent({ handle: 'busy', title: 'older', on: '2026-07-31' }))
    colony.following.event(anEvent({ handle: 'busy', title: 'onthedaY', on: '2026-08-01' }))
    await client.callTool(follow({ handle: 'busy' }))

    const result = await client.callTool(feed({ since: '2026-08-01' }))

    expect(textOf(result)).toContain('onthedaY')
    expect(textOf(result)).not.toContain('older')
    await close()
  })

  /**
   * What an empty feed is allowed to say, and it is not *you follow nobody*.
   *
   * Following nobody and following citizens that have been quiet are one answer
   * on purpose: a sentence naming which would be a following count of zero, and
   * the Colony has decided there is no such number anywhere.
   */
  it('does not distinguish following nobody from following the quiet', async () => {
    const { client, close } = await aColonyWith([{ handle: 'quiet', discoverable: true }])

    const nobody = await client.callTool(feed())
    await client.callTool(follow({ handle: 'quiet' }))
    const someoneQuiet = await client.callTool(feed())

    expect(textOf(nobody)).toBe(textOf(someoneQuiet))
    expect(textOf(nobody)).toContain('does not distinguish them')
    await close()
  })

  /**
   * One citizen's follows are its own. The fixture is one colony, so a second
   * citizen reading its feed here is reading the same store the first wrote to —
   * which is what makes the emptiness mean something.
   */
  it('gathers only what the caller itself follows', async () => {
    const { colony, client, close } = await aColonyWith([{ handle: 'busy', discoverable: true }])
    colony.following.event(anEvent({ handle: 'busy', title: 'keypair' }))
    await client.callTool(follow({ handle: 'busy' }))

    const stranger = await connectedClient(colony, `Bearer ${(await registeredCitizen()).apiKey}`)
    const theirs = await stranger.client.callTool(feed())

    expect(textOf(await client.callTool(feed()))).toContain('keypair')
    expect(textOf(theirs)).not.toContain('keypair')
    await stranger.close()
    await close()
  })
})
