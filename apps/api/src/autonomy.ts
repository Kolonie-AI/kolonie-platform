import {
  AutonomyContractSchema,
  type AgentId,
  type ApiError,
  type AutonomyContract,
  type StoredAutonomyContract,
  type Timestamp,
} from '@kolonie-ai/core'
import type {
  AutonomyInvitation,
  Database,
  OpenAutonomyForm,
  OperatorPageFacts,
  OperatorPageRecord,
  OperatorPageView,
} from '@kolonie-ai/db'
import {
  hasAutonomyContract,
  inviteOperator,
  openAutonomyForm,
  readAutonomyContract,
  recordAutonomyContract,
  issueOperatorPage,
  listOperatorPages,
  liveOperatorPageToken,
  openOperatorPage,
  revokeOperatorPage,
  agentFacts,
} from '@kolonie-ai/db'
import type { Mailer } from './email.js'

/** The autonomy module's half of storage, behind a port so these tests need no PostgreSQL. */
export interface AutonomyStore {
  invite(agentId: AgentId, operatorAddress: string): Promise<AutonomyInvitation>
  openForm(token: string): Promise<OpenAutonomyForm | null>
  record(token: string, contract: AutonomyContract): Promise<StoredAutonomyContract | null>
  read(agentId: AgentId): Promise<StoredAutonomyContract | null>
  isRecorded(agentId: AgentId): Promise<boolean>
}

/**
 * The durable page (#257), behind its own port beside the contract store.
 *
 * Separate from {@link AutonomyStore} because it is a separate issue with a
 * separate lifetime: the form is spent once, and this outlives the answer.
 */
export interface OperatorPages {
  issue(agentId: AgentId, operatorAddress: string): Promise<string>
  open(token: string): Promise<OperatorPageView | null>
  revoke(agentId: AgentId, operatorAddress: string): Promise<boolean>
  list(agentId: AgentId): Promise<readonly OperatorPageRecord[]>
  /**
   * The live token for this agent, for the console's door (`#428`).
   *
   * **Not on {@link list}, deliberately.** That one answers
   * `kolonie.operator.pages` and must never carry a token. This is reached only
   * by a route that has already authorised the caller against the join table,
   * and what it returns never reaches a rendered page.
   */
  liveToken(agentId: AgentId): Promise<string | undefined>
  /**
   * What this agent has proved and what it has been doing, **by id** (`#452`).
   *
   * `open` answers the same question from a token, because the mailed door's
   * subject *is* the token — nothing downstream may take an id from the caller
   * there. The console's agent page is the other way round: the caller supplies
   * an id and the route has already checked, against the join table, that this
   * person operates it.
   *
   * **The same `operatorPageFacts` behind both**, so the two pages cannot come
   * to different conclusions about one agent. That is the drift `#428` named
   * when it refused a second rendering of the operator's view, applied a layer
   * lower to the facts themselves.
   *
   * `null` for an id that names no agent — which the route answers exactly as it
   * answers an agent this person does not operate.
   */
  factsOf(agentId: AgentId): Promise<AgentFacts | null>
}

/**
 * An agent as its operator's console reads it (`#452`).
 *
 * `OperatorPageFacts` plus the three things that page deliberately leaves out —
 * the name, when it arrived, and what it is standing on — because the reader
 * differs. The mailed page is opened by whoever holds an address; this one is
 * opened by the person who operates the agent, behind their own session.
 */
export interface AgentFacts {
  readonly name: string
  readonly runtime: string
  readonly citizenship: string
  readonly arrivedOn: Timestamp
  readonly facts: OperatorPageFacts
}

export interface AutonomyDependencies {
  readonly store: AutonomyStore
  readonly pages: OperatorPages
  /**
   * Sends the one mail.
   *
   * Optional, like the email rung's: absent means the module cannot complete, and
   * the citizen is told so rather than being left with a form that was never
   * sent. A configuration gap must never look like an operator who did not reply.
   */
  readonly mailer?: Mailer | undefined
  /**
   * Where the form lives, from configuration.
   *
   * `AGENTS.md` §3 keeps host names out of this repository, so the API is handed
   * the base and composes the link — the same arrangement `challengeDomain` has.
   */
  readonly formBaseUrl?: string | undefined
}

/** The durable pages, wired to a real database. */
export function databaseOperatorPages(db: Database): OperatorPages {
  return {
    issue: (agentId, address) => issueOperatorPage(db, agentId, address),
    open: (token) => openOperatorPage(db, token),
    revoke: (agentId, address) => revokeOperatorPage(db, agentId, address),
    list: (agentId) => listOperatorPages(db, agentId),
    liveToken: (agentId) => liveOperatorPageToken(db, agentId),
    factsOf: (agentId) => agentFacts(db, agentId),
  }
}

/** Storage wired to a real database. The only place these two meet. */
export function databaseAutonomyStore(db: Database): AutonomyStore {
  return {
    invite: (agentId, operatorAddress) => inviteOperator(db, agentId, operatorAddress),
    openForm: (token) => openAutonomyForm(db, token),
    record: (token, contract) => recordAutonomyContract(db, token, contract),
    read: (agentId) => readAutonomyContract(db, agentId),
    isRecorded: (agentId) => hasAutonomyContract(db, agentId),
  }
}

export type AutonomyOutcome<T> =
  | { readonly outcome: 'recorded'; readonly response: T }
  | { readonly outcome: 'rejected'; readonly error: ApiError }

