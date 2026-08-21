#!/usr/bin/env node

/**
 * Clear the one conflict this repository has decided to keep (`#1544`).
 *
 * ## Why the conflict exists and is not being removed
 *
 * `packages/db/drizzle/meta/_journal.json` is the one hot file `.gitattributes`
 * (`#1496`) deliberately left without a merge driver, and the reasoning holds:
 * order carries meaning, the entries are numbered, and `union` would keep two
 * of them claiming the same `idx`. A driver that resolved it silently would
 * trade a loud failure for a quiet one, which is the wrong direction.
 *
 * This does not reopen that. It makes the loud failure **cheap to clear**.
 *
 * ## How often it bites
 *
 * Measured 2026-08-21: of 721 commits in fourteen days, **184 touched the
 * migration journal** — better than one in four. Of six open pull requests, the
 * two that were `DIRTY` were both on it, and both had generated `0337`.
 * drizzle-kit assigns `idx` as `lastEntryInJournal.idx + 1` unconditionally, so
 * two branches cut from the same `main` always land on the same number. The
 * `prefix` setting in `drizzle.config.ts` changes the *filename* and not this.
 *
 * ## What it does, which is what AGENTS.md §4 already documents
 *
 *     git checkout origin/main -- packages/db/drizzle/meta/_journal.json packages/db/drizzle/meta
 *     rm packages/db/drizzle/NNNN_your_migration.sql
 *     npm run generate -w @kolonie-ai/db
 *
 * The three things a person doing that by hand gets wrong:
 *
 * 1. **Finding `NNNN`.** It is the tag in the working tree's journal that is not
 *    in the base's. Mid-rebase a person reads it out of a conflict hunk and
 *    mistypes it.
 * 2. **Guessing.** If this cannot identify exactly one migration of its own — none,
 *    or more than one — it exits non-zero and says what it found. A script that
 *    picks one when it is unsure is the silent resolution the whole design refused.
 * 3. **Saying what it did.** Which file it removed, and which number the
 *    regenerated migration got.
 *
 * ## What it deliberately does not do
 *
 * - **It is not in `npm run check` or any gate.** It rewrites files; a gate does not.
 * - **It touches nothing outside the journal, `drizzle/meta/` and the caller's own
 *   migration file.** A stray `git checkout` over the working tree would take
 *   somebody's unrelated work with it, so every path handed to git is written out
 *   here rather than assembled from anything the caller passes.
 * - **It does not resolve the conflict in git's eyes.** It puts the tree right;
 *   whether the rebase continues is the caller's decision and the caller's
 *   `git add`.
 *
 * ## Reading the journal mid-conflict, and why both stages
 *
 * The working tree's copy may be a file with conflict markers in it, which is not
 * JSON — so the index is read instead, and **both conflict stages are, not one**.
 *
 * `git merge` and `git rebase` disagree about which side is *ours*: in a merge
 * stage 2 is your branch, and in a **rebase** it is the upstream you are landing
 * on, because a rebase replays your commit onto theirs. Reading stage 2 alone
 * therefore answers *no migrations of your own* on exactly the run this exists
 * for, which is what the first version of this script did and what a probe
 * reproducing a real `0339` collision caught.
 *
 * So: the tags from stage 2, stage 3 and the file, unioned, minus the base's.
 * That is right in both directions and needs to know neither which command is
 * running nor which way round it labelled the sides. All three are only ever read
 * to learn which tags exist, never written back.
 */

// `console` and `process` are imported rather than reached for, as
// `check-union-merge-guards.mjs` and `check-counts.mjs` do: the eslint config
// declares no environment for a script.
import { execFileSync } from 'node:child_process'
import console from 'node:console'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DRIZZLE = join('packages', 'db', 'drizzle')
const META = join(DRIZZLE, 'meta')
const JOURNAL = join(META, '_journal.json')

const git = (...args) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const fail = (message) => {
  console.error(message)
  process.exit(1)
}

/** The tags in one journal, in order. Anything unreadable is an empty list. */
const tagsOf = (text) => {
  try {
    const parsed = JSON.parse(text)
    return Array.isArray(parsed.entries) ? parsed.entries.map((entry) => entry.tag) : []
  } catch {
    return []
  }
}

/**
 * The base to rebase onto. `origin/main` is what AGENTS.md documents and what a
 * rebase is almost always against; an argument covers the case where it is not.
 */
const base = process.argv[2] ?? 'origin/main'

