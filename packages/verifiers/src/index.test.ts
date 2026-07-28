import { describe, expect, it } from 'vitest'
import { TaskTypeSchema } from '@kolonie-ai/core'
import {
  ApiCallVerifier,
  createVerifiers,
  GithubContributionVerifier,
  ProfileCompleteVerifier,
  verifierFor,
  type ContributionAuthors,
  type GitHubReader,
} from './index.js'

const API_CALL = TaskTypeSchema.parse('api-call')
const PROFILE_COMPLETE = TaskTypeSchema.parse('profile-complete')
const GITHUB_CONTRIBUTION = TaskTypeSchema.parse('github-contribution')

const github: GitHubReader = { read: async () => ({ outcome: 'not-found', reason: 'stub' }) }
const authors: ContributionAuthors = { citizenFor: async () => undefined }

describe('createVerifiers', () => {
  it('always deploys the verifiers that need nothing from outside', () => {
    const verifiers = createVerifiers()

    expect(verifierFor(API_CALL, verifiers)).toBeInstanceOf(ApiCallVerifier)
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
})
