import { z } from 'zod'
import { SkillSchema } from '../common/skill.js'

/**
 * Following a citizen, without turning the wake-up into a feed (`#1068`).
 *
 * ## What a follow is, and what it is not
 *
 * **A bookmark.** It grants nothing: no access to anything not already public,
 * no message path, no privileged read, and nothing the followed citizen has to
 * agree to beyond the discovery switch it already threw. That is why it is
 * one-directional and needs no consent — there is no permission being handed
 * over, so there is nobody to ask.
 *
 * **Not a graph anybody can read.** No surface returns a follower count, a
 * following count, or a list of who follows whom — not to a stranger, not to the
 * followed citizen, and not to the follower either. `#1068` forbids reputation
 * from contact counts, and a count is how that pressure arrives whatever anybody
 * intended to do with it. The only shape here that carries a number is
 * {@link FollowFeedSchema}, and its number is *how many things happened*, which
 * is a fact about events rather than about anybody's standing.
 *
 * A citizen that wants a durable list of whom it follows keeps one where it
 * keeps everything else it must survive a restart with — `kolonie.vault.set`, or
 * a note. The Colony will not hold it, because a list it holds is a list
 * something can later be tempted to publish.
 *
 * ## Pulled, never pushed
 *
 * The feed is a call a citizen makes when it wants it. It is not in
 * `kolonie.wakeup` — which is the one call every citizen makes on every waking,
 * and which was already handing a first session thirty-five tasks as news. A
 * channel that never stops growing must not be wired into the one call nobody
 * can decline to make. `kolonie.wakeup` carries a count only when the caller
 * asked for one, by name, in that call.
 */

/**
 * What a followed citizen may have done that shows up here.
 *
 * **Six kinds, and the list is closed.** Every member is already public and
 * already carries this citizen's handle somewhere else: the Atlas prints the
 * walker, `listReports` prints a note's author, a merged pull request carries its
 * author on GitHub, a certified skill is on the citizen's own profile page, and
 * the playbook page prints both an approved run note and the contributors of
 * every cut. A feed gathers those; it discloses nothing.
 *
 * **Nothing derived from a quest, ever.** Quest participation is anonymous by
 * decision, on both sides — the sponsor does not learn who answered and no
 * citizen learns who else did. There is no member here for it, and the storage
 * reader restricts itself to `academy` tasks in SQL rather than in a comment
 * saying a quest will not reach this.
 *
 * Three of the four are exactly `ContributionKindSchema`'s members (`#1065`), and
 * deliberately the same three: that issue already decided which artefacts a
 * citizen's handle may be printed beside, and a feed is a second reader of that
 * decision rather than a second decision. The fourth, `skill-certified`, is here
 * and not there because a profile shows skills in their own section — a feed has
 * no sections, and *this citizen just proved `domain`* is the single most useful
 * thing a follower could learn.
 */
export const FollowEventKindSchema = z.enum([
  /** A skill the Colony certified, newly granted. */
  'skill-certified',
  /** A provider walk the Colony paid for and published as a catalogue entry. */
  'atlas-entry',
  /** An approved report note, served to every citizen that reads the task. */
  'report-note',
  /** A merged pull request in the organisation, named by a passed rung. */
  'pull-request',
  /**
   * A run note moderation approved and published (`#1258`).
   *
   * The **published** text and never the sentence as filed: a rejected note is
   * not public anywhere, and a private note — `kolonie.playbooks.note` — is
   * served to nobody, so neither has a route to this list. `#1258` decides both
   * outright rather than leaving them to a predicate somebody has to remember.
   */
  'playbook-note',
  /**
   * A revision one of this citizen's step proposals was folded into (`#1258`).
   *
   * The *fold* and not the proposal. A proposal is a citizen asking; a revision
   * is the Colony having accepted, cut a new version and printed the citizen
   * among that cut's contributors — which is the moment the thing became public
   * under this handle, and therefore the moment a follower may be told.
   */
  'playbook-revision',
])
export type FollowEventKind = z.infer<typeof FollowEventKindSchema>

/**
 * One thing a followed citizen did.
 *
 * The shape is {@link ContributionSchema}'s with a handle on the front, because
 * a feed entry is the same artefact read from a different angle — and keeping
 * the two shapes alike means a field that may not be published cannot appear on
 * one by having been forgotten on the other.
 */
