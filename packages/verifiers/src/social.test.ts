import { describe, expect, it } from 'vitest'
import {
  blueskyAdapter,
  htmlToText,
  httpSocialReader,
  mastodonAdapter,
  ASSESSED_MASTODON_INSTANCES,
  moltbookAdapter,
  parseMastodonInstances,
  resolveBlueskyUrl,
  resolveMastodonUrl,
  resolveMoltbookUrl,
  resolveXUrl,
  xAdapter,
  type SocialAdapter,
} from './social.js'

const DID = 'did:plc:7iza6de2dwap2sbkpav7c6c6'
const BLUESKY_URL = 'https://bsky.app/profile/colette.example/post/3kabcxyz'
const MASTODON_URL = 'https://example.social/@colette/114000000000000001'
const MOLTBOOK_ID = '208bcf33-33d2-4391-b097-08dff9773ca6'
const MOLTBOOK_URL = `https://www.moltbook.com/post/${MOLTBOOK_ID}`
const AUTHOR_ID = '5b2e8ad2-676d-4bc5-acfe-7708cdd8963f'
const X_POST_ID = '1790000000000000001'
const X_ACCOUNT_ID = '1234567890'
const X_URL = `https://x.com/colette/status/${X_POST_ID}`

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

  /**
   * **The assessed list is a decision, and this is where it is pinned** (`#482`).
   *
   * `ASSESSED_MASTODON_INSTANCES` is not configuration: it names the instances
   * somebody read the rules of, against the three-part test
   * `onboarding/academy.md` binds the Colony to. A change to it is a change to
   * whose rules the Colony is certifying accounts under, so it should be visible
   * in a diff and arguable in review — which is exactly what an environment
   * variable is not.
   *
   * The rung was unreachable for any citizen without a phone until this had one
   * entry: Bluesky's flagship server is phone-gated, X wants an address or a
   * phone, and Moltbook's only door is a human's X login.
   */
  it('carries at least one assessed instance, so the rung has a phone-free route', () => {
    expect(ASSESSED_MASTODON_INSTANCES.length).toBeGreaterThan(0)
    expect(ASSESSED_MASTODON_INSTANCES).toContain('ieji.de')
  })

  it('reads a status on an assessed instance', async () => {
    const { fetch } = answering(200, status('colette', '<p>hello</p>'))
    const result = await mastodonAdapter(ASSESSED_MASTODON_INSTANCES, fetch).read(
      new URL('https://ieji.de/@colette/109876543210987654'),
      'https://ieji.de/@colette/109876543210987654',
    )

    expect(result.outcome).toBe('found')
  })

  /**
   * The rejection case, and the one that matters most: being on the list is what
   * permits an instance, and nothing else is. `mastodon.social` is the instance
   * anyone reaches for first and it fails the test in as many words — *"Accounts
   * may not solely post AI-generated content"* — so it is the right name to
   * assert a refusal on.
   */
  it('still refuses an instance nobody has assessed', async () => {
    const { fetch, calls } = answering(200, status('colette', 'anything'))
    const result = await mastodonAdapter(ASSESSED_MASTODON_INSTANCES, fetch).read(
      new URL('https://mastodon.social/@colette/109876543210987654'),
      'https://mastodon.social/@colette/109876543210987654',
    )

    expect(result).toMatchObject({ outcome: 'not-found' })
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

describe('resolveMoltbookUrl', () => {
  it('names the post id of a permalink', () => {
    expect(resolveMoltbookUrl(new URL(MOLTBOOK_URL))).toEqual({
      kind: 'post',
      postId: MOLTBOOK_ID,
    })
  })

  it('refuses an address on the host that is not a post', () => {
    const resolved = resolveMoltbookUrl(new URL('https://www.moltbook.com/agent/dynamo'))

    expect(resolved.kind).toBe('unaddressable')
    expect(resolved.kind === 'unaddressable' && resolved.reason).toContain('/post/')
  })
})

describe('the Moltbook adapter', () => {
  const moltbookPost = (over: Record<string, unknown> = {}): unknown => ({
    success: true,
    post: {
      id: MOLTBOOK_ID,
      title: 'A title',
      content: 'A body',
      author_id: AUTHOR_ID,
      author: { id: AUTHOR_ID, name: 'dynamo' },
      is_deleted: false,
      ...over,
    },
  })

  it('owns its own host, with and without www, and nothing else', () => {
    const adapter = moltbookAdapter()

    expect(adapter.owns(new URL(MOLTBOOK_URL))).toBe(true)
    expect(adapter.owns(new URL(`https://moltbook.com/post/${MOLTBOOK_ID}`))).toBe(true)
    expect(adapter.owns(new URL('https://bsky.app/profile/x/post/y'))).toBe(false)
  })

  /**
   * **The account is `author_id` and never `author.name`** — the rule every
   * adapter on the list is held to, and the one X was kept off the list for
   * failing until D-071 found it an endpoint that serves an id. The name is
   * carried as the handle, for evidence a human can read, and certifies nothing.
   */
  it('certifies the stable author id, and carries the mutable name as the handle', async () => {
    const { fetch, calls } = answering(200, moltbookPost())

    const result = await moltbookAdapter(fetch).read(new URL(MOLTBOOK_URL), MOLTBOOK_URL)

    expect(result).toMatchObject({
      outcome: 'found',
      post: { network: 'moltbook', account: AUTHOR_ID, handle: 'dynamo' },
    })
    expect(calls[0]).toContain(`/api/v1/posts/${MOLTBOOK_ID}`)
  })

  /**
   * Two text fields where both siblings have one. A citizen that put the nonce
   * in the title has done nothing wrong, and the newline is what lets
   * `hasMarkerLine` still see the id alone on a line.
   */
  it('reads the marker out of the title as readily as out of the content', async () => {
    const { fetch } = answering(200, moltbookPost({ title: 'kolonie', content: 'the-nonce' }))

    const result = await moltbookAdapter(fetch).read(new URL(MOLTBOOK_URL), MOLTBOOK_URL)

    expect(result.outcome === 'found' && result.post.body).toBe('kolonie\nthe-nonce')
  })

  /**
   * The rejection case the issue singled out: Moltbook answers 200 with a flag
   * rather than 404, so a reader checking only the status would carry on to an
   * empty body and fail the agent on the nonce instead of on the deletion.
   */
  it('reports a deleted post as not-found, and says it was deleted', async () => {
    const { fetch } = answering(200, moltbookPost({ is_deleted: true }))

    const result = await moltbookAdapter(fetch).read(new URL(MOLTBOOK_URL), MOLTBOOK_URL)

    expect(result.outcome).toBe('not-found')
    expect(result.outcome === 'not-found' && result.reason).toContain('deleted')
  })

  it('reports a 404 as not-found', async () => {
    const { fetch } = answering(404, { message: 'Post not found' })

    expect(await moltbookAdapter(fetch).read(new URL(MOLTBOOK_URL), MOLTBOOK_URL)).toMatchObject({
      outcome: 'not-found',
    })
  })

  /** An outage is never the submission's problem. */
  it('reports a 503 as unavailable rather than not-found', async () => {
    const { fetch } = answering(503, {})

    expect(await moltbookAdapter(fetch).read(new URL(MOLTBOOK_URL), MOLTBOOK_URL)).toMatchObject({
      outcome: 'unavailable',
    })
  })

  it('reports an unreachable host as unavailable', async () => {
    const result = await moltbookAdapter(throwing('EAI_AGAIN')).read(
      new URL(MOLTBOOK_URL),
      MOLTBOOK_URL,
    )

    expect(result.outcome).toBe('unavailable')
  })

  it('names the form it expected when the address is not a post', async () => {
    const url = 'https://www.moltbook.com/agent/dynamo'
    const { fetch, calls } = answering(200, moltbookPost())

    const result = await moltbookAdapter(fetch).read(new URL(url), url)

    expect(result.outcome).toBe('not-found')
    expect(result.outcome === 'not-found' && result.reason).toContain('/post/')
    // Refused before any request: a malformed address is not an outage.
    expect(calls).toEqual([])
  })

  it('reports a payload with no author as unavailable, not as a missing post', async () => {
    const { fetch } = answering(200, { success: true, post: { id: MOLTBOOK_ID } })

    expect(await moltbookAdapter(fetch).read(new URL(MOLTBOOK_URL), MOLTBOOK_URL)).toMatchObject({
      outcome: 'unavailable',
    })
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

describe('resolveXUrl', () => {
  it('reads the post id out of a status permalink', () => {
    expect(resolveXUrl(new URL(X_URL))).toEqual({ kind: 'post', postId: X_POST_ID })
  })

  /** `twitter.com/i/web/status/…` and the plural form are both in the wild. */
  it('accepts the /statuses/ spelling', () => {
    expect(resolveXUrl(new URL(`https://twitter.com/colette/statuses/${X_POST_ID}`))).toEqual({
      kind: 'post',
      postId: X_POST_ID,
    })
  })

  it('refuses an address that is not a post, and says what was expected', () => {
    const resolved = resolveXUrl(new URL('https://x.com/colette'))

    expect(resolved.kind).toBe('unaddressable')
    expect(resolved.kind === 'unaddressable' && resolved.reason).toContain('/status/')
  })

  /** A post id is digits. A path that looks right and is not addressable fails here. */
  it('refuses a non-numeric post id', () => {
    expect(resolveXUrl(new URL('https://x.com/colette/status/not-a-number')).kind).toBe(
      'unaddressable',
    )
  })
})

describe('the X adapter', () => {
  const xPost = (over: Record<string, unknown> = {}): unknown => ({
    __typename: 'Tweet',
    id_str: X_POST_ID,
    text: 'A post of my own',
    user: { id_str: X_ACCOUNT_ID, screen_name: 'colette', name: 'Colette' },
    ...over,
  })

  it('owns x.com and twitter.com, with and without www, and nothing else', () => {
    const adapter = xAdapter()

    expect(adapter.owns(new URL(X_URL))).toBe(true)
    expect(adapter.owns(new URL(`https://www.twitter.com/colette/status/${X_POST_ID}`))).toBe(true)
    expect(adapter.owns(new URL('https://bsky.app/profile/x/post/y'))).toBe(false)
  })

  /**
   * **The whole of `#275`.** D-066 refused X because the documented endpoint
   * serves a handle, and a handle moves. The account certified here is the
   * numeric id, and `screen_name` is display only — so a citizen that renames
   * keeps its skill and a handle acquired by somebody else certifies nothing.
   */
  it('certifies user.id_str and carries screen_name as the handle', async () => {
    const { fetch, calls } = answering(200, xPost())

    const result = await xAdapter(fetch).read(new URL(X_URL), X_URL)

    expect(result).toMatchObject({
      outcome: 'found',
      post: { network: 'x', account: X_ACCOUNT_ID, handle: 'colette' },
    })
    // The id addresses the read; nothing from the path reaches the request.
    expect(calls[0]).toContain(`id=${X_POST_ID}`)
    expect(calls[0]).not.toContain('colette')
  })

  /**
   * The submitted handle is not evidence of anything (D-018): a post linked
   * under one handle and served by an account with another certifies the
   * account the network named.
   */
  it('takes the account from the response and never from the submitted URL', async () => {
    const impostor = `https://x.com/somebody-else/status/${X_POST_ID}`
    const { fetch } = answering(200, xPost())

    const result = await xAdapter(fetch).read(new URL(impostor), impostor)

    expect(result).toMatchObject({ outcome: 'found', post: { account: X_ACCOUNT_ID } })
  })

  it('reports a post that is not there as not-found', async () => {
    const { fetch } = answering(404, '')

    expect(await xAdapter(fetch).read(new URL(X_URL), X_URL)).toMatchObject({
      outcome: 'not-found',
    })
  })

  /**
   * The endpoint is undocumented, so the shape changing is the realistic
   * failure — and it must cost a citizen nothing. `unavailable` becomes a
   * `pending` verdict, and the evidence has to name the Colony rather than
   * leave an agent looking for a mistake it did not make.
   */
  it('answers unavailable, naming itself, when the response carries no account id', async () => {
    const { fetch } = answering(200, { __typename: 'TweetTombstone', tombstone: {} })

    const result = await xAdapter(fetch).read(new URL(X_URL), X_URL)

    expect(result.outcome).toBe('unavailable')
    expect(result.outcome === 'unavailable' && result.reason).toContain('Colony')
    expect(result.outcome === 'unavailable' && result.reason).toContain('undocumented')
  })

  it('answers unavailable when X cannot be reached at all', async () => {
    const result = await xAdapter(throwing('ECONNRESET')).read(new URL(X_URL), X_URL)

    expect(result.outcome).toBe('unavailable')
  })
})
