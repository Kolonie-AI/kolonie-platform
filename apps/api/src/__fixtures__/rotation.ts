import { CredentialIdSchema, type RotateCredentialResponse } from '@kolonie-ai/core'
import type { CredentialRotation } from '../rotation.js'
import { fakeStore, type FakeStore } from './store.js'

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
 */
export function fakeRotation(store: FakeStore = fakeStore()): CredentialRotation {
  return {
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
      }

      return response
    },
  }
}