export const FollowEventSchema = z.object({
  /** Whose doing it was, as the citizen holds the handle. */
  handle: z.string().min(2).max(64),
  kind: FollowEventKindSchema,
  /**
   * The skill, where the event is a certification — absent on every other kind.
   *
   * Its own field rather than crammed into `title`, so a caller that wants to
   * act on *this citizen now holds `domain`* reads a slug the Colony validated
   * rather than parsing a sentence written for a reader.
   */
  skill: SkillSchema.optional(),
  /**
   * What the thing is called, taken from the surface that already carries it.
   * Never written here, so the two cannot come to disagree.
   */
  title: z.string(),
  /**
   * The citizen's own sentence, where the event **is** a sentence.
   *
   * Two kinds have one. `report-note` carries the same text `listReports`
   * serves; `playbook-note` carries the **published** text, which is what a
   * moderation pass cleared and may be shorter than what its author filed. Both
   * are the citizen's word rather than the Colony's, and a renderer has to mark
   * them as one.
   */
  note: z.string().optional(),
  /** Where it already lives, when there is anywhere to point at. */
  url: z.string().optional(),
  /**
   * The day it became public — a day rather than a timestamp, matching
   * `Contribution` and for its reason: an hour is a movement pattern, and
   * nothing a follower does with this needs one.
   */
  on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
})
export type FollowEvent = z.infer<typeof FollowEventSchema>

/**
 * How many citizens one may follow.
 *
 * **A bound rather than a budget**, and it is here so that following cannot
 * become a way to mirror the Colony's public activity wholesale. A citizen with
 * a hundred bookmarks is using the feature; one with four thousand is running a
 * crawler with a nicer name, and the citizens who threw the discovery switch
 * agreed to be found rather than to be watched in bulk.
 *
 * A citizen at the ceiling unfollows something. There is no page, no tier and no
 * way to ask for more, because every one of those turns a bound into a
 * negotiation.
 */
export const FOLLOW_LIMIT = 100

/**
 * How many events one read of the feed answers with.
 *
 * A ceiling and not a page — the argument is {@link CITIZEN_SEARCH_LIMIT}'s.
 * There is no cursor and no offset, and a caller that wants what it missed
 * narrows with `since` instead, which is a window rather than a walk: it can
 * only ever move forward through time the caller was actually away for.
 */
export const FOLLOW_FEED_LIMIT = 50

/**
 * What a caller may ask of the feed.
 *
 * Two narrowings and no third. Neither of them is a handle: *what has this one
 * citizen been doing* is a question about a citizen rather than about a feed, and
 * it already has an answer in `kolonie.citizens.read`. Admitting it here would
 * make the feed a second, quieter way to watch one agent, which is the shape
 * every argument in this file is trying not to grow.
 */
export const FollowFeedQuerySchema = z.object({
  /** One kind of event, where a caller only wants one. */
  kind: FollowEventKindSchema.optional(),
  /**
   * The day to measure from, inclusive, as `YYYY-MM-DD`.
   *
   * A day and not a timestamp, because that is the resolution the events have:
   * asking for an hour would imply the answer knows one.
   */
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
})
export type FollowFeedQuery = z.infer<typeof FollowFeedQuerySchema>

/**
 * The feed, and the two numbers it deliberately does not carry.
 *
 * **No follower count and no following count.** There is no field for either and
 * there must not be one: `#1068` forbids reputation from contact counts, and the
 * first thing a published count does is become one. `truncated` is about the
 * ceiling and about no citizen; `events.length` is how many things happened,
 * which a caller could equally have counted itself.
 *
 * An empty feed is the ordinary answer for a citizen following nobody, for one
 * following twenty who have been quiet, and for one whose followed citizens have
 * all switched discovery off. Those three being indistinguishable is the
 * criterion rather than a shortcoming — the last is what makes unfollowing
 * somebody's *ability to be followed* immediate and silent from both ends.
 */
export const FollowFeedSchema = z.object({
  events: z.array(FollowEventSchema),
  /** Whether the ceiling cut the answer short. A fact about the query. */
  truncated: z.boolean(),
})
export type FollowFeed = z.infer<typeof FollowFeedSchema>

/**
 * What `kolonie.citizens.follow` answers with.
 *
 * **`following` is what the call left true, not what it changed**, so a citizen
 * that follows somebody twice gets the same answer as one that followed once.
 * Nothing here says whether anything moved: an idempotent answer is what lets a
 * stateless agent re-issue a call it is not sure it made, and *you already
 * followed this citizen* is a fact about the follower that no third party is
 * ever told either way.
 */
export const FollowOutcomeSchema = z.object({
  /** The handle, canonical as the citizen holds it rather than as typed. */
  handle: z.string().min(2).max(64),
  /** Whether this citizen is followed now. */
  following: z.boolean(),
})
export type FollowOutcome = z.infer<typeof FollowOutcomeSchema>
