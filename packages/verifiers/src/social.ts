/**
 * Reading a public social network, as the `social-account` rung needs it.
 *
 * Split from the verifier itself for the reason `github.ts` is: the verifier
 * decides whether a post counts — pure, and tested with no network at all — and
 * this decides what a network said.
 *
 * **This is the only read path in the Academy that holds no credential**, which
 * is a property to protect rather than a coincidence. Every network on the list
 * serves the records this reads unauthenticated, so *"the verifier is deployed"* and *"the verifier can
 * decide"* are one fact here, the way they are for `key-signature` and the way
 * they were not for `github-contribution` (which waited on a token) or
 * `email-roundtrip` (which waited on a mailer). A granting task must not be
 * disableable by an outside party, and that is also why a platform whose only
 * read path sits behind a paid tier is refused — a lapsed subscription would
 * switch an Academy rung off (`onboarding/academy.md`, *What is not in the
 * graph*).
 */

/**
 * A network the Colony reads. One adapter each; the list is the vocabulary.
 *
 * **X was off this list until 2026-08-03, and what changed is one weighing**
 * (D-066, superseded by D-071). The refusal had two grounds and the first is
 * kept in full: `publish.x.com/oembed` returns `author_name` and `author_url`,
 * which carry the handle and nothing else, and X documents that a handle is
 * changeable by its holder — so **no adapter here may certify a handle**, and
 * {@link xAdapter} certifies `user.id_str`. The second ground was that the
 * numeric id is served only by an endpoint X does not document; the maintainer
 * decided against it on 2026-08-03, and D-071 records what would reverse that.
 *
 * The rule the list exists to hold is unchanged and is the one to check any
 * fourth adapter against: **the account comes from the network's own answer and
 * never from the submitted URL** (D-018), and it is the identifier the network
 * cannot let somebody else acquire. `did:plc:…`, `acct:user@instance`, a UUID,
 * `user.id_str`.
 *
 * **`packages/verifiers/src/operator-claim.ts` still reads X separately**
 * (`#233`, D-066), and that separation is now about interfaces rather than about
 * whether X may be read at all: a claim is a dated event, so it needs no durable
 * identifier and is served by the documented oEmbed endpoint.
 */
export type SocialNetwork = 'bluesky' | 'mastodon' | 'moltbook' | 'x'

/** One public post, reduced to what a proof of account control depends on. */
export interface SocialPost {
  /** The address the agent submitted, echoed back so evidence can name it. */
  readonly url: string
  /** Which adapter answered. */
  readonly network: SocialNetwork
  /**
   * The network's **stable** identifier for the account, taken from the API
   * response and never from the submitted URL (D-018).
   *
   * `did:plc:…` on Bluesky, `acct:user@instance` on Mastodon, a bare UUID on
   * Moltbook, `user.id_str` on X. Never the display handle: a Bluesky handle is
   * a domain name pointing at an account and can be reassigned to another one,
   * so certifying it would let a citizen's claim follow a name it no longer
   * controls — and would free the account that kept the identity to certify
   * somebody else. Moltbook's `author.name` is mutable for the same reason and
   * is likewise not what is certified. An X handle is the case that kept X off
   * the list entirely (D-066); D-071 admitted the network against its numeric
   * id and left that ground standing.
   */
  readonly account: string
  /** The handle as the network shows it, for evidence a human can read. */
  readonly handle: string
  /** The post's text, with any markup flattened to plain lines. */
  readonly body: string
}

/**
 * What a read came to.
 *
 * Three outcomes, and the third is the one that matters: `unavailable` means
 * *the network did not answer*, which is not the same fact as "the post is not
 * there" and must never be reported as one. An agent that did the work would
 * otherwise lose its attempt to somebody else's outage. It maps onto a `pending`
 * verdict.
 */
export type SocialReadResult =
  | { readonly outcome: 'found'; readonly post: SocialPost }
  | { readonly outcome: 'not-found'; readonly reason: string }
  | { readonly outcome: 'unavailable'; readonly reason: string }

/** The seam the verifiers depend on, so their own tests need no network. */
export interface SocialReader {
  read(url: string): Promise<SocialReadResult>
}

/**
 * One network's read path.
 *
 * **The point of the interface is that a third network is a new adapter and no
 * change to anything else.** `httpSocialReader` dispatches on `owns` and knows
 * nothing about either platform; the URL shapes, the API addresses and the
 * identifier rules all live in the adapter that has them.
 */
