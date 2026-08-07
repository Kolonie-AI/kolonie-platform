import {
  clearSetting,
  effectiveSettings,
  writeSetting,
  type Database,
  type EffectiveSetting,
  type SettingClearOutcome,
  type SettingWriteOutcome,
} from '@kolonie-ai/db'
import { SETTINGS, type HumanId } from '@kolonie-ai/core'

/**
 * The settings surface the console routes take (`#489`, D-104).
 *
 * A desk rather than the storage functions directly, for the reason every other
 * dependency here is one: the routes are tested against a fake, and a fake that
 * has to reproduce Postgres' `on conflict` would be a second opinion about
 * something `packages/db` already asserts against a real database.
 */
export interface SettingsDesk {
  /** Every setting, with its effective value and where that value came from. */
  effective(): Promise<readonly EffectiveSetting[]>
  write(command: {
    readonly name: string
    readonly value: string
    readonly by: HumanId
  }): Promise<SettingWriteOutcome>
  clear(command: { readonly name: string; readonly by: HumanId }): Promise<SettingClearOutcome>
}

/**
 * A desk with no overrides and no database, for tests and for nothing else.
 *
 * **Every setting reads as `unset`**, which is honest rather than convenient: a
 * default that fell back to `process.env` would make the surrounding tests
 * depend on the machine they run on, and one that invented values would make a
 * page assert against numbers nobody chose.
 *
 * `buildApp` defaults to this so that the ninety-odd tests which build an app
 * and never touch a setting do not each have to say so — the same trade
 * `log = silentLog` and `limiter = registrationLimiter()` already make.
 * `server.ts` passes {@link databaseSettings} explicitly, and it is the only
 * caller that matters.
 */
export function noSettings(): SettingsDesk {
  return {
    effective: async () =>
      SETTINGS.map((definition) => ({ definition, value: undefined, source: 'unset' as const })),
    write: async () => ({ outcome: 'unknown-setting' as const }),
    clear: async () => ({ outcome: 'unknown-setting' as const }),
  }
}

export function databaseSettings(db: Database): SettingsDesk {
  return {
    effective: () => effectiveSettings(db),
    write: (command) => writeSetting(db, command),
    clear: (command) => clearSetting(db, command),
  }
}
