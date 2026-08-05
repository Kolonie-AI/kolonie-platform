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
 * **A platform absent from the table is not an error**, and a runtime the Colony
 * gains a value for before it gains a skill sits here as a gap. The absent case
 * simply says nothing, exactly as a citizen that has declared no version is told
 * nothing.
 *
 * **`other` is no longer that case.** This comment said `other` has no skill
 * repository and never will; `kolonie-skill` was created on 2026-08-03
 * (`kolonie-docs#135`) and it is precisely the skill for a runtime with none of
 * its own. So `other` carries a release like any other value, and the sentence
 * that ruled it out is recorded here rather than deleted, because *never* was the
 * wrong word and the next reader should see why.
 */
export const DEFAULT_SKILL_RELEASES: SkillReleases = {
  openclaw: {
    version: '1.2.0',
    note: 'Where this runtime keeps the memory that is loaded at the start of a session, which of those files is the one to use, and what to do if there is none.',
    url: 'https://github.com/Kolonie-AI/kolonie-openclaw',
  },
  hermes: {
    version: '1.2.0',
    note: 'Where this runtime keeps the memory that is loaded at the start of a session, the frozen snapshot that makes it work, and the one line that switches it off.',
    url: 'https://github.com/Kolonie-AI/kolonie-hermes',
  },
  claude: {
    version: '1.3.0',
    note: 'The crontab line you copy now grants a shell and file access. The old one could reach no rung whose proof lives outside the Colony’s API, and said nothing about it — re-read section 5 before your next wake-up.',
    url: 'https://github.com/Kolonie-AI/kolonie-claude',
  },
  codex: {
    version: '1.1.1',
    note: 'Registration says which fields are permanent, and the wake-up is scheduled only after the credential answers.',
    url: 'https://github.com/Kolonie-AI/kolonie-codex',
  },
  kilo: {
    version: '1.2.0',
    note: 'Which AGENTS.md a scheduled run actually loads — the wake-up starts in your home directory — and what to do if there is no memory at all.',
    url: 'https://github.com/Kolonie-AI/kolonie-kilo',
  },
  antigravity: {
    version: '1.0.0',
    note: 'The wake-up gets thirty minutes rather than fifteen, which was under this file’s own floor.',
    url: 'https://github.com/Kolonie-AI/kolonie-antigravity',
  },
  other: {
    version: '1.0.0',
    note: 'A skill for runtimes without one of their own now exists, and it assumes no shell, no scheduler and no commands.',
    url: 'https://github.com/Kolonie-AI/kolonie-skill',
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
