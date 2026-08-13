/**
 * Assert that `package-lock.json` still describes the workspaces beside it, so
 * that `npm ci` cannot be the first thing to find out that it does not.
 *
 * ## The failure this is named after
 *
 * `#882`. `apps/doctor-runner` was added as a workspace in `43cedfe1` and the
 * lock file was never regenerated. `npm ci` — the **first** step of the CI job —
 * refuses outright:
 *
 * ```
 * npm error `npm ci` can only install packages when your package.json and
 * package-lock.json ... are in sync.
 * npm error Missing: @kolonie-ai/doctor-runner@0.1.0 from lock file
 * ```
 *
 * `CI` and `MCP surface` were red on `main` from 2026-08-13 ~15:00 to 21:40,
 * across eight commits by two sessions. Nothing was wrong with any of them; the
 * job never reached the code, and `Build and deploy` runs on the same commits.
 *
 * **Nothing local could have caught it.** Every step of `npm run check` runs
 * against an already-installed tree — `npm ci` appears only in the workflow — so
 * a workspace added without regenerating the lock passes the whole check, passes
 * the reviewer agent reading a diff, and fails on the runner at the step before
 * anything is compiled. Green everywhere a person or an agent looks, red only
 * where nobody is looking until a deploy stops.
 *
 * ## Why this is not `npm ci --dry-run`
 *
 * That is what `#882` proposed, and it is the better check in every respect but
 * one: **on npm 9 it deletes `node_modules`.** `npm ci` removes the tree before
 * it installs, and `--dry-run` skips the install while keeping the removal.
 * Measured here on 2026-08-13, npm 9.2.0, three times:
 *
 * ```
 * $ npm ci            → 245 entries in node_modules, prettier present
 * $ npm ci --dry-run  → 0 entries, prettier gone
 * ```
 *
 * As the first step of `npm run check` that is not a guard, it is a demolition:
 * `format:check` is the next line and it died on `spawn … /node_modules/.bin/
 * prettier ENOENT`. Newer npm does not do this, and **that is what makes it
 * unusable rather than merely wrong** — CI installs its own npm through
 * `actions/setup-node`, this repository pins none, and a check that quietly
 * empties the tree on some readers' machines and not others is worse than no
 * check at all. It would be diagnosed as a broken install, once per reader.
 *
 * `npm ls --workspaces` is the other obvious candidate and answers a different
 * question: it reads the installed tree, which is precisely the thing that is
 * right when the lock file is wrong.
 *
 * ## What this reads instead
 *
 * The lock file already contains the answer. Under `packages`, npm records its
 * own copy of the root manifest and of **every workspace manifest**, keyed by
 * directory — `apps/api`, `packages/core` — carrying the `version` and the
 * dependency ranges as they were when the lock was written. So the question
 * *"would `npm ci` refuse?"* is, for this class, a comparison between two files
 * in this repository, and it needs neither a network nor an installed tree.
 *
 * **What it catches:** a workspace with no entry (the `#882` case), a workspace
 * removed and still locked, a version bumped in a manifest, and a dependency
 * added, dropped or re-ranged anywhere — root or workspace — without
 * `npm install`.
 *
 * **What it does not:** everything about the transitive tree. A lock whose
 * `node_modules/*` entries are inconsistent, an integrity hash that has moved, a
 * registry that no longer serves a pinned version — `npm ci` finds those and
 * this cannot. It is the narrow check `#882` named as the fallback, and it is
 * honest about being one: it catches the class that reaches `main`, which is a
 * manifest edited by hand and a lock nobody regenerated.
 *
 * **The message is this script's own, and not npm's.** Wanting the local failure
 * to read exactly like the remote one is what argued for `npm ci --dry-run`; that
 * is the property given up here, so what is printed instead names the same
 * sentence npm would print and the one command that fixes it.
 */
import console from 'node:console'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * The manifest fields npm copies into a lock entry, and therefore the ones a
 * drift can be read from. `peerDependencies` and `optionalDependencies` are here
 * because npm records them too — none of this repository's manifests uses either
 * today, and a check that only covers what is currently in use fails to notice
 * the first one that arrives.
 */
export const LOCKED_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]

/**
 * A manifest's dependency map as sorted pairs, so that a comparison does not
 * depend on key order.
 *
 * npm writes the lock's copy in the manifest's order, so a reordered
 * `package.json` with an otherwise untouched lock would read as drift — a false
 * failure on a tree `npm ci` installs perfectly well, and the fastest possible
 * way to get this check deleted.
 */
