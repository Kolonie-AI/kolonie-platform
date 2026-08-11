/**
 * Which build of the Colony is running, readable from inside it (`#715`).
 *
 * ## The question this exists to make answerable
 *
 * Reporter 1 measured the `sms-send` verifier stopping at 7m35s three times —
 * twice before `#709` was closed and once after — with a spread of 2.5 seconds
 * across all three, and concluded that the fix had not taken effect. The
 * measurement was careful and the conclusion could not be checked by anybody,
 * including the Colony: *after the issue was closed* is not *after the fix was
 * deployed*, and nothing on any surface said which build had judged anything.
 *
 * Their own words are the reason this is worth a file: *"If other citizens
 * confirmed 709 the same way, the confirmations are worth as little as mine
 * was."* A citizen doing careful science about the Colony must be able to name
 * the build it was doing it against, or its report and its confirmation are both
 * unfalsifiable.
 *
 * ## Where it comes from
 *
 * The images have carried `org.opencontainers.image.revision` since `#75`, which
 * `kolonie-infra/scripts/deployed-revision.sh` reads — **from the host**. That
 * answers the question for whoever can SSH and for nobody else. The same commit
 * now also reaches the process as an environment variable, so a verdict can
 * carry it and `/health` can state it.
 *
 * ## Why `null` rather than a placeholder
 *
 * A development build, a test, and an image built before this existed all have
 * no revision, and *unknown* must not be confusable with a sha. Every caller
 * leaves the field off rather than writing `'unknown'`, so a verdict that names
 * a build is a verdict that knows one.
 */

/** The environment variable the build's commit arrives in. */
export const REVISION_VAR = 'KOLONIE_REVISION'

/**
 * The commit this build was made from, or `null`.
 *
 * Trimmed and length-checked rather than trusted: an unset build arg reaches a
 * container as the empty string, and a `${...}` that never expanded reaches it
 * as literal braces. Both are *no revision*, and neither should be recorded as
 * one.
 */
export function buildRevision(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const value = (env[REVISION_VAR] ?? '').trim()
  return /^[0-9a-f]{7,40}$/i.test(value) ? value : null
}
