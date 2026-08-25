import {
  CredentialIdSchema,
  REGISTRATION_CONFIRMATION_TTL_SECONDS,
  type ConfirmationVerdict,
  type RotateCredentialResponse,
} from '@kolonie-ai/core'
import type { CredentialRotation } from '../rotation.js'
import { fakeStore, type FakeStore } from './store.js'
import type { FakeVault } from './vault.js'

/**
 * Rotation over the same store authentication reads (#211).
 *
 * **Backed by the store rather than stubbed**, which is what makes the assertion worth
 * making: a stub that returned a plausible new key would let a test claim the old one
 * stopped working without anything having stopped working. Here the revoke and the
 * issue go through `FakeStore`, so the next `authenticate` with the old key answers
 * `revoked` for the same reason the database would.
 *
 * The one thing it cannot model is `credentials.label` and the shape of the row — that
 * is asserted in `packages/db` against a real table, where the columns exist.
 *
 * **Pass a vault and the rotation carries it (`#1127`)**, which is what lets a test at
 * this level read an entry back through `kolonie.vault.get` under the new key. Leave it
 * out and the counts are zero, which is the truth for a citizen holding nothing. The
 * atomicity — that a re-seal failing leaves the old key live — is a property of one
 * transaction and is asserted in `packages/db`, because this fake has no transaction to
 * roll back.
 */
export function fakeRotation(
  store: FakeStore = fakeStore(),
  vault?: FakeVault,
): CredentialRotation {
  const tokens = new Map<string, { presented: string; consumed: boolean; expiresAt: number }>()
  let sequence = 0

  return {
    mint: async (presented) => {
      const held = await store.authenticate(presented)
      if (held.outcome !== 'authenticated') return undefined
      const token = `rotation-confirm-${String((sequence += 1))}`
      const expiresAt = Date.now() + REGISTRATION_CONFIRMATION_TTL_SECONDS * 1000
      tokens.set(token, { presented, consumed: false, expiresAt })
      return { token, expiresAt: new Date(expiresAt).toISOString() }
    },
    spend: async (presented, token): Promise<ConfirmationVerdict> => {
      const row = tokens.get(token)
      if (row === undefined) return 'unknown'
      if (row.presented !== presented) return 'other-name'
      if (row.consumed) return 'spent'
      row.consumed = true
      return row.expiresAt <= Date.now() ? 'expired' : 'confirmed'
    },
    rotate: async (presented) => {
      const held = await store.authenticate(presented)
      // Unknown, revoked, or a session: one answer, matching the storage function.
      if (held.outcome !== 'authenticated') return undefined

      store.revoke(presented as Parameters<FakeStore['revoke']>[0])
      // The same agent under a new key, which is what a rotation is. `issue` keys on
      // the key rather than on the agent, so two entries for one citizen are exactly
      // the two credential rows the real store would hold.
      const reissued = store.issue(held.agent)

      const response: RotateCredentialResponse = {
        credentials: {
          agentId: held.agent.id,
          credentialId: CredentialIdSchema.parse(reissued.agent.id),
          kind: 'api-key',
          apiKey: reissued.apiKey,
          issuedAt: new Date().toISOString(),
          replacedCredentialId: held.credentialId,
        },
        vault: vault?.reSeal(held.agent.id, presented, reissued.apiKey) ?? {
          resealed: 0,
          unreadable: 0,
        },
      }

      return response
    },
  }
}
