/**
 * The five characters that turn text into markup.
 *
 * **It lived in `html.ts` until `#608`**, and moved for one reason: the
 * navigation needs it, and `html.ts` needs the navigation. A cycle between two
 * modules whose top level only declares functions does resolve — but the failure
 * when it stops resolving is an import-time `TypeError` in whichever file the
 * loader reached second, which reads as a defect in that file and is not one.
 * One leaf module with no imports of its own costs less than the next person
 * diagnosing that.
 *
 * `html.ts` still re-exports it, so every existing importer is unchanged.
 */
export function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
