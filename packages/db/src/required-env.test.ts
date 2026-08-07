import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { banSaltFromEnv } from './ban-salt.js'
import { BOOTSTRAP_MAINTAINER_SUBJECT_VAR } from './storage/humans.js'
import { databaseUrlFromEnv } from './client.js'
import {
  API_REQUIRED_ENV,
  IMAGE_REQUIRED_ENV,
  REQUIRED_ENV,
  REQUIRED_ENV_LABEL,
  requiredEnvLabelValue,
} from './required-env.js'

/**
 * The images that import this package, each with the list it declares. Each one
 * repeats its list as a Dockerfile label, because a label is a build-time
 * literal and cannot import TypeScript — so this test is the only thing standing
 * between the copies and the drift that produced the 2026-07-31 outage in the
 * first place.
 */
const IMAGES = Object.entries(IMAGE_REQUIRED_ENV)

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

/** The label's value as that image's Dockerfile declares it, or undefined if it has none. */
function labelIn(app: string): string | undefined {
  const source = readFileSync(`${repoRoot}${app}/Dockerfile`, 'utf8')
  const match = source.match(new RegExp(`^LABEL\\s+${REQUIRED_ENV_LABEL}="([^"]*)"`, 'm'))
  return match?.[1]
}

/** Every directory under `apps/` that is built into an image. */
function appsWithDockerfiles(): string[] {
  return readdirSync(`${repoRoot}apps`, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `apps/${entry.name}`)
    .filter((app) => readdirSync(`${repoRoot}${app}`).includes('Dockerfile'))
    .sort()
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

  it('declares a per-image variable for that image and no other', () => {
    // The gap #252 closed: DEPOSIT_SEALING_KEY makes apps/api exit and is read
    // by nothing else, so it belongs to one image. Adding it to the shared list
    // would refuse a deploy of three containers over a variable they never read
    // — a worse failure than the one being fixed.
    expect(API_REQUIRED_ENV).toContain('DEPOSIT_SEALING_KEY')
    expect(REQUIRED_ENV as readonly string[]).not.toContain('DEPOSIT_SEALING_KEY')

    for (const [app, names] of IMAGES) {
      if (app === 'apps/api') continue
      expect(names, `${app} must not inherit apps/api's variables`).toEqual(REQUIRED_ENV)
    }
  })

  it('names every image built here, so a new one cannot go unchecked', () => {
    // Without this, adding apps/whatever with a Dockerfile and no entry in
    // IMAGE_REQUIRED_ENV produces an image whose label nothing compares against
    // anything — the check would pass by having nothing to say.
    expect(IMAGES.map(([app]) => app).sort()).toEqual(appsWithDockerfiles())
  })

  it('is parseable by the deploy that reads it', () => {
    // preflight_env() splits on commas and whitespace and then requires each
    // name to match ^[A-Za-z_][A-Za-z0-9_]*$. A name that does not is silently
    // dropped there, which would turn this whole mechanism off without a word.
    for (const [, names] of IMAGES) {
      for (const name of names) {
        expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/)
      }
    }
    expect(requiredEnvLabelValue()).toBe(REQUIRED_ENV.join(','))
    expect(requiredEnvLabelValue()).not.toContain(' ')
  })

  it.each(IMAGES)('%s declares exactly its own list', (app, names) => {
    // Not "contains" — exactly. A Dockerfile that declares less lets the
    // 2026-07-31 failure through for the name it omits; one that declares more
    // stops a deploy over a variable the process would have started without,
    // and a check that is wrong in that direction is one people switch off.
    expect(labelIn(app)).toBe(requiredEnvLabelValue(names))
  })
})

/**
 * `#485`. `BOOTSTRAP_MAINTAINER_SUBJECT` grants the maintainer role at startup
 * and is **optional on purpose**, so declaring it here would break every
 * deployment that has no maintainer to bootstrap — which is every one but the
 * Colony's own, and every future one, since the variable is only ever needed
 * once.
 *
 * `required-env.test.ts` otherwise checks only that the TypeScript source and
 * the Dockerfile labels *agree*; it cannot tell you that an entry should not be
 * there. So this is the assertion that makes the judgement `bootstrapMaintainer`
 * documents into something a test catches rather than something a reviewer has
 * to remember.
 *
 * `CONSOLE_SENDER_ADDRESS` is the precedent and states the same trade.
 */
describe('the variables that must stay optional', () => {
  it('never declares BOOTSTRAP_MAINTAINER_SUBJECT anywhere', () => {
    expect(BOOTSTRAP_MAINTAINER_SUBJECT_VAR).toBe('BOOTSTRAP_MAINTAINER_SUBJECT')

    expect(REQUIRED_ENV as readonly string[]).not.toContain(BOOTSTRAP_MAINTAINER_SUBJECT_VAR)
    for (const [, names] of IMAGES) {
      expect(names as readonly string[]).not.toContain(BOOTSTRAP_MAINTAINER_SUBJECT_VAR)
    }
    // And not in the labels the images actually carry, which is where a copy
    // would drift to if one were ever added by hand.
    for (const [app] of IMAGES) {
      expect(labelIn(app)).not.toContain(BOOTSTRAP_MAINTAINER_SUBJECT_VAR)
    }
  })
})
