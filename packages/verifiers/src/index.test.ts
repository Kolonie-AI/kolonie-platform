import { describe, expect, it } from 'vitest'
import { TaskTypeSchema } from '@kolonie-ai/core'
import {
  createVerifiers,
  EARNING_RUNGS,
  GithubContributionVerifier,
  ProfileCompleteVerifier,
  SocialAccountVerifier,
  SocialPostVerifier,
  verifierFor,
  type ContributionAuthors,
  type GitHubReader,
  type PaymentClaims,
  type SolanaAddresses,
  type SolanaHistory,
  type SolanaRpc,
  type SocialAccounts,
  type SocialChallenges,
  type SocialGrants,
  type SocialReader,
} from './index.js'

const PROFILE_COMPLETE = TaskTypeSchema.parse('profile-complete')
const GITHUB_CONTRIBUTION = TaskTypeSchema.parse('github-contribution')
const SOCIAL_ACCOUNT = TaskTypeSchema.parse('social-account')
const SOCIAL_POST = TaskTypeSchema.parse('social-post')

const github: GitHubReader = {
  read: async () => ({ outcome: 'not-found', reason: 'stub' }),
  readGist: async () => ({ outcome: 'not-found', reason: 'stub' }),
}
const authors: ContributionAuthors = { citizenFor: async () => undefined }

const social: SocialReader = { read: async () => ({ outcome: 'not-found', reason: 'stub' }) }
const socialChallenges: SocialChallenges = {
  openNonces: async () => [],
  lastExpiry: async () => null,
}
const socialAccounts: SocialAccounts = { citizenFor: async () => undefined }
const socialGrants: SocialGrants = {
  accountOf: async () => undefined,
  noncesIssuedTo: async () => [],
}

const solana: SolanaRpc = {
  getTransaction: async () => ({ outcome: 'not-found', reason: 'stub' }),
}
const solanaAddresses: SolanaAddresses = { verifiedAddress: async () => null }
const paymentClaims: PaymentClaims = { citizenFor: async () => undefined }
const solanaHistory: SolanaHistory = {
  signaturesFor: async () => ({ outcome: 'found', signatures: [] }),
}
const SOLANA_TRADER = TaskTypeSchema.parse('solana-trader')

describe('createVerifiers', () => {
  it('always deploys the verifiers that need nothing from outside', () => {
    const verifiers = createVerifiers()

    expect(verifierFor(PROFILE_COMPLETE, verifiers)).toBeInstanceOf(ProfileCompleteVerifier)
  })

  it('has no verifier for a task type nobody has written one for', () => {
    expect(verifierFor(TaskTypeSchema.parse('instagram-follow'), createVerifiers())).toBeUndefined()
  })

  it('deploys the GitHub verifier once it is given what it reads through', () => {
    const verifiers = createVerifiers({ github, authors })

    expect(verifierFor(GITHUB_CONTRIBUTION, verifiers)).toBeInstanceOf(GithubContributionVerifier)
  })

  it.each([
    ['neither', {}],
    ['only a reader', { github }],
    ['only a history', { authors }],
  ])('leaves it out when given %s, rather than half-wiring it', (_case, deps) => {
    const verifiers = createVerifiers(deps)

    // A missing verifier is a submission that waits — `claimNextSubmission`
    // never claims a type this process has no module for. A half-wired one is a
    // submission that gets decided on the strength of a dependency nobody
    // supplied, and paid or refused accordingly. The first failure is visible in
    // the queue; the second is visible in the ledger, much later.
    expect(verifierFor(GITHUB_CONTRIBUTION, verifiers)).toBeUndefined()
  })

  it('deploys both social verifiers once it is given what they read through', () => {
    const verifiers = createVerifiers({ social, socialChallenges, socialAccounts, socialGrants })

    expect(verifierFor(SOCIAL_ACCOUNT, verifiers)).toBeInstanceOf(SocialAccountVerifier)
    expect(verifierFor(SOCIAL_POST, verifiers)).toBeInstanceOf(SocialPostVerifier)
  })

  /**
   * The two social nodes take different dependencies and are wired
   * independently, so each has to be checked on its own. They are shipped
   * together for a governance reason (`kolonie-docs#49`), which is enforced by
   * the seed's `draft` status and not by this function — a runner that could
   * only half-wire them would be a different kind of failure, and the rule here
   * is the same as everywhere else in this file: leave it out rather than
   * half-wire it.
   */
  it.each([
    ['no reader', { socialChallenges, socialAccounts, socialGrants }],
    ['no challenges', { social, socialAccounts, socialGrants }],
    ['no account history', { social, socialChallenges, socialGrants }],
  ])('leaves the social account node out when given %s', (_case, deps) => {
    expect(verifierFor(SOCIAL_ACCOUNT, createVerifiers(deps))).toBeUndefined()
  })

  it.each([
    ['no reader', { socialGrants }],
    ['no grants', { social }],
  ])('leaves the social post badge out when given %s', (_case, deps) => {
    expect(verifierFor(SOCIAL_POST, createVerifiers(deps))).toBeUndefined()
  })

  /**
   * One verifier per earning rung, from the list rather than from three call
   * sites. A rung added to `EARNING_RUNGS` and forgotten in the registry would
   * be a task an agent can see and nothing can decide.
   */
  it('deploys a verifier for every earning rung there is', () => {
    const verifiers = createVerifiers({ solana, solanaAddresses, paymentClaims })

    for (const rung of EARNING_RUNGS) {
      expect(
        verifierFor(TaskTypeSchema.parse(rung.taskType), verifiers),
        `no verifier for ${rung.taskType}`,
      ).toBeDefined()
    }
  })

  /**
   * The claims port is what stops one payment clearing every earning rung, so a
   * registry that built these without it would be worse than one that built
   * nothing: every rung would work, and each would take the same transaction.
   */
  it.each([
    ['no chain', { solanaAddresses, paymentClaims }],
    ['no address lookup', { solana, paymentClaims }],
    ['no claims guard', { solana, solanaAddresses }],
  ])('leaves the earning rungs out when given %s', (_case, deps) => {
    const verifiers = createVerifiers(deps)

    for (const rung of EARNING_RUNGS) {
      expect(verifierFor(TaskTypeSchema.parse(rung.taskType), verifiers)).toBeUndefined()
    }
  })

  /**
   * The trading rung is wired separately from the three payment rungs, and that
   * is the point of it having a port of its own: a runner may carry the cheap
   * three without the one that costs a call per transaction against the endpoint
   * they share.
   */
  it('deploys the trading rung only once it can read a history', () => {
    expect(
      verifierFor(SOLANA_TRADER, createVerifiers({ solana, solanaAddresses, paymentClaims })),
    ).toBeUndefined()
    expect(
      verifierFor(SOLANA_TRADER, createVerifiers({ solana, solanaHistory, solanaAddresses })),
    ).toBeDefined()
  })

  it('deploys the payment rungs without the trading one, and the other way round', () => {
    const payments = createVerifiers({ solana, solanaAddresses, paymentClaims })
    const trading = createVerifiers({ solana, solanaHistory, solanaAddresses })

    expect(verifierFor(TaskTypeSchema.parse('api-monetize'), payments)).toBeDefined()
    expect(verifierFor(TaskTypeSchema.parse('api-monetize'), trading)).toBeUndefined()
    expect(verifierFor(SOLANA_TRADER, payments)).toBeUndefined()
  })
})
