import { isSisterProjectName } from '@kolonie-ai/core'
import { AUTHENTICATED_TOOLS, STEWARD_TOOLS, UNAUTHENTICATED_TOOLS } from '../mcp.js'

/**
 * Every `kolonie.*` name a piece of Colony-authored text tells a citizen to call
 * (`#196`, `#357`).
 *
 * **One parser, because there is one class of defect.** A name that does not
 * exist fires exactly when an agent is already stuck through no fault of its
 * own, and a client-side validation error reads as a broken connection rather
 * than a wrong name — so the natural next move is silence, and the Colony never
 * hears about it. That is true of a task's instructions and equally true of a
 * standing hint, which arrives in a channel the citizen did not ask for and has
 * no reason to distrust.
 *
 * Trailing punctuation is not part of a name: the texts write "`kolonie.about`."
 * and "call kolonie.tasks.list to see what is open."
 *
 * **A name the Colony hands out is not a call**, which `#373` discovered by
 * shipping one. `kolonie.sh` is a sister project's domain and it matches this
 * grammar exactly — so the moment `domain-verify`'s own text named the domain it
 * excludes, the parity check reported an unregistered tool. The collision is
 * real rather than a quirk of the regex: a Colony service and a Colony tool are
 * both `kolonie` followed by dotted segments, and no pattern separates them.
 * `SISTER_PROJECT_DOMAINS` is the one place those names live, so it is the one
 * place this consults.
 *
 * **A segment may contain a hyphen**, which this missed until `#244`.
 * `kolonie.tasks.set-aside` has been on the surface since `#234` and would have
 * been read as `kolonie.tasks.set` — an unregistered name — the first time any
 * text mentioned it. None did, so the parser was wrong and green at the same
 * time, which is the failure mode this exists to catch. Trailing hyphens are
 * excluded, so prose does not extend a name.
 */
export function toolNamesIn(text: string): readonly string[] {
  return [...text.matchAll(/kolonie(?:\.[a-z]+(?:-[a-z]+)*)+/g)]
    .map((match) => match[0].replace(/\.$/, ''))
    .filter((name) => !isSisterProjectName(name))
}

/**
 * Every tool the MCP surface registers, in any tier.
 *
 * All of them, because a text may legitimately name a tool a stranger can call,
 * a text read by a citizen may name one only a citizen can, and a text read by a
 * steward may name one only a steward is offered. **What this check is about is
 * whether the name exists at all** — a tier a caller is not in answers a
 * refusal, and a name that was never registered answers a validation error the
 * agent reads as a broken connection.
 *
 * **`STEWARD_TOOLS` was missing here until `#492`**, and the gap was invisible
 * because no Colony-authored text had ever named a third-tier tool. The first
 * one that did — the `quests-awaiting-review` hint, whose whole job is to send a
 * steward to `kolonie.quests.review` — was reported as naming a tool that does
 * not exist. The parser was right, the hint was right, and this set was one tier
 * out of date: exactly the shape of failure `#196` built the parity check to
 * catch, one level up.
 *
 * **Both that hint and that tool are gone** (`#723`): a quest that clears
 * moderation is published by that verdict. The set still carries `STEWARD_TOOLS`
 * for the reason above, which was never about which tools were in it.
 */
export function registeredTools(): ReadonlySet<string> {
  return new Set<string>([...UNAUTHENTICATED_TOOLS, ...AUTHENTICATED_TOOLS, ...STEWARD_TOOLS])
}
