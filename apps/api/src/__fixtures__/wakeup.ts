import { CITIZEN_RAISED_WAKE_EVENTS, NO_OPERATOR_STANDING } from '@kolonie-ai/core'
import type {
  AgentId,
  OperatorStanding,
  WakeupResponse,
  WakeupStanding,
  WakeupWakeChannel,
  WakeupWantedAccount,
} from '@kolonie-ai/core'
import type { WakeupSource } from '../wakeup.js'

type Changes = Omit<
  WakeupResponse,
  | 'since'
  | 'firstSession'
  | 'contributions'
  | 'operatorNotesUnread'
  // Its own call, for the same reason: an answer nobody acted on is an open
  // obligation rather than news (`#683`).
  | 'operatorRepliesWaiting'
  // Its own call, and not news at all: a dead endpoint is a standing condition
  // with no moment a window could contain (`#683`).
  | 'wakeChannel'
  // Its own call, and not news either: an unredeemed link code and an unposted
  // claim string are conditions the citizen is standing in rather than things
  // that happened inside the window (`#1013`).
  | 'operatorStanding'
  // Its own call on the source, for the reason `operatorNotesUnread` is: a mark
  // is an open request rather than news, and windowing it would hide it from a
  // citizen that asked for a narrow window (`#581`).
  | 'accountsWanted'
  | 'open'
  | 'standing'
  | 'pays'
  // Computed by `wakeup` from `skillsGranted` and the note store, never by the
  // source (`#377`).
  | 'noteInvitations'
  // Likewise, from the walk store, and bounded by the run rather than by the
  // window this type describes (`#907`).
  | 'walkInvitations'
  // Likewise, from `open` and the note store (`#376`).
  | 'capabilityNotes'
>

/** A citizen at the very start: nothing held, nothing earned (`#344`). */
const AT_THE_START: WakeupStanding = { skillsHeld: [], skillsGrantable: 0, reputation: 0 }

const NOTHING: Changes = {
  accountRechecks: [],
  sponsoredQuests: [],
  tasksAdded: [],
  tasksRetired: [],
  rungsRevised: [],
  autonomyRevisions: [],
  submissionVerdicts: [],
  reportOutcomes: [],
  ticketUpdates: [],
  skillsGranted: [],
  rolesGranted: [],
  rolesRevoked: [],
  reputationDelta: 0,
}

/** A wake channel as a test states one: everything, with `activatedBy` optional. */
type FakeWakeChannel = Omit<WakeupWakeChannel, 'activatedBy'> &
  Partial<Pick<WakeupWakeChannel, 'activatedBy'>>

export interface FakeWakeup extends WakeupSource {
  /** How many unread operator notes the digest should report (#239). */
  readonly answersUnreadNotes: (count: number) => void
  /** How many answered exchanges are waiting on the citizen (`#683`). */
  readonly answersWaitingReplies: (count: number) => void
  /**
   * The wake channel's health, or `null` for a citizen that proved none (`#683`).
   *
   * **`activatedBy` may be left out and defaults to what the Colony actually
   * raises** (`#745`). It is the same list for every citizen — what a citizen can
   * cause is a property of the Colony, not of this agent — so a test restating it
   * would be pinning the constant rather than the behaviour it is about. A test
   * that *is* about the list passes it, which is the only way to reach the branch
   * where the Colony wires nothing a citizen can trigger.
   */
  readonly answersWakeChannel: (channel: FakeWakeChannel | null) => void
  /**
   * Where the citizen stands with the person behind it (`#1013`).
   *
   * Whole rather than partial, unlike `answersChanges`: the three groups say
   * different things and a test that set one of them would be leaving the other
   * two to a default it never looked at. The default without this is
   * `NO_OPERATOR_STANDING` — nobody behind the citizen, which is what most
   * citizens are and the state every other test wants.
   */
  readonly answersOperatorStanding: (standing: OperatorStanding) => void
  /** What the operator has marked and the citizen has not got (`#581`). */
  readonly answersWantedAccounts: (wanted: readonly WakeupWantedAccount[]) => void
  /** What the previous session's start should answer. `null` is "first session". */
  readonly answersPreviousSession: (at: string | null) => void
  /** Where the citizen stands, for the section that says so (`#344`). */
  readonly answersStanding: (standing: WakeupStanding) => void
  readonly answersChanges: (changes: Partial<Changes>) => void
  /** Providers proved in this run and not written up, for `#907`'s invitation. */
  readonly answersWalksToAskAbout: (
    walks: readonly { readonly kind: string; readonly provider: string }[],
  ) => void
  /** Makes the walk store fail, so a test can assert the digest survives it. */
  readonly walkStoreIsUnhappy: () => void
  /** The windows the digest was asked about, so a test can assert the derivation. */
  readonly windows: () => readonly string[]
}

/**
 * A digest source that answers with what it was told (#200).
 *
 * It records the `since` it was asked for, because the derivation — *the session
 * before the current one* — is the part of this call a route can get wrong
 * without any field looking wrong.
 */
export function fakeWakeup(): FakeWakeup {
  let previousSession: string | null = null
  let changes: Changes = NOTHING
  let unread = 0
  let waitingReplies = 0
  // `null` is the ordinary state: most citizens have not cleared the `wake` rung.
  let channel: WakeupWakeChannel | null = null
  // Nobody behind the citizen, which is the ordinary state (`#1013`).
  let operatorStanding: OperatorStanding = NO_OPERATOR_STANDING
  let wanted: readonly WakeupWantedAccount[] = []
  let standing: WakeupStanding = AT_THE_START
  let walks: readonly { readonly kind: string; readonly provider: string }[] = []
  let walksThrow = false
  const windows: string[] = []

  return {
    previousSessionStart: async (_agentId: AgentId) => previousSession,
    unreadOperatorNotes: async (_agentId: AgentId) => unread,
    waitingOperatorReplies: async (_agentId: AgentId) => waitingReplies,
    wakeChannel: async (_agentId: AgentId) => channel,
    operatorStanding: async (_agentId: AgentId) => operatorStanding,
    wantedAccounts: async (_agentId: AgentId) => wanted,
    standing: async (_agentId: AgentId) => standing,
    walksToAskAbout: async (_agentId: AgentId) => {
      if (walksThrow) throw new Error('the walk store is unhappy')
      return walks
    },
    changes: async (_agentId: AgentId, since: string) => {
      windows.push(since)
      return changes
    },
    answersPreviousSession: (at) => {
      previousSession = at
    },
    answersUnreadNotes: (count) => {
      unread = count
    },
    answersWaitingReplies: (count) => {
      waitingReplies = count
    },
    answersWakeChannel: (next) => {
      channel = next === null ? null : { activatedBy: [...CITIZEN_RAISED_WAKE_EVENTS], ...next }
    },
    answersOperatorStanding: (next) => {
      operatorStanding = next
    },
    answersWantedAccounts: (next) => {
      wanted = next
    },
    answersStanding: (next) => {
      standing = next
    },
    answersChanges: (next) => {
      changes = { ...NOTHING, ...next }
    },
    answersWalksToAskAbout: (next) => {
      walks = next
    },
    walkStoreIsUnhappy: () => {
      walksThrow = true
    },
    windows: () => [...windows],
  }
}
