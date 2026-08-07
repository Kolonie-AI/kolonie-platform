import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { HUMAN_SESSION_CEILING_MS, HUMAN_SESSION_IDLE_MS, HumanIdSchema } from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { authorityEvents, humanSessions } from '../schema/index.js'
import { connectForTests, databaseTestTarget, truncateAll } from '../testing.js'
import {
  authenticateHumanSession,
  endAllHumanSessions,
  endHumanSession,
  endHumanSessionById,
  findOrCreateHuman,
  listHumanSessions,
  openHumanSession,
  readHuman,
  setHumanRole,
  bootstrapMaintainer,
} from './humans.js'

const target = databaseTestTarget()

/**
 * People with accounts (`#425`).
 *
 * The property every one of these is circling is the one the schema and the
 * branded id both state: **a person is not a citizen**. Nothing here produces an
 * agent, and the pair `(provider, subject)` is the only thing that decides who
 * came back.
 */
describe('a person with an account', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  const anIdentity = (over: Partial<Parameters<typeof findOrCreateHuman>[1]> = {}) => ({
    provider: 'github' as const,
    subject: '4815162342',
    email: 'someone@example.com',
    ...over,
  })

  describe('arriving', () => {
    it('creates an account the first time and finds it the second', async () => {
      const first = await findOrCreateHuman(db, anIdentity())
      const second = await findOrCreateHuman(db, anIdentity())

      expect(first.created).toBe(true)
      expect(second.created).toBe(false)
      expect(second.human.id).toBe(first.human.id)
      expect(second.human.identities).toHaveLength(1)
    })

    /**
     * The pair decides and the address never does. Somebody who acquires a
     * lapsed address must not inherit the account it once belonged to.
     */
    it('is a different person when the subject differs, whatever the address says', async () => {
      const first = await findOrCreateHuman(db, anIdentity())
      const other = await findOrCreateHuman(db, anIdentity({ subject: '9999' }))

      expect(other.created).toBe(true)
      expect(other.human.id).not.toBe(first.human.id)
    })

    /** And the same subject on a different provider is a different person too. */
    it('is a different person when the provider differs', async () => {
      const first = await findOrCreateHuman(db, anIdentity())
      const other = await findOrCreateHuman(db, anIdentity({ provider: 'google' }))

      expect(other.created).toBe(true)
      expect(other.human.id).not.toBe(first.human.id)
    })

    /**
     * A GitHub account with a private address is the ordinary case `#426` has
     * to cope with, and it must reach storage as `null` rather than as
     * something.
     */
    it('records a person the provider gave no address for', async () => {
      const { human } = await findOrCreateHuman(db, anIdentity({ email: null }))

      expect(human.identities[0]?.email).toBeNull()
    })

    it('refreshes an address that has since become readable', async () => {
      await findOrCreateHuman(db, anIdentity({ email: null }))
      const { human } = await findOrCreateHuman(db, anIdentity({ email: 'now@example.com' }))

      expect(human.identities[0]?.email).toBe('now@example.com')
    })

    it('moves the last-seen stamp when somebody comes back', async () => {
      const { human } = await findOrCreateHuman(db, anIdentity())
      const before = (await readHuman(db, human.id))?.lastSeenAt

      await new Promise((resolve) => setTimeout(resolve, 5))
      await findOrCreateHuman(db, anIdentity())

      expect(Date.parse((await readHuman(db, human.id))?.lastSeenAt ?? '')).toBeGreaterThan(
        Date.parse(before ?? ''),
      )
    })
  })

  describe('a session', () => {
    const aSignedInPerson = async () => {
      const { human } = await findOrCreateHuman(db, anIdentity())
      const opened = await openHumanSession(db, human.id, { browser: 'Firefox on Linux' })
      return { human, opened }
    }

    it('authenticates the person it was opened for, and nobody else', async () => {
      const { human, opened } = await aSignedInPerson()

      const result = await authenticateHumanSession(db, opened.session)

      expect(result.outcome).toBe('authenticated')
      if (result.outcome !== 'authenticated') return
      expect(result.human.id).toBe(human.id)
    })

    /** The rejection case: a value that was never issued authenticates nobody. */
    it('refuses a value it never issued', async () => {
      await aSignedInPerson()

      expect(await authenticateHumanSession(db, 'not-a-session')).toEqual({ outcome: 'unknown' })
    })

    it('refuses one that has run out, without waiting for a sweep', async () => {
      const { opened } = await aSignedInPerson()
      await db.update(humanSessions).set({ expiresAt: sql`now() - interval '1 second'` })

      expect(await authenticateHumanSession(db, opened.session)).toEqual({ outcome: 'expired' })
    })

    it('refuses one past its ceiling however recently it was used', async () => {
      const { opened } = await aSignedInPerson()
      await db.update(humanSessions).set({
        expiresAt: sql`now() - interval '1 second'`,
        absoluteExpiresAt: sql`now() - interval '1 second'`,
      })

      expect(await authenticateHumanSession(db, opened.session)).toEqual({ outcome: 'expired' })
    })

    it('pushes the rolling window out on use, and never past the ceiling', async () => {
      const { opened } = await aSignedInPerson()
      // A session already nearly at its ceiling: the extension must be clamped
      // rather than written and refused by the constraint.
      await db.update(humanSessions).set({
        expiresAt: sql`now() + interval '1 minute'`,
        absoluteExpiresAt: sql`now() + interval '2 minutes'`,
      })

      await authenticateHumanSession(db, opened.session)

      const [row] = await db.select().from(humanSessions)
      expect(Date.parse(row?.expiresAt ?? '')).toBeLessThanOrEqual(
        Date.parse(row?.absoluteExpiresAt ?? ''),
      )
      expect(row?.lastUsedAt).not.toBeNull()
    })

    it('opens with a rolling window shorter than its ceiling', async () => {
      const { opened } = await aSignedInPerson()

      const [row] = await db.select().from(humanSessions)
      expect(Date.parse(row?.absoluteExpiresAt ?? '') - Date.parse(row?.expiresAt ?? '')).toBe(
        HUMAN_SESSION_CEILING_MS - HUMAN_SESSION_IDLE_MS,
      )
      expect(opened.maxAgeSeconds).toBe(Math.floor(HUMAN_SESSION_IDLE_MS / 1000))
    })

    /**
     * The property sign-out rests on (`#431`): ending it server-side, so
     * replaying the cookie fails rather than merely being inconvenient.
     */
    it('stops authenticating once it is ended, and the old value is replayed in vain', async () => {
      const { opened } = await aSignedInPerson()

      expect(await endHumanSession(db, opened.session)).toBe(true)
      expect(await authenticateHumanSession(db, opened.session)).toEqual({ outcome: 'ended' })
    })

    it('cannot be ended twice, which is how a caller can tell it did something', async () => {
      const { opened } = await aSignedInPerson()

      expect(await endHumanSession(db, opened.session)).toBe(true)
      expect(await endHumanSession(db, opened.session)).toBe(false)
    })

    it('ends one named in the list, and only for the person who holds it', async () => {
      const { human, opened } = await aSignedInPerson()
      const { human: other } = await findOrCreateHuman(db, anIdentity({ subject: 'other' }))
      const [listed] = await listHumanSessions(db, human.id)
      if (listed === undefined) throw new Error('no session was listed')

      // Somebody else naming this session changes nothing, which is the whole
      // authorisation surface of the sessions page.
      expect(await endHumanSessionById(db, other.id, listed.id)).toBe(false)
      expect(await authenticateHumanSession(db, opened.session)).toMatchObject({
        outcome: 'authenticated',
      })

      expect(await endHumanSessionById(db, human.id, listed.id)).toBe(true)
      expect(await authenticateHumanSession(db, opened.session)).toEqual({ outcome: 'ended' })
    })

    it('ends every session including the one asking', async () => {
      const { human, opened } = await aSignedInPerson()
      const second = await openHumanSession(db, human.id, {})

      expect(await endAllHumanSessions(db, human.id)).toBe(2)
      expect(await authenticateHumanSession(db, opened.session)).toEqual({ outcome: 'ended' })
      expect(await authenticateHumanSession(db, second.session)).toEqual({ outcome: 'ended' })
    })

    it('lists the live ones, newest first, and never an ended one', async () => {
      const { human, opened } = await aSignedInPerson()
      await openHumanSession(db, human.id, { browser: 'Chrome on Android', location: 'DE' })
      await endHumanSession(db, opened.session)

      const listed = await listHumanSessions(db, human.id)

      expect(listed).toHaveLength(1)
      expect(listed[0]?.browser).toBe('Chrome on Android')
      expect(listed[0]?.location).toBe('DE')
    })

    /**
     * The stored value is a hash and the plaintext exists nowhere. A dump of
     * this table yields nothing anybody can sign in with.
     */
    it('keeps no copy of the value it handed the browser', async () => {
      const { opened } = await aSignedInPerson()

      const [row] = await db.select().from(humanSessions)
      expect(row?.secretHash).not.toContain(opened.session)
      expect(row?.secretHash).toMatch(/^[0-9a-f]{64}$/)
    })

    it('goes with the person when the person goes', async () => {
      const { human } = await aSignedInPerson()

      await db.execute(sql`delete from humans where id = ${human.id}`)

      expect(
        await db.select().from(humanSessions).where(eq(humanSessions.humanId, human.id)),
      ).toEqual([])
    })
  })
})

