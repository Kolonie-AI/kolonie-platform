import { ATLAS_PATH, stepInstruction, type AtlasCategory, type AtlasEntry } from '@kolonie-ai/core'

/**
 * The Atlas, as data a machine reads (`#789`).
 *
 * ## Why this is the cheapest reach on the surface
 *
 * `application/ld+json` appeared **0 times** anywhere on kolonie.ai, measured
 * 2026-08-12. An Atlas entry page is already a numbered list of steps for
 * accomplishing one task, with an actor marked on each step, a stated outcome
 * and a date — `#588` and `#589` forced the row into that shape for readers, and
 * a `HowTo` is that shape written down for crawlers. No new data, no curation, no
 * request-time cost.
 *
 * ## The one constraint, and it was checked rather than assumed
 *
 * These responses carry `default-src 'none'` with **no `script-src`**, measured
 * against the live headers of `/atlas/trello.com` on 2026-08-12:
 *
 * ```
 * content-security-policy: default-src 'none'; img-src 'self'; style-src 'unsafe-inline';
 *   form-action 'none'; base-uri 'none'; frame-ancestors 'none'
 * ```
 *
 * **A `<script type="application/ld+json">` is data and not a script.** CSP's
 * `script-src` governs what a browser *executes*; a block whose type is not a
 * JavaScript MIME type is never executed, so there is nothing for the policy to
 * refuse, and a parser reads it out of the DOM either way. The fallback named in
 * `#789` — serving the JSON at its own route behind `<link rel="alternate">` — is
 * therefore not taken, and the reason is written here so that a future reader can
 * disagree with the argument rather than rediscover the question.
 *
 * ## What is deliberately not here
 *
 * `Organization` belongs to the website and not to this route. `FAQPage` would
 * need `NOT_A_PROMISE` and the counterparty note restructured into questions,
 * which is a content decision. `Dataset` is worth having once the figures are
 * publishable (`#792`). All three are `#789`'s own exclusions, kept.
 */

/**
 * The shelf's own path.
 *
 * **Written here rather than imported from `html.ts`**, which exports the same
 * one line: `html.ts` imports this module to emit the blocks, and a cycle
 * between the two would be a cycle for one string concatenation. `sitemap.ts`
 * makes the same call for the same reason.
 */
const shelfPath = (category?: AtlasCategory): string =>
  category === undefined ? ATLAS_PATH : `${ATLAS_PATH}?category=${category}`

/**
 * JSON for an inline `ld+json` block, with `<` escaped.
 *
 * **This is the whole of the injection defence and it is not optional.** A
 * provider named `</script><script>…` would otherwise close the element and open
 * a real one — the values here are curated, but the catalogue is a table a
 * `psql` prompt writes to by design (`#521`), so *curated* is not a property this
 * function may assume. `>` and `&` go with it, because a partial escape is the
 * one that looks safe.
 */
export function asJsonLdBlock(value: unknown): string {
  const json = JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')

  return `<script type="application/ld+json">${json}</script>`
}

/**
 * The steps of one recipe, numbered as the page numbers them.
 *
 * **`reaches.steps` continues the count rather than restarting it** (`#637`),
 * which is the same rule the rendered page and the walk report's tick-list
 * follow. Three numberings of one list would be two of them wrong.
 */
function howToSteps(recipe: AtlasEntry['recipes'][number]): readonly unknown[] {
  const account = recipe.steps.map((step, at) => ({
    '@type': 'HowToStep',
    position: at + 1,
    name: stepInstruction(step),
    text:
      step.actor === 'operator'
        ? `${stepInstruction(step)} This step is your operator's, not yours.`
        : stepInstruction(step),
  }))

  const reach = (recipe.reaches?.steps ?? []).map((step, at) => ({
    '@type': 'HowToStep',
    position: recipe.steps.length + at + 1,
    name: stepInstruction(step),
    text: stepInstruction(step),
  }))

  return [...account, ...reach]
}

/**
 * One `HowTo` per joinable row (`#789`).
 *
 * **Per row and not per entry**, because a provider can be joinable for a mailbox
 * and refused for a domain, and one `HowTo` welding both sets of steps together
 * would be a sequence nobody can walk. The name carries the kind wherever the
 * entry has more than one row, so two blocks on one page are told apart.
 *
 * **A refused, unwritten, proposed or retired row gets nothing.** There are no
 * steps, and emitting an empty `HowTo` would be the catalogue pretending — the
 * rule `recipeSection()` already follows for the rendered page.
 */
export function howToFor(entry: AtlasEntry): readonly string[] {
  const joinable = entry.recipes.filter((recipe) => recipe.status === 'joinable')

  return joinable.map((recipe) =>
    asJsonLdBlock({
      '@context': 'https://schema.org',
      '@type': 'HowTo',
      name:
        entry.recipes.length === 1
          ? `How an agent joins ${entry.provider}`
          : `How an agent joins ${entry.provider} for a ${recipe.kind} account`,
      description: recipe.about ?? `Obtaining a ${recipe.kind} account at ${entry.provider}.`,
      /**
       * **`totalTime` is omitted because the Colony does not measure it.** The
       * figures record how many got through and the median hours to *proof*,
       * which is a different quantity from how long the steps take, and a
       * plausible-looking guess in a machine-readable field is worse than a
       * missing one.
       */
      dateModified: recipe.updatedAt,
      step: howToSteps(recipe),
    }),
  )
}

/** Atlas → category → entry, from the same helper the page's own links use. */
export function breadcrumbFor(entry: AtlasEntry, siteUrl: string): string {
  const at = (path: string) => `${siteUrl}${path}`

  return asJsonLdBlock({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'The Atlas', item: at(shelfPath()) },
      {
        '@type': 'ListItem',
        position: 2,
        name: entry.category,
        item: at(shelfPath(entry.category)),
      },
      { '@type': 'ListItem', position: 3, name: entry.title, item: at(entry.path) },
    ],
  })
}

/**
 * The index, as the list it rendered.
 *
 * **In the order it was rendered in, and never re-sorted here.** That order is
 * `atlasByOutcome`'s — measured outcome, never payment — and a second sort at
 * this layer would be a second answer to the one question the ranking exists to
 * settle.
 */
export function itemListFor(
  entries: readonly AtlasEntry[],
  siteUrl: string,
  category?: AtlasCategory | undefined,
): string {
  return asJsonLdBlock({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: category === undefined ? 'The Atlas' : `The Atlas — ${category}`,
    numberOfItems: entries.length,
    itemListElement: entries.map((entry, at) => ({
      '@type': 'ListItem',
      position: at + 1,
      name: entry.title,
      url: `${siteUrl}${entry.path}`,
    })),
  })
}
