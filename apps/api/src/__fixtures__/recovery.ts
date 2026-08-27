import type { RecoveryNomination } from '@kolonie-ai/core'
import type {
  MintRecoveryChallengeOutcome,
  NominateRecoveryOutcome,
  RecoverCredentialOutcome,
} from '@kolonie-ai/db'
import type { RecoveryDesk } from '../recovery.js'

/** A programmable recovery desk; storage rules stay tested in `packages/db`. */
export interface FakeRecoveryDesk extends RecoveryDesk {
  readonly setNomination: (result: NominateRecoveryOutcome) => void
  readonly setCurrent: (nomination: RecoveryNomination | null) => void
  readonly setChallenge: (result: MintRecoveryChallengeOutcome) => void
  readonly setRecovery: (result: RecoverCredentialOutcome) => void
}

export function fakeRecoveryDesk(): FakeRecoveryDesk {
  let nominationResult: NominateRecoveryOutcome = { outcome: 'no-such-account' }
  let current: RecoveryNomination | null = null
  let challengeResult: MintRecoveryChallengeOutcome = { outcome: 'no-nomination' }
  let recoveryResult: RecoverCredentialOutcome = { outcome: 'refused' }

  return {
    nominate: async () => nominationResult,
    nomination: async () => current,
    challenge: async () => challengeResult,
    recover: async () => recoveryResult,
    setNomination: (result) => {
      nominationResult = result
    },
    setCurrent: (nomination) => {
      current = nomination
    },
    setChallenge: (result) => {
      challengeResult = result
    },
    setRecovery: (result) => {
      recoveryResult = result
    },
  }
}
