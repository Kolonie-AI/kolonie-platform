import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — a build script, deliberately outside the TypeScript project,
// for the same reason the workspace runner and the dist check are.
import { drift, lockDrift } from './check-lock.mjs'

/**
 * `#882`. A workspace added without regenerating `package-lock.json` passes every
 * step of `npm run check` and fails on the runner at `npm ci`, before anything is
 * compiled — `main` was red for six and a half hours across eight commits that
 * were all fine.
 *
 * The reasoning, the measurement that ruled out `npm ci --dry-run`, and what this
 * check deliberately does not cover are in `check-lock.mjs`. What is here is the
 * behaviour, and the two directions it has to get right: it must fail on a lock
 * that `npm ci` would refuse, and it must **not** fail on one npm installs
 * perfectly well. The second is the one that decides whether this check survives
 * — a check that cries wolf is removed from the chain within a week, and the
 * defect it was written for comes back with it.
 */
const ROOT = path.join(import.meta.dirname, '..')

const manifest = (extra: Record<string, unknown> = {}) => ({
  name: '@kolonie-ai/api',
  version: '0.1.0',
  dependencies: { fastify: '^5.10.0', '@kolonie-ai/core': '*' },
  ...extra,
})

describe('reading a drift out of two files', () => {
  it('says nothing when every manifest matches its lock entry', () => {
    expect(lockDrift({ 'apps/api': manifest() }, { 'apps/api': manifest() })).toEqual([])
  })

  /** The `#882` case itself: a workspace in the tree that the lock has never heard of. */
  it('names a workspace with no entry at all', () => {
    const found = lockDrift(
      {
        'apps/api': manifest(),
        'apps/doctor-runner': manifest({ name: '@kolonie-ai/doctor-runner' }),
      },
      { 'apps/api': manifest() },
    )

    expect(found).toEqual([
      {
        location: 'apps/doctor-runner',
        problem: 'apps/doctor-runner has no entry in the lock file',
      },
    ])
  })

  it('names a dependency added to a manifest and not to the lock', () => {
    const found = lockDrift(
      {
        'apps/api': manifest({
          dependencies: { fastify: '^5.10.0', '@kolonie-ai/core': '*', zod: '^4.4.3' },
        }),
      },
      { 'apps/api': manifest() },
    )

    expect(found).toEqual([{ location: 'apps/api', problem: 'apps/api dependencies: added zod' }])
  })

  it('names a dependency dropped, and a range that moved', () => {
    const found = lockDrift(
      { 'apps/api': manifest({ dependencies: { fastify: '^6.0.0' } }) },
      { 'apps/api': manifest() },
    )

    expect(found).toEqual([
      {
        location: 'apps/api',
        problem: 'apps/api dependencies: dropped @kolonie-ai/core; re-ranged fastify',
      },
    ])
  })

  it('names a version bumped in the manifest alone', () => {
    const found = lockDrift(
      { 'apps/api': manifest({ version: '0.2.0' }) },
      { 'apps/api': manifest() },
    )

    expect(found).toEqual([
      { location: 'apps/api', problem: 'apps/api is version 0.2.0, locked as 0.1.0' },
    ])
  })

  /** The same edit made the other way round — a workspace deleted and left locked. */
  it('names a lock entry that is no longer a workspace', () => {
    const found = lockDrift(
      { '': { name: 'root' } },
      { '': { name: 'root' }, 'apps/gone': manifest() },
    )

    expect(found).toEqual([
      { location: 'apps/gone', problem: 'apps/gone is in the lock file and is not a workspace' },
    ])
  })

  it('does not mistake the lock’s installed packages for missing workspaces', () => {
    const found = lockDrift(
      { '': { name: 'root' } },
      { '': { name: 'root' }, 'node_modules/fastify': { version: '5.10.0' } },
    )

    expect(found).toEqual([])
  })

  /**
   * The false-failure guard, and the reason `pairs` sorts. npm writes the lock's
   * copy in the manifest's own order, so reordering `package.json` — which a
   * formatter or a person may do at any time — must not read as drift on a tree
   * `npm ci` installs without complaint.
   */
  it('does not read a reordered dependency block as a change', () => {
    const found = lockDrift(
      { 'apps/api': manifest({ dependencies: { '@kolonie-ai/core': '*', fastify: '^5.10.0' } }) },
      { 'apps/api': manifest() },
    )

    expect(found).toEqual([])
  })

  it('treats an absent block and an empty one as the same thing', () => {
    expect(
      lockDrift(
        { 'apps/api': { version: '0.1.0' } },
        { 'apps/api': { version: '0.1.0', dependencies: {} } },
      ),
    ).toEqual([])
  })
})

describe('walking this repository', () => {
  const treeWith = async (lockPackages: Record<string, unknown>) => {
    const root = await mkdtemp(path.join(tmpdir(), 'check-lock-'))
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'root', version: '0.0.0', workspaces: ['apps/*'] }),
    )
    await mkdir(path.join(root, 'apps/api'), { recursive: true })
    await writeFile(path.join(root, 'apps/api/package.json'), JSON.stringify(manifest()))
    await writeFile(
      path.join(root, 'package-lock.json'),
      JSON.stringify({ lockfileVersion: 3, packages: lockPackages }),
    )
    return root
  }

  it('reads the root and every workspace the globs resolve to', async () => {
    const root = await treeWith({
      '': { name: 'root', version: '0.0.0' },
      'apps/api': manifest(),
    })

    expect(await drift(root)).toEqual([])
  })

  it('finds the workspace the lock is missing', async () => {
    const root = await treeWith({ '': { name: 'root', version: '0.0.0' } })

    expect(await drift(root)).toEqual([
      { location: 'apps/api', problem: 'apps/api has no entry in the lock file' },
    ])
  })

  /**
   * The check runs against this repository on every `npm run check`, so the
   * repository itself has to pass it — and this is the assertion that says so
   * before a reader concludes from a green chain that it was even looked at.
   */
  it('is green against the repository it guards', async () => {
    expect(await drift(ROOT)).toEqual([])
  })
})

describe('where the guard sits in the chain', () => {
  const scripts = () => {
    const parsed = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    return parsed.scripts
  }

  /**
   * **First**, because it is the step whose failure makes every later step
   * meaningless: a lock file that cannot install is not a tree whose formatting,
   * types or tests mean anything. That ordering is one word in a long shell
   * string — the easiest thing here to lose to somebody appending a step — and
   * losing it is silent, because the check still passes.
   *
   * Both chains, and not only `check`. `check:fast` is the loop an agent runs
   * while it works, so a guard absent from it reports the defect one full check
   * later than it could have.
   */
  it.each(['check', 'check:fast'])('runs before anything else in %s', (name) => {
    expect(scripts()[name]).toMatch(/^npm run check:lock &&/)
  })

  it('is this script, and not npm ci --dry-run, which empties node_modules on npm 9', () => {
    expect(scripts()['check:lock']).toBe('node scripts/check-lock.mjs')
  })
})
