import { readFileSync, readdirSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * Every label a source in this repository applies to a GitHub issue belongs to
 * the shared vocabulary.
 *
 * `#687` removed `needs-triage` after the board's Inbox column became the one
 * record of that state. The label had still been applied by a runner after it
 * was deleted from GitHub, because nothing joined source literals to the list of
 * labels the repositories maintain. This test makes that drift fail locally.
 *
 * The vocabulary is deliberately easy to extend: add the label here when it is
 * added to the repositories. What is refused is a source inventing a name on its
 * own. Tests are excluded because they may name an unknown label to prove the
 * rejection case below.
 */
const ISSUE_LABELS = new Set([
  'p1',
  'p2',
  'bug',
  /**
   * The other half of `bug`, and the label a citizen's proposal now carries
   * (`#783`). Both exist in kolonie-platform, kolonie-infra and kolonie-docs —
   * checked against the three repositories on 2026-08-13 before the runner was
   * allowed to write either.
   */
  'enhancement',
  /**
   * A report that describes an attack surface (`#783`). It is a property of a
   * ticket rather than a route for one: same repository, same `area:`, and the
   * citizen's words are withheld from the public issue.
   */
  'security',
  'area:platform',
  'area:infra',
  'area:docs',
  'area:skills',
  'area:website',
  'area:governance',
  'area:dns',
  'idea',
  'question',
  'decision',
  'documentation',
  'from:citizen',
  'from:watcher',
  'from:maintainer',
  'from:agent',
  'from:external',
  'agent:claude',
  'agent:opencode',
  'blocked:human',
  'opencode:failed',
  'opencode:forbidden',
])

const ROOT = resolve(import.meta.dirname, '..')
const LABEL_PREFIX = /^(?:p\d+|area:|from:|agent:|blocked:|opencode:)/

interface AppliedLabel {
  readonly source: string
  readonly label: string
}

function stringLiterals(node: ts.Node): readonly string[] {
  const values: string[] = []

  function visit(current: ts.Node): void {
    if (ts.isStringLiteralLike(current)) values.push(current.text)
    ts.forEachChild(current, visit)
  }

  visit(node)
  return values
}

function filesBelow(directory: string, extensions: ReadonlySet<string>): readonly string[] {
  const files: string[] = []

  function walk(current: string): void {
    for (const entry of readdirSync(resolve(ROOT, current), { withFileTypes: true })) {
      const source = join(current, entry.name)
      if (entry.isDirectory()) walk(source)
      else if (extensions.has(extname(entry.name))) files.push(source)
    }
  }

  walk(directory)
  return files
}

function typescriptLabels(source: string): readonly AppliedLabel[] {
  const text = readFileSync(resolve(ROOT, source), 'utf8')
  const file = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, true)
  const labels: AppliedLabel[] = []
  const createsIssues = /\b(?:GitHub|IssueOpener|NewIssue|issues\.create|gh issue create)\b/.test(
    text,
  )

  function visit(node: ts.Node): void {
    if (createsIssues && ts.isStringLiteralLike(node) && LABEL_PREFIX.test(node.text)) {
      labels.push({ source, label: node.text })
    }

    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'labels' &&
      createsIssues
    ) {
      labels.push(...stringLiterals(node.initializer).map((label) => ({ source, label })))
    }

    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text.endsWith('_LABELS') &&
      createsIssues &&
      node.initializer !== undefined
    ) {
      labels.push(...stringLiterals(node.initializer).map((label) => ({ source, label })))
    }

    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text.toLowerCase().includes('label') === true &&
      createsIssues
    ) {
      labels.push(...stringLiterals(node).map((label) => ({ source, label })))
    }

    ts.forEachChild(node, visit)
  }

  visit(file)
  return labels
}

function templateLabels(source: string): readonly AppliedLabel[] {
  const text = readFileSync(resolve(ROOT, source), 'utf8')
  const line = text.match(/^labels:\s*\[(.*)]$/m)?.[1] ?? ''
  return [...line.matchAll(/['"]([^'"]+)['"]/g)].map((match) => ({
    source,
    label: match[1] ?? '',
  }))
}

function workflowLabels(source: string): readonly AppliedLabel[] {
  const text = readFileSync(resolve(ROOT, source), 'utf8')
  return [...text.matchAll(/--label\s+['"]([^'"]+)['"]/g)].map((match) => ({
    source,
    label: match[1] ?? '',
  }))
}

function unknownLabels(labels: readonly AppliedLabel[]): readonly AppliedLabel[] {
  return labels.filter(({ label }) => !ISSUE_LABELS.has(label))
}

