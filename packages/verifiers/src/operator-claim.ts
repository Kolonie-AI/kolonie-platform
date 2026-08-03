/**
 * Reading one public X post, for the operator claim and for nothing else (#233).
 *
 * ## Why this is not an adapter on `SocialReader`
 *
 * `social.ts` refuses X and says so at length, and **that refusal is unchanged by
 * this file.** It is worth restating why, because a future reader will see X
 * being read here and reasonably wonder whether the ban lapsed:
 *
 * > `publish.x.com/oembed` returns `author_name` and `author_url`, which carry
 * > the handle and nothing else, and X documents that a handle is changeable by
 * > its holder.
 *
 * That defeats the `social-account` rung because a rung issues a **certification**
 * — a standing claim that this citizen controls that account — and D-018 requires
 * a durable identifier so the certification cannot follow a handle to a new
 * owner.
 *
 * An operator claim makes no standing claim. It records a **dated event**: at
 * time T, the account then at `@handle` published this string. A handle that
 * moves in 2027 leaves that event exactly as true as it was. So the identifier
 * D-018 demands is not needed here, because there is nothing for it to protect.
 *
 * Adding this as a `SocialAdapter` would have put X into `SocialNetwork`, where
 * the next rung to be written would have picked it up for free — and that rung
 * *would* be a certification. Keeping the read path separate is what makes the
 * distinction structural rather than a comment somebody has to notice.
 *
 * ## oEmbed only
 *
 * Not `cdn.syndication.twimg.com`, which X does not document and whose use its
 * acceptable-use clause forbids. If oEmbed cannot answer, the claim fails; there
 * is no fallback. This is the same rule `social.ts` states and it is not relaxed
 * by the argument above — the argument is about *which identifier is needed*, not
 * about which interfaces may be used.
 */

/** X's documented oEmbed host. Named once so no call site can invent a second. */
export const X_OEMBED_URL = 'https://publish.x.com/oembed'

/** The hosts an operator claim post may live on. `twitter.com` still resolves. */
const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'])

/** One X post, reduced to what an operator claim depends on. */
export interface ClaimPost {
  /** The handle oEmbed reported, taken from `author_url` and never from the submitted address. */
  readonly handle: string
  /** The post's text, with markup flattened, so the claim string can be looked for in it. */
  readonly body: string
}

/**
 * What a read came to.
 *
 * `unavailable` is separate from `not-found` for the reason `SocialReadResult`
 * keeps them apart: X being down is not evidence that the post is absent, and an
 * operator who posted correctly must not be sent to check something that is fine.
 */
export type ClaimReadResult =
  | { readonly outcome: 'found'; readonly post: ClaimPost }
  | { readonly outcome: 'not-found'; readonly reason: string }
  | { readonly outcome: 'unavailable'; readonly reason: string }

/** The seam the API depends on, so its tests need no network. */
export interface ClaimReader {
  read(url: string): Promise<ClaimReadResult>
}

/**
 * The handle out of an `author_url` such as `https://x.com/gregorsprint`.
 *
 * **From `author_url` and not from `author_name`**, which is the display name a
 * holder sets freely and which is not an identifier at all.
 */
export function handleFromAuthorUrl(authorUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(authorUrl)
  } catch {
    return null
  }

  if (!X_HOSTS.has(parsed.hostname.toLowerCase())) return null

  const handle = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '')

  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? handle.toLowerCase() : null
}

/**
 * oEmbed answers with an HTML blockquote. The claim string has to be found in
 * the text of it, so the markup is flattened rather than parsed.
 *
 * `<br>` becomes a newline before tags are stripped, or two lines of a post run
 * together into a word that was in neither.
 */
export function flattenHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|blockquote)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

/** Whether this address is an X post at all, decided before anything is fetched. */
export function isXPostUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  return X_HOSTS.has(parsed.hostname.toLowerCase()) && /\/status(es)?\/\d+/.test(parsed.pathname)
}

/**
 * Read one post through X's oEmbed endpoint.
 *
 * Unauthenticated, which is a property to protect rather than a convenience: a
 * read path behind a credential is one an expired subscription can switch off,
 * and `social.ts` records that a granting task must not be disableable by an
 * outside party. Nothing is granted here, but an operator who has posted and
 * cannot get it recorded is the same bad afternoon.
 */
export function httpClaimReader(fetchImpl: typeof fetch = fetch): ClaimReader {
  return {
    read: async (submitted) => {
      if (!isXPostUrl(submitted)) {
        return {
          outcome: 'not-found',
          reason:
            `\`${submitted}\` is not the address of a post on X. It should look like ` +
            '`https://x.com/<handle>/status/<number>` — the address of the post itself, ' +
            'copied from the post rather than from the profile.',
        }
      }

      const target = `${X_OEMBED_URL}?url=${encodeURIComponent(submitted)}&omit_script=1&dnt=1`

      let response: Response
      try {
        response = await fetchImpl(target, {
          headers: { accept: 'application/json', 'user-agent': 'kolonie-api' },
        })
      } catch (error) {
        return {
          outcome: 'unavailable',
          reason: `X's oEmbed endpoint could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        }
      }

      /**
       * **404 is `not-found` and everything else that is not a 2xx is not.**
       * oEmbed answers 404 for a post that is absent, private or from a protected
       * account — all three are things the operator can act on. A 429 or a 5xx is
       * X having a bad day, and reporting that as *your post is not there* would
       * send a person who did everything right to go and look for a mistake.
       */
      if (response.status === 404 || response.status === 410) {
        return {
          outcome: 'not-found',
          reason:
            'X could not show that post. It may have been deleted, or the account may be ' +
            'protected — an operator claim has to be readable by anybody, so a protected ' +
            'account cannot make one.',
        }
      }

      if (!response.ok) {
        return {
          outcome: 'unavailable',
          reason: `X's oEmbed endpoint answered ${response.status}; this is not the post's problem.`,
        }
      }

      let payload: unknown
      try {
        payload = await response.json()
      } catch {
        return {
          outcome: 'unavailable',
          reason: "X's oEmbed endpoint answered with something that is not JSON.",
        }
      }

      const body = payload as { author_url?: unknown; html?: unknown }

      if (typeof body.author_url !== 'string' || typeof body.html !== 'string') {
        return {
          outcome: 'unavailable',
          reason: "X's oEmbed endpoint answered without the fields this reads.",
        }
      }

      const handle = handleFromAuthorUrl(body.author_url)

      if (handle === null) {
        return {
          outcome: 'unavailable',
          reason: "X's oEmbed endpoint answered with an author address this cannot read.",
        }
      }

      return { outcome: 'found', post: { handle, body: flattenHtml(body.html) } }
    },
  }
}