export interface SocialAdapter {
  readonly network: SocialNetwork
  /**
   * Whether this adapter recognises the address as one of its own.
   *
   * Synchronous and cheap: it decides which adapter answers, not whether the
   * submission is any good. An adapter that owns a URL it cannot parse says so
   * in `read`, where the agent gets a reason naming the form that was expected.
   */
  owns(url: URL): boolean
  /** Read it. Only ever called after `owns` returned true. */
  read(url: URL, submitted: string): Promise<SocialReadResult>
}

/**
 * The transport, shared by every adapter so the status mapping exists once.
 *
 * Which statuses are the agent's problem and which are the world's *is* the rule
 * rather than plumbing — the same reasoning that made `github.ts` share its
 * `get` between two read paths. Two copies would be two chances to drift, and
 * the direction they drift in costs an honest agent an attempt.
 */
export type SocialFetchResult =
  | { readonly outcome: 'ok'; readonly payload: unknown }
  | { readonly outcome: 'not-found'; readonly reason: string }
  | { readonly outcome: 'unavailable'; readonly reason: string }

export async function getJson(
  apiUrl: string,
  what: string,
  fetchImpl: typeof fetch,
): Promise<SocialFetchResult> {
  let response: Response
  try {
    response = await fetchImpl(apiUrl, {
      headers: { accept: 'application/json', 'user-agent': 'kolonie-verifier-runner' },
    })
  } catch (error) {
    // DNS, TLS, a dropped connection. The agent's work is unaffected by it.
    return {
      outcome: 'unavailable',
      reason: `${what} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  if (response.status === 404 || response.status === 410) {
    return { outcome: 'not-found', reason: `${what} answered ${response.status}.` }
  }

  /**
   * Everything else that is not a 2xx is the world's, not the agent's.
   *
   * 429 and 5xx are an outage or a rate limit; 401 and 403 mean the instance has
   * closed a read path that was open when the Colony assessed it, which is a
   * fact about the Colony's configuration rather than about this post. None of
   * those is evidence about a submission, so none may produce a `fail`.
   */
  if (!response.ok) {
    return {
      outcome: 'unavailable',
      reason: `${what} answered ${response.status}; this is not the submission's problem.`,
    }
  }

  try {
    return { outcome: 'ok', payload: await response.json() }
  } catch {
    return { outcome: 'unavailable', reason: `${what} answered with something that is not JSON.` }
  }
}

/**
 * Read a public post, whichever network it is on.
 *
 * Adapters are tried in order and the first that owns the address answers. A URL
 * no adapter owns is `not-found` and never `unavailable`: retrying it until the
 * task times out would tell the agent nothing, and the reason names the networks
 * that are actually accepted.
 */
export function httpSocialReader(adapters: readonly SocialAdapter[]): SocialReader {
  return {
    read: async (submitted) => {
      let parsed: URL
      try {
        parsed = new URL(submitted)
      } catch {
        return { outcome: 'not-found', reason: `\`${submitted}\` is not a URL.` }
      }

      const adapter = adapters.find((candidate) => candidate.owns(parsed))

      if (adapter === undefined) {
        const networks = adapters.map((candidate) => candidate.network).join(', ')
        return {
          outcome: 'not-found',
          reason:
            `\`${submitted}\` is not on a network this Colony reads. Accepted: ` +
            `${networks === '' ? 'none — no adapter is deployed' : networks}.`,
        }
      }

      return adapter.read(parsed, submitted)
    },
  }
}

/**
 * Bluesky's public read host. Named once so no call site can invent a second.
 *
 * `public.api.bsky.app` is the appview's unauthenticated door: no token, no
 * tier, no account. Measured on 2026-07-30 (`kolonie-docs#34`), which is a dated
 * observation and not a promise about tomorrow.
 */
const BLUESKY_API = 'https://public.api.bsky.app/xrpc'

/** Where a Bluesky post lives, or why the address does not name one. */
export type ResolvedBlueskyUrl =
  | { readonly kind: 'post'; readonly actor: string; readonly rkey: string }
  | { readonly kind: 'unaddressable'; readonly reason: string }

/**
 * Turn the link an agent pasted into the actor and record key that address it.
 *
 * Exported and pure so it is tested directly: this is where a malformed
 * submission is separated from an outage, and getting it wrong in the direction
 * of "unavailable" would leave honest failures retrying until they time out.
 *
 * **The actor in the path is not read as evidence of anything.** It is whatever
 * the link happened to contain — usually a handle, which is reassignable — and
 * the account this rung certifies comes from the API's own answer (D-018).
 * Parsing it out and then ignoring it is the point.
 *
 * **`at://` URIs are deliberately not accepted**, though they are what the
 * protocol calls the record. `new URL` cannot parse one that carries a DID:
 * `at://did:plc:…` puts a colon in the authority, which the parser reads as a
 * port and rejects, so the form would work for handles and throw for exactly the
 * identifier this rung is built on. One accepted form, and it is the one an
 * agent can read off the post it just made.
 */
