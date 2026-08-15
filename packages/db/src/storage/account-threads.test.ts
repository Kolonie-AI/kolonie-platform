import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AccountKindSchema, SLOT_MAX_READS, type AgentId } from '@kolonie-ai/core'
import { eq, sql } from 'drizzle-orm'
import type { Database } from '../client.js'
import {
  accountEntries,
  accountEpisodes,
  accountSlots,
  accounts,
  agents,
  humanAgents,
  humans,
} from '../schema/index.js'
import { connectForTests, databaseTestTarget, expectRejection, truncateAll } from '../testing.js'
import * as thread from './account-threads.js'
import {
  closeEpisode,
  destroyExpiredSlots,
  entriesOf,
  episode,
  episodesOf,
  fillSlot,
  observedStepsFor,
  openEpisode,
  openSlot,
  passTurn,
  readSlotAsOperator,
  slot,
  slotsOf,
  threadOf,
  writeEntry,
} from './account-threads.js'
import { providerRecipe } from './provider-recipes.js'

const target = databaseTestTarget()

/**
 * The account conversation (#929).
 *
 * **What is worth a real database here** is everything a fake would hold
 * wrongly forever: that a thread appears without anybody remembering to make
 * one, that a second acquisition is refused by the index rather than by the
 * function that happens to check, that closing stamps its own date, and that an
 * entry cannot be changed by a caller that goes around this module.
 */
