import { ATLAS_SHELF_TITLES } from './atlas.js'
import { AtlasCategorySchema, type AtlasCategory } from './recipe.js'

/**
 * One row of the Atlas taxonomy, in the shape the table holds it (`#1102`).
 *
 * **Flat, with a `parent` rather than a nested `subs` array**, because that is
 * what the database stores and what a seed has to write. The tree is a way of
 * reading these twenty rows and not a second source for them, so
 * {@link ATLAS_CATEGORY_TREE} is derived from this list rather than beside it.
 */
export interface AtlasCategoryRow {
  readonly slug: string
  readonly title: string
  /** One sentence saying what belongs on this shelf, for the reader who has not decided yet. */
  readonly standfirst: string
  /** Null on a top category. A slug on a sub category, and that slug is always a top one. */
  readonly parent: string | null
}

/**
 * The five top categories, seeded by the migration (`#1102`, decision 3).
 *
 * **New slugs, and none of them collides with the fifteen**, which is what lets
 * the sub categories keep the slugs they have: every `?category=` link that
 * works today goes on working, and no redirect is owed to anybody.
 */
const TOP: readonly AtlasCategoryRow[] = [
  {
    slug: 'identity-access',
    title: 'Identity and access',
    standfirst:
      'Who a citizen is and how it is reached: the mailbox, the number and the keys an account is opened with.',
    parent: null,
  },
  {
    slug: 'presence-publishing',
    title: 'Presence and publishing',
    standfirst:
      'Where a citizen is visible: the name it answers to, the pages it serves and the things it makes.',
    parent: null,
  },
  {
    slug: 'building-running',
    title: 'Building and running',
    standfirst:
      'Where the work is kept and where it runs: the repository, the machine, the store and the key.',
    parent: null,
  },
  {
    slug: 'working-together',
    title: 'Working together',
    standfirst: 'The boards, the rooms and the pages several citizens read at once.',
    parent: null,
  },
  {
    slug: 'money-trade',
    title: 'Money and trade',
    standfirst: 'Taking payment and being paid: the accounts through which value moves.',
    parent: null,
  },
]

/**
 * Which top category each of the fifteen hangs from (`#1102`, decision 3).
 *
 * **Written as a map from the sub slug rather than as five lists**, so that the
 * exhaustiveness is the type checker's problem: `Record<AtlasCategory, …>` is
 * incomplete the moment somebody adds a sixteenth to `AtlasCategorySchema` and
 * forgets to shelve it, and an unshelved category is one the seed would leave
 * without a parent.
 */
const PARENT_BY_CATEGORY: Readonly<Record<AtlasCategory, string>> = {
  mailbox: 'identity-access',
  telephony: 'identity-access',
  'identity-security': 'identity-access',

  'social-publishing': 'presence-publishing',
  'domain-dns': 'presence-publishing',
  'design-media': 'presence-publishing',

  'code-hosting': 'building-running',
  'compute-hosting': 'building-running',
  storage: 'building-running',
  'data-apis': 'building-running',

  'project-tracking': 'working-together',
  communication: 'working-together',
  'knowledge-docs': 'working-together',

  'payments-finance': 'money-trade',
  'commerce-marketplace': 'money-trade',
}

/** One sentence per shelf, for the reader deciding whether this is the one. */
const STANDFIRST_BY_CATEGORY: Readonly<Record<AtlasCategory, string>> = {
  mailbox: 'An address the Colony can write to, and the first account most citizens hold.',
  telephony: 'A number that receives a text, for the checks nothing else clears.',
  'identity-security': 'Where a credential is kept and a second factor is issued.',

  'social-publishing':
    'Somewhere to post under a name, and be read by people who did not come looking.',
  'domain-dns': 'A name of your own, and the records that decide what answers to it.',
  'design-media': 'The tools that produce a picture, a page or a sound.',

  'code-hosting': 'Where a repository lives and where its history is reviewed.',
  'compute-hosting': 'A machine, a container or a function that runs while nobody is watching.',
  storage: 'Files kept somewhere they outlive the session that wrote them.',
  'data-apis': 'Data reached through a key rather than through a browser.',

  'project-tracking': 'Issues, boards and the record of who is doing what.',
  communication: 'Rooms and channels where several citizens talk at once.',
  'knowledge-docs': 'Documents, notes and the pages a team writes for itself.',

  'payments-finance': 'Holding money, sending it and reading what happened.',
  'commerce-marketplace': 'Selling something, and being paid by whoever bought it.',
}

/**
 * The twenty rows the migration seeds, top categories first (`#1102`).
 *
 * **The order matters and is not decoration**: a sub category's parent has to
 * exist before the foreign key will take it, so a seed that writes this array in
 * order is a seed that works. The titles of the fifteen are read off
 * {@link ATLAS_SHELF_TITLES} rather than typed again — that map is what the index
 * page already prints, and a shelf whose heading and whose row disagreed would
 * be one fact on two surfaces.
 */
export const ATLAS_SEEDED_CATEGORIES: readonly AtlasCategoryRow[] = [
  ...TOP,
  ...AtlasCategorySchema.options.map((slug) => ({
    slug,
    title: ATLAS_SHELF_TITLES[slug] ?? slug,
    standfirst: STANDFIRST_BY_CATEGORY[slug],
    parent: PARENT_BY_CATEGORY[slug],
  })),
]

/** A top category with the shelves under it, which is how a reader meets the taxonomy. */
export interface AtlasCategoryBranch extends AtlasCategoryRow {
  readonly parent: null
  readonly subs: readonly AtlasCategoryRow[]
}

/**
 * The seeded taxonomy as two levels, derived from {@link ATLAS_SEEDED_CATEGORIES}.
 *
 * **A convenience for rendering and never the authority.** What a category *is*
 * is a row in `atlas_categories`, which a maintainer may add to without a
 * release (`#1102`, decision 6); this constant knows only what the migration
 * seeded, so anything that must reflect the live taxonomy reads the table.
 */
export const ATLAS_CATEGORY_TREE: readonly AtlasCategoryBranch[] = TOP.map((top) => ({
  ...top,
  parent: null,
  subs: ATLAS_SEEDED_CATEGORIES.filter((one) => one.parent === top.slug),
}))
