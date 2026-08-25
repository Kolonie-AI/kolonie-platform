import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * **The two generated artefacts are one fact, and either of them alone can be
 * stale** (`#1621`).
 *
 * `npm run catalogue-structure` used to compare only `catalogue-structure.json`
 * against the served catalogue and exit before it reached the fingerprint. A
 * correct snapshot beside a stale `catalogue-fingerprint.ts` is not exotic — it
 * is what resolving the one-line rebase conflict on the fingerprint in favour of
 * `origin/main` produces, twice in one session on `#1616` — and in that state the
 * script printed *Nothing written* and wrote nothing, while
 * `catalogue-structure.test.ts` went on failing and naming this command as the
 * remedy.
 *
 * So these cases are about *which* artefacts a run writes, and they drive the
 * script end to end rather than importing from it: the early exit, the two
 * writes and the closing message are one path, and a unit of it in isolation
 * would not have caught a gate that returned before reaching the rest.
 *
 * The sandbox stands in for the repository — a copy of the script, the two
 * artefacts, and an `npx` on `PATH` that copies a fixture where the api suite
 * would have written the served catalogue. That last shim is what keeps this
 * suite off a database: the real run drives `catalogue-structure.test.ts`, which
 * needs a PostgreSQL 16, and what is under test here is the decision the script
 * makes about what it read, not the reading.
 */
const ROOT = path.join(import.meta.dirname, '..')
const SCRIPT = 'scripts/write-catalogue-structure.mjs'
const SNAPSHOT = 'apps/api/src/mcp/catalogue-structure.json'
const FINGERPRINT = 'apps/api/src/mcp/catalogue-fingerprint.ts'
const SERVED = { tools: [{ name: 'kolonie.test', inputSchema: { type: 'object' } }] }
const EXPECTED_FINGERPRINT = createHash('sha256')
  .update(JSON.stringify(SERVED.tools))
  .digest('hex')
  .slice(0, 12)
const CURRENT_DECLARATION = `export const CATALOGUE_FINGERPRINT = '${EXPECTED_FINGERPRINT}'\n`
const STALE_DECLARATION = "export const CATALOGUE_FINGERPRINT = '000000000000'\n"

let sandbox: string | undefined

const write = (at: string, file: string, contents: string): void => {
  mkdirSync(path.join(at, path.dirname(file)), { recursive: true })
  writeFileSync(path.join(at, file), contents)
}

/**
 * A repository the script can run against, carrying the snapshot the served
 * fixture implies and a stale fingerprint — the pair `#1621` is about. A case
 * that wants a different starting state overwrites one artefact and says so.
 */
const aSandbox = (): string => {
  const at = mkdtempSync(path.join(tmpdir(), 'catalogue-structure-'))
  sandbox = at
  cpSync(path.join(ROOT, SCRIPT), path.join(at, SCRIPT))
  write(at, SNAPSHOT, JSON.stringify(SERVED))
  write(at, FINGERPRINT, STALE_DECLARATION)
  mkdirSync(path.join(at, 'node_modules'))
  symlinkSync(
    path.join(ROOT, 'node_modules', 'prettier'),
    path.join(at, 'node_modules', 'prettier'),
  )
  write(at, 'npx', '#!/bin/sh\ncp "$CATALOGUE_STRUCTURE_FIXTURE" "$CATALOGUE_STRUCTURE_OUT"\n')
  execFileSync('chmod', ['+x', path.join(at, 'npx')])
  write(at, 'served.json', JSON.stringify(SERVED))
  return at
}

const run = (at: string): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync('node', [SCRIPT], {
    cwd: at,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${at}:${process.env.PATH ?? ''}`,
      TMPDIR: at,
      CATALOGUE_STRUCTURE_FIXTURE: path.join(at, 'served.json'),
    },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const artefacts = (at: string): { snapshot: string; fingerprint: string } => ({
  snapshot: readFileSync(path.join(at, SNAPSHOT), 'utf8'),
  fingerprint: readFileSync(path.join(at, FINGERPRINT), 'utf8'),
})

afterEach(() => {
  if (sandbox !== undefined) rmSync(sandbox, { recursive: true, force: true })
  sandbox = undefined
})

describe('catalogue structure regeneration', () => {
  it('rewrites a stale fingerprint when the snapshot already matches', () => {
    const at = aSandbox()

    const result = run(at)

    expect(result.status).toBe(0)
    expect(artefacts(at).fingerprint).toBe(CURRENT_DECLARATION)
    expect(result.stdout).not.toContain('Nothing written')
  })

  // The snapshot is the expensive artefact and the one a reviewer reads line by
  // line. A run that only had the fingerprint to fix must not restamp
  // `measuredAt`, which is the determinism `#1227` asked for and the reason the
  // early exit existed at all.
  it('leaves the snapshot untouched when only the fingerprint was stale', () => {
    const at = aSandbox()
    const before = artefacts(at).snapshot

    const result = run(at)

    expect(artefacts(at).snapshot).toBe(before)
    expect(result.stdout).toContain('catalogue-fingerprint.ts')
    expect(result.stdout).not.toContain('catalogue-structure.json')
  })

  it('writes nothing when both artefacts already describe the served catalogue', () => {
    const at = aSandbox()
    write(at, FINGERPRINT, CURRENT_DECLARATION)
    const before = artefacts(at)

    const result = run(at)

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Nothing written')
    expect(artefacts(at)).toEqual(before)
  })

  it('rewrites both artefacts when the snapshot is stale', () => {
    const at = aSandbox()
    write(at, SNAPSHOT, JSON.stringify({ tools: [] }))

    const result = run(at)

    expect(result.status).toBe(0)
    expect(JSON.parse(artefacts(at).snapshot).tools).toEqual(SERVED.tools)
    expect(artefacts(at).fingerprint).toBe(CURRENT_DECLARATION)
    expect(result.stdout).toContain('catalogue-structure.json')
    expect(result.stdout).toContain('catalogue-fingerprint.ts')
  })

  /**
   * The rewrite is a regex over a one-line generated file, so the one way it
   * fails silently is finding no declaration to replace: `String.replace` on a
   * miss returns the source unchanged, and the script would then report a write
   * it did not make and send somebody back to a red `catalogue-structure.test.ts`
   * with the command that had just claimed to fix it — which is `#1621` again in
   * a second shape.
   */
  it('refuses when the generated declaration is not there to rewrite', () => {
    const at = aSandbox()
    write(at, FINGERPRINT, "export const OTHER_GENERATED_VALUE = '000000000000'\n")

    const result = run(at)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('CATALOGUE_FINGERPRINT')
    expect(artefacts(at).fingerprint).toBe("export const OTHER_GENERATED_VALUE = '000000000000'\n")
    expect(result.stdout).not.toContain('Commit')
  })
})