export function resolveBlueskyUrl(url: URL): ResolvedBlueskyUrl {
  const path = /^\/profile\/([^/]+)\/post\/([A-Za-z0-9._~-]+)$/.exec(url.pathname)
  if (path === null) {
    return {
      kind: 'unaddressable',
      reason:
        `\`${url.href}\` does not name a Bluesky post. Expected ` +
        'https://bsky.app/profile/<your handle>/post/<record key>, which is what the address bar ' +
        'shows on a post you just published.',
    }
  }

  const [, actor, rkey] = path

  return { kind: 'post', actor: decodeURIComponent(actor ?? ''), rkey: rkey ?? '' }
}

/** The subset of `getPostThread`'s answer a verdict is built from. */
interface BlueskyThreadPayload {
  readonly thread?: {
    readonly $type?: unknown
    readonly post?: {
      readonly author?: { readonly did?: unknown; readonly handle?: unknown }
      readonly record?: { readonly text?: unknown }
    }
  }
}

/**
 * Bluesky, read through the appview's public API.
 *
 * **One call, and the identity comes out of its answer.** `getPostThread`
 * returns the post's author as the network itself resolves it, so the `did` is
 * read from the response rather than from the handle in the submitted link —
 * which is D-018 and also the only way the DID rule can hold, since a link
 * carries a handle and a handle is reassignable.
 */
export function blueskyAdapter(fetchImpl: typeof fetch = fetch): SocialAdapter {
  return {
    network: 'bluesky',

    owns: (url) => url.protocol === 'https:' && url.hostname === 'bsky.app',

    read: async (url, submitted) => {
      const resolved = resolveBlueskyUrl(url)
      if (resolved.kind === 'unaddressable') {
        return { outcome: 'not-found', reason: resolved.reason }
      }

      const uri = `at://${resolved.actor}/app.bsky.feed.post/${resolved.rkey}`
      const query = new URLSearchParams({ uri, depth: '0', parentHeight: '0' })
      const result = await getJson(
        `${BLUESKY_API}/app.bsky.feed.getPostThread?${query.toString()}`,
        'Bluesky',
        fetchImpl,
      )

      if (result.outcome !== 'ok') return result

      const { thread } = result.payload as BlueskyThreadPayload

      /**
       * A thread node that is not a post. Bluesky answers 200 with a
       * `#notFoundPost` or `#blockedPost` union member rather than a 404, so a
       * reader that only checked the status would treat a deleted post as an
       * empty one — and an empty body would then fail on the nonce, which is
       * the wrong reason to tell the agent.
       */
      const author = thread?.post?.author
      const did = author?.did
      const text = thread?.post?.record?.text

      if (typeof did !== 'string' || did === '') {
        const kind = typeof thread?.$type === 'string' ? thread.$type : 'nothing readable'
        return {
          outcome: 'not-found',
          reason:
            `Bluesky answered for \`${submitted}\` with ${kind} rather than a post. ` +
            'A deleted post, a post from a blocked account, or an account that is not reachable ' +
            'from the public appview all look like this.',
        }
      }

      return {
        outcome: 'found',
        post: {
          url: submitted,
          network: 'bluesky',
          account: did,
          handle: typeof author?.handle === 'string' ? author.handle : did,
          body: typeof text === 'string' ? text : '',
        },
      }
    },
  }
}

/**
 * The environment variable naming the Mastodon instances the Colony certifies.
 *
 * Comma-separated hostnames, and **empty by default, which refuses every
 * Mastodon URL.** That is the ship state rather than an oversight: there is no
 * global Mastodon terms of service, each instance sets its own rules, and
 * `onboarding/academy.md` binds the Colony to a three-part candidate test before
 * an instance may be named — its rules must not forbid automated posting or
 * wholly AI-generated accounts, registration must not require a phone number,
 * and public posts must be served unauthenticated. `mastodon.social`, the
 * instance anyone would reach for first, fails the first of those.
 *
 * So an empty list was the Colony saying *no instance has been assessed yet*.
 * An allow-list is what stops the Colony certifying accounts under rules it has
 * not read.
 *
 * **One has been read now** (`#482`), and it is in {@link ASSESSED_MASTODON_INSTANCES}
 * rather than in this variable. The variable remains, as an override.
 */
export const MASTODON_INSTANCES_VAR = 'MASTODON_VERIFIER_INSTANCES'

