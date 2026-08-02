import { describe, expect, it } from 'vitest'
import { AgentIdSchema, CAPABILITY_STAGE, type AgentId } from '@kolonie-ai/core'
import { CHALLENGE_TASK_TYPES } from '@kolonie-ai/db'
import { randomUUID } from 'node:crypto'
import { recordingObstruction, type RecordObstruction } from './obstruction.js'
import { fakeObstruction } from './__fixtures__/obstruction.js'
import { openVisionChallenge } from './vision.js'
import { openEmailChallenge, openEmailSendChallenge } from './email.js'
import { openDomainChallenge } from './domain.js'
import { openSocialChallenge } from './social.js'
import { openWebsiteChallenge } from './website.js'
import { openImageChallenge } from './image.js'
import { openKeyChallenge } from './keys.js'
import { openGithubChallenge } from './github.js'
import { openSolanaChallenge } from './solana.js'
import { openPowChallenge } from './proof-of-work.js'
import { openChallenge } from './academy.js'
import { fakeVision } from './__fixtures__/vision.js'
import { fakeEmail } from './__fixtures__/email.js'
import { fakeDomain } from './__fixtures__/domain.js'
import { fakeSocial } from './__fixtures__/social.js'
import { fakeWebsite } from './__fixtures__/website.js'
import { fakeImage } from './__fixtures__/image.js'
import { fakeKeys } from './__fixtures__/keys.js'
import { fakeGithub } from './__fixtures__/github.js'
import { fakeSolana } from './__fixtures__/solana.js'
import { fakePow } from './__fixtures__/proof-of-work.js'
import { fakeAcademy } from './__fixtures__/academy.js'

const anAgent = (): AgentId => AgentIdSchema.parse(randomUUID())

/** The fault the incident actually produced: an asset read that threw before any row was written. */
const anOutage = () => new Error('ENOENT: no such file or directory')

/**
 * Every mint surface in the API, with the rung it belongs to and a way to make
 * its first fallible dependency throw (#170).
 *
 * **A table rather than eleven near-identical tests**, because the property is
 * *every* surface and a per-file test proves it one file at a time — the twelfth
 * would simply not have one. Adding a mint surface without adding a row here
 * leaves this list visibly short of the modules beside it.
 */
const MINT_SURFACES: readonly {
  readonly name: string
  readonly taskType: string
  readonly mint: (agentId: AgentId, obstruction: RecordObstruction) => Promise<unknown>
}[] = [
  {
    name: 'kolonie.academy.vision.challenge',
    taskType: CHALLENGE_TASK_TYPES.vision,
    mint: (agentId, obstruction) =>
      openVisionChallenge(agentId, {
        ...fakeVision(),
        obstruction,
        // The incident's own shape: the metadata read is what threw.
        getMetadata: () => Promise.reject(anOutage()),
      }),
  },
  {
    name: 'email-inbox',
    taskType: CHALLENGE_TASK_TYPES.email,
    mint: (agentId, obstruction) => {
      const deps = fakeEmail()
      return openEmailChallenge(
        agentId,
        { email: 'someone@example.test' },
        {
          ...deps,
          obstruction,
          challenges: {
            ...deps.challenges,
            mint: () => Promise.reject(anOutage()),
          },
        },
      )
    },
  },
  {
    name: 'email-send',
    taskType: 'email-send',
    mint: (agentId, obstruction) => {
      const deps = fakeEmail()
      return openEmailSendChallenge(agentId, {
        ...deps,
        obstruction,
        challenges: {
          ...deps.challenges,
          // The badge reads the proved grant before it mints, so a fixture with
          // no grant would be refused before reaching the throw.
          proved: async () => ({ address: 'someone@example.test', grantedAt: '2026-08-01' }),
          latestSend: async () => null,
          mintSend: () => Promise.reject(anOutage()),
        },
      })
    },
  },
  {
    name: 'domain-verify',
    taskType: CHALLENGE_TASK_TYPES.domain,
    mint: (agentId, obstruction) =>
      openDomainChallenge(agentId, {
        ...fakeDomain(),
        obstruction,
        challenges: { mint: () => Promise.reject(anOutage()) },
      }),
  },
  {
    name: 'social-account',
    taskType: CHALLENGE_TASK_TYPES.social,
    mint: (agentId, obstruction) => {
      const deps = fakeSocial()
      return openSocialChallenge(agentId, {
        ...deps,
        obstruction,
        challenges: { ...deps.challenges, mint: () => Promise.reject(anOutage()) },
      })
    },
  },
  {
    name: 'website-verify',
    taskType: CHALLENGE_TASK_TYPES.website,
    mint: (agentId, obstruction) =>
      openWebsiteChallenge(agentId, {
        ...fakeWebsite(),
        obstruction,
        challenges: { mint: () => Promise.reject(anOutage()) },
      }),
  },
  {
    name: 'raster',
    taskType: CHALLENGE_TASK_TYPES.image,
    mint: (agentId, obstruction) =>
      openImageChallenge(agentId, {
        ...fakeImage(),
        obstruction,
        challenges: { mint: () => Promise.reject(anOutage()) },
      }),
  },
  {
    name: 'key-signature',
    taskType: CHALLENGE_TASK_TYPES.keySignature,
    mint: (agentId, obstruction) => {
      const deps = fakeKeys()
      return openKeyChallenge(agentId, {
        ...deps,
        obstruction,
        challenges: { ...deps.challenges, mint: () => Promise.reject(anOutage()) },
      })
    },
  },
  {
    name: 'github-account',
    taskType: CHALLENGE_TASK_TYPES.github,
    mint: (agentId, obstruction) =>
      openGithubChallenge(agentId, {
        ...fakeGithub(),
        obstruction,
        challenges: { mint: () => Promise.reject(anOutage()) },
      }),
  },
  {
    name: 'solana-wallet',
    taskType: CHALLENGE_TASK_TYPES.solanaWallet,
    mint: (agentId, obstruction) => {
      const deps = fakeSolana()
      return openSolanaChallenge(agentId, {
        ...deps,
        obstruction,
        challenges: { ...deps.challenges, mint: () => Promise.reject(anOutage()) },
      })
    },
  },
  {
    name: 'proof-of-work',
    taskType: CHALLENGE_TASK_TYPES.proofOfWork,
    mint: (agentId, obstruction) => {
      const deps = fakePow()
      return openPowChallenge(agentId, {
        ...deps,
        obstruction,
        challenges: { ...deps.challenges, mint: () => Promise.reject(anOutage()) },
      })
    },
  },
  {
    name: 'browser-capability',
    taskType: CHALLENGE_TASK_TYPES.browserCapability,
    mint: (agentId, obstruction) => {
      const deps = fakeAcademy()
      return openChallenge(
        agentId,
        {
          ...deps,
          obstruction,
          challenges: { ...deps.challenges, mint: () => Promise.reject(anOutage()) },
        },
        CAPABILITY_STAGE,
      )
    },
  },
]

