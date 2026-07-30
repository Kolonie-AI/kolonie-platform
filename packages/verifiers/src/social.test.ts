import { describe, expect, it } from 'vitest'
import {
  blueskyAdapter,
  htmlToText,
  httpSocialReader,
  mastodonAdapter,
  parseMastodonInstances,
  resolveBlueskyUrl,
  resolveMastodonUrl,
  type SocialAdapter,
} from './social.js'

const DID = 'did:plc:7iza6de2dwap2sbkpav7c6c6'
const BLUESKY_URL = 'https://bsky.app/profile/colette.example/post/3kabcxyz'
const MASTODON_URL = 'https://example.social/@colette/114000000000000001'

/** A `fetch` that answers one canned body, and records what it was asked for. */
const answering = (status: number, payload: unknown): { fetch: typeof fetch; calls: string[] } => {
  const calls: string[] = []
  const impl = (async (input: string | URL | Request) => {
    calls.push(String(input))
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    } as unknown as Response
  }) as unknown as typeof fetch

  return { fetch: impl, calls }
}

const throwing = (message: string): typeof fetch =>
  (async () => {
    throw new Error(message)
  }) as unknown as typeof fetch

const post = (did: string, handle: string, text: string): unknown => ({
  thread: {
    $type: 'app.bsky.feed.defs#threadViewPost',
    post: { author: { did, handle }, record: { text } },
  },
})

describe('resolveBlueskyUrl', () => {
  it('names the actor and the record key of a post permalink', () => {
    expect(resolveBlueskyUrl(new URL(BLUESKY_URL))).toEqual({
      kind: 'post',
      actor: 'colette.example',
      rkey: '3kabcxyz',
    })
  })

  it('refuses an address that is not a post', () => {
    const resolved = resolveBlueskyUrl(new URL('https://bsky.app/profile/colette.example'))

    expect(resolved.kind).toBe('unaddressable')
  })
})

describe('the Bluesky adapter', () => {
  it('owns bsky.app addresses and nothing else', () => {
    const adapter = blueskyAdapter()

    expect(adapter.owns(new URL(BLUESKY_URL))).toBe(true)
    expect(adapter.owns(new URL(MASTODON_URL))).toBe(false)
    expect(adapter.owns(new URL('http://bsky.app/profile/a/post/b'))).toBe(false)
  })

  /**
   * The rule the rung rests on: the identity comes out of the response, and the
   * handle in the submitted link is parsed and then ignored. A handle is a
   * domain name pointing at an account and can be reassigned; the `did` cannot.
   */
  it('takes the did from the response, not the handle from the link', async () => {
    const { fetch, calls } = answering(200, post(DID, 'renamed.example', 'hello'))
    const result = await blueskyAdapter(fetch).read(new URL(BLUESKY_URL), BLUESKY_URL)

    expect(result).toMatchObject({
      outcome: 'found',
      post: { account: DID, handle: 'renamed.example', body: 'hello', network: 'bluesky' },
    })
    expect(calls[0]).toContain('app.bsky.feed.getPostThread')
    // Unauthenticated, and that is the property that makes this rung
    // undisableable by an outside party. Nothing here carries a credential.
    expect(calls[0]).toContain('public.api.bsky.app')
  })

  /**
   * Bluesky answers 200 with a union member for a deleted or blocked post rather
   * than a 404. A reader that only checked the status would hand the verifier an
   * empty body, and the agent would then be told its nonce was missing — the
   * wrong reason.
   */
  it('reads a notFoundPost as not-found rather than as an empty post', async () => {
    const { fetch } = answering(200, { thread: { $type: 'app.bsky.feed.defs#notFoundPost' } })
    const result = await blueskyAdapter(fetch).read(new URL(BLUESKY_URL), BLUESKY_URL)

    expect(result.outcome).toBe('not-found')
  })

  it('answers unavailable when Bluesky is down, so the agent keeps its attempt', async () => {
    const { fetch } = answering(503, {})
    const result = await blueskyAdapter(fetch).read(new URL(BLUESKY_URL), BLUESKY_URL)

    expect(result.outcome).toBe('unavailable')
  })

  it('answers unavailable when the host cannot be reached at all', async () => {
    const result = await blueskyAdapter(throwing('EAI_AGAIN')).read(
      new URL(BLUESKY_URL),
      BLUESKY_URL,
    )

    expect(result).toMatchObject({ outcome: 'unavailable' })
  })

  it('answers not-found on a 404, which is a fact about the submission', async () => {
    const { fetch } = answering(404, {})
    const result = await blueskyAdapter(fetch).read(new URL(BLUESKY_URL), BLUESKY_URL)

    expect(result.outcome).toBe('not-found')
  })
})

describe('resolveMastodonUrl', () => {
  it('names the instance and status id of a web permalink', () => {
    expect(resolveMastodonUrl(new URL(MASTODON_URL))).toEqual({
      kind: 'status',
      instance: 'example.social',
      statusId: '114000000000000001',
    })
  })

  it('names them for the ActivityPub form too', () => {
    expect(
      resolveMastodonUrl(
        new URL('https://example.social/users/colette/statuses/114000000000000001'),
      ),
    ).toEqual({ kind: 'status', instance: 'example.social', statusId: '114000000000000001' })
  })
})