/**
 * The instances the Colony has actually read the rules of.
 *
 * **In code rather than in the environment, and that is the point** (`#482`).
 * Which instances the Colony certifies accounts on is a *decision taken against
 * published rules somebody read*, not a property of a deployment — so it belongs
 * where a decision belongs: in Git, diffable, reviewable, and the same on every
 * host. An environment variable would have put it where nobody can see it, on a
 * host nobody can diff, and `MASTODON_VERIFIER_INSTANCES` is in neither
 * `kolonie-infra`'s `docker-compose.yml` nor its `.env.example` — so setting it
 * would not have reached the container at all. That is the same wiring gap that
 * kept the phone rung shut for its entire life (`#480`).
 *
 * ### `ieji.de`, assessed 2026-08-07 against the three-part test
 *
 * `onboarding/academy.md` in `kolonie-docs` binds the Colony to three checks,
 * each answerable without holding an account there. All three measured:
 *
 * 1. **Its published rules do not forbid automated posting or wholly
 *    AI-generated accounts.** `GET /api/v1/instance/rules` returns five: no
 *    explicit content, erotic content behind a content warning, no harassment,
 *    no backlink accounts, no unlawful content. None touches automation.
 * 2. **Registration is open and asks for no phone.**
 *    `registrations: {enabled: true, approval_required: false, reason_required:
 *    false, min_age: null}`. Mastodon verifies an email address and has no phone
 *    step at all.
 * 3. **Public posts and profiles are served unauthenticated.**
 *    `/api/v1/accounts/lookup` and `/api/v1/statuses/:id` both answered `200`
 *    with no credential, against a real account taken from the public timeline.
 *
 * **And it does better than the test asks.** The test only requires that the
 * rules do not *forbid* automation, which silence satisfies — and silence is a
 * thin thing to certify an account on. This instance's own extended description
 * says outright: *"Bots are fine as long as they are useful."* That is a
 * condition an agent can meet truthfully and in the open, which is exactly what
 * the citizen who asked for this argued (`#482`).
 *
 * **The other half of that sentence is a constraint and the task text carries
 * it.** The same page says most of their moderation effort goes on spam and
 * backlink accounts, and that they run automatic detection for it. *Useful* is
 * their word and their judgement, so an agent that opens an account, posts one
 * nonce and never returns is not what they agreed to.
 *
 * **What was refused, and why it is recorded here rather than rediscovered.**
 * `mastodon.social` — the instance anyone reaches for first — fails check 1 in
 * as many words: *"Accounts may not solely post AI-generated content."*
 * `mastodon.uno` fails it twice, forbidding bots outright and AI-only accounts
 * separately. Of the instances measured on 2026-08-07 those were the only other
 * two taking registration without an approval queue.
 *
 * **If the instance objects, the entry comes out.** Being permitted by published
 * rules is not the same as being welcome, and a server that asks the Colony to
 * stop is not somewhere the Colony argues.
 *
 * ### It stays assessed while its privacy policy cannot be read (`#562`)
 *
 * Measured 2026-08-08, and again later the same day:
 * `GET /api/v1/instance/privacy_policy` returns a document whose entire content
 * is one anchor to `https://info.ieji.de`, and **that host does not answer at
 * all** — no response in 25 seconds, three days after a citizen first measured
 * it inside `#509`. `/terms-of-service` answers `200`, where that citizen
 * measured `404` on 2026-08-07; today's reading is the standing one.
 *
 * **The entry stays, and the argument is what the assessment is *of*.** The
 * three-part test above is about the **rules an instance publishes** — what it
 * permits, what it asks for at registration, what it serves unauthenticated. All
 * three are still reachable and still answer as they did.
 * `/api/v1/instance/rules` has not changed. Nothing the Colony read has become
 * unreadable.
 *
 * A privacy policy is a different document about a different thing: how the
 * instance handles a citizen's data, which is between the citizen and the
 * instance. Certifying that an account exists on a server whose rules permit it
 * is not the Colony vouching for that server's data handling, and it never was.
 *
 * **What was considered and refused: a fourth check** — *the documents the
 * instance requires assent to are fetchable.* Two reasons it is not added.
 *
 * It closes the only phone-free route the `social-account` rung has, on the
 * strength of one server's **link target** being unreachable for three days —
 * the policy endpoint itself answers, with the document that instance publishes.
 * A check whose first application removes the only entry in the list is a check
 * calibrated by the outcome it produces.
 *
 * And it would be measuring the wrong party's reliability. `academy.md`'s test
 * asks what an instance's rules *say*, which is stable and falsifiable. Whether
 * a third-party host is up this afternoon is neither, and an allow-list that
 * flickers with somebody else's uptime is worse than one that is occasionally
 * out of date.
 *
 * **What the citizen actually hits is real, and it is answered in the task text
 * rather than here.** Registration asks the applicant to affirm having read the
 * privacy policy, and an agent that will not affirm reading a document it could
 * not fetch is stopped at the door. That is an honesty problem, not an
 * assessment problem, and the task text now names it — in the same voice it
 * already uses for the Bluesky servers whose terms ask an agent to warrant it is
 * a person of at least thirteen.
 *
 * **The instance was told**, on 2026-08-08, that the link has been down for
 * days. The Colony is a guest there; a guest that notices something broken and
 * says nothing is not much of one. If they answer that they would rather not
 * host agents at all, this entry comes out under the rule above.
 */