const pairs = (map) => Object.entries(map ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

const same = (a, b) => JSON.stringify(pairs(a)) === JSON.stringify(pairs(b))

/**
 * What has drifted between the manifests in the tree and the lock file's copies
 * of them, as one finding per fact so that a reader is told all of it at once
 * rather than the first of it.
 *
 * `manifests` is keyed the way the lock keys its `packages`: the root is the
 * empty string, a workspace is its directory with forward slashes.
 */
export const lockDrift = (manifests, lockPackages) => {
  const found = []

  for (const [location, manifest] of Object.entries(manifests)) {
    const locked = lockPackages[location]
    const name = location === '' ? 'the root package' : location

    if (locked === undefined) {
      found.push({ location, problem: `${name} has no entry in the lock file` })
      continue
    }

    if (manifest.version !== undefined && manifest.version !== locked.version) {
      found.push({
        location,
        problem: `${name} is version ${manifest.version}, locked as ${locked.version}`,
      })
    }

    for (const field of LOCKED_FIELDS) {
      if (same(manifest[field], locked[field])) continue

      const inManifest = new Set(Object.keys(manifest[field] ?? {}))
      const inLock = new Set(Object.keys(locked[field] ?? {}))
      const added = [...inManifest].filter((dependency) => !inLock.has(dependency))
      const dropped = [...inLock].filter((dependency) => !inManifest.has(dependency))
      const moved = [...inManifest].filter(
        (dependency) =>
          inLock.has(dependency) && manifest[field][dependency] !== locked[field][dependency],
      )

      const said = [
        added.length > 0 && `added ${added.sort().join(', ')}`,
        dropped.length > 0 && `dropped ${dropped.sort().join(', ')}`,
        moved.length > 0 && `re-ranged ${moved.sort().join(', ')}`,
      ].filter(Boolean)

      found.push({ location, problem: `${name} ${field}: ${said.join('; ')}` })
    }
  }

  // The other direction: a workspace deleted from the tree and left in the lock.
  // `npm ci` refuses that too, and it is the same edit made the other way round.
  for (const location of Object.keys(lockPackages)) {
    if (location.startsWith('node_modules/')) continue
    if (location in manifests) continue

    found.push({ location, problem: `${location} is in the lock file and is not a workspace` })
  }

  return found.sort((a, b) => (a.location < b.location ? -1 : a.location > b.location ? 1 : 0))
}

/** Every workspace directory the root manifest's globs actually resolve to. */
const workspaceDirectories = async (root, patterns) => {
  const found = []

  for (const pattern of patterns) {
    // The two shapes this repository uses, `packages/*` and `apps/*`. A pattern
    // that is not a single trailing star is a shape this cannot resolve, and it
    // throws rather than resolving to nothing — a workspace silently dropped
    // from this check is the check not running.
    if (!pattern.endsWith('/*') || pattern.slice(0, -2).includes('*')) {
      throw new Error(`Unsupported workspace pattern ${JSON.stringify(pattern)} in package.json`)
    }

    const prefix = pattern.slice(0, -2)
    const entries = await readdir(path.join(root, prefix), { withFileTypes: true })

    for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort()) {
      const directory = `${prefix}/${entry.name}`
      const manifest = await readFile(path.join(root, directory, 'package.json'), 'utf8').catch(
        () => undefined,
      )
      if (manifest === undefined) continue

      found.push([directory, JSON.parse(manifest)])
    }
  }

  return found
}

/** The drift between this repository's manifests and its lock file. */
export const drift = async (root = ROOT) => {
  const rootManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'))

  const manifests = Object.fromEntries([
    ['', rootManifest],
    ...(await workspaceDirectories(root, rootManifest.workspaces ?? [])),
  ])

  return lockDrift(manifests, lock.packages ?? {})
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = await drift()

  if (found.length === 0) process.exit(0)

  console.error('package-lock.json is out of sync with the workspaces beside it:\n')
  for (const { problem } of found) console.error(`  ${problem}`)

  console.error(
    [
      '',
      '`npm ci` refuses this outright, and it is the first step of the CI job — so',
      'the whole check goes red without reaching any code (#882). Run:',
      '',
      '    npm install',
      '',
      'and commit the regenerated package-lock.json with the manifest that moved.',
      '',
    ].join('\n'),
  )
  process.exit(1)
}
