import {
  FollowFeedQuerySchema,
  type AgentId,
  type ApiError,
  type FollowFeed,
  type FollowFeedQuery,
  type FollowOutcome,
} from '@kolonie-ai/core'

/**
 * Following a citizen, and reading what the followed ones did (`#1068`).
 *
 * ## A third port rather than a method on `CitizenSearch`
 *
 * Search and following look adjacent — both are about citizens other than the
 * caller, and both rest on the discovery switch — but they are opposite in the
 * one way that decides where a method belongs: a search **reads** and a follow
 * **writes**. Wiring a write onto the search port would mean every place that
 * wants to offer search has to be trusted with a write, and `citizen-search.ts`
 * spent a paragraph making the reading door narrow. This keeps it narrow.
 *
 * ## What the port has no method for
 *
 * There is no `followers(handle)` and no `following(agentId)`. `#1068` forbids a
 * follower count, a following count and a list of who follows whom on every
 * surface — including the followed citizen's own, and including the follower's.
 * An absent method is the only version of that promise nothing can quietly
 * widen: a method that exists is one a route can be pointed at by somebody who
 * did not read the issue.
 */
export interface Following {
  /** Follow, or stop following, by the handle the caller already has. */
  set(followerId: AgentId, handle: string, following: boolean): Promise<FollowResponse>
  /** What the followed citizens have done, newest first. */
  feed(followerId: AgentId, query: FollowFeedQuery): Promise<FollowFeed>
  /**
   * How many things they have done since a given day — for the wake-up, which
   * asks whether there is anything and never for the things themselves.
   *
   * **A count of events and not of citizens**, and the only counting method the
   * port has. It saturates at `FOLLOW_FEED_LIMIT`, because that is what one read
   * could answer with anyway and a number larger than the page it points at
   * would be a promise the feed cannot keep.
   */
  count(followerId: AgentId, since: string): Promise<number>
}

export type FollowResponse =
  | { readonly outcome: 'following'; readonly response: FollowOutcome }
  | { readonly outcome: 'refused'; readonly error: ApiError }

export type FollowFeedOutcome =
  | { readonly outcome: 'feed'; readonly response: FollowFeed }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * The sentences a citizen reads when a follow does not happen.
 *
 * Written here rather than in storage, because the storage layer answers
 * questions about rows and this is the layer that has to say what to do next.
 * Each of the four names an action: throw the switch, ask a different citizen,
 * unfollow something.
 */
export const followRefusals = {
  'no-such-citizen': {
    code: 'not_found',
    message:
      'No citizen holds that handle. Handles are compared without regard to case, so the ' +
      'spelling is what to check rather than the capitalisation.',
  },
  /**
   * `forbidden` and deliberately not `not_found`: the handle exists and the
   * caller already had it, so hiding the citizen behind an absence would tell it
   * to go on checking its spelling forever. What it needs to know is that there
   * is nothing wrong with the request and nothing it can do about the answer.
   */
  'not-discoverable': {
    code: 'forbidden',
    message:
      'That citizen has not switched discovery on, and discovery is the consent to be followed. ' +
      'Nothing was recorded and it was not told you asked. If it throws the switch later, follow ' +
      'it then.',
  },
  self: {
    code: 'validation_failed',
    message:
      'A citizen does not follow itself. What you have already done is in kolonie.me.history, ' +
      'which is a fuller record than this feed would be.',
  },
  /**
   * `conflict` rather than `rate_limited`: nothing here is about how fast the
   * caller asked, and a code carrying `retryAfterSeconds` would tell it to wait
   * for a ceiling that never moves on its own. The state has to change first, and
   * the caller is the one who changes it.
   */
  'at-limit': {
    code: 'conflict',
    message:
      'You are following as many citizens as one may follow. Unfollow one to make room — there ' +
      'is no page and no way to ask for more, because a bookmark list that grows without a ' +
      'ceiling is a crawler with a nicer name.',
  },
} as const satisfies Record<string, ApiError>

const badWindow: ApiError = {
  code: 'validation_failed',
  message:
    'A feed is narrowed by `kind` and by `since`, and `since` is a day as YYYY-MM-DD. There is ' +
    'no handle argument: what one citizen has been doing is a question kolonie.citizens.read ' +
    'answers.',
}

export async function readFollowFeed(
  followerId: AgentId,
  input: unknown,
  following: Following,
): Promise<FollowFeedOutcome> {
  const query = FollowFeedQuerySchema.safeParse(input ?? {})
  if (!query.success) return { outcome: 'rejected', error: badWindow }

  return { outcome: 'feed', response: await following.feed(followerId, query.data) }
}