describe('parseMastodonInstances', () => {
  it('is empty when nothing is configured, which refuses every instance', () => {
    expect(parseMastodonInstances(undefined)).toEqual([])
    expect(parseMastodonInstances('  ')).toEqual([])
  })

  it('trims and lowercases a comma-separated list', () => {
    expect(parseMastodonInstances(' One.Example , two.example ')).toEqual([
      'one.example',
      'two.example',
    ])
  })
})

describe('the Mastodon adapter', () => {
  const status = (acct: string, content: string): unknown => ({
    content,
    account: { acct, username: acct.split('@')[0] },
  })

  it('owns a status permalink on any host, so a refusal can name the instance', () => {
    const adapter = mastodonAdapter([])

    expect(adapter.owns(new URL(MASTODON_URL))).toBe(true)
    expect(adapter.owns(new URL('https://example.social/@colette'))).toBe(false)
  })

  /**
   * The allow-list is the deliverable, not a configuration detail: Mastodon
   * rules are per instance, so an open set would have the Colony certifying
   * accounts under rules it has not read. Empty means none has been assessed.
   */
  it('refuses an instance that is not on the allow-list, and says Bluesky instead', async () => {
    const { fetch, calls } = answering(200, status('colette', 'anything'))
    const result = await mastodonAdapter([], fetch).read(new URL(MASTODON_URL), MASTODON_URL)

    expect(result).toMatchObject({ outcome: 'not-found' })
    expect(result.outcome === 'not-found' && result.reason).toContain('Bluesky')
    // Nothing was fetched: the refusal is decided before the instance is asked.
    expect(calls).toEqual([])
  })

  it('reads an allow-listed instance and records acct: plus the instance', async () => {
    const { fetch, calls } = answering(200, status('colette', '<p>hello</p>'))
    const result = await mastodonAdapter(['example.social'], fetch).read(
      new URL(MASTODON_URL),
      MASTODON_URL,
    )

    expect(result).toMatchObject({
      outcome: 'found',
      post: { account: 'acct:colette@example.social', handle: '@colette@example.social' },
    })
    expect(calls[0]).toBe('https://example.social/api/v1/statuses/114000000000000001')
  })

  /**
   * Without this the allow-list is decorative: any account anywhere could be
   * certified by finding one allow-listed instance that federates with it, and
   * the Colony would be certifying accounts under rules it never read.
   */
  it('refuses an allow-listed instance’s copy of a post from elsewhere', async () => {
    const { fetch } = answering(200, status('someone@other.example', 'hello'))
    const result = await mastodonAdapter(['example.social'], fetch).read(
      new URL(MASTODON_URL),
      MASTODON_URL,
    )

    expect(result).toMatchObject({ outcome: 'not-found' })
    expect(result.outcome === 'not-found' && result.reason).toContain('another instance')
  })

  it('answers unavailable when an allow-listed instance is down', async () => {
    const { fetch } = answering(502, {})
    const result = await mastodonAdapter(['example.social'], fetch).read(
      new URL(MASTODON_URL),
      MASTODON_URL,
    )

    expect(result.outcome).toBe('unavailable')
  })
})

describe('htmlToText', () => {
  /**
   * The marker rule asks whether the id is on a line of its own, so block
   * boundaries have to become newlines before the tags go — an agent that wrote
   * two paragraphs would otherwise hand in one long line and fail a rule it had
   * followed.
   */
  it('turns block boundaries into newlines before stripping tags', () => {
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\ntwo\n')
    expect(htmlToText('a<br />b')).toBe('a\nb')
  })

  it('decodes the entities an encoder emits, and &amp; last', () => {
    expect(htmlToText('a &amp;lt; b')).toBe('a &lt; b')
    expect(htmlToText('&quot;q&quot;&nbsp;&#39;')).toBe('"q" \'')
  })
})

describe('httpSocialReader', () => {
  const stub = (network: 'bluesky' | 'mastodon', owns: boolean): SocialAdapter => ({
    network,
    owns: () => owns,
    read: async (_url, submitted) => ({
      outcome: 'found',
      post: { url: submitted, network, account: 'a', handle: 'h', body: '' },
    }),
  })

  it('dispatches to the first adapter that owns the address', async () => {
    const reader = httpSocialReader([stub('mastodon', false), stub('bluesky', true)])

    expect(await reader.read('https://anything.example/x')).toMatchObject({
      outcome: 'found',
      post: { network: 'bluesky' },
    })
  })

  /**
   * Not-found rather than unavailable: retrying an address on a network nobody
   * reads would tell the agent nothing, and the reason names what is accepted.
   */
  it('refuses an address no adapter owns, naming the networks that are read', async () => {
    const result = await httpSocialReader([stub('bluesky', false)]).read(
      'https://elsewhere.example/x',
    )

    expect(result).toMatchObject({ outcome: 'not-found' })
    expect(result.outcome === 'not-found' && result.reason).toContain('bluesky')
  })

  it('refuses something that is not a URL at all', async () => {
    const result = await httpSocialReader([stub('bluesky', true)]).read('not a url')

    expect(result).toMatchObject({ outcome: 'not-found' })
  })
})