const typescriptSources = [
  ...filesBelow('apps', new Set(['.ts'])),
  ...filesBelow('packages', new Set(['.ts'])),
]
  .filter((source) => !source.endsWith('.test.ts'))
  .filter((source) => !source.includes('/dist/'))
const issueTemplates = filesBelow('.github/ISSUE_TEMPLATE', new Set(['.md']))
const issueWorkflows = filesBelow('.github/workflows', new Set(['.yml', '.yaml']))
const applied = [
  ...typescriptSources.flatMap(typescriptLabels),
  ...issueTemplates.flatMap(templateLabels),
  ...issueWorkflows.flatMap(workflowLabels),
]

describe('GitHub issue labels used by source', () => {
  it('finds every current label-producing source, so discovery cannot silently empty', () => {
    const sources = new Set(applied.map(({ source }) => relative(ROOT, resolve(ROOT, source))))
    expect(sources).toContain('apps/support-triage-runner/src/triage.ts')
    expect(sources).toContain('apps/support-triage-runner/src/defects.ts')
    expect(sources).toContain('apps/moderation-runner/src/tripwire.ts')
    expect(sources).toContain('.github/workflows/skill-platforms.yml')
    expect(sources).toContain('.github/ISSUE_TEMPLATE/bug.md')
  })

  it('uses only labels from the shared vocabulary', () => {
    expect(unknownLabels(applied)).toEqual([])
  })

  it('rejects a label a source invented', () => {
    expect(unknownLabels([{ source: 'example.ts', label: 'invented-status' }])).toEqual([
      { source: 'example.ts', label: 'invented-status' },
    ])
  })
})

/**
 * Provenance — `#686`, and `kolonie-docs#259`'s last row is what consumes it.
 *
 * **An issue's provenance decides how carefully it must be triaged**, and it was
 * recorded inconsistently and by hand: measured 2026-08-10 across the four
 * repositories, `from:citizen` was on 7 open issues, `from:watcher` on 3, and
 * nothing at all on everything a maintainer or the maintainer agent opened. The
 * labels existed; nothing set them reliably.
 *
 * `from:citizen` is the one that earns the rest. A support ticket becomes an
 * issue body through a model, and that body becomes an instruction to a coding
 * agent — the only path in the Colony from *anyone with an API key* to *a
 * commit*. The chain is legitimate; the label is what lets the routing rule see
 * it. `from:watcher` marks the opposite, text the Colony generated about itself,
 * which is why those can be routed briskly.
 */
describe('every machine path says where its issue came from', () => {
  const PROVENANCE = /^from:/

  /**
   * Sources that create an issue without a human choosing to. The list is
   * explicit because the point is that **none** of them may be missing — a
   * discovery rule that quietly returned fewer sources would pass this suite by
   * having nothing left to check.
   */
  const MACHINE_PATHS = [
    'apps/support-triage-runner/src/triage.ts',
    'apps/support-triage-runner/src/defects.ts',
    'apps/moderation-runner/src/tripwire.ts',
    '.github/workflows/skill-platforms.yml',
  ]

  /**
   * **Distinct labels, not occurrences.** The extractor above deliberately reads
   * a source several ways — every string literal, every `labels:` property,
   * every `*_LABELS` declaration — so one label reached by two of them arrives
   * twice. That is the right behaviour for *is this label in the vocabulary* and
   * the wrong unit for *how many did it set*. A source naming two different
   * provenances is still caught, which is what the rule is for.
   */
  it.each(MACHINE_PATHS)('%s sets exactly one from: label', (source) => {
    const provenance = new Set(
      applied
        .filter((entry) => relative(ROOT, resolve(ROOT, entry.source)) === source)
        .map(({ label }) => label)
        .filter((label) => PROVENANCE.test(label)),
    )

    expect([...provenance]).toHaveLength(1)
  })

  /**
   * **The one that must not be forgeable.** `from:external` is applied by
   * whatever reads the board, from the author's organisation membership — a
   * fact GitHub already holds. An issue opened by a stranger claiming
   * `from:maintainer` is the whole attack, and an issue *template* is the file
   * a stranger fills in.
   *
   * So a template carries no provenance at all, and this asserts the absence
   * rather than trusting it. It is the reason the rule above is scoped to
   * machine paths instead of to everything that touches a label.
   */
  it('lets no issue template claim a provenance for its author', () => {
    const claimed = issueTemplates
      .flatMap(templateLabels)
      .filter(({ label }) => PROVENANCE.test(label))

    expect(claimed).toEqual([])
  })

  it('refuses a template that tried to', () => {
    const claimed = [{ source: 'bug.md', label: 'from:maintainer' }].filter(({ label }) =>
      PROVENANCE.test(label),
    )

    expect(claimed).toEqual([{ source: 'bug.md', label: 'from:maintainer' }])
  })
})
