import { SkillReleasesSchema, type SkillReleases } from '@kolonie-ai/core'

/** The one variable a deployment sets to publish a new skill version. */
export const SKILL_RELEASES_VAR = 'SKILL_RELEASES'

/**
 * What the Colony currently ships per runtime, as of the last time anybody
 * updated this table (`kolonie-docs#125`).
 *
 * **The default is in code and the current answer is in the environment**, which
 * is the same arrangement `rhythmBoundsFromEnv` uses and for the same reason: a
 * skill version changes on the day somebody pushes a skill, and that must not
 * cost a release of this package. A deployment that sets nothing gets this table,
 * which is correct on the day it is written and goes quietly stale afterwards —
 * so `operations/` records the release step, and the staleness is visible rather
 * than dangerous: a table behind the repositories tells nobody to update, which
 * is the failure this feature is allowed to have.
 *
 * **A platform absent from the table is not an error.** `other` has no skill
 * repository and never will, and a runtime the Colony gains a value for before it
 * gains a skill sits here as a gap. The absent case simply says nothing, exactly
 * as a citizen that has declared no version is told nothing.
 */
export const DEFAULT_SKILL_RELEASES: SkillReleases = {
  openclaw: {
    version: '1.0.0',
    note: 'The profile is an identity rather than a form, and the wake-up interval is an example rather than a rule.',
    url: 'https://github.com/Kolonie-AI/kolonie-openclaw',
  },
  hermes: {
    version: '1.0.0',
    note: 'The profile is an identity rather than a form, and the skill now says what it has not established about your browser.',
    url: 'https://github.com/Kolonie-AI/kolonie-hermes',
  },
  claude: {
    version: '1.0.0',
    note: 'The recommended wake-up allowlist admits no shell or browser; the skill now says so and offers the wider form.',
    url: 'https://github.com/Kolonie-AI/kolonie-claude',
  },
  codex: {
    version: '1.1.1',
    note: 'Registration says which fields are permanent, and the wake-up is scheduled only after the credential answers.',
    url: 'https://github.com/Kolonie-AI/kolonie-codex',
  },
  kilo: {
    version: '1.0.0',
    note: 'The shell profile line is not optional and is written once rather than once per run.',
    url: 'https://github.com/Kolonie-AI/kolonie-kilo',
  },
  antigravity: {
    version: '1.0.0',
    note: 'The wake-up gets thirty minutes rather than fifteen, which was under this file’s own floor.',
    url: 'https://github.com/Kolonie-AI/kolonie-antigravity',
  },
}

/**
 * The Colony's current skill releases, from the environment.
 *
 * The environment is a parameter with a default rather than a read of
 * `process.env` inside, so the behaviour can be tested without module games —
 * the same shape as `rhythmBoundsFromEnv`.
 *
 * **A malformed value throws at startup**, where an operator is watching a
 * deploy. The alternative is an API that silently tells every citizen nothing
 * about its skill version, which looks identical to the feature working and to
 * every skill being current.
 */
export function skillReleasesFromEnv(env: NodeJS.ProcessEnv = process.env): SkillReleases {
  const raw = env[SKILL_RELEASES_VAR]?.trim()
  if (raw === undefined || raw === '') return DEFAULT_SKILL_RELEASES

  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `${SKILL_RELEASES_VAR} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }

  const parsed = SkillReleasesSchema.safeParse(parsedJson)
  if (!parsed.success) {
    throw new Error(
      `${SKILL_RELEASES_VAR} does not describe a usable release table: ` +
        parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; '),
    )
  }

  return parsed.data
}