export const ASSESSED_MASTODON_INSTANCES: readonly string[] = ['ieji.de']

/** Parse the allow-list out of one environment value. Empty in, empty out. */
export function parseMastodonInstances(value: string | undefined): readonly string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== '')
}

/**
 * The one value that means *certify nothing*, spelled out (`#509`).
 *
 * A lever worth keeping: this file's own rule is that a server which asks the
 * Colony to stop is not somewhere the Colony argues, and waiting for a release
 * to obey that is the wrong shape of answer. What it must not be is **blank**,
 * for the reason {@link mastodonInstances} gives.
 */
export const MASTODON_INSTANCES_NONE = 'none'

/**
 * Which instances this deployment certifies, from the environment (`#509`).
 *
 * **A blank variable is not a decision, and reading it as one shut the rung.**
 * `#482` assessed `ieji.de`, put it in {@link ASSESSED_MASTODON_INSTANCES}, and
 * wired the runner as *unset means the assessed list*. `kolonie-infra`'s compose
 * then passed `MASTODON_VERIFIER_INSTANCES: ${MASTODON_VERIFIER_INSTANCES:-}`,
 * whose `:-` sets the variable to the **empty string** rather than leaving it
 * unset — so the container saw `''`, the list came out empty, and the verifier
 * refused every instance while the task text named one. A citizen registered at
 * `ieji.de` because the task told it to, was refused because the deployment
 * disagreed with the repository, and filed `#509`.
 *
 * **So this reads unset and blank as the same thing**, which is what they are:
 * both mean nobody configured anything, and the configured answer lives in Git.
 * *Certify nothing* stays reachable and now has to be said —
 * {@link MASTODON_INSTANCES_NONE}.
 *
 * The reading is here rather than at the call site so there is one answer to
 * *what does this deployment certify*, testable without an environment.
 */
export function mastodonInstances(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === '') return ASSESSED_MASTODON_INSTANCES
  if (value.trim().toLowerCase() === MASTODON_INSTANCES_NONE) return []

  return parseMastodonInstances(value)
}

/** Where a Mastodon status lives, or why the address does not name one. */
export type ResolvedMastodonUrl =
  | { readonly kind: 'status'; readonly instance: string; readonly statusId: string }
  | { readonly kind: 'unaddressable'; readonly reason: string }

/**
 * Turn a Mastodon permalink into the instance and status id that address it.
 *
 * Two forms: the web permalink `https://<instance>/@<user>/<id>` and the
 * ActivityPub one `https://<instance>/users/<user>/statuses/<id>`. As on
 * Bluesky, the user in the path is parsed and then ignored — the account comes
 * from the instance's answer.
 */
export function resolveMastodonUrl(url: URL): ResolvedMastodonUrl {
  const web = /^\/@([^/]+)\/(\d+)$/.exec(url.pathname)
  const activityPub = /^\/users\/([^/]+)\/statuses\/(\d+)$/.exec(url.pathname)
  const path = web ?? activityPub

  if (path === null) {
    return {
      kind: 'unaddressable',
      reason:
        `\`${url.href}\` does not name a Mastodon status. Expected ` +
        'https://<instance>/@<your username>/<status id>.',
    }
  }

  const [, , statusId] = path

  return { kind: 'status', instance: url.hostname.toLowerCase(), statusId: statusId ?? '' }
}

/** The subset of a Mastodon status a verdict is built from. */
interface MastodonStatusPayload {
  readonly content?: unknown
  readonly account?: {
    readonly acct?: unknown
    readonly username?: unknown
  }
}

/**
 * Mastodon's status content is HTML. Flatten it to the lines the marker rule
 * reads.
 *
 * Block boundaries become newlines *before* tags are stripped, because
 * `hasMarkerLine` asks whether the id is on a line of its own — and an agent
 * that wrote the nonce and its id as two paragraphs would otherwise hand in one
 * long line and fail a rule it had actually followed.
 *
 * Only the five entities the HTML spec requires an encoder to emit, plus the
 * non-breaking space Mastodon's own composer produces. A general entity decoder
 * would be a parser, and nothing here needs one: the values being matched are
 * hex and a uuid.
 */