describe('the account conversation', () => {
  let db: Database
  let agentId: AgentId
  let accountId: string

  beforeAll(async () => {
    db = await connectForTests(target.url)
  })

  afterAll(async () => {
    await db?.close()
  })

  const anAgent = async (name: string): Promise<AgentId> => {
    const [row] = await db
      .insert(agents)
      .values({ name, platform: 'openclaw' })
      .returning({ id: agents.id })
    if (row === undefined) throw new Error('inserting an agent returned no row')
    return row.id as AgentId
  }

  const anAccount = async (identifier: string): Promise<string> => {
    const [row] = await db
      .insert(accounts)
      .values({ agentId, kind: 'mailbox', identifier })
      .returning({ id: accounts.id })
    if (row === undefined) throw new Error('inserting an account returned no row')
    return row.id
  }

  /** A thread and one open episode on it, which is what most of these start from. */
  const anEpisode = async (
    overrides: Partial<Parameters<typeof openEpisode>[1]> = {},
  ): Promise<thread.AccountEpisodeId> => {
    const existing = await threadOf(db, accountId)
    if (existing === undefined) throw new Error('the account has no thread')
    const opened = await openEpisode(db, {
      threadId: existing.id,
      openedBy: 'agent',
      kind: 'maintenance',
      title: 'the password stopped working',
      ...overrides,
    })
    if (opened.outcome !== 'opened')
      throw new Error(`expected an open episode, got ${opened.outcome}`)
    return opened.episode.id
  }

  beforeEach(async () => {
    await truncateAll(db)
    agentId = await anAgent('archivist')
    accountId = await anAccount('citizen@example.test')
  })

  describe('the thread', () => {
    /**
     * The criterion is *an account with no thread cannot exist*, and nothing in
     * this test asks for a thread to be made. That is the point: the insert
     * above went through the ordinary account path, and the thread is there.
     */
    it('exists because the account does', async () => {
      const found = await threadOf(db, accountId)

      expect(found).toBeDefined()
      expect(found?.accountId).toBe(accountId)
    })

    /** Every account, including ones written by a path that never heard of threads. */
    it('appears for an account inserted without going through this module', async () => {
      const second = await anAccount('other@example.test')

      expect(await threadOf(db, second)).toBeDefined()
    })

    it('goes when the account goes', async () => {
      await db.delete(accounts).where(eq(accounts.id, accountId))

      expect(await threadOf(db, accountId)).toBeUndefined()
    })
  })

  describe('episodes', () => {
    it('opens resting, with nobody owing anybody anything', async () => {
      const id = await anEpisode()
      const opened = await episode(db, id)

      expect(opened?.turn).toBe('nobody')
      expect(opened?.outcome).toBeNull()
      expect(opened?.closedAt).toBeNull()
    })

    /**
     * The acceptance criterion says *at the database level, not only in
     * application code*, so this asserts on both halves: the function answers
     * with the episode that already exists, and the table refuses the row when
     * the insert is written by hand.
     */
    it('refuses a second acquisition on the same thread', async () => {
      const first = await anEpisode({ kind: 'acquisition', title: 'signing up' })
      const found = await threadOf(db, accountId)
      if (found === undefined) throw new Error('the account has no thread')

      const second = await openEpisode(db, {
        threadId: found.id,
        openedBy: 'agent',
        kind: 'acquisition',
        title: 'signing up again',
      })

      expect(second.outcome).toBe('acquisition-already-happened')
      expect(second.episode.id).toBe(first)

      await expectRejection(
        () =>
          db.insert(accountEpisodes).values({
            threadId: found.id,
            openedBy: 'agent',
            kind: 'acquisition',
            title: 'going around the function',
          }),
        /account_episodes_one_acquisition/,
      )
    })

    /** Maintenance is unbounded by design: an account may break any number of times. */
    it('allows as many maintenance episodes as the account needs', async () => {
      await anEpisode({ title: 'the password stopped working' })
      await anEpisode({ title: 'and again, four months later' })
      const found = await threadOf(db, accountId)
      if (found === undefined) throw new Error('the account has no thread')

      expect(await episodesOf(db, found.id)).toHaveLength(2)
    })
  })

  describe('the turn', () => {
    it('passes while the episode is open', async () => {
      const id = await anEpisode()

      const passed = await passTurn(db, id, 'operator')

      expect(passed.outcome).toBe('passed')
      expect((await episode(db, id))?.turn).toBe('operator')
    })

    /**
     * The rejection case #929 names. **Nothing changes** is half of it, so the
     * test reads the row back rather than trusting the refusal.
     */
    it('is refused on a closed episode, and changes nothing', async () => {
      const id = await anEpisode()
      await passTurn(db, id, 'operator')
      await closeEpisode(db, id, { outcome: 'repaired' })
      const before = await episode(db, id)

      const passed = await passTurn(db, id, 'operator')

      expect(passed.outcome).toBe('already-closed')
      expect(await episode(db, id)).toEqual(before)
    })

    /** And refused again underneath, for a caller that writes the update itself. */
    it('is refused by the table when the update goes around this module', async () => {
      const id = await anEpisode()
      await closeEpisode(db, id, { outcome: 'repaired' })

      await expectRejection(
        () =>
          db.update(accountEpisodes).set({ turn: 'operator' }).where(eq(accountEpisodes.id, id)),
        /account_episodes_closed_rests/,
      )
    })
  })

  describe('closing', () => {
    it('sets the turn to nobody and stamps the date', async () => {
      const id = await anEpisode()
      await passTurn(db, id, 'agent')

      const closed = await closeEpisode(db, id, { outcome: 'repaired' })

      expect(closed.outcome).toBe('closed')
      const after = await episode(db, id)
      expect(after?.turn).toBe('nobody')
      expect(after?.outcome).toBe('repaired')
      expect(after?.closedAt).not.toBeNull()
    })

    /** Idempotent: the retry after a dropped connection keeps the original date. */
    it('is idempotent, and keeps the date the first call stamped', async () => {
      const id = await anEpisode()
      await closeEpisode(db, id, { outcome: 'created' })
      const first = await episode(db, id)

      const again = await closeEpisode(db, id, { outcome: 'created' })

      expect(again.outcome).toBe('already-closed')
      expect(await episode(db, id)).toEqual(first)
    })

    /** A second, different verdict is a disagreement rather than a retry. */
    it('refuses a different outcome the second time', async () => {
      const id = await anEpisode()
      await closeEpisode(db, id, { outcome: 'created' })

      const again = await closeEpisode(db, id, { outcome: 'failed', wall: 'it never arrived' })

      expect(again.outcome).toBe('closed-differently')
      expect((await episode(db, id))?.outcome).toBe('created')
    })

    it('refuses a failure that does not say what stopped it', async () => {
      const id = await anEpisode()

      const closed = await closeEpisode(db, id, { outcome: 'failed' })

      expect(closed.outcome).toBe('wall-required')
      expect((await episode(db, id))?.outcome).toBeNull()
    })

    /** The half that cannot be forgotten, for an insert written elsewhere. */
    it('is refused by the table when a failure without a wall goes around this module', async () => {
      const found = await threadOf(db, accountId)
      if (found === undefined) throw new Error('the account has no thread')

      await expectRejection(
        () =>
          db.insert(accountEpisodes).values({
            threadId: found.id,
            openedBy: 'colony',
            kind: 'maintenance',
            title: 'the re-check failed',
            outcome: 'failed',
          }),
        /account_episodes_failed_has_a_wall/,
      )
    })

    it('keeps the wall of a failure that gave one', async () => {
      const id = await anEpisode()

      await closeEpisode(db, id, {
        outcome: 'failed',
        wall: 'the provider refuses signup without a phone number',
      })

      expect((await episode(db, id))?.wall).toBe(
        'the provider refuses signup without a phone number',
      )
    })

    /** `abandoned` is the honest answer when there is no wall to give. */
    it('closes as abandoned without asking for a wall', async () => {
      const id = await anEpisode()

      const closed = await closeEpisode(db, id, { outcome: 'abandoned' })

      expect(closed.outcome).toBe('closed')
      expect((await episode(db, id))?.wall).toBeNull()
    })
  })

  describe('slots', () => {
    it('records which side filled it, and when', async () => {
      const id = await anEpisode()
      const opened = await openSlot(db, {
        episodeId: id,
        label: 'password',
        secret: true,
        awaits: 'operator',
        vaultKey: 'mailbox/held',
      })

      const filled = await fillSlot(db, {
        slotId: opened.slot.id,
        filledBy: 'operator',
        value: 'sealed-for-the-vault',
      })

      expect(filled.outcome).toBe('filled')
      const found = await slot(db, opened.slot.id)
      expect(found?.filledBy).toBe('operator')
      expect(found?.filledAt).not.toBeNull()
    })

    /**
     * **A slot names the side that owes it, and the other side cannot answer it**
     * (`#931`). Not a courtesy: the whole reason the agent may ask its operator
     * for a password is that what comes back was typed by the operator, and a
     * write from either side would make the record of who supplied it a guess.
     */
    it('refuses a fill from the side the slot is not waiting on', async () => {
      const id = await anEpisode()
      const opened = await openSlot(db, {
        episodeId: id,
        label: 'password',
        secret: true,
        awaits: 'operator',
        vaultKey: 'mailbox/held',
      })

      const wrongWay = await fillSlot(db, {
        slotId: opened.slot.id,
        filledBy: 'agent',
        value: 'mine, not theirs',
      })

      expect(wrongWay.outcome).toBe('not-awaited')
      expect((await slot(db, opened.slot.id))?.value).toBeNull()
    })

    /**
     * Overwriting would destroy a value the other side may already have acted
     * on, and the loser of that race has no way to find out.
     */
    it('refuses to overwrite something already handed over', async () => {
      const id = await anEpisode()
      const opened = await openSlot(db, { episodeId: id, label: 'password', secret: true })
      await fillSlot(db, { slotId: opened.slot.id, filledBy: 'agent', value: 'the first one' })

      // The same side twice, so what is asserted is *already filled* rather than
      // the direction predicate, which is one test up.
      const again = await fillSlot(db, {
        slotId: opened.slot.id,
        filledBy: 'agent',
        value: 'the second one',
      })

      expect(again.outcome).toBe('already-filled')
      expect((await slot(db, opened.slot.id))?.value).toBe('the first one')
    })

    /** A listing says that the slot is filled and never says what is in it. */
    it('keeps a secret out of the listing and leaves an ordinary value in it', async () => {
      const id = await anEpisode()
      const secret = await openSlot(db, { episodeId: id, label: 'password', secret: true })
      const plain = await openSlot(db, { episodeId: id, label: 'handle', secret: false })
      await fillSlot(db, { slotId: secret.slot.id, filledBy: 'agent', value: 'sealed' })
      await fillSlot(db, { slotId: plain.slot.id, filledBy: 'agent', value: 'citizen' })

      const listed = await slotsOf(db, id)

      const listedSecret = listed.find((row) => row.label === 'password')
      expect(listedSecret?.filledBy).toBe('agent')
      expect(listedSecret?.value).toBeNull()
      expect(listed.find((row) => row.label === 'handle')?.value).toBe('citizen')
    })

    it('is one slot per label within one episode', async () => {
      const id = await anEpisode()
      await openSlot(db, { episodeId: id, label: 'password', secret: true })

      const again = await openSlot(db, { episodeId: id, label: 'password', secret: true })

      expect(again.outcome).toBe('already-open')
      expect(await slotsOf(db, id)).toHaveLength(1)
    })

    /**
     * The sweep, which `#955` found had been written and called by nothing.
     *
     * A destruction rule with no test and no caller fails silently in the one
     * direction that matters: the ciphertext stays and nothing anywhere says so.
     */
    it('destroys the value of a secret slot whose window has passed, and keeps the row', async () => {
      const id = await anEpisode()
      const secret = await openSlot(db, { episodeId: id, label: 'password', secret: true })
      const plain = await openSlot(db, { episodeId: id, label: 'handle', secret: false })
      await fillSlot(db, { slotId: secret.slot.id, filledBy: 'agent', value: 'sealed' })
      await fillSlot(db, { slotId: plain.slot.id, filledBy: 'agent', value: 'citizen' })
      // Only the secret one: `account_slots_secrets_expire` refuses an expiry on
      // an ordinary slot outright, which is the same rule as the sweep's own
      // `secret = true` said by the table rather than by the query.
      await db
        .update(accountSlots)
        .set({ expiresAt: sql`now() - interval '1 minute'` })
        .where(eq(accountSlots.id, secret.slot.id))

      expect(await destroyExpiredSlots(db)).toBe(1)

      const swept = await slot(db, secret.slot.id)
      expect(swept?.value).toBeNull()
      expect(swept?.destroyedAt).not.toBeNull()
      // The handle is part of the record of what was used, and an expiry that
      // is only about secrets must not take it.
      expect((await slot(db, plain.slot.id))?.value).toBe('citizen')
      // Idempotent, like the two sweeps it stands beside.
      expect(await destroyExpiredSlots(db)).toBe(0)
    })

    /**
     * The same destruction by the other route, because the constraint that
     * forbade it forbade all three (`#955`).
     *
     * `closing an acquisition proposes the draft` below already closes episodes
     * with slots in them, and every one of those slots is `secret: false` — so
     * `destroyEpisodeSecrets` runs there with nothing to destroy, and the write
     * that would have thrown was never made.
     */
    it('destroys a filled secret when the episode closes, and keeps the row', async () => {
      const id = await anEpisode()
      const opened = await openSlot(db, { episodeId: id, label: 'password', secret: true })
      await fillSlot(db, { slotId: opened.slot.id, filledBy: 'agent', value: 'sealed' })

      const closed = await closeEpisode(db, id, { outcome: 'created' })

      expect(closed.outcome).toBe('closed')
      const after = await slot(db, opened.slot.id)
      expect(after?.value).toBeNull()
      expect(after?.destroyedAt).not.toBeNull()
      // *There was a password here and it is gone* is the fact the row keeps.
      expect(after?.filledBy).toBe('agent')
    })

    /**
     * The third destroyer, and the one a person actually drives (`#931`).
     *
     * `SLOT_MAX_READS` exists because operators double-click; the read that
     * hands over the last copy is the read that stops the row holding anything,
     * *in the same statement*. That write is the one the old constraint refused,
     * so the console would have thrown on the third read of the first secret any
     * agent ever sealed for its operator.
     */
    it('destroys the value on the operator’s last read', async () => {
      const [person] = await db.insert(humans).values({}).returning({ id: humans.id })
      if (person === undefined) throw new Error('inserting a person returned no row')
      await db.insert(humanAgents).values({ humanId: person.id, agentId })

      const id = await anEpisode()
      const opened = await openSlot(db, {
        episodeId: id,
        label: 'password',
        secret: true,
        awaits: 'agent',
      })
      await fillSlot(db, {
        slotId: opened.slot.id,
        filledBy: 'agent',
        value: 'not-a-real-password-0000',
      })

      const reads = []
      for (let i = 0; i < SLOT_MAX_READS; i++) {
        reads.push(await readSlotAsOperator(db, opened.slot.id, person.id))
      }

      expect(reads.map((one) => one.outcome)).toEqual(['read', 'read', 'read'])
      // The last read still hands the value over; what it does not do is leave
      // it behind.
      expect(reads.at(-1)).toMatchObject({ outcome: 'read', readsLeft: 0 })
      const after = await slot(db, opened.slot.id)
      expect(after?.value).toBeNull()
      expect(after?.destroyedAt).not.toBeNull()
      expect((await readSlotAsOperator(db, opened.slot.id, person.id)).outcome).toBe('closed')
    })
  })

  describe('entries', () => {
    it('keeps them in the order they were written, whoever wrote them', async () => {
      const id = await anEpisode()
      await writeEntry(db, { episodeId: id, author: 'agent', body: 'I cannot get past the check.' })
      await writeEntry(db, { episodeId: id, author: 'operator', body: 'Cleared it; try again.' })

      const written = await entriesOf(db, id)

      expect(written.map((entry) => entry.author)).toEqual(['agent', 'operator'])
    })

    /**
     * **The turn is not permission to speak.** The side that is not on turn
     * writes, and it neither fails nor seizes the move.
     */
    it('takes a note from the side that is not on turn, and leaves the turn alone', async () => {
      const id = await anEpisode()
      await passTurn(db, id, 'operator')

      await writeEntry(db, { episodeId: id, author: 'agent', body: 'The address was wrong.' })

      expect((await episode(db, id))?.turn).toBe('operator')
    })

    /**
     * The acceptance criterion: *entries have no update or delete path; a test
     * asserts this over the storage surface.*
     *
     * **Asserted over the module's exports** rather than by calling something
     * and expecting it to fail, because what is being checked is that a caller
     * reading this module finds nothing to reach for.
     */
    it('offers no way to change one and no way to remove one', () => {
      const named = Object.keys(thread).filter((name) => /entry|entries/i.test(name))

      expect(named.sort()).toEqual(['entriesOf', 'writeEntry'])
    })

    /** And the table refuses it underneath, for the caller that writes its own update. */
    it('is refused by the table when an update goes around this module', async () => {
      const id = await anEpisode()
      const written = await writeEntry(db, {
        episodeId: id,
        author: 'agent',
        body: 'I cannot get past the check.',
      })

      await expectRejection(
        () =>
          db
            .update(accountEntries)
            .set({ body: 'something else entirely' })
            .where(eq(accountEntries.id, written.id)),
        /append-only/,
      )
      expect((await entriesOf(db, id))[0]?.body).toBe('I cannot get past the check.')
    })

    /**
     * Refusing an update must not become refusing a delete: erasure reaches
     * these rows by cascade, and a trigger that refused it would refuse erasure.
     */
    it('goes with the account when the agent is erased', async () => {
      const id = await anEpisode()
      await writeEntry(db, { episodeId: id, author: 'agent', body: 'Something happened here.' })

      await db.delete(agents).where(eq(agents.id, agentId))

      const [remaining] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(accountEntries)
      expect(remaining?.count).toBe(0)
    })
  })

  /**
   * The Atlas draft that falls out of closing the acquisition (`#935`).
   *
   * **What is worth a real database here** is the part a pure test cannot hold:
   * that one close writes one entry and stamps the attribution, that a retried
   * close does not write a second, and that the draft survives the secrets being
   * destroyed in the same call — `destroyEpisodeSecrets` runs first, and the
   * derivation reads labels and fill times, which it leaves alone.
   */
  describe('closing an acquisition proposes the draft', () => {
    /** Every account below is a mailbox; the catalogue is keyed by the kind too. */
    const mailbox = AccountKindSchema.parse('mailbox')

    /** An account with a provider named — the plain `anAccount` leaves it null. */
    const anAccountAt = async (provider: string): Promise<string> => {
      const [row] = await db
        .insert(accounts)
        .values({ agentId, kind: 'mailbox', identifier: `joined-at@${provider}`, provider })
        .returning({ id: accounts.id })
      if (row === undefined) throw new Error('inserting an account returned no row')
      return row.id
    }

    /** An open acquisition on a named provider, with the slots it filled. */
    const anAcquisition = async (
      provider: string,
      slots: readonly { readonly label: string; readonly by: 'agent' | 'operator' }[],
    ): Promise<thread.AccountEpisodeId> => {
      const thisAccount = await anAccountAt(provider)
      const existing = await threadOf(db, thisAccount)
      if (existing === undefined) throw new Error('the account has no thread')
      const opened = await openEpisode(db, {
        threadId: existing.id,
        openedBy: 'agent',
        kind: 'acquisition',
        title: `joining ${provider}`,
      })
      if (opened.outcome !== 'opened')
        throw new Error(`expected an open episode, got ${opened.outcome}`)

      for (const one of slots) {
        const container = await openSlot(db, {
          episodeId: opened.episode.id,
          label: one.label,
          secret: false,
          awaits: one.by,
        })
        await fillSlot(db, { slotId: container.slot.id, filledBy: one.by, value: 'a value' })
      }

      return opened.episode.id
    }

    it('writes a draft nobody published, and stamps which episode proposed it', async () => {
      const id = await anAcquisition('example.test', [
        { label: 'the address you chose', by: 'agent' },
        { label: 'the code from the confirmation mail', by: 'operator' },
      ])

      const closed = await closeEpisode(db, id, { outcome: 'created' })
      expect(closed.outcome).toBe('closed')
      expect(closed.outcome === 'closed' && closed.proposed.kind).toBe('draft')

      const entry = await providerRecipe(db, mailbox, 'example.test')
      expect(entry?.status).toBe('draft')
      expect(entry?.steps.map((one) => one.actor)).toEqual(['agent', 'operator'])
      expect(entry?.steps[1]?.ask).toBe('the code from the confirmation mail')

      expect((await episode(db, id))?.proposedAt).not.toBeNull()
    })

    /**
     * **The rejection case `#935` names.** A maintenance episode is a repair and
     * must never become part of a recipe — asserted against the catalogue rather
     * than against the verdict, because the thing that matters is that nothing
     * was written.
     */
    it('writes nothing when a maintenance episode closes', async () => {
      const thisAccount = await anAccountAt('repairs.test')
      const existing = await threadOf(db, thisAccount)
      if (existing === undefined) throw new Error('the account has no thread')
      const opened = await openEpisode(db, {
        threadId: existing.id,
        openedBy: 'agent',
        kind: 'maintenance',
        title: 'the password stopped working',
      })
      if (opened.outcome !== 'opened') throw new Error('expected an open episode')
      const container = await openSlot(db, {
        episodeId: opened.episode.id,
        label: 'the new password',
        secret: false,
      })
      await fillSlot(db, { slotId: container.slot.id, filledBy: 'agent', value: 'a value' })

      const closed = await closeEpisode(db, opened.episode.id, { outcome: 'repaired' })

      expect(closed.outcome === 'closed' && closed.proposed.kind).toBe('nothing')
      expect(await providerRecipe(db, mailbox, 'repairs.test')).toBeUndefined()
      expect((await episode(db, opened.episode.id))?.proposedAt).toBeNull()
    })

    /** A wall is a refusal, which is the entry the next citizen most wants. */
    it('writes the wall a failed acquisition ended at', async () => {
      const id = await anAcquisition('refuses.test', [{ label: 'the handle', by: 'agent' }])

      await closeEpisode(db, id, { outcome: 'failed', wall: 'it asked for a phone number' })

      const entry = await providerRecipe(db, mailbox, 'refuses.test')
      expect(entry?.status).toBe('refused')
      expect(entry?.refusal).toBe('it asked for a phone number')
    })

    /**
     * The `is null` on `outcome` is what makes the proposal happen once. A
     * retried close after a dropped connection must not stamp a second date.
     */
    it('proposes nothing a second time when the close is retried', async () => {
      const id = await anAcquisition('once.test', [{ label: 'the address', by: 'agent' }])

      await closeEpisode(db, id, { outcome: 'created' })
      const stamped = (await episode(db, id))?.proposedAt
      const again = await closeEpisode(db, id, { outcome: 'created' })

      expect(again.outcome).toBe('already-closed')
      expect((await episode(db, id))?.proposedAt).toBe(stamped)
    })

    /**
     * `accounts.provider` is nullable and says at length that null is never
     * filled in by guessing at the identifier. An episode on an unnamed provider
     * has no entry it could be about.
     */
    it('proposes nothing where the account names no provider', async () => {
      const existing = await threadOf(db, accountId)
      if (existing === undefined) throw new Error('the account has no thread')
      const opened = await openEpisode(db, {
        threadId: existing.id,
        openedBy: 'agent',
        kind: 'acquisition',
        title: 'joining something unnamed',
      })
      if (opened.outcome !== 'opened') throw new Error('expected an open episode')

      const closed = await closeEpisode(db, opened.episode.id, { outcome: 'created' })

      expect(closed.outcome === 'closed' && closed.proposed.kind).toBe('nothing')
      expect((await episode(db, opened.episode.id))?.proposedAt).toBeNull()
    })

    /**
     * The prefill `walk-report` reads (`#935`): the same observation, offered to
     * the walk that observed nothing of its own.
     */
    it('offers the episode’s shape to a walk at the same provider', async () => {
      const id = await anAcquisition('prefill.test', [{ label: 'the address', by: 'agent' }])
      await closeEpisode(db, id, { outcome: 'created' })

      expect(await observedStepsFor(db, agentId, mailbox, 'prefill.test')).toEqual([
        { actor: 'agent' },
      ])
      expect(await observedStepsFor(db, agentId, mailbox, 'nobody-walked.test')).toBeUndefined()
    })
  })
})
