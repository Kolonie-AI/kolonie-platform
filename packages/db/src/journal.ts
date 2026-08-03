/**
 * The four invariants that make the migration journal safe to merge.
 *
 * `drizzle/meta/_journal.json` is the most contended file in this repository —
 * 87 commits in the 21 days to 2026-08-03, against 77 for the largest source
 * file here. It is forty lines long, so the contention has nothing to do with
 * size: every migration appends one entry, so every migration touches it.
 *
 * **A text conflict is the good outcome.** Git raises it, somebody resolves it,
 * and the resolution is obvious. What these checks exist for is the version that
 * merges cleanly: `migrate()` applies journal entries in order of `when`, a
 * millisecond stamp taken from the clock of whichever machine ran
 * `drizzle-kit generate` — so **the order migrations run in is the order they
 * were generated in, and the order a person reads them in is the file number.**
 * While one agent generates migrations those agree. With two they can disagree,
 * and nothing about the diff looks wrong.
 *
 * Each check returns finished sentences rather than a boolean or a list of ids,
 * because its reader is an agent that has not read the issue behind it and is
 * looking at a red test with no other context. The sentence has to say which
 * invariant broke, what broke it, and what to do instead.
 *
 * These are pure functions over the journal and the directory listing. Nothing
 * here touches a database — the guard has to run wherever `npm run check` runs,
 * including where `DATABASE_URL` is unset. The complementary question, whether a
 * database's own bookkeeping still agrees with the journal, cannot be asked from
 * disk and lives in `migrate.ts`.
 */
import { readdir } from 'node:fs/promises'
import { MIGRATIONS_FOLDER, type JournalEntry } from './migrations.js'

/** The `.sql` files in the migrations folder, sorted, without their extension. */
export async function migrationFileTags(
  folder: string = MIGRATIONS_FOLDER,
): Promise<readonly string[]> {
  const names = await readdir(folder)
  return names
    .filter((name) => name.endsWith('.sql'))
    .map((name) => name.replace(/\.sql$/, ''))
    .sort()
}

/**
 * Every `idx` appears once.
 *
 * A duplicate is what a hand-resolved conflict produces when both sides kept
 * their own entry and neither renumbered: the journal then has two entries
 * claiming the same position, and which of them drizzle believes depends on
 * nothing a person would think to check.
 */
export function duplicateIndexes(entries: readonly JournalEntry[]): readonly string[] {
  const seen = new Map<number, string[]>()
  for (const entry of entries) {
    seen.set(entry.idx, [...(seen.get(entry.idx) ?? []), entry.tag])
  }

  return [...seen.entries()]
    .filter(([, tags]) => tags.length > 1)
    .map(
      ([idx, tags]) =>
        `Two journal entries claim idx ${idx}: ${tags.join(' and ')}. ` +
        'This is a merge that kept both sides. Do not renumber the entry by hand — ' +
        'delete the later migration and its snapshot, restore the journal to the ' +
        'other side, and regenerate with `npm run generate` in packages/db.',
    )
}

/**
 * Every `.sql` file's numeric prefix appears once across the directory.
 *
 * Two agents generating against the same tree both get `0087`. The journal may
 * still be consistent afterwards — the collision is in the file names, and it is
 * the one a person reading `drizzle/` trips over rather than the one drizzle
 * does.
 */
export function duplicateFilePrefixes(tags: readonly string[]): readonly string[] {
  const seen = new Map<string, string[]>()
  const unnumbered: string[] = []

  for (const tag of tags) {
    const prefix = /^(\d+)_/.exec(tag)?.[1]
    if (prefix === undefined) {
      unnumbered.push(tag)
      continue
    }
    seen.set(prefix, [...(seen.get(prefix) ?? []), tag])
  }

  return [
    ...unnumbered.map(
      (tag) =>
        `${tag}.sql has no numeric prefix. Every migration is named by ` +
        '`drizzle-kit generate`, which numbers it; a file that arrived any other ' +
        'way is not a migration and does not belong in drizzle/.',
    ),
    ...[...seen.entries()]
      .filter(([, group]) => group.length > 1)
      .map(
        ([prefix, group]) =>
          `Two migrations were generated as ${prefix}: ${group.map((tag) => `${tag}.sql`).join(' and ')}. ` +
          'Two agents generated against the same tree. Delete the one that came ' +
          'second, with its snapshot and its journal entry, and regenerate it with ' +
          '`npm run generate` in packages/db so it takes the next free number.',
      ),
  ]
}

/**
 * The journal and the directory are in one-to-one correspondence.
 *
 * An entry with no file is a migration that cannot run. A file with no entry is
 * a migration that will never run, silently — drizzle reads the journal and not
 * the directory, so nothing about an unregistered `.sql` file announces itself.
 */
export function journalFileMismatches(
  entries: readonly JournalEntry[],
  tags: readonly string[],
): readonly string[] {
  const inJournal = new Set(entries.map((entry) => entry.tag))
  const onDisk = new Set(tags)

  return [
    ...[...inJournal]
      .filter((tag) => !onDisk.has(tag))
      .map(
        (tag) =>
          `The journal has an entry for ${tag}, and drizzle/${tag}.sql does not exist. ` +
          'A deploy will fail reading it. Either the file was deleted without its ' +
          'entry — restore both from git — or the entry survived a merge its file ' +
          'did not, in which case remove the entry and its snapshot.',
      ),
    ...[...onDisk]
      .filter((tag) => !inJournal.has(tag))
      .map(
        (tag) =>
          `drizzle/${tag}.sql has no journal entry, so it will never run and nothing ` +
          'will say so. Do not add the entry by hand: delete the file and its ' +
          'snapshot and regenerate with `npm run generate` in packages/db, which ' +
          'writes all three together.',
      ),
  ]
}

/**
 * `when` increases strictly when the entries are read in `idx` order.
 *
 * **This is the one that catches the silent case.** Agent A generates `0087_a`
 * at 10:00; agent B generates `0087_b` at 09:58 against a tree that does not yet
 * have A's; the merge renumbers B to `0088_b` and it applies *before* `0087_a`.
 * Every file is present, every entry is present, the diff is clean, and the
 * database ends up in a state no reading of the directory predicts.
 *
 * The worse variant is a stamp far enough ahead to swallow its successors
 * entirely: drizzle applies only entries newer than the newest `created_at` it
 * has recorded, so one entry from a fast clock hides every migration after it
 * while the deploy reports `none pending`. That happened on 2026-08-03, twice.
 */
export function outOfOrderStamps(entries: readonly JournalEntry[]): readonly string[] {
  const ordered = [...entries].sort((a, b) => a.idx - b.idx)

  return ordered.flatMap((entry, position) => {
    const previous = position === 0 ? undefined : ordered[position - 1]
    if (previous === undefined || entry.when > previous.when) return []

    const gap =
      entry.when === previous.when
        ? 'stamped at the same millisecond as it'
        : `stamped ${previous.when - entry.when}ms before it`

    return [
      `${entry.tag} is numbered after ${previous.tag} and ${gap} ` +
        `(when ${entry.when} against ${previous.when}). The file numbering and the ` +
        'execution order disagree: drizzle applies journal entries by `when`, so this one runs ' +
        'first and a person reading drizzle/ has no way to see it. Regenerate the later ' +
        'migration rather than editing `when` by hand — `npm run generate` in packages/db ' +
        'stamps it from the current clock, which is what makes the two orders agree again.',
    ]
  })
}