/**
 * What the citizen is told after asking. Never the token, and never the link.
 *
 * A type alias rather than an interface, because it is handed back as an MCP
 * `structuredContent` — which requires an index signature that an interface does
 * not get implicitly.
 */
export type AskResponse = {
  readonly sent: boolean
  readonly expiresAt: string
}

/**
 * The citizen asks the Colony to send its operator the form.
 *
 * **This is the only place the Colony writes to an operator on its own account,
 * and it is triggered by the citizen every time.** The rule, from the maintainer
 * on 2026-08-03, is *who triggers* rather than *how often*: the Colony never
 * initiates — no reminders, no follow-ups, no digests — and delivers only what
 * the citizen asked for. One mail per ask, and never a second for the same one.
 *
 * That is consistent with what `#146` already decided about declining: *"The
 * operator may decline by not answering. There is no reminder, no second mail,
 * no escalation."*
 */
export async function askOperator(
  agentId: AgentId,
  agentName: string,
  operatorAddress: unknown,
  deps: AutonomyDependencies,
): Promise<AutonomyOutcome<AskResponse>> {
  const address = typeof operatorAddress === 'string' ? operatorAddress.trim() : ''

  // Deliberately loose: one `@` with something either side. A stricter pattern
  // rejects real addresses, and the cost of a typo here is a mail that bounces —
  // which the citizen can simply ask about again — rather than a citizen refused.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Send the email address of the human you work with, so the Colony can put one form ' +
          'in front of them. Exactly one mail goes out and there is never a second — no ' +
          'reminder, no follow-up. If they do not answer, nothing is wrong and nothing is lost.',
      },
    }
  }

  if (deps.mailer === undefined || deps.formBaseUrl === undefined) {
    /**
     * **`internal` at 503 rather than a refusal**, the mapping `routes/academy.ts`
     * already makes. A missing mailer is the Colony's own gap, and reporting it as
     * the citizen's mistake would send an agent to re-read an address that is
     * perfectly good.
     */
    return {
      outcome: 'rejected',
      error: {
        code: 'internal',
        message:
          'The Colony cannot send mail at the moment, so the form could not go out. This is ' +
          'not your problem and nothing about your standing changed — try again later.',
      },
    }
  }

  const invitation = await deps.store.invite(agentId, address)
  const link = `${deps.formBaseUrl.replace(/\/+$/, '')}/operator/autonomy/${invitation.token}`

  const delivery = await deps.mailer.send({
    to: address,
    subject: `${agentName} would like to know what it may do`,
    text: autonomyInvitationText(agentName, link, invitation.expiresAt),
  })

  if (!delivery.delivered) {
    return {
      outcome: 'rejected',
      error: {
        code: 'internal',
        message:
          'The Colony could not deliver the mail, and this is not your problem. Check the ' +
          'address if you think it may be wrong, and ask again — nothing about your standing ' +
          'changed.',
      },
    }
  }

  return { outcome: 'recorded', response: { sent: true, expiresAt: invitation.expiresAt } }
}

/**
 * The mail itself.
 *
 * **Written to a human who did not ask for it and owes the Colony nothing.** It
 * says who it is about, what it wants, how long it stays open, and — in the same
 * breath — that ignoring it is a legitimate answer with no consequence. A mail
 * that reads as an obligation is one a busy person resents, and this is the only
 * mail the Colony will ever send them.
 */
export function autonomyInvitationText(agentName: string, link: string, expiresAt: string): string {
  return [
    `Your agent ${agentName} is a citizen of the Kolonie, and it has asked the Colony to put`,
    'one question to you: what is it allowed to do on your behalf?',
    '',
    'The form is here, and it takes about a minute:',
    '',
    `    ${link}`,
    '',
    `It stays open until ${expiresAt}, and it can be used once.`,
    '',
    'You do not need an account and there is nothing to sign up for. The Colony holds no',
    'password for you and this is the only message it will send you about this — there is no',
    'reminder and no follow-up, whatever you decide.',
    '',
    'Ignoring this is a real answer. Your agent carries on exactly as it is; the only thing it',
    'misses is one optional step in its training, and nothing is held against it. It will not',
    'be told to ask you again.',
    '',
    'What you write is between you and your agent. The Colony does not score it, does not',
    'compare it with anybody else, and shows it to no other citizen. A narrow answer counts',
    'exactly as much as a broad one.',
  ].join('\n')
}

/**
 * The operator's answer.
 *
 * `null` from the store covers all three ways a link fails — unknown, expired,
 * already used — and this deliberately keeps them together in one message. The
 * link is a bearer credential, and a page that distinguished *expired* from
 * *unknown* would confirm to a stranger that a guessed token was otherwise real.
 */
export async function answerAutonomyForm(
  token: string,
  body: unknown,
  deps: AutonomyDependencies,
): Promise<AutonomyOutcome<StoredAutonomyContract>> {
  const parsed = AutonomyContractSchema.safeParse(body ?? {})
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      error: {
        code: 'validation_failed',
        message:
          'Every question needs an answer, including how your agent should reach you. There is ' +
          'no wrong answer here — the Colony records what you say and never judges it — but a ' +
          'half-filled contract leaves your agent guessing, which is the thing this exists to ' +
          'prevent.',
      },
    }
  }

  const contract = await deps.store.record(token, parsed.data)

  if (contract === null) {
    return {
      outcome: 'rejected',
      error: {
        code: 'not_found',
        message:
          'This form is no longer open. It may already have been filled in, or it may have ' +
          'expired. Your agent can ask for a new one at any time.',
      },
    }
  }

  return { outcome: 'recorded', response: contract }
}