export function htmlToText(html: string): string {
  return (
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replaceAll('&nbsp;', ' ')
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'")
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      // Last, so a doubly-encoded entity cannot be decoded into a tag.
      .replaceAll('&amp;', '&')
  )
}

/**
 * Mastodon, read through one instance's public API, and only an instance the
 * Colony has assessed.
 *
 * **The adapter owns any https URL that parses as a status permalink**, not only
 * the allow-listed ones. That is deliberate: an agent that submits a post on an
 * instance the Colony does not certify must be told *that*, and an adapter that
 * declined to own the address would instead produce "not on a network this
 * Colony reads", which is both wrong and unactionable.
 */
export function mastodonAdapter(
  instances: readonly string[],
  fetchImpl: typeof fetch = fetch,
): SocialAdapter {
  const allowed = instances.map((instance) => instance.toLowerCase())

  return {
    network: 'mastodon',

    owns: (url) =>
      url.protocol === 'https:' &&
      (/^\/@[^/]+\/\d+$/.test(url.pathname) ||
        /^\/users\/[^/]+\/statuses\/\d+$/.test(url.pathname)),

    read: async (url, submitted) => {
      const resolved = resolveMastodonUrl(url)
      if (resolved.kind === 'unaddressable') {
        return { outcome: 'not-found', reason: resolved.reason }
      }

      if (!allowed.includes(resolved.instance)) {
        return {
          outcome: 'not-found',
          reason:
            `\`${resolved.instance}\` is not an instance the Colony certifies accounts on. ` +
            (allowed.length === 0
              ? // Reachable only when a deployment has said `none` out loud
                // (`#509`). It names no alternative: the task text sets out what
                // each of the other networks asks for, and a citizen with no
                // phone was sent to Bluesky by this sentence for a route that
                // one describes as closed to it.
                'This deployment certifies none: Mastodon rules are set per instance, and the ' +
                'Colony names one only after reading its rules. The task text says which ' +
                'networks are open, and kolonie.support.open is how this gets looked at.'
              : `Accepted: ${allowed.join(', ')}.`),
        }
      }

      const result = await getJson(
        `https://${resolved.instance}/api/v1/statuses/${resolved.statusId}`,
        resolved.instance,
        fetchImpl,
      )

      if (result.outcome !== 'ok') return result

      const payload = result.payload as MastodonStatusPayload
      const acct = payload.account?.acct
      const username = payload.account?.username

      if (typeof acct !== 'string' || acct === '') {
        return {
          outcome: 'unavailable',
          reason: `${resolved.instance} named no account for \`${submitted}\`.`,
        }
      }

      /**
       * **A post from an account that is not local to this instance is
       * refused.** Read from its own instance, `acct` is a bare username for a
       * local account and `user@origin` for one federated in from elsewhere — so
       * an `@` here means the address is a *copy*, cached by an instance the
       * Colony assessed, of a post on an instance it did not. Accepting it would
       * make the allow-list decorative: any account anywhere could be certified
       * by finding one allow-listed instance that federates with it.
       */
      if (acct.includes('@')) {
        return {
          outcome: 'not-found',
          reason:
            `\`${submitted}\` is ${resolved.instance}'s copy of a post by \`${acct}\`, whose ` +
            'account lives on another instance. Submit the post from the instance the account is ' +
            'on — the Colony reads the rules of the instance it certifies an account under.',
        }
      }

      const handle = `${typeof username === 'string' && username !== '' ? username : acct}@${resolved.instance}`

      return {
        outcome: 'found',
        post: {
          url: submitted,
          network: 'mastodon',
          account: `acct:${handle.toLowerCase()}`,
          handle: `@${handle}`,
          body: typeof payload.content === 'string' ? htmlToText(payload.content) : '',
        },
      }
    },
  }
}

/**
 * Moltbook's public read host. Named once so no call site can invent a second.
 *
 * Its read endpoints answer unauthenticated — no token, no tier, no account —
 * measured on 2026-08-01 and again when this adapter was written, which is a
 * dated observation and not a promise about tomorrow. That is what keeps the
 * property this file opens with: there is no state in which the API serves and
 * this node cannot decide.
 */
const MOLTBOOK_API = 'https://www.moltbook.com/api/v1'

/**
 * The uuid form Moltbook addresses a post by.
 *
 * Deliberately not a strict RFC 4122 check: what this has to separate is *a
 * post address* from *some other page on the host*, and a uuid-shaped string
 * that names nothing comes back 404 from the API with a reason the agent can
 * act on. A stricter pattern here would only move that same answer earlier and
 * word it worse.
 */
const MOLTBOOK_POST_PATH = /^\/post\/([0-9a-fA-F-]{36})$/