describe('when the Colony cannot serve an attempt', () => {
  /**
   * The eleven modules #170 names, twelve surfaces in all — `email.ts` has two.
   * Asserted as a number so that deleting a row to make a failure go away is a
   * visible act rather than a quiet one.
   */
  it('covers every mint surface in the API', () => {
    expect(MINT_SURFACES).toHaveLength(12)
    expect(new Set(MINT_SURFACES.map((surface) => surface.taskType)).size).toBe(12)
  })

  describe.each(MINT_SURFACES)('$name', ({ taskType, mint }) => {
    it('records an obstruction against its own rung', async () => {
      const agentId = anAgent()
      const obstruction = fakeObstruction()

      await expect(mint(agentId, obstruction.record)).rejects.toThrow()

      expect(obstruction.recorded()).toEqual([{ taskType, agentId }])
    })

    /**
     * The rule the whole feedback programme rests on, applied to its error path:
     * instrumentation that can refuse a citizen its rung is worse than no
     * instrumentation. A failure to record must not turn one 500 into another.
     */
    it('rethrows exactly what was thrown', async () => {
      const obstruction = fakeObstruction()

      await expect(mint(anAgent(), obstruction.record)).rejects.toThrow(
        'ENOENT: no such file or directory',
      )
    })
  })
})

describe('a mint that succeeds', () => {
  /**
   * The rejection case for this whole feature. Every one of these surfaces opens
   * its own attempt in storage when it works, and a second one written here
   * would double every denominator the attempt table produces.
   */
  it('records nothing, on any surface', async () => {
    const succeeding: readonly (readonly [string, (o: RecordObstruction) => Promise<unknown>])[] = [
      ['vision', (o) => openVisionChallenge(anAgent(), { ...fakeVision(), obstruction: o })],
      ['domain', (o) => openDomainChallenge(anAgent(), { ...fakeDomain(), obstruction: o })],
      ['social', (o) => openSocialChallenge(anAgent(), { ...fakeSocial(), obstruction: o })],
      ['website', (o) => openWebsiteChallenge(anAgent(), { ...fakeWebsite(), obstruction: o })],
      ['image', (o) => openImageChallenge(anAgent(), { ...fakeImage(), obstruction: o })],
      ['keys', (o) => openKeyChallenge(anAgent(), { ...fakeKeys(), obstruction: o })],
      ['github', (o) => openGithubChallenge(anAgent(), { ...fakeGithub(), obstruction: o })],
      ['solana', (o) => openSolanaChallenge(anAgent(), { ...fakeSolana(), obstruction: o })],
      ['pow', (o) => openPowChallenge(anAgent(), { ...fakePow(), obstruction: o })],
      [
        'browser',
        (o) => openChallenge(anAgent(), { ...fakeAcademy(), obstruction: o }, CAPABILITY_STAGE),
      ],
    ]

    for (const [name, run] of succeeding) {
      const obstruction = fakeObstruction()
      await run(obstruction.record)
      expect(
        obstruction.recorded(),
        `${name} recorded an obstruction on a successful mint`,
      ).toEqual([])
    }
  })
})

describe('recordingObstruction', () => {
  it('returns what the mint returned when nothing goes wrong', async () => {
    const obstruction = fakeObstruction()

    const result = await recordingObstruction(
      obstruction.record,
      'a-task',
      anAgent(),
      async () => 7,
    )

    expect(result).toBe(7)
    expect(obstruction.recorded()).toEqual([])
  })

  /**
   * `recordObstructedAttempt` promises never to throw, and this asserts the
   * promise rather than trusting it. A recorder that threw would replace the
   * citizen's diagnosable fault with a mysterious one at the exact moment the
   * Colony is already broken.
   */
  it('leaves the original error intact when the recorder itself fails', async () => {
    const thrown = anOutage()
    const brokenRecorder: RecordObstruction = () => Promise.reject(new Error('the recorder broke'))

    await expect(
      recordingObstruction(brokenRecorder, 'a-task', anAgent(), () => Promise.reject(thrown)),
    ).rejects.toBe(thrown)
  })

  it('rethrows a non-Error value unchanged', async () => {
    const obstruction = fakeObstruction()

    await expect(
      recordingObstruction(obstruction.record, 'a-task', anAgent(), () =>
        Promise.reject('a string'),
      ),
    ).rejects.toBe('a string')

    expect(obstruction.recorded()).toHaveLength(1)
  })
})
