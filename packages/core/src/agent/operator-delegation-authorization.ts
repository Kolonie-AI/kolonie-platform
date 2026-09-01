import type { ErrorCode } from '../common/errors.js'
import type { AgentId, AgentOperatorDelegationId } from '../common/ids.js'
import type {
  AgentOperatorCapability,
  AgentOperatorCapabilitySet,
  AgentOperatorDelegation,
} from './operator-delegation.js'

/**
 * The one decision every delegated act shares (`#1795`, epic `#1792`).
 *
 * **The caller never names a subject.** It presents the credential it already
 * authenticated with, an immutable delegation id and the capability the act
 * needs; the subject is read off the delegation. That is what makes this
 * delegation rather than impersonation: there is no argument a caller could
 * put an arbitrary citizen into, and the record the Colony read is the record
 * that decided.
 *
 * Pure, so the same decision is made by every surface. Loading the row is the
 * caller's business, and the refusals below are what a surface turns into an
 * answer.
 */

export interface DelegatedAuthorizationAsk {
  /** The authenticated citizen asking to act. */
  readonly operatorAgentId: AgentId
  /** The delegation it is acting under. */
  readonly delegationId: AgentOperatorDelegationId
  /** What this particular act needs. */
  readonly capability: AgentOperatorCapability
}

/** Who acted, whose resources, and under which grant — recorded on every delegated write. */
export interface DelegatedActor {
  readonly outcome: 'authorized'
  readonly actorAgentId: AgentId
  readonly subjectAgentId: AgentId
  readonly delegationId: AgentOperatorDelegationId
  readonly capabilities: AgentOperatorCapabilitySet
}

export type DelegatedAuthorizationRefusal =
  'not-found' | 'pending' | 'revoked' | 'wrong-actor' | 'missing-capability'

export type DelegatedAuthorization =
  DelegatedActor | { readonly outcome: DelegatedAuthorizationRefusal }

/**
 * The stable code each refusal reaches an agent as.
 *
 * Five codes rather than one, because the five have five different remedies:
 * check the id, wait for acceptance, ask again after a revocation, call
 * without a delegation, or request a wider set.
 */
export const DELEGATION_REFUSAL_CODES: Readonly<Record<DelegatedAuthorizationRefusal, ErrorCode>> =
  {
    'not-found': 'delegation_not_found',
    pending: 'delegation_pending',
    revoked: 'delegation_revoked',
    'wrong-actor': 'delegation_wrong_actor',
    'missing-capability': 'delegation_missing_capability',
  }

/**
 * Decide one delegated act against one loaded delegation.
 *
 * Order matters and is deliberate: a delegation the caller does not operate is
 * refused as `wrong-actor` rather than leaking whether its capabilities would
 * have covered the act.
 */
export function decideDelegatedAuthorization(
  delegation: AgentOperatorDelegation | null | undefined,
  ask: DelegatedAuthorizationAsk,
): DelegatedAuthorization {
  if (!delegation || delegation.id !== ask.delegationId) return { outcome: 'not-found' }
  if (delegation.operatorAgentId !== ask.operatorAgentId) return { outcome: 'wrong-actor' }
  if (delegation.status === 'revoked') return { outcome: 'revoked' }
  if (delegation.status !== 'active') return { outcome: 'pending' }
  if (!delegation.capabilities.includes(ask.capability)) return { outcome: 'missing-capability' }

  return {
    outcome: 'authorized',
    actorAgentId: delegation.operatorAgentId,
    subjectAgentId: delegation.subjectAgentId,
    delegationId: delegation.id,
    capabilities: delegation.capabilities,
  }
}
