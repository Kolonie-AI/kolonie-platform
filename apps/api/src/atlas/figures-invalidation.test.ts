import { describe, expect, it } from 'vitest'
import type { AccountProofs } from '../account-proofs.js'
import type { AccountRegister } from '../accounts.js'
import type { WalkStore } from '../account-walks.js'
import type { EmailChallenges } from '../email.js'
import type { SmsChallengeStore } from '../sms.js'
import { atlasFiguresCache } from './figures-cache.js'
import {
  tellingAccounts,
  tellingEmail,
  tellingProofs,
  tellingSms,
  tellingWalks,
} from './figures-invalidation.js'

/**
 * Which writes tell the Atlas cache, and which deliberately do not (`#1629`).
 *
 * **Against fake ports and a counter**, because that is what the question is:
 * not whether the query returns the right number — `packages/db` proves that —
 * but whether the process that holds the answer is told when the answer stops
 * being true.
 */
describe('telling the figures cache what changed', () => {
  const warm = async () => {
    const cache = atlasFiguresCache()
    let ran = 0

    await cache.read('public ', () => {
      ran++

      return Promise.resolve([])
    })

    return {
      cache,
      /** Whether the entry survived, read by asking for it again. */
      async stillHeld() {
        await cache.read('public ', () => {
          ran++

          return Promise.resolve([])
        })

        return ran === 1
      },
    }
  }

  /** Every method resolves; the fake exists so the decorator has something to wrap. */
  const nothing = <T extends object>(methods: readonly string[]): T =>
    Object.fromEntries(methods.map((name) => [name, () => Promise.resolve(undefined)])) as T

  describe('a walk', () => {
    const walks = () =>
      nothing<WalkStore>([
        'open',
        'record',
        'finish',
        'submit',
        'withdrawReported',
        'unreported',
        'amend',
        'report',
      ])

    it('invalidates when one closes', async () => {
      const held = await warm()

      await tellingWalks(walks(), held.cache).finish('walk-1', { outcome: 'proved' })

      expect(await held.stillHeld()).toBe(false)
    })

    /**
     * The retiring `provider-report` alias writes a walk, so *filing a provider
     * report* and *closing a walk* are one event since `#1036`. Both are here so
     * that stays true if the alias ever grows a path of its own.
     */
    it('invalidates when a report is filed as one', async () => {
      const held = await warm()

      await tellingWalks(walks(), held.cache).submit(
        'agent-1' as never,
        { kind: 'mailbox' as never, provider: 'somewhere.test' },
        { outcome: 'refused' },
      )

      expect(await held.stillHeld()).toBe(false)
    })

    it('invalidates when a filed report is withdrawn', async () => {
      const held = await warm()

      await tellingWalks(walks(), held.cache).withdrawReported('agent-1' as never, {
        kind: 'mailbox' as never,
        provider: 'somewhere.test',
      })

      expect(await held.stillHeld()).toBe(false)
    })

    /**
     * **Opening one does not**, and that is the CTE's own rule rather than a
     * saving: a walk with `finished_at` null is not in the figures at all, so
     * every step of every walk in progress would throw the Atlas away for
     * nothing.
     */
    it('does not invalidate while one is merely in progress', async () => {
      const held = await warm()
      const telling = tellingWalks(walks(), held.cache)

      await telling.open('agent-1' as never, {
        kind: 'mailbox' as never,
        provider: 'somewhere.test',
      })
      await telling.record('walk-1', { actor: 'agent' })

      expect(await held.stillHeld()).toBe(true)
    })

    /**
     * A write that threw may still have committed part of what it did. One
     * unnecessary recomputation is the cheaper side of that.
     */
    it('invalidates even when the write fails', async () => {
      const held = await warm()
      const failing = {
        ...walks(),
        finish: () => Promise.reject(new Error('deadlock detected')),
      } as unknown as WalkStore

      await expect(
        tellingWalks(failing, held.cache).finish('walk-1', { outcome: 'proved' }),
      ).rejects.toThrow('deadlock detected')
      expect(await held.stillHeld()).toBe(false)
    })
  })

  describe('an account', () => {
    const register = () =>
      nothing<AccountRegister>([
        'list',
        'declare',
        'setStatus',
        'forget',
        'setNote',
        'setProvider',
        'setForWork',
        'setAttestable',
        'setShownOnProfile',
        'providers',
        'troubles',
        'setVaultKey',
        'prefer',
      ])

    it('invalidates when one is proved by a redeemed code', async () => {
      const held = await warm()
      const email = nothing<EmailChallenges>(['mint', 'redeem', 'inbound', 'latest'])

      await tellingEmail(email, held.cache).redeem('agent-1' as never, '123456')

      expect(await held.stillHeld()).toBe(false)
    })

    it('invalidates when one is proved by an arriving message', async () => {
      const held = await warm()
      const sms = nothing<SmsChallengeStore>(['mint', 'redeem', 'recordInbound', 'latest'])

      await tellingSms(sms, held.cache).recordInbound({} as never)

      expect(await held.stillHeld()).toBe(false)
    })

    it('invalidates when one is proved by a page the Colony read', async () => {
      const held = await warm()
      const proofs = nothing<AccountProofs>(['mint', 'open', 'redeemPost', 'inbound'])

      await tellingProofs(proofs, held.cache).redeemPost(
        'agent-1' as never,
        'proof-1',
        'https://somewhere.test/proof',
      )

      expect(await held.stillHeld()).toBe(false)
    })

    it('invalidates when one is declared, retired or re-providered', async () => {
      for (const write of [
        (port: AccountRegister) =>
          port.declare('agent-1' as never, { kind: 'mailbox' as never, identifier: 'a@b.test' }),
        (port: AccountRegister) => port.setStatus('agent-1' as never, 'account-1', 'retired'),
        (port: AccountRegister) => port.forget('agent-1' as never, 'account-1'),
        (port: AccountRegister) => port.setForWork('agent-1' as never, 'account-1', false),
        (port: AccountRegister) => port.setProvider('agent-1' as never, 'account-1', 'other.test'),
      ]) {
        const held = await warm()

        await write(tellingAccounts(register(), held.cache))

        expect(await held.stillHeld()).toBe(false)
      }
    })

    /**
     * **A cache told about writes it does not care about never gets to be warm.**
     * None of these is read by `atlasFigures`.
     */
    it('does not invalidate for a note, a flag or a preference', async () => {
      for (const write of [
        (port: AccountRegister) => port.setNote('agent-1' as never, 'account-1', 'a note'),
        (port: AccountRegister) => port.setAttestable('agent-1' as never, 'account-1', true),
        (port: AccountRegister) => port.setShownOnProfile('agent-1' as never, 'account-1', true),
        (port: AccountRegister) => port.setVaultKey('agent-1' as never, 'account-1', 'a/key'),
        (port: AccountRegister) => port.prefer('agent-1' as never, 'account-1'),
      ]) {
        const held = await warm()

        await write(tellingAccounts(register(), held.cache))

        expect(await held.stillHeld()).toBe(true)
      }
    })
  })

  /**
   * The spread is what makes a decorator survive a port growing a method, and
   * this is the assertion that says so — a read added to `WalkStore` tomorrow
   * must still be reachable through the wrapper.
   */
  it('forwards every method it does not wrap', async () => {
    const cache = atlasFiguresCache()
    const walks = {
      ...nothing<WalkStore>(['finish', 'submit', 'withdrawReported', 'amend', 'report']),
      list: () => Promise.resolve(['a walk']),
    } as unknown as WalkStore

    expect(await tellingWalks(walks, cache).list('agent-1' as never)).toEqual(['a walk'])
  })
})
