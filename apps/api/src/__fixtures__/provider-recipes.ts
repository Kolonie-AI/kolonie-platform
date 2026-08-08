import {
  AccountKindSchema,
  noFigures,
  now as currentTime,
  type AtlasFigures,
  type ProviderRecipe,
} from '@kolonie-ai/core'
import type { ProviderRecipes } from '../provider-recipes.js'

/**
 * The provider catalogue, in memory (`#521`).
 *
 * **Empty by default and seeded by the test that needs entries.** A fixture that
 * shipped the three real entries would make every unrelated test depend on their
 * wording, and the catalogue is content — the thing most likely to be edited.
 */
export interface FakeProviderRecipes extends ProviderRecipes {
  readonly write: (
    entry: Omit<Partial<ProviderRecipe>, 'kind' | 'provider'> & {
      kind: string
      provider: string
    },
  ) => void
  /**
   * What a test says was measured about an entry (`#545`).
   *
   * **Set rather than derived**, unlike the catalogue rows beside it: the
   * measurement is a query over two other tables, and reimplementing it here
   * would let a page test pass against a fake that counts differently from the
   * SQL. `packages/db/src/storage/atlas-figures.test.ts` is where the counting
   * is asserted, against a real Postgres.
   */
  readonly measure: (figures: AtlasFigures) => void
}

export function fakeProviderRecipes(): FakeProviderRecipes {
  const rows: ProviderRecipe[] = []
  const measured: AtlasFigures[] = []

  return {
    async figures() {
      return rows.map(
        (row) =>
          measured.find((one) => one.kind === row.kind && one.provider === row.provider) ??
          noFigures(row.kind, row.provider),
      )
    },

    measure(figures) {
      measured.push(figures)
    },

    async list(kind) {
      return rows
        .filter((row) => kind === undefined || row.kind === kind)
        .sort((a, b) => Number(b.joinable) - Number(a.joinable))
    },

    async one(kind, provider) {
      return rows.find(
        (row) => row.kind === kind && row.provider.toLowerCase() === provider.toLowerCase(),
      )
    },

    write(entry) {
      const joinable = entry.joinable ?? true
      rows.push({
        kind: AccountKindSchema.parse(entry.kind),
        provider: entry.provider as ProviderRecipe['provider'],
        title: entry.title ?? `${entry.provider}`,
        about: entry.about ?? null,
        runtimes: entry.runtimes ?? [],
        paid: entry.paid ?? false,
        joinable,
        refusal: entry.refusal ?? (joinable ? null : 'no honest route in'),
        steps: entry.steps ?? (joinable ? [{ actor: 'agent', instruction: 'sign up' }] : []),
        proves: entry.proves ?? (joinable ? 'provider-post' : null),
        caution: entry.caution ?? null,
        pacePerDay: entry.pacePerDay ?? null,
        updatedAt: currentTime(),
      })
    },
  }
}
