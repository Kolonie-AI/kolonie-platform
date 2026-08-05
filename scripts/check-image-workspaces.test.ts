import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Every workspace an image's app depends on is copied into that image's runtime
 * stage.
 *
 * ## The failure this is named after
 *
 * `#243` added `import { fetchPage } from '@kolonie-ai/verifiers'` to the badge
 * runner and added the dependency to its `package.json`. `apps/badge-runner/
 * Dockerfile` was not touched, and its runtime stage carried a comment saying
 * the opposite in so many words: *"`packages/verifiers` is absent: this process
 * gives out things that are worth nothing and verifies nothing at all."* True
 * when written, false the moment the import landed.
 *
 * **Nothing anywhere failed.** `npm run check` is green — the workspace resolves
 * perfectly in the repository. The image builds, pushes and passes every gate,
 * because a Dockerfile is not typechecked against the manifest beside it. It is
 * only wrong on the host.
 *
 * **And it has no symptom to read.** `node_modules/@kolonie-ai/verifiers` is a
 * workspace symlink, so it exists in the image and dangles; the process dies on
 * `ERR_MODULE_NOT_FOUND` before `createLog` has been called, so the container
 * prints **nothing at all**. The deploy script's own log said
 * `--- what the failing containers printed (last 40 lines each) ---` followed
 * immediately by the end marker. A crash-looping container with an empty log
 * reads as an infrastructure fault, and it was diagnosed as one for a day —
 * every deploy of every service reported failure, because the cascade re-deploy
 * retried the same broken image each time.
 *
 * ## Why the check is on the Dockerfile text rather than on a built image
 *
 * Building five images to assert a `COPY` line would put a Docker daemon in the
 * definition of done, which `AGENTS.md` §7 refuses: *name capabilities, not
 * tools*. What is actually being asserted is a relationship between two files in
 * this repository, and both are readable without leaving it.
 */
const ROOT = join(import.meta.dirname, '..')
const APPS = join(ROOT, 'apps')

/** The `@kolonie-ai/*` workspaces this app declares as runtime dependencies. */
function declaredWorkspaces(app: string): readonly string[] {
  const manifest = JSON.parse(readFileSync(join(APPS, app, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }

  return Object.keys(manifest.dependencies ?? {})
    .filter((name) => name.startsWith('@kolonie-ai/'))
    .map((name) => name.slice('@kolonie-ai/'.length))
}

/**
 * The runtime stage of a Dockerfile — everything after the last `FROM`.
 *
 * The build stage copies every workspace by construction (`COPY packages/
 * packages/`), so reading the whole file would pass on an image that ships none
 * of them. The runtime stage is the only part that decides what is in the
 * artefact.
 */
function runtimeStage(app: string): string {
  const dockerfile = readFileSync(join(APPS, app, 'Dockerfile'), 'utf8')
  const stages = dockerfile.split(/^FROM /m)
  return stages[stages.length - 1] ?? ''
}

const apps = readdirSync(APPS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()

describe('every image carries the workspaces its app imports', () => {
  it('finds the apps, so a rename does not silently empty this suite', () => {
    expect(apps).toContain('badge-runner')
    expect(apps.length).toBeGreaterThanOrEqual(5)
  })

  it.each(apps)('%s', (app) => {
    const stage = runtimeStage(app)

    for (const workspace of declaredWorkspaces(app)) {
      expect(
        stage.includes(`/app/packages/${workspace}/dist`),
        `apps/${app}/package.json depends on @kolonie-ai/${workspace}, and the runtime stage ` +
          `of apps/${app}/Dockerfile does not COPY packages/${workspace}/dist. The image will ` +
          `start and die on ERR_MODULE_NOT_FOUND with an empty log — the workspace symlink in ` +
          `node_modules is present and dangling, so nothing reports the absence.`,
      ).toBe(true)

      expect(
        stage.includes(`/app/packages/${workspace}/package.json`),
        `apps/${app}/Dockerfile copies packages/${workspace}/dist without its package.json. ` +
          `Node resolves the workspace through that manifest's "exports", so the dist alone ` +
          `does not make the import work.`,
      ).toBe(true)
    }
  })
})