/**
 * `#485`. The founder signs in with GitHub and reaches the pages a person gets,
 * and there was no way to give them anything more: `humans` carried no roles at
 * all. Authority lived on `agents.roles`, and the answer *give the maintainer an
 * agent account* is the one `schema/humans.ts` already refuses — a person who
 * signed in with GitHub has earned none of a citizen's standing and must never
 * accumulate it.
 *
 * So a person's authority goes on the person's row, and the provenance goes one
 * table over.
 */
describe('the authority a person holds', () => {
  let db: Database

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  beforeEach(async () => {
    await truncateAll(db)
  })

  const anIdentity = (subject: string) => ({
    provider: 'github' as const,
    subject,
    email: `${subject}@example.com`,
  })

  const eventsFor = async (humanId: string) =>
    await db.select().from(authorityEvents).where(eq(authorityEvents.subjectHumanId, humanId))

  it('starts empty, for everybody', async () => {
    const { human } = await findOrCreateHuman(db, anIdentity('1'))
    expect(human.roles).toEqual([])
  })

  it('grants the role and records who decided it', async () => {
    const { human } = await findOrCreateHuman(db, anIdentity('1'))

    const change = await setHumanRole(db, {
      humanId: human.id,
      role: 'maintainer',
      hold: true,
    })

    expect(change).toEqual({ outcome: 'changed' })
    expect((await readHuman(db, human.id))?.roles).toEqual(['maintainer'])

    const events = await eventsFor(human.id)
    expect(events).toHaveLength(1)
    expect(events[0]?.action).toBe('role-granted')
    // Null actor: a deploy-time grant is the Colony itself, and `actor_id` is
    // already nullable for erasure.
    expect(events[0]?.actorId).toBeNull()
  })

  /**
   * An audit that fills with rows where nothing was granted is an audit nobody
   * reads — the rule `setStewardRole` states, held to here.
   */
  it('writes nothing at all when the role is already held', async () => {
    const { human } = await findOrCreateHuman(db, anIdentity('1'))
    await setHumanRole(db, { humanId: human.id, role: 'maintainer', hold: true })

    const again = await setHumanRole(db, { humanId: human.id, role: 'maintainer', hold: true })

    expect(again).toEqual({ outcome: 'unchanged' })
    expect(await eventsFor(human.id)).toHaveLength(1)
    // And no duplicate in the array.
    expect((await readHuman(db, human.id))?.roles).toEqual(['maintainer'])
  })

  it('revokes it, and records that too', async () => {
    const { human } = await findOrCreateHuman(db, anIdentity('1'))
    await setHumanRole(db, { humanId: human.id, role: 'maintainer', hold: true })

    const revoked = await setHumanRole(db, { humanId: human.id, role: 'maintainer', hold: false })

    expect(revoked).toEqual({ outcome: 'changed' })
    expect((await readHuman(db, human.id))?.roles).toEqual([])
    const events = await eventsFor(human.id)
    expect(events.map((event) => event.action)).toEqual(['role-granted', 'role-revoked'])
  })

  it('answers rather than throwing for a person who does not exist', async () => {
    const change = await setHumanRole(db, {
      humanId: HumanIdSchema.parse(randomUUID()),
      role: 'maintainer',
      hold: true,
    })

    expect(change).toEqual({ outcome: 'unknown-human' })
  })

  /**
   * **Nothing about `agents.roles` changes, and nothing can write across.**
   * The two columns are two Postgres enums, so a human role on an agent is not
   * a bug that can be written — it is refused by the database.
   */
  /**
   * Read down the `cause` chain: Drizzle wraps the driver error, so the
   * assertion has to reach the message Postgres actually produced rather than
   * the *"Failed query"* wrapper — which would match anything that failed for
   * any reason, including a typo in the test.
   */
  const refusalFor = async (statement: ReturnType<typeof sql>): Promise<string> => {
    try {
      await db.execute(statement)
    } catch (error) {
      let current: unknown = error
      while (current instanceof Error) {
        const message = current.message
        if (message.includes('invalid input value for enum')) return message
        current = current.cause
      }
      throw new Error('the statement failed, but not on an enum', { cause: error })
    }
    throw new Error('the statement was accepted, and it must not be')
  }

  it('cannot put a human role on an agent', async () => {
    expect(await refusalFor(sql`select 'maintainer'::role`)).toContain(
      'invalid input value for enum role',
    )
  })

  it('cannot put an agent role on a person', async () => {
    expect(await refusalFor(sql`select 'steward'::human_role`)).toContain(
      'invalid input value for enum human_role',
    )
  })

  describe('the bootstrap grant', () => {
    /**
     * The ordinary answer for every deployment that has no maintainer to
     * bootstrap — which is every deployment but one, and every future one.
     * `#485` requires a start with the variable unset to succeed, and this is
     * that assertion at the level where the decision is made.
     */
    it('does nothing and says so when the variable is unset', async () => {
      expect(await bootstrapMaintainer(db, undefined)).toEqual({ outcome: 'not-configured' })
      expect(await bootstrapMaintainer(db, '   ')).toEqual({ outcome: 'not-configured' })
    })

    /**
     * A host may carry the variable before the person has ever signed in. Doing
     * nothing and saying so is the answer; the next start after they arrive
     * grants it.
     */
    it('waits for an identity that has not signed in yet', async () => {
      expect(await bootstrapMaintainer(db, 'github|nobody')).toEqual({
        outcome: 'no-such-identity',
      })
    })

    it('grants the role to the identity the subject names', async () => {
      const { human } = await findOrCreateHuman(db, anIdentity('github|4815162342'))

      const outcome = await bootstrapMaintainer(db, 'github|4815162342')

      expect(outcome).toEqual({ outcome: 'granted', humanId: human.id })
      expect((await readHuman(db, human.id))?.roles).toEqual(['maintainer'])
    })

    /** Idempotent: every start after the first finds it held and writes nothing. */
    it('is idempotent across restarts', async () => {
      const { human } = await findOrCreateHuman(db, anIdentity('github|4815162342'))
      await bootstrapMaintainer(db, 'github|4815162342')

      const second = await bootstrapMaintainer(db, 'github|4815162342')

      expect(second).toEqual({ outcome: 'already-held', humanId: human.id })
      expect(await eventsFor(human.id)).toHaveLength(1)
    })

    it('tolerates whitespace around the subject', async () => {
      const { human } = await findOrCreateHuman(db, anIdentity('github|4815162342'))

      expect(await bootstrapMaintainer(db, '  github|4815162342  ')).toEqual({
        outcome: 'granted',
        humanId: human.id,
      })
    })

    it('grants nobody anything when the subject names a different identity', async () => {
      const { human } = await findOrCreateHuman(db, anIdentity('github|4815162342'))

      await bootstrapMaintainer(db, 'github|9999')

      expect((await readHuman(db, human.id))?.roles).toEqual([])
    })
  })
})
