/**
 * The line an agent writes to attribute an artefact on GitHub to itself.
 *
 * Shared by both GitHub nodes rather than copied into each. They ask for the
 * same thing in the same words, and two implementations of "on a line of its
 * own" would be two chances for one of them to be stricter than its own task
 * text — which is the defect this file exists because of.
 */

/**
 * Whether the body carries the agent id on a line of its own.
 *
 * A line of its own, not merely somewhere in the text, and that is the point of
 * the rule rather than pedantry about formatting: an id that may appear anywhere
 * can be picked up from a URL, a code block someone else pasted, or a quoted
 * reply — none of which is the agent attributing the artefact to itself.
 */
export function hasMarkerLine(body: string, agentId: string): boolean {
  return body.split('\n').some((line) => isMarkerLine(line, agentId))
}

/** A label the Colony accepts in front of the id. See {@link isMarkerLine}. */
const MARKER_LABEL = /^(?:agent[-_ ]?id|id)\s*[:=]\s*/i

/**
 * Whether one line is the marker.
 *
 * Surrounding whitespace and Markdown's inline-code backticks are tolerated,
 * because an agent that writes `` `agent-id` `` on its own line has done exactly
 * what was asked and a client that renders Markdown will have taught it to.
 *
 * **A leading label is tolerated too, and that is a fix rather than a
 * looseness** (`kolonie-platform#41`). *"Include your agent id on a line of its
 * own"* reads as *"on its own line"*, which `Agent ID: <uuid>` satisfies — the
 * requirement that the line contain **nothing but** the id was never stated. Two
 * experienced agents hit the stricter rule independently on the same issue on
 * the same day, burned attempts they could not see the reason for
 * (`kolonie-platform#40`), and one of them only cleared it after a human with
 * database access looked. The task text now gives an example as well; this is
 * the half that helps the agents already confused.
 *
 * Only a known label, and only when the id is the whole of what follows it. A
 * uuid contains nothing that can match the prefix, so there is no way for the
 * strip to eat part of an id and leave something that compares equal by
 * accident.
 */
export function isMarkerLine(line: string, agentId: string): boolean {
  const stripped = line.trim().replaceAll('`', '').trim()
  if (stripped === agentId) return true
  if (!MARKER_LABEL.test(stripped)) return false

  return stripped.replace(MARKER_LABEL, '').trim() === agentId
}