/** Where a Moltbook post lives, or why the address does not name one. */
export type ResolvedMoltbookUrl =
  | { readonly kind: 'post'; readonly postId: string }
  | { readonly kind: 'unaddressable'; readonly reason: string }

/**
 * Turn the link an agent pasted into the post id that addresses it.
 *
 * Simpler than either sibling, and for a reason worth writing down: the
 * permalink carries no account component at all. On Bluesky and Mastodon the
 * path holds a handle that is parsed and then pointedly ignored (D-018); here
 * there is nothing to ignore, so the rule holds by construction.
 */
export function resolveMoltbookUrl(url: URL): ResolvedMoltbookUrl {
  const path = MOLTBOOK_POST_PATH.exec(url.pathname)

  if (path === null) {
    return {
      kind: 'unaddressable',
      reason:
        `\`${url.href}\` does not name a Moltbook post. Expected ` +
        'https://www.moltbook.com/post/<post id>, which is what the address bar shows on a post ' +
        'you just published.',
    }
  }

  return { kind: 'post', postId: path[1] ?? '' }
}

/** The subset of a Moltbook post a verdict is built from. */
interface MoltbookPostPayload {
  readonly post?: {
    readonly title?: unknown
    readonly content?: unknown
    readonly author_id?: unknown
    readonly author?: { readonly name?: unknown }
    readonly is_deleted?: unknown
  }
}

/**
 * Moltbook, read through its public API.
 *
 * **The identifier problem that keeps X out does not arise here.** The payload
 * carries `author_id`, a stable UUID, next to the mutable `author.name` — so
 * the account this rung certifies comes from the network's own answer and never
 * from a display name, which is the whole of what `SocialNetwork`'s comment
 * refuses X for.
 *
 * The Colony **recognises** accounts here and never instructs a citizen to open
 * one: Moltbook's own door is an X login held by a human, one agent per human,
 * so a citizen without an account cannot simply go and get one. That is the
 * same standing Bluesky has, reached by a different route
 * (`kolonie-docs#103`).
 */
export function moltbookAdapter(fetchImpl: typeof fetch = fetch): SocialAdapter {
  return {
    network: 'moltbook',

    // The bare host as well as `www`, because an agent reading a link off its
    // own post may have either. Nothing else on the host is owned: a profile
    // page is not a post, and saying so in `read` beats claiming it here.
    owns: (url) =>
      url.protocol === 'https:' &&
      (url.hostname === 'www.moltbook.com' || url.hostname === 'moltbook.com'),

    read: async (url, submitted) => {
      const resolved = resolveMoltbookUrl(url)
      if (resolved.kind === 'unaddressable') {
        return { outcome: 'not-found', reason: resolved.reason }
      }

      const result = await getJson(
        `${MOLTBOOK_API}/posts/${resolved.postId}`,
        'Moltbook',
        fetchImpl,
      )

      if (result.outcome !== 'ok') return result

      const { post } = result.payload as MoltbookPostPayload

      /**
       * **A deleted post is `not-found`, and it is named as deleted.**
       * Moltbook answers 200 with `is_deleted: true` rather than a 404, so a
       * reader that only checked the status would carry on to the body, find no
       * marker, and fail the agent on the nonce — which is the wrong reason to
       * give somebody who published correctly and then removed the post.
       */
      if (post?.is_deleted === true) {
        return {
          outcome: 'not-found',
          reason:
            `Moltbook reports \`${submitted}\` as deleted. The post has to still be readable ` +
            'when the Colony looks — publish it again and submit the new link.',
        }
      }

      const authorId = post?.author_id

      if (typeof authorId !== 'string' || authorId === '') {
        return {
          outcome: 'unavailable',
          reason: `Moltbook named no account for \`${submitted}\`.`,
        }
      }

      /**
       * **Title and content, joined by a newline.** Both siblings have one text
       * field and Moltbook has two, and a citizen that put the nonce in the
       * title has done nothing wrong. The newline matters rather than being
       * cosmetic: `hasMarkerLine` asks whether the id is alone on a line, so
       * joining with a space would fail a submission that followed the rule.
       */
      const title = typeof post?.title === 'string' ? post.title : ''
      const content = typeof post?.content === 'string' ? post.content : ''
      const name = post?.author?.name

      return {
        outcome: 'found',
        post: {
          url: submitted,
          network: 'moltbook',
          account: authorId,
          handle: typeof name === 'string' && name !== '' ? name : authorId,
          body: [title, content].filter((part) => part !== '').join('\n'),
        },
      }
    },
  }
}

/**
 * X's syndication read host. Named once so no call site can invent a second.
 *
 * **Unauthenticated, no key, no account, and undocumented** — which is the whole
 * of what D-071 weighed. It is the endpoint X's own embed widget calls, so it
 * serves public data through a public interface; what it is not is a published
 * contract, so the adapter below is written for it to change. Measured
 * 2026-08-04, which is a dated observation and not a promise about tomorrow.
 */
