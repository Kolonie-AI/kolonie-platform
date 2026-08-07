import { eq } from 'drizzle-orm'
import {
  SETTINGS,
  SETTING_MAX_STALENESS_MS,
  settingNamed,
  type HumanId,
  type SettingDefinition,
  type Timestamp,
} from '@kolonie-ai/core'
import type { Database } from '../client.js'
import { authorityEvents, settings } from '../schema/index.js'

/**
 * Reading and writing the settings a maintainer may turn — D-104 (`#489`).
 *
 * ## The allow-list is consulted on every path, in and out
 *
 * A name absent from `SETTINGS` is **refused**, not stored-and-ignored. That is
 * the whole of D-104's security half: the exclusion is a property of this module
 * rather than a rule on a page, so a secret cannot reach the table even if a row
 * for it were somehow written — the read path would not return it either.
 */

/** One setting as the page shows it. */
export interface EffectiveSetting {
  readonly definition: SettingDefinition
  /** What is in effect right now, or `undefined` when neither source has a value. */
  readonly value: string | undefined
  /**
   * Which of the two is in effect.
   *
   * `#489` calls this the one that is easy to leave out, and it is required
   * whichever way precedence runs: under D-104 the database always wins, so this
   * line is what tells a maintainer their value is **still** the environment's
   * before they conclude their change did nothing.
   */
  readonly source: 'database' | 'environment' | 'unset'
  /** When the override was written, where there is one. */
  readonly changedAt?: Timestamp
}

/** How the environment is read. Injected so a test does not mutate `process.env`. */
export type EnvironmentReader = (name: string) => string | undefined

const processEnvironment: EnvironmentReader = (name) => process.env[name]

/**
 * Every setting, with its effective value and where that value came from.
 *
 * Iterates `SETTINGS` rather than the table, so a setting nobody has overridden
 * is still listed — a page that showed only the rows would be a page that hides
 * every setting until somebody changes it.
 */
export async function effectiveSettings(
  db: Database,
  environment: EnvironmentReader = processEnvironment,
): Promise<readonly EffectiveSetting[]> {
  const rows = await db.select().from(settings)
  const overridden = new Map(rows.map((row) => [row.name, row]))

  return SETTINGS.map((definition) => {
    const row = overridden.get(definition.name)
    if (row !== undefined) {
      return {
        definition,
        value: row.value,
        source: 'database' as const,
        changedAt: row.updatedAt as Timestamp,
      }
    }

    const fromEnvironment = environment(definition.name)
    return fromEnvironment === undefined || fromEnvironment === ''
      ? { definition, value: undefined, source: 'unset' as const }
      : { definition, value: fromEnvironment, source: 'environment' as const }
  })
}

export type SettingWriteOutcome =
  | { readonly outcome: 'written' }
  /** The name is not in the allow-list. Not *unsupported* — refused (D-104). */
  | { readonly outcome: 'unknown-setting' }
  /** The value did not pass the same schema the reader uses. */
  | { readonly outcome: 'invalid'; readonly reason: string }

/**
 * Override a setting, with the record of who did it.
 *
 * **Validated against the definition's own schema**, not a looser one written
 * for the form: a poll interval of `0` and a model name that is not a model are
 * both things a text box will happily accept and a runner will not survive, and
 * the refusal has to happen before the row is written rather than at the next
 * loop.
 *
 * **The write and its audit row commit together.** D-104: *a write that could
 * not be recorded is a write that does not happen.*
 */
export async function writeSetting(
  db: Database,
  command: {
    readonly name: string
    readonly value: string
    readonly by: HumanId
  },
): Promise<SettingWriteOutcome> {
  const definition = settingNamed(command.name)
  if (definition === undefined) return { outcome: 'unknown-setting' }

  const parsed = definition.schema.safeParse(command.value)
  if (!parsed.success) {
    return {
      outcome: 'invalid',
      reason: parsed.error.issues[0]?.message ?? 'not a value this setting accepts',
    }
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(settings)
      .values({ name: definition.name, value: parsed.data })
      .onConflictDoUpdate({
        target: settings.name,
        set: { value: parsed.data, updatedAt: new Date().toISOString() },
      })

    await tx.insert(authorityEvents).values({
      action: 'setting-changed',
      subjectHumanId: command.by,
    })
  })

  return { outcome: 'written' }
}

