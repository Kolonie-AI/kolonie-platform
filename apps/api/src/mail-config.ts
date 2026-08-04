import { cloudflareMailer, type Mailer } from './email.js'

/**
 * The three variables outbound mail needs, and the one the autonomy form needs
 * on top (`#261`).
 *
 * Named as a list rather than read three times inline, because that is what
 * makes the absence sayable: a surface that degrades has to be able to name the
 * variable that would fix it, and a refusal reading *"try again later"* about a
 * variable nobody ever set is a citizen waiting for a weather change.
 */
export const MAILER_VARS = [
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_EMAIL_SEND_TOKEN',
  'ACADEMY_SENDER_ADDRESS',
] as const

/** What outbound mail has, and what it is missing. */
export interface MailConfiguration {
  /** Absent when anything in {@link MAILER_VARS} is unset — never a broken one. */
  readonly mailer?: Mailer | undefined
  /** The variables that were not set, in the order above. Empty when mail works. */
  readonly missing: readonly string[]
}

/**
 * The mailer three surfaces share, built once (`#261`).
 *
 * **One resolution rather than three copies of the same condition.** The mailbox
 * rung, the console sign-in and the autonomy form each rebuilt this inline from
 * the same three variables, so *is mail configured* had three answers that
 * happened to agree — and nothing anywhere said no when they agreed on no.
 *
 * **A partial configuration is no mailer, deliberately.** Two variables out of
 * three is not a mailer that mostly works; it is one that fails at the first
 * send, after the Colony has already told a citizen its form went out. The
 * surfaces degrade to their own refusals, which are written for exactly this.
 *
 * A citizen filed `#261` after being told the Colony could not send mail, with
 * no way to tell that from a send that was refused and nothing in any log to
 * say which. The mail path itself was healthy when measured; what was missing
 * was anybody knowing it was not configured.
 */
export function mailerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  make: typeof cloudflareMailer = cloudflareMailer,
): MailConfiguration {
  const missing = MAILER_VARS.filter((variable) => (env[variable] ?? '') === '')

  if (missing.length > 0) return { missing }

  return {
    mailer: make({
      accountId: env['CLOUDFLARE_ACCOUNT_ID']!,
      token: env['CLOUDFLARE_EMAIL_SEND_TOKEN']!,
      sender: env['ACADEMY_SENDER_ADDRESS']!,
    }),
    missing: [],
  }
}