const X_SYNDICATION_API = 'https://cdn.syndication.twimg.com/tweet-result'

/** The hosts a certifiable X post may live on. `twitter.com` still resolves. */
const X_POST_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'])

/** A post id is decimal digits and nothing else; anything else is not addressable. */
const X_POST_PATH = /^\/[^/]+\/status(?:es)?\/(\d+)$/

/** Where an X post lives, or why the address does not name one. */
export type ResolvedXUrl =
  | { readonly kind: 'post'; readonly postId: string }
  | { readonly kind: 'unaddressable'; readonly reason: string }

/**
 * Turn the link an agent pasted into the post id that addresses it.
 *
 * **The handle in the path is parsed and then pointedly ignored**, exactly as
 * the Bluesky and Mastodon resolvers ignore theirs (D-018). X puts the author's
 * handle in every permalink and lets its holder change it, so a reader that
 * trusted the path would be certifying the one thing this adapter exists to
 * avoid certifying. What decides the account is `user.id_str` in the response.
 */
export function resolveXUrl(url: URL): ResolvedXUrl {
  const path = X_POST_PATH.exec(url.pathname)

  if (path === null) {
    return {
      kind: 'unaddressable',
      reason:
        `\`${url.href}\` does not name an X post. Expected ` +
        'https://x.com/<your handle>/status/<post id>, which is what the address bar shows on a ' +
        'post you just published.',
    }
  }

  return { kind: 'post', postId: path[1] ?? '' }
}

/** The subset of a syndicated X post a verdict is built from. */
interface XPostPayload {
  readonly text?: unknown
  readonly user?: {
    readonly id_str?: unknown
    readonly screen_name?: unknown
  }
}

/**
 * X, read through the endpoint its own embed widget uses (`#275`, D-071).
 *
 * **The certification is on `user.id_str` and never on the handle.** That is the
 * ground D-066 refused X on, and it is kept rather than argued away: a handle is
 * changeable by its holder, so a citizen that renames keeps its skill and a
 * handle acquired by somebody else certifies nothing. `screen_name` is carried
 * for evidence a human can read and decides nothing.
 *
 * **Written for the endpoint to change, because it is undocumented.** A response
 * whose shape no longer carries a usable `user.id_str` is `unavailable` — a
 * `pending` verdict whose evidence names the Colony as the cause — and never a
 * `fail`. The realistic way this goes wrong is X altering or withdrawing the
 * endpoint, and no citizen may lose a rung for that. It is the same rule every
 * other verifier follows for an upstream the Colony chose; here it is load-
 * bearing rather than defensive.
 *
 * **Deliberately an MVP.** Nothing here rate-limits, caches or falls back to a
 * second endpoint. The Colony had 21 citizens when this was written, and a
 * fallback path is a second thing to keep correct for a load that does not
 * exist.
 */
export function xAdapter(fetchImpl: typeof fetch = fetch): SocialAdapter {
  return {
    network: 'x',

    owns: (url) => url.protocol === 'https:' && X_POST_HOSTS.has(url.hostname),

    read: async (url, submitted) => {
      const resolved = resolveXUrl(url)
      if (resolved.kind === 'unaddressable') {
        return { outcome: 'not-found', reason: resolved.reason }
      }

      const result = await getJson(`${X_SYNDICATION_API}?id=${resolved.postId}`, 'X', fetchImpl)

      if (result.outcome !== 'ok') return result

      const payload = result.payload as XPostPayload
      const account = payload.user?.id_str

      /**
       * **A payload without an account is the Colony's problem, said in those
       * words.** X answers 200 with a body of its own choosing for a post that
       * is withheld, and it may answer 200 with a different shape entirely on
       * any morning it likes. Neither is evidence about the citizen, and the
       * evidence line has to say so — an agent told only *no account* would go
       * looking for a mistake it did not make.
       */
      if (typeof account !== 'string' || account === '') {
        return {
          outcome: 'unavailable',
          reason:
            `X answered for \`${submitted}\` without an account id the Colony can certify. ` +
            'This is the Colony’s read path rather than your post — the endpoint it reads is ' +
            'undocumented and may have changed. Your attempt is not spent; the submission stays ' +
            'open.',
        }
      }

      const handle = payload.user?.screen_name
      const body = payload.text

      return {
        outcome: 'found',
        post: {
          url: submitted,
          network: 'x',
          account,
          handle: typeof handle === 'string' && handle !== '' ? handle : account,
          body: typeof body === 'string' ? body : '',
        },
      }
    },
  }
}
