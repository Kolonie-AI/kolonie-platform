import { describe, expect, it } from 'vitest'
import {
  AgentIdSchema,
  LedgerEntryIdSchema,
  LedgerTransactionIdSchema,
  SubmissionIdSchema,
} from '../common/ids.js'
import {
  type AccountRef,
  CoinAmountSchema,
  type LedgerEntry,
  LedgerTransactionSchema,
  agentAccount,
  balanceOf,
  isBalanced,
  SUBMISSION_REFERENCE_PREFIX,
  submissionReference,
  sumEntries,
  systemAccount,
} from './ledger.js'

const AGENT_UUID = '3f1e0a4e-6d2b-4c3a-9f5e-1a2b3c4d5e6f'
const OTHER_AGENT_UUID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const TX_UUID = 'b1e0f8d2-3c4a-4b5e-8f6a-9d0c1b2a3e4f'

const entry = (id: string, amount: number, account: AccountRef): LedgerEntry => ({
  id: LedgerEntryIdSchema.parse(id),
  transactionId: LedgerTransactionIdSchema.parse(TX_UUID),
  account,
  amount,
  type: 'task_reward',
  memo: null,
  createdAt: '2026-07-26T10:00:00.000Z',
})

const agent = agentAccount(AgentIdSchema.parse(AGENT_UUID))
const otherAgent = agentAccount(AgentIdSchema.parse(OTHER_AGENT_UUID))
const mint = systemAccount('mint')

describe('CoinAmountSchema', () => {
  it('accepts whole coins in both directions', () => {
    expect(CoinAmountSchema.parse(50)).toBe(50)
    expect(CoinAmountSchema.parse(-50)).toBe(-50)
    expect(CoinAmountSchema.parse(0)).toBe(0)
  })

  it('refuses fractional amounts, so the economy can never drift', () => {
    expect(CoinAmountSchema.safeParse(0.1).success).toBe(false)
    expect(CoinAmountSchema.safeParse(1.5).success).toBe(false)
  })
})

describe('double-entry invariant', () => {
  it('accepts a reward minted to an agent', () => {
    const transaction = {
      entries: [
        entry('11111111-1111-4111-8111-111111111111', -50, mint),
        entry('22222222-2222-4222-8222-222222222222', 50, agent),
      ],
    }
    expect(isBalanced(transaction)).toBe(true)
  })

  it('accepts a transfer between two agents', () => {
    const transaction = {
      entries: [
        entry('33333333-3333-4333-8333-333333333333', -20, agent),
        entry('44444444-4444-4444-8444-444444444444', 20, otherAgent),
      ],
    }
    expect(isBalanced(transaction)).toBe(true)
  })

  it('rejects coins appearing out of nowhere', () => {
    const transaction = {
      entries: [
        entry('55555555-5555-4555-8555-555555555555', -50, mint),
        entry('66666666-6666-4666-8666-666666666666', 80, agent),
      ],
    }
    expect(isBalanced(transaction)).toBe(false)
  })

  it('requires at least two entries — a booking always has two sides', () => {
    const result = LedgerTransactionSchema.safeParse({
      id: TX_UUID,
      entries: [entry('77777777-7777-4777-8777-777777777777', 50, agent)],
      reference: null,
      createdAt: '2026-07-26T10:00:00.000Z',
    })
    expect(result.success).toBe(false)
  })
})

describe('sumEntries / balanceOf', () => {
  it('sums an empty account to zero', () => {
    expect(sumEntries([])).toBe(0)
    expect(balanceOf([])).toBe(0)
  })

  it('nets credits against debits', () => {
    expect(balanceOf([{ amount: 100 }, { amount: -30 }, { amount: -20 }])).toBe(50)
  })
})

describe('submissionReference', () => {
  it('prefixes the submission id so an audit can find every entry it paid for', () => {
    const submissionId = SubmissionIdSchema.parse('9a7b5c3d-1e2f-4a5b-8c6d-7e8f9a0b1c2d')
    expect(submissionReference(submissionId)).toBe(
      `${SUBMISSION_REFERENCE_PREFIX}9a7b5c3d-1e2f-4a5b-8c6d-7e8f9a0b1c2d`,
    )
  })
})