let theirs
try {
  theirs = git('show', `${base}:${JOURNAL}`)
} catch {
  fail(
    `Could not read ${JOURNAL} at ${base}.\n` +
      `Fetch first — git fetch origin — or name a different base:\n` +
      `  npm run rebase:migrations -- <ref>`,
  )
}

/**
 * Every tag this working tree knows about: both conflict stages and the file.
 *
 * A conflicted copy on disk is not JSON, so the index is what carries the two
 * sides — and both of them are read, because a merge and a rebase label them
 * oppositely and the whole point is to find the caller's own migration whichever
 * side git put it on. Absent stages and unparseable text are both an empty list.
 */
const seen = new Set()
for (const source of [`:2:${JOURNAL}`, `:3:${JOURNAL}`]) {
  try {
    for (const tag of tagsOf(git('show', source))) seen.add(tag)
  } catch {
    // No such stage: this path is not conflicted, which is the ordinary case
    // when the script is run to tidy up rather than mid-rebase.
  }
}
if (existsSync(join(ROOT, JOURNAL))) {
  for (const tag of tagsOf(readFileSync(join(ROOT, JOURNAL), 'utf8'))) seen.add(tag)
}

const baseTags = new Set(tagsOf(theirs))
const mine = [...seen].filter((tag) => !baseTags.has(tag)).sort()

if (mine.length !== 1) {
  fail(
    mine.length === 0
      ? `No migration of your own in ${JOURNAL} against ${base}.\n` +
          'Nothing to rebase. If you expected one, the journal may already have been\n' +
          "taken from the base — check `git status` and this branch's own commits."
      : `${String(mine.length)} migrations of your own against ${base}, and this repairs one:\n` +
          mine.map((tag) => `  ${tag}`).join('\n') +
          '\n\nDo it by hand, in the order you wrote them — AGENTS.md §4 has the steps.\n' +
          'Guessing which to regenerate is the silent resolution this refuses to make.',
  )
}

const tag = mine[0]
const sql = join(DRIZZLE, `${tag}.sql`)
const snapshot = join(META, `${tag.slice(0, 4)}_snapshot.json`)

/**
 * **Remove, then take the base's — in that order, and the order is the whole of
 * it.**
 *
 * `git checkout <ref> -- <dir>` overwrites what the ref has and **leaves what it
 * does not**. So the two cases need opposite things from the snapshot and one
 * sequence gives both:
 *
 * - **The base has a migration at this number** — the collision this exists for.
 *   Deleting first and checking out second restores *theirs* at that index,
 *   which is what the tree must end up holding.
 * - **The base does not** — an ordinary rebase past a base that never got this
 *   far. Nothing is restored, and the deletion stands.
 *
 * Doing it the other way round deletes the base's snapshot in the first case,
 * and the run *looks* fine: `check:migrations` compares the final schema and is
 * happy, while the tree now holds two migrations both adding the same column.
 * A probe reproducing a real `0339` collision is what caught it.
 *
 * **And the snapshot has to go with the `.sql`**, which is the older trap:
 * `drizzle-kit generate` reads the newest snapshot as the current state, so one
 * left on disk after its `.sql` is deleted makes it print *No schema changes,
 * nothing to migrate* and write nothing — which reads as *my change is already
 * covered* and is not.
 */
for (const path of [sql, snapshot]) {
  if (existsSync(join(ROOT, path))) rmSync(join(ROOT, path))
}

git('checkout', base, '--', JOURNAL, META)

console.log(`Removed ${sql} and took ${JOURNAL} from ${base}. Regenerating…\n`)

try {
  execFileSync('npm', ['run', 'generate', '-w', '@kolonie-ai/db'], {
    cwd: ROOT,
    stdio: 'inherit',
  })
} catch {
  fail(
    '\ndrizzle-kit generate failed. The journal and meta/ are now the base’s and your\n' +
      `${tag}.sql is gone, so the schema change is still in packages/db/src/schema/.\n` +
      'Fix whatever it reported and run `npm run generate -w @kolonie-ai/db` again.',
  )
}

const written = tagsOf(readFileSync(join(ROOT, JOURNAL), 'utf8')).filter(
  (each) => !baseTags.has(each),
)

if (written.length !== 1) {
  fail(
    `\nRegenerated ${String(written.length)} migrations, expected 1.\n` +
      'Nothing has been left in a half-state — the journal is the base’s plus whatever\n' +
      'drizzle wrote — but check `git status` before continuing the rebase.',
  )
}

console.log(
  `\n${tag} → ${written[0]}\n\n` +
    'The tree is right. Resolving the rebase is yours: git add the files above, then\n' +
    'git rebase --continue. Run `npm run check:migrations` if you want it confirmed first.',
)
