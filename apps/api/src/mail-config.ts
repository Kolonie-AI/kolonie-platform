import { cloudflareMailer, operatorMailerFrom, type Mailer, type OperatorMailer } from './email.js'

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

/**
 * Who console mail comes from, and it is one variable rather than a string at
 * each call site (`#398`).
 *
 * **Optional, and it falls back to the Academy's sender.** A deployment that has
 * not set it keeps sending exactly what it sent before, which is why this is not
 * in {@link MAILER_VARS}: mail failing entirely because the console has no
 * sender of its own would be a worse answer than the one this fixes.
 *
 * **What it is for.** A sponsor opening an account received mail from
 * `academy@challenge.<domain>` — the host the Academy serves challenge pages
 * from. To somebody who has never seen the Colony and is about to be asked for
 * money, account mail from a host called *challenge* reads as phishing, and a
 * cautious reader is right to hesitate.
 *
 * **Setting it is a deploy-side decision with a prerequisite**: whatever address
 * is chosen must sit on a domain onboarded for Cloudflare Email Sending, or the
 * send is refused rather than rewritten. That is a dashboard step and it is the
 * maintainer's, so this code makes the address configurable and does not choose
 * one.
 */
export const CONSOLE_SENDER_VAR = 'CONSOLE_SENDER_ADDRESS'

/** What outbound mail has, and what it is missing. */
export interface MailConfiguration {
  /** Absent when anything in {@link MAILER_VARS} is unset — never a broken one. */
  readonly mailer?: Mailer | undefined
  /** The variables that were not set, in the order above. Empty when mail works. */
  readonly missing: readonly string[]
  /**
   * The address console mail is sent from.
   *
   * Always a value when {@link MailConfiguration.mailer} is present: the
   * console's own if one is configured, the Academy's otherwise.
   */
  readonly consoleSender?: string | undefined
  /**
   * The mailer every **operator-facing** surface takes, with
   * {@link MailConfiguration.consoleSender} already bound (`#474`).
   *
   * Present whenever {@link MailConfiguration.mailer} is.
   *
   * **Six sends across three modules write to a person about their account**, and
   * each used to receive the bare mailer beside an address it had to remember to
   * pass. Three remembered: the console's sign-in, sign-up and key confirmation.
   * Three did not — the console's own account-deletion notice, the operator
   * request, and the autonomy contract request, which is the one a stranger
   * receives unprompted and the reason `#474` exists.
   *
   * A seventh caller would have been a coin toss. Handing them a mailer that has
   * already chosen removes the thing that could be forgotten, and the wiring
   * error becomes a compile error. See {@link OperatorMailer}.
   */
  readonly operatorMailer?: OperatorMailer | undefined
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

  const academySender = env['ACADEMY_SENDER_ADDRESS']!

  const mailer = make({
    accountId: env['CLOUDFLARE_ACCOUNT_ID']!,
    token: env['CLOUDFLARE_EMAIL_SEND_TOKEN']!,
    sender: academySender,
  })
  const consoleSender =
    (env[CONSOLE_SENDER_VAR] ?? '') === '' ? academySender : env[CONSOLE_SENDER_VAR]!

  return {
    mailer,
    missing: [],
    consoleSender,
    operatorMailer: operatorMailerFrom(mailer, consoleSender),
  }
}
