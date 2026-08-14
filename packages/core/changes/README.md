# changes

**One file per changelog entry.** `../CHANGELOG.md` is assembled from this
directory and is not edited by hand.

## Adding one

Create a file. The name is `<next number>-<a-slug-of-the-entry>.md`, the first
line names the section, and the rest is the entry as it should read:

```markdown
<!-- section: Added -->

- **A quest draft has three chances to be corrected after refusal**
  (`kolonie-platform#696`). `QUEST_REFUSAL_LIMIT` names the per-draft boundary;
  it does not impose a cooldown or change anything about the sponsor.
```

Then rebuild, from the repository root:

```bash
node scripts/build-changelog.mjs
```

`npm run check` fails if `CHANGELOG.md` is not what this directory assembles to,
so the rebuild is not optional and cannot be forgotten quietly.

Sections are Keep a Changelog's: `Added`, `Changed`, `Deprecated`, `Removed`,
`Fixed`, `Security`.

## Why one file each

`CHANGELOG.md` was appended to at the top by every change that touched
`@kolonie-ai/core`, so **two changes in flight at once conflicted there by
construction** — whatever else they touched and however unrelated they were. On
2026-08-10 `#668` and `#670` collided on it: two entries, two different subjects,
both inserted under `### Added`. Two changes now write two files, and **those two
files never meet**.

### They still meet on the assembled file, and here is what to do about it

`CHANGELOG.md` is generated _and committed_, so a change that adds an entry also
rewrites it — and two branches in flight collide there, on a file neither author
wrote. Measured 2026-08-14 on one branch, twice in an hour: `#948` and `#950`
shared nothing, added `214-…md` and `215-…md`, and conflicted on the assembled
file the moment the first merged; rebased and pushed, and `#929` merging did it
again.

**The resolution is always the same and is never a judgement:**

```bash
node scripts/build-changelog.mjs   # then `git add packages/core/CHANGELOG.md`
```

Take neither side. `git checkout --ours` on a generated file silently drops the
other change's entry — `npm run check` catches it at `check:changelog`, so it
fails safe, but it fails safe because somebody wrote that check and not because
resolving it by hand is sound.

**Whether the collision should exist at all is `#951`**, which weighs a merge
driver against not committing the file and picks neither. This paragraph is true
whichever way that goes.

**The argument was made once already in this organisation and won.**
`kolonie-docs/state/decisions.md` had the same shape, reached 3052 lines on
+3135/−82 in three weeks, and was split one-file-per-record for this reason. This
file had reached 1745 lines and 138 entries under a single `## Unreleased` — with
_fourteen_ separate `### Added` and `### Changed` headings inside it, because
each append made its own heading rather than finding the last one. That is the
same defect showing through the structure.

## What this is not

**Not a second place to look.** `CHANGELOG.md` is still where a changelog is
read, and consumers of the package read it at a tag and through GitHub. Only
where an entry is _written_ changed.

**Not a generated file with no author.** Assembling is concatenation and never
summarisation — every byte of every entry reaches the output unchanged. Several
of these entries are the only place a decision's shape is recorded, which is why
they are prose and worth reading.

## The numbers

They are a reading order, not an identity. 001–138 are the positions the entries
had when this directory was created, so the assembled file reads as it always
did. A new entry takes the next number and lands at the end of its section rather
than the top: the one visible change, and the price of two changes never touching
the same line.

Nothing reads a gap in the sequence, so a deleted entry leaves one and that is
fine.

## At a release

The unreleased entries fold into `RELEASED.md` under a new version heading, and
the files that produced them are deleted. `RELEASED.md` is the one file here that
is written by hand, and only then.
