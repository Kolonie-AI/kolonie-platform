import { SETTINGS, settingNamed, type HumanId } from '@kolonie-ai/core'
import type { EffectiveSetting } from '@kolonie-ai/db'
import type { SettingsDesk } from '../settings.js'

/**
 * The settings desk, in memory (`#489`).
 *
 * **The allow-list, the validation and the precedence are reproduced; the
 * `on conflict` and the audit row are not.** Those are `packages/db`'s and are
 * asserted there against a real database — a second opinion here would be a
 * second thing to keep in step. What the routes rely on and what this holds is:
 * a name outside `SETTINGS` is refused, a value that fails the definition's
 * schema is refused *before* anything is written, and clearing removes the
 * override rather than writing a value back.
 */
export interface FakeSettingsDesk extends SettingsDesk {
  /** Put an override in place without going through the route. */
  readonly overrides: (name: string, value: string) => void
  /** What the environment would say, for the `source` line. */
  readonly environment: (name: string, value: string) => void
  /** Every write that got through, in order. */
  readonly written: () => readonly { name: string; value: string; by: string }[]
  /** Every clear that changed something. */
  readonly cleared: () => readonly string[]
}

export function fakeSettings(): FakeSettingsDesk {
  const held = new Map<string, { value: string; at: string }>()
  const environment = new Map<string, string>()
  const written: { name: string; value: string; by: string }[] = []
  const cleared: string[] = []

  return {
    overrides: (name, value) => {
      held.set(name, { value, at: new Date().toISOString() })
    },
    environment: (name, value) => {
      environment.set(name, value)
    },
    written: () => written,
    cleared: () => cleared,

    effective: async (): Promise<readonly EffectiveSetting[]> =>
      SETTINGS.map((definition) => {
        const override = held.get(definition.name)
        if (override !== undefined) {
          return {
            definition,
            value: override.value,
            source: 'database' as const,
            changedAt: override.at as EffectiveSetting['changedAt'],
          }
        }
        const fromEnvironment = environment.get(definition.name)
        return fromEnvironment === undefined
          ? { definition, value: undefined, source: 'unset' as const }
          : { definition, value: fromEnvironment, source: 'environment' as const }
      }),

    write: async (command: { name: string; value: string; by: HumanId }) => {
      const definition = settingNamed(command.name)
      if (definition === undefined) return { outcome: 'unknown-setting' as const }

      const parsed = definition.schema.safeParse(command.value)
      if (!parsed.success) {
        return {
          outcome: 'invalid' as const,
          reason: parsed.error.issues[0]?.message ?? 'not a value this setting accepts',
        }
      }

      held.set(definition.name, { value: parsed.data, at: new Date().toISOString() })
      written.push({ name: definition.name, value: parsed.data, by: String(command.by) })
      return { outcome: 'written' as const }
    },

    clear: async (command: { name: string; by: HumanId }) => {
      if (settingNamed(command.name) === undefined) return { outcome: 'unknown-setting' as const }
      if (!held.has(command.name)) return { outcome: 'unchanged' as const }
      held.delete(command.name)
      cleared.push(command.name)
      return { outcome: 'cleared' as const }
    },
  }
}
