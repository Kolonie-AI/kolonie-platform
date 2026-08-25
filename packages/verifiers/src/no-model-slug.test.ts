import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * No provider model slug is compiled into this repository (`#1694`).
 *
 * **A grep and not a review**, because the failure this prevents is somebody
 * adding one back quietly: a slug is one line, it works, and it is only wrong on
 * the day somebody wants a different model and finds it costs a release. What a
 * service asks for is a capability tier; which model serves it is a gateway
 * setting.
 *
 * The pattern is `apps/doctor-runner/src/prose.test.ts`'s, generalised from one
 * file to three trees. A provider slug is `vendor/model` in a quoted string, and
 * media types are the one shape that looks like one and is not — excluded by
 * name rather than by loosening the pattern, because a check that had to be
 * loosened once has to be loosened again.
 */
const REPOSITORY = fileURLToPath(new URL('../../../', import.meta.url))

const TREES = [
  'packages/core/src',
  'packages/verifiers/src',
  ...readdirSync(`${REPOSITORY}apps`, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith('-runner'))
    .map((entry) => `apps/${entry.name}/src`),
]

/**
 * A provider model slug is `vendor/model` **where the model segment carries a
 * version** — `openai/gpt-4o-mini`, `deepseek/deepseek-v4-flash`,
 * `openai/text-embedding-3-small`, every one of the five this issue removed.
 *
 * The version is what separates a slug from the other things shaped like one, and
 * naming it is narrower than the exclusions it replaces: `they/them`, `it/its`
 * and `n/a` in `agent.ts` are pronouns and an abbreviation, and
 * `governance/quests.md.` is a path into `kolonie-docs`. A list of those by name
 * would be a list that grows every time somebody writes a pronoun, which is the
 * loosening this rule warns about — this one does not move when prose does.
 *
 * Media types are excluded by name because `image/png` has no version and would
 * otherwise pass anyway; they are listed so that the reason is stated rather than
 * incidental. `@preset/tier-N` is excluded because it is the string this issue
 * introduced: a tier, which is the entire point.
 */
const VERSIONED = /[0-9-]/

const NOT_A_SLUG = (slug: string): boolean => {
  const model = slug.slice(slug.indexOf('/') + 1)
  return (
    slug.startsWith('application/') ||
    slug.startsWith('text/') ||
    slug.startsWith('image/') ||
    slug.startsWith('@preset/') ||
    !VERSIONED.test(model)
  )
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) {
      // Fixtures and fakes may name a slug: they stand in for a provider's own
      // answer, and a reply that names what answered is what a real one carries.
      return entry.name === '__fixtures__' ? [] : sourceFiles(path)
    }
    if (!entry.name.endsWith('.ts')) return []
    if (entry.name.endsWith('.test.ts')) return []
    return [path]
  })
}

describe('no committed source names a model', () => {
  it.each(TREES)('names none in %s', (tree) => {
    const found = sourceFiles(`${REPOSITORY}${tree}`).flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      return [...source.matchAll(/['"]([a-z0-9-]+\/[a-z0-9.-]+)['"]/g)]
        .map((match) => match[1] as string)
        .filter((slug) => !NOT_A_SLUG(slug))
        .map((slug) => `${path.slice(REPOSITORY.length)}: ${slug}`)
    })

    expect(found).toEqual([])
  })

  it('reads something, so a passing grep is not an empty one', () => {
    for (const tree of TREES) {
      expect(sourceFiles(`${REPOSITORY}${tree}`).length).toBeGreaterThan(0)
    }
  })
})
