import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { banSaltFromEnv } from './ban-salt.js'
import { databaseUrlFromEnv } from './client.js'
import { REQUIRED_ENV, REQUIRED_ENV_LABEL, requiredEnvLabelValue } from './required-env.js'

/**
 * The three images that import this package. Each one repeats REQUIRED_ENV as a
 * Dockerfile label, because a label is a build-time literal and cannot import
 * TypeScript — so this test is the only thing standing between the copies and
 * the drift that produced the 2026-07-31 outage in the first place.
 */
const DOCKERFILES = [
  'apps/api/Dockerfile',
  'apps/verifier-runner/Dockerfile',
  'apps/moderation-runner/Dockerfile',
]

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

/** The label's value as that Dockerfile declares it, or undefined if it has none. */
function labelIn(dockerfile: string): string | undefined {
  const source = readFileSync(repoRoot + dockerfile, 'utf8')
  const match = source.match(new RegExp(`^LABEL\\s+${REQUIRED_ENV_LABEL}="([^"]*)"`, 'm'))
  return match?.[1]
}

describe('REQUIRED_ENV', () => {
  it('lists only variables whose absence stops the process', () => {
    // The claim the list makes, checked against the functions that make it true.
    // Both throw on an unset value and on whitespace, so an empty deploy secret
    // fails the same way an absent one does.
    expect(() => databaseUrlFromEnv({})).toThrow(/DATABASE_URL is not set/)
    expect(() => banSaltFromEnv({})).toThrow(/BAN_MARK_SALT is not set/)

    expect(REQUIRED_ENV).toContain('DATABASE_URL')
    expect(REQUIRED_ENV).toContain('BAN_MARK_SALT')
  })

  it('is parseable by the deploy that reads it', () => {
    // preflight_env() splits on commas and whitespace and then requires each
    // name to match ^[A-Za-z_][A-Za-z0-9_]*$. A name that does not is silently
    // dropped there, which would turn this whole mechanism off without a word.
    for (const name of REQUIRED_ENV) {
      expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
    }
    expect(requiredEnvLabelValue()).toBe(REQUIRED_ENV.join(','))
    expect(requiredEnvLabelValue()).not.toContain(' ')
  })

  it.each(DOCKERFILES)('%s declares exactly REQUIRED_ENV', (dockerfile) => {
    // Not "contains" — exactly. A Dockerfile that declares less lets the
    // 2026-07-31 failure through for the name it omits; one that declares more
    // stops a deploy over a variable the process would have started without,
    // and a check that is wrong in that direction is one people switch off.
    expect(labelIn(dockerfile)).toBe(requiredEnvLabelValue())
  })
})
