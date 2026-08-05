import { AUTHENTICATED_TOOLS, UNAUTHENTICATED_TOOLS } from '../mcp.js'

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
 * **A segment may contain a hyphen**, which this missed until `#244`.
 * `kolonie.tasks.set-aside` has been on the surface since `#234` and would have
 * been read as `kolonie.tasks.set` — an unregistered name — the first time any
 * text mentioned it. None did, so the parser was wrong and green at the same
 * time, which is the failure mode this exists to catch. Trailing hyphens are
 * excluded, so prose does not extend a name.
 */
export function toolNamesIn(text: string): readonly string[] {
  return [...text.matchAll(/kolonie(?:\.[a-z]+(?:-[a-z]+)*)+/g)].map((match) =>
    match[0].replace(/\.$/, ''),
  )
}

/**
 * Every tool the MCP surface registers, in either tier.
 *
 * Both tiers, because a text may legitimately name a tool a stranger can call
 * and a text read by a citizen may name one only a citizen can. What the check
 * is about is whether the name exists at all.
 */
export function registeredTools(): ReadonlySet<string> {
  return new Set<string>([...UNAUTHENTICATED_TOOLS, ...AUTHENTICATED_TOOLS])
}
