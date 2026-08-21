#!/usr/bin/env node

/**
 * Assemble `docs/decisions.md` as an index over `docs/decisions/` (`#1497`).
 *
 * Usage:
 *   node scripts/build-decisions-index.mjs            # write the index
 *   node scripts/build-decisions-index.mjs --check    # fail if it is not what would be written
 *
 * ## The conflict this removes
 *
 * `docs/decisions.md` reached **9497 lines** on +9582/−85 in thirty days. It more
 * than doubled in a month and was essentially never edited, only appended to — at
 * the bottom, where every branch in flight appends. Two agents recording two
 * unrelated decisions collided there **by construction**.
 *
 * **This argument had already been made twice in this organisation and won
 * twice.** `kolonie-docs/state/decisions.md` at 3052 lines on +3135/−82 in three
 * weeks, and `packages/core/CHANGELOG.md` at 1745 lines with 138 entries under
 * one heading — both cured the same way, one file per record. This file is the
 * one that was never brought along.
 *
 * ## Why an index rather than either precedent exactly
 *
 * `#1497` weighs two endings and the two precedents disagree:
 *
 * | | Source | Artefact |
 * |---|---|---|
 * | `packages/core/CHANGELOG.md` | `changes/` | **produced**, and since `#1572` not tracked — the tag that would have read it never existed |
 * | `kolonie-docs/state/decisions/` | the directory | a **register**, not the records |
 *
 * `docs/decisions.md` has no consumer outside this repository, which argues
 * against producing the whole file. But **twenty-odd things link into it**,
 * several by `D-` number — `ci.yml:192` and `:398` cite *"D-009 in
 * docs/decisions.md"*, `AGENTS.md` cites D-008, `core/src/api/tasks.ts` cites
 * D-014 — and deleting it breaks every one.
 *
 * So this takes `kolonie-docs`' shape, which is neither of the two the issue
 * offers and is what that repository actually built when it faced this: **the
 * file stays and stops being the records.** It becomes an index — number, title,
 * date, link — about 140 lines, and every existing reference still lands
 * somewhere that answers it. A citation by `D-` number resolves better than
 * before, because the index links straight at the record instead of asking a
 * reader to scroll 9497 lines.
 *
 * ## Why it is produced rather than hand-maintained
 *
 * `packages/core/changes/README.md` names the failure mode: if both the directory
 * and the file are hand-edited, the conflict comes back with an extra step in
 * front of it. So `--check` runs in `npm run check`, the index is derived, and
 * the two cannot drift.
 *
 * It is also what lets `.gitattributes` give the index `merge=union` under
 * `#1496`: a produced file's union result is allowed to be wrong, because this is
 * what refuses to let it stay wrong.
 *
 * ## What a record is
 *
 * One file per record under `docs/decisions/`, named `D-0NN-<slug>.md`, opening
 * with its own `## D-0NN — Title` heading and carrying `**Date:** YYYY-MM-DD`.
 * **Numbers are never reassigned** — `D-114` stays `D-114` forever, because
 * things cite it.
 *
 * `open-questions.md` is the one file that is not a record. It sat between D-028
 * and D-029 in the old file, which is where it happened to be appended rather
 * than anywhere meaningful, and it is edited rather than appended to.
 */

// `console` and `process` are imported rather than reached for, as
// `check-fixture-mirrors.mjs` and `check-counts.mjs` do: the eslint config
// declares no environment for a script.
import console from 'node:console'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIRECTORY = join(root, 'docs', 'decisions')
const INDEX = join(root, 'docs', 'decisions.md')

/** The one file under `docs/decisions/` that is not a numbered record. */
const OPEN_QUESTIONS = 'open-questions.md'

const PREAMBLE = `# Modelling Decisions

Why the domain model looks the way it does. Each entry records the decision, the
alternative that was rejected, and what it would have cost — so a future agent
can tell a deliberate choice from an accident.

**One record is one file, in [\`docs/decisions/\`](decisions/).** This page is an
index over that directory and is **produced** by
\`scripts/build-decisions-index.mjs\` — do not edit it, and do not add a row to it.
Write \`docs/decisions/D-0NN-<slug>.md\`, take the next free number, and run
\`npm run build:decisions\` (or \`npm run check\`, which fails when the two have
drifted).

**Why it is shaped this way** (\`#1497\`): until 2026-08-21 every record lived in
this file, which reached 9497 lines on +9582/−85 in thirty days. It was never
edited, only appended to — at the bottom, where every branch in flight appends,
so two agents recording two unrelated decisions collided by construction. The
same argument had already been won twice in this organisation, at
\`kolonie-docs/state/decisions.md\` and at \`packages/core/CHANGELOG.md\`. This file
is the one that was never brought along.

**Numbers are never reassigned.** \`D-114\` stays \`D-114\` forever, because things
cite it — \`ci.yml\`, \`AGENTS.md\` and a dozen source comments cite records by
number, and a number that moved would send every one of them somewhere else.

[Open questions](decisions/open-questions.md) — not decided yet, and to be
resolved in an issue before anything is built on them.

## The records
`

