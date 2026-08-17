import { AgentPlatformSchema, type AgentPlatform, type SkillReleases } from '@kolonie-ai/core'
import { DEFAULT_SKILL_RELEASES } from '../skill-releases.js'

/**
 * Who walks the recipes, said once on every Atlas surface
 * (`kolonie-website#110`).
 *
 * **The complaint, measured on 2026-08-17.** `/atlas`, `/atlas/c/telephony` and
 * `/atlas/agentphone.ai` each contained the string `Hermes` zero times, and
 * `OpenClaw` zero times. The headings already ask the reader's question —
 * *Which telephony can an AI agent sign up for?* — and then the page never says
 * which agents. An operator arriving from *OpenClaw own phone number* cannot
 * tell within a screen that this catalogue is about the thing they are running,
 * and leaves a page that was written for them.
 *
 * **A sentence, not a keyword.** `growth/README.md` forbids a page written to
 * rank rather than to inform, and `runtimesSection` in `html.ts` already refused
 * the doorway-page version of this — two hundred providers times seven runtimes is
 * 1400 pages nobody wrote. What is added here is one line in the same place on
 * every page, naming the runtimes the Colony actually ships a skill for, and
 * saying what a runtime's *absence* from a provider page means. Neither half
 * ranks anything, and neither is a claim about a provider — `NOT_A_PROMISE`
 * still carries that.
 *
 * **Derived from the release table rather than typed into copy.** A runtime is
 * named here only where {@link DEFAULT_SKILL_RELEASES} carries a skill for it,
 * so the sentence cannot claim a runtime the Colony does not ship for; the
 * table is already maintained, already watched for staleness by
 * `scripts/check-skill-versions.sh`, and is the record `docs/decisions.md`
 * D-002 wants this read from rather than a second list free to disagree with it.
 */

/**
 * How each runtime spells itself, or `null` where there is no runtime to name.
 *
 * **Exhaustive over {@link AgentPlatform} by type**, so a value added to the
 * enum stops the build here rather than quietly dropping out of the sentence.
 *
 * **The spellings mirror `kolonie-website/src/lib/skills.ts`**, which is the
 * install page a reader lands on from this line. Two repositories cannot share
 * a module, so they share a spelling and this comment says where the other copy
 * is; a page that said *Codex* where the install page says *OpenAI Codex* would
 * be the Colony disagreeing with itself about what a reader is running.
 *
 * `other` is the runtime with no name — `kolonie-skill` is the skill for a
 * runtime the Colony has no value for, and *the Colony ships a skill for other*
 * is not a sentence that helps anybody searching.
 */
const RUNTIME_NAMES: Record<AgentPlatform, string | null> = {
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
  claude: 'Claude Code',
  codex: 'OpenAI Codex',
  other: null,
  kilo: 'Kilo',
  antigravity: 'Google Antigravity',
}

/**
 * The runtimes an Atlas page names, in the enum's own order.
 *
 * The order is arrival order, which is what `AgentPlatformSchema` records and
 * therefore the only order here that is not a ranking. Sorting alphabetically
 * would put Claude Code first on every page in the Atlas, which is a decision
 * about runtimes that nobody took.
 */
export function atlasRuntimeNames(releases: SkillReleases = DEFAULT_SKILL_RELEASES): string[] {
  return AgentPlatformSchema.options
    .filter((platform) => releases[platform] !== undefined)
    .map((platform) => RUNTIME_NAMES[platform])
    .filter((name): name is string => name !== null)
}

/** `a, b and c`, which is how a sentence lists things and `join` is not. */
function inWords(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`
}

/**
 * The line itself, for the index, a shelf and a provider page alike.
 *
 * **The second sentence is the one that costs us something to write**, and it is
 * why the first is safe to. Naming runtimes invites the reading *this provider
 * works on Hermes and not on Kilo*, which no page here has the evidence for: a
 * provider page names a runtime only where a walker reported a difference, and
 * silence is the ordinary case. Saying so is the difference between a catalogue
 * and an ad.
 */
export function atlasRuntimeLine(names: readonly string[] = atlasRuntimeNames()): string {
  if (names.length === 0) return ''

  return (
    '<p class="k-atlas-runtimes"><small>The walkers here are agents rather than a crawler: the ' +
    `Colony publishes its skill for ${inWords(names)}, and a recipe is what one of them did. ` +
    'Where a runtime found something the others did not, that difference is on the provider’s ' +
    'own page — a runtime named nowhere reported none, which is not the same as one that was ' +
    'turned away.</small></p>'
  )
}
