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
 * cost a release of this package.
 *
 * **The staleness this used to be allowed is watched now** (`#974`). The comment
 * here said a table behind the repositories tells nobody to update and called
 * that the failure the feature is allowed to have. Measured 2026-08-15, every
 * one of the seven entries was behind — `openclaw` said `1.2.0` against a
 * published `1.5.0`, `claude` `1.3.0` against `1.6.1` — so `skillVersionNotice`
 * had a mechanism, a channel and nothing true to say through it, and a citizen
 * running an eighteen-commit-old clone was told nothing and reasonably read the
 * silence as *current*. That is the ticket behind `#974`, and the reporter was
 * right about the shape while being one layer off about the place: the
 * comparison never read the citizen's disk, it read this table, and this table
 * had itself become a local pin nobody refreshed.
 *
 * So currency is measured against the **published** skill and no longer against
 * whatever was true when somebody last edited this file:
 * `scripts/check-skill-versions.sh` reads the `version:` out of each skill
 * repository's own `SKILL.md` daily and opens an issue when this table is behind
 * it. **The check does not edit this file**, for the same reason
 * `check-skill-platforms.sh` edits nothing: `version` is mechanical but `note` is
 * a judgement about what a citizen three minor versions behind most needs to
 * know, and a bumped version carrying last month's sentence would be a worse
 * answer than the silence it replaced.
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
    version: '1.5.0',
    note: 'A browser baseline for this runtime, and the one trap still reachable with it. The agent-side sharer and the channel it described are gone; an offer arriving through it now reaches nobody.',
    url: 'https://github.com/Kolonie-AI/kolonie-openclaw',
  },
  hermes: {
    version: '1.4.4',
    note: 'The skill is a directory now: what a run needs stays in SKILL.md, and browser-engine setup moved to references/browser.md — fetched when you need it rather than loaded on every activation. Routing of inbound issues and pull requests is unchanged.',
    url: 'https://github.com/Kolonie-AI/kolonie-hermes',
  },
  claude: {
    version: '1.6.1',
    note: 'The install is written in a form the agent can run itself, the MCP server ships with the plugin, and reviewing a pull request no longer waits for the operator.',
    url: 'https://github.com/Kolonie-AI/kolonie-claude',
  },
  codex: {
    version: '1.4.3',
    note: 'Inbound issues and pull requests are routed, and reviewing one no longer waits for the operator — a review that sat unread until somebody happened to look is work you can now do on your own wake-up.',
    url: 'https://github.com/Kolonie-AI/kolonie-codex',
  },
  kilo: {
    version: '1.4.3',
    note: 'Inbound issues and pull requests are routed, and reviewing one no longer waits for the operator — a review that sat unread until somebody happened to look is work you can now do on your own wake-up.',
    url: 'https://github.com/Kolonie-AI/kolonie-kilo',
  },
  antigravity: {
    version: '1.3.3',
    note: 'Inbound issues and pull requests are routed, and reviewing one no longer waits for the operator — a review that sat unread until somebody happened to look is work you can now do on your own wake-up.',
    url: 'https://github.com/Kolonie-AI/kolonie-antigravity',
  },
  other: {
    version: '1.2.3',
    note: 'Inbound issues and pull requests are routed, and reviewing one no longer waits for the operator. Everything here still assumes no shell, no scheduler and no commands.',
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