/** Every numbered record, oldest number first. */
function records() {
  const found = []
  for (const file of readdirSync(DIRECTORY).sort()) {
    if (!file.endsWith('.md')) continue
    if (file === OPEN_QUESTIONS) continue

    const text = readFileSync(join(DIRECTORY, file), 'utf8')
    const heading = text.split('\n')[0] ?? ''
    const parsed = heading.match(/^## (D-\d{3}) — (.+)$/)
    if (parsed === null) {
      throw new Error(
        `${file} does not open with a '## D-0NN — Title' heading. Every file under ` +
          `docs/decisions/ is a record except ${OPEN_QUESTIONS}; if this is meant to be one, ` +
          'give it that heading, and if it is not, it does not belong in this directory.',
      )
    }

    /**
     * The date, in whichever of three shapes the record happens to use.
     *
     * 129 records grew three conventions and none of them is wrong:
     *
     * | | |
     * |---|---|
     * | D-001 … D-045 | `**Date:** 2026-07-26`, sometimes with an issue after it |
     * | D-046 onward | `**2026-08-01.**`, issue and any supersession on the line |
     * | D-051 and friends | `**Decided 2026-08-02**` inside the opening sentence |
     *
     * So this takes the first date in the record's opening lines rather than
     * asserting a convention. **Normalising 44 files would have made the diff a
     * rewrite of the thing it was meant to be moving** — every byte of every
     * record reaches its file unchanged, which is what makes the split provable.
     *
     * A convention for the next record belongs in `AGENTS.md`, where an author
     * meets it, and not in a check that would fail the 129 already written.
     */
    const opening = text.split('\n').slice(0, 10).join('\n')
    const date = opening.match(/(\d{4}-\d{2}-\d{2})/)
    if (date === null) {
      throw new Error(
        `${file} states no date in its opening lines. Every record records when it was ` +
          'decided — `**Date:** YYYY-MM-DD` on the line after the heading is the shape to use.',
      )
    }

    if (!file.startsWith(`${parsed[1]}-`)) {
      throw new Error(`${file} is named for a different record than its heading (${parsed[1]}).`)
    }

    found.push({ file, number: parsed[1], title: parsed[2], date: date[1] })
  }

  const seen = new Map()
  for (const record of found) {
    const first = seen.get(record.number)
    if (first !== undefined) {
      throw new Error(
        `${record.number} is claimed by two files: ${first} and ${record.file}. A number is ` +
          'never reassigned and never shared — take the next free one.',
      )
    }
    seen.set(record.number, record.file)
  }

  return found
}

/**
 * The index, as a list and deliberately not as a table.
 *
 * **A markdown table would undo the thing this split is for.** Prettier pads
 * every cell to the width of the widest one, so a record with a long title
 * rewrites *every other row* — one append, 129 lines changed, which is a worse
 * conflict than the one being cured. A list item is one line, and a new record
 * adds exactly one line at the end.
 *
 * That also makes `merge=union` on this file correct rather than merely safe:
 * two branches each appending one line produce two lines, which is what the file
 * should say.
 *
 * One entry per record and nothing else. Whatever a reader wants beyond the
 * title is in the record, one link away, which is the whole point.
 */
function index() {
  const rows = records().map(
    (record) => `- [${record.number}](decisions/${record.file}) — ${record.title} · ${record.date}`,
  )

  return [PREAMBLE, ...rows, ''].join('\n')
}

/**
 * The directory's own errors, as a gate failure rather than a stack trace.
 *
 * **This is the path `merge=union` on the index makes reachable** (`#1496`,
 * `#1497`). Two branches that both take `D-130` merge cleanly — that is what the
 * driver is for — and the collision surfaces here, which makes this the message a
 * person actually meets. Measured 2026-08-21: it arrived as an unhandled
 * exception with eight lines of Node internals above the sentence that says what
 * to do. Every sibling gate in `scripts/` prints its reason and exits; this one
 * now does too.
 */
let built
try {
  built = index()
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}

if (process.argv.includes('--check')) {
  const onDisk = readFileSync(INDEX, 'utf8')
  if (onDisk === built) {
    console.log(`docs/decisions.md is the index ${records().length} records assemble to`)
    process.exit(0)
  }

  console.error(
    'docs/decisions.md is not what scripts/build-decisions-index.mjs would write.\n' +
      'It is produced from docs/decisions/ and must not be hand-edited — a record is a file in\n' +
      'that directory. Run `npm run build:decisions` and commit the result.',
  )
  process.exit(1)
}

writeFileSync(INDEX, built, 'utf8')
console.log(`docs/decisions.md written as an index over ${records().length} records`)