export type SettingClearOutcome =
  | { readonly outcome: 'cleared' }
  /** There was no override. Nothing was written, audit row included. */
  | { readonly outcome: 'unchanged' }
  | { readonly outcome: 'unknown-setting' }

/**
 * Put a setting back to the environment's value.
 *
 * **Deleting the row is what *back to the environment* means**, and it is a
 * distinct action from writing the old number back — the old number may itself
 * have been an override, and a maintainer recovering from a change that made
 * things worse usually does not remember what it was.
 */
export async function clearSetting(
  db: Database,
  command: { readonly name: string; readonly by: HumanId },
): Promise<SettingClearOutcome> {
  if (settingNamed(command.name) === undefined) return { outcome: 'unknown-setting' }

  return await db.transaction(async (tx) => {
    const removed = await tx
      .delete(settings)
      .where(eq(settings.name, command.name))
      .returning({ name: settings.name })

    // Nothing to clear is not an act, so it leaves no record — the rule
    // `setStewardRole` states: an audit that fills with rows where nothing
    // happened is an audit nobody reads.
    if (removed.length === 0) return { outcome: 'unchanged' as const }

    await tx.insert(authorityEvents).values({
      action: 'setting-cleared',
      subjectHumanId: command.by,
    })

    return { outcome: 'cleared' as const }
  })
}

/**
 * A reader that answers from the database, falling back to the environment, and
 * caches for {@link SETTING_MAX_STALENESS_MS}.
 *
 * D-104's third answer, as the thing that implements it. **Read at the point of
 * use through a bounded cache** — not at startup, which is the defect being
 * fixed; not uncached, which would put a query on the hottest path in the system
 * for a value that changes a few times a year; and not *at the next loop*, which
 * is unbounded for a switch, because the next loop of a paused runner may never
 * come.
 *
 * The staleness is a **number** rather than *eventually*, so a maintainer
 * flipping a switch knows what they are waiting for and when to conclude
 * something is wrong.
 */
export interface SettingsReader {
  /** The effective value, or `undefined` when neither source has one. */
  read(name: string): Promise<string | undefined>
  /** Drop the cache — for a test, and for a process that has just written one. */
  forget(): void
}

export function settingsReader(
  db: Database,
  options: {
    readonly environment?: EnvironmentReader
    readonly maxStalenessMs?: number
    /** Injected so a test does not have to wait thirty seconds. */
    readonly now?: () => number
  } = {},
): SettingsReader {
  const environment = options.environment ?? processEnvironment
  const maxStalenessMs = options.maxStalenessMs ?? SETTING_MAX_STALENESS_MS
  const clock = options.now ?? Date.now

  let cache: Map<string, string> | undefined
  let readAt = 0

  const overrides = async (): Promise<Map<string, string>> => {
    const now = clock()
    if (cache !== undefined && now - readAt < maxStalenessMs) return cache

    const rows = await db.select().from(settings)
    // Rebuilt through the allow-list, so a row for a name that is not a setting
    // cannot be read back out — the refusal holds on the way in *and* out.
    cache = new Map(
      rows
        .filter((row) => settingNamed(row.name) !== undefined)
        .map((row) => [row.name, row.value]),
    )
    readAt = now
    return cache
  }

  return {
    read: async (name) => {
      if (settingNamed(name) === undefined) return undefined
      const held = (await overrides()).get(name)
      if (held !== undefined) return held
      const fromEnvironment = environment(name)
      return fromEnvironment === undefined || fromEnvironment === '' ? undefined : fromEnvironment
    },
    forget: () => {
      cache = undefined
      readAt = 0
    },
  }
}
