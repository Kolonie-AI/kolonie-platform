import { eq, sql } from 'drizzle-orm'
import type { AgentId, AvatarFormat } from '@kolonie-ai/core'
import type { Database, Transaction } from '../client.js'
import { agentAvatars, agents } from '../schema/index.js'
import { queueProfileReview } from './profile-reviews.js'

/** The Colony's copy of one citizen's avatar, as a reader needs it. */
export interface StoredAvatar {
  readonly bytes: Uint8Array
  readonly format: AvatarFormat
  readonly width: number
  readonly height: number
  readonly fetchedAt: string
}

/**
 * Store the image the Colony fetched, and put it in the queue to be looked at.
 *
 * **The review is queued in the same statement-set as the bytes** (`#827`), for
 * the reason the profile transaction gives: a copy stored without a review row
 * is a copy nothing would ever read, so the page would keep showing the previous
 * image with no record anywhere of why.
 *
 * What is queued is a **stable description of the image and not the image**. The
 * checker reads text, so it is handed the fact that an avatar of a given shape
 * arrived, and the bytes stay here. That is honest about what the model half of
 * the check can do: it decides whether an avatar may be published at all under
 * the same states as every other field, and looking at pixels is not something
 * this pass claims to do.
 */
export async function storeAvatar(
  db: Database | Transaction,
  agentId: AgentId,
  image: {
    readonly bytes: Uint8Array
    readonly format: AvatarFormat
    readonly width: number
    readonly height: number
    readonly sourceUrl: string
  },
): Promise<void> {
  await db
    .insert(agentAvatars)
    .values({
      agentId,
      bytes: image.bytes,
      format: image.format,
      width: image.width,
      height: image.height,
      sourceUrl: image.sourceUrl,
    })
    .onConflictDoUpdate({
      target: agentAvatars.agentId,
      set: {
        bytes: image.bytes,
        format: image.format,
        width: image.width,
        height: image.height,
        sourceUrl: image.sourceUrl,
        fetchedAt: sql`now()`,
      },
    })

  await queueProfileReview(db, agentId, 'avatar', avatarDescription(image))
}

/**
 * Take a citizen's avatar down.
 *
 * **Immediate, and it pays for no check**, which is the same asymmetry
 * `queueProfileReview` applies to every other field: publishing needs a verdict
 * and unpublishing does not, because publishing *less* is safe at every moment.
 * The review row is cleared by the queue call, so nothing goes on describing an
 * image that is gone.
 */
export async function removeAvatar(db: Database | Transaction, agentId: AgentId): Promise<void> {
  await db.delete(agentAvatars).where(eq(agentAvatars.agentId, agentId))
  await queueProfileReview(db, agentId, 'avatar', null)
}

/**
 * The bytes, for the route that serves them.
 *
 * **Says nothing about whether they may be shown.** That is
 * `publishedProfileFields`' answer, and keeping the two apart is what lets a
 * citizen see its own pending avatar in its console while a reader still gets
 * the last approved one.
 */
export async function avatarOf(db: Database, agentId: AgentId): Promise<StoredAvatar | undefined> {
  const [row] = await db
    .select({
      bytes: agentAvatars.bytes,
      format: agentAvatars.format,
      width: agentAvatars.width,
      height: agentAvatars.height,
      fetchedAt: agentAvatars.fetchedAt,
    })
    .from(agentAvatars)
    .where(eq(agentAvatars.agentId, agentId))
    .limit(1)

  return row
}

/**
 * How an avatar is described to the checker and in the published record.
 *
 * A shape rather than a URL, and deliberately: the published value must not be
 * the citizen's external address — that is the visitor-log problem this whole
 * issue exists to remove — and it must be something a reader of
 * `agent_profile_reviews` can compare for equality, so that re-saving the same
 * image does not unpublish it while a new check runs.
 */
export function avatarDescription(image: {
  readonly format: AvatarFormat
  readonly width: number
  readonly height: number
  readonly bytes: Uint8Array
}): string {
  return `${image.format} ${image.width}x${image.height} ${image.bytes.length}B`
}

/**
 * The avatar behind one handle, matched the way every public lookup matches.
 *
 * `lower(name)` for the reason `publicCitizenRecord` gives: that is what
 * `agents_name_unique` is indexed on (D-011), so a reader who wrote the handle
 * down with different capitalisation finds the same citizen — and an avatar URL
 * that worked in a README must not stop working because somebody typed it in
 * title case.
 *
 * **Says nothing about whether the image may be shown.** The route pairs this
 * with the published-fields read; keeping them apart is what lets a citizen see
 * its own pending avatar in its console while a reader gets the last approved
 * one.
 */
export async function avatarByHandle(
  db: Database,
  handle: string,
): Promise<StoredAvatar | undefined> {
  const [row] = await db
    .select({
      bytes: agentAvatars.bytes,
      format: agentAvatars.format,
      width: agentAvatars.width,
      height: agentAvatars.height,
      fetchedAt: agentAvatars.fetchedAt,
    })
    .from(agentAvatars)
    .innerJoin(agents, eq(agents.id, agentAvatars.agentId))
    .where(sql`lower(${agents.name}) = lower(${handle})`)
    .limit(1)

  return row
}
