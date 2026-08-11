/**
 * One JSON object per line, so a log line can be asked a question (`#230`).
 *
 * **What was wrong with what this replaces.** All four processes logged through
 * three methods that forwarded to `console`, and the API had no logger at all.
 * A line read `could not read the App key at /run/secrets/app.pem`: grep finds
 * it if you know the wording, and nothing can answer *"how many errors did the
 * triage runner have yesterday"*. Worse, `console.error(message, error)` prints
 * an `Error` through Node's inspector, so one failure became N lines and any
 * collector that treats a line as a record got N records with no way to rejoin
 * them.
 *
 * **The shape is decided here rather than per service**, because a field a
 * service can name for itself is a field no query can rely on.
 */

/** How bad it is. Three levels, because a fourth is one nobody filters on. */
export type LogLevel = 'info' | 'warn' | 'error'

/**
 * Anything else the call site knows, flat.
 *
 * **One level of nesting, and no deeper.** A collector that has to walk a tree
 * to find an id cannot index it, and a field it cannot index is prose wearing
 * JSON. `err` is the single exception, and this module writes it.
 */
export interface LogFields {
  /**
   * A short stable slug — `poll.start`, `ticket.triaged`, `openrouter.failed`.
   *
   * **This is the field that makes the whole change worth making.** `msg` is
   * prose and will be reworded; `event` survives that rewrite, and a query
   * grouping by it does not break when somebody improves a sentence.
   */
  readonly event?: string
  readonly [field: string]: unknown
}

/**
 * Where a process says what it did.
 *
 * **Every existing call still compiles and still produces a valid record.** A
 * migration that requires touching every call site before anything works is a
 * migration that stalls half done, so the structured argument is optional
 * everywhere it appears.
 */
export interface Log {
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, error?: unknown, fields?: LogFields): void
}

/**
 * What is written when a call site names no event.
 *
 * Not omitted: a field that is sometimes absent forces every query to handle
 * both, and the whole point of `event` is that it can be grouped by. It is
 * deliberately ugly — a dashboard full of `unspecified` is the pressure to name
 * one, and that pressure is only felt if it is visible.
 */
export const UNSPECIFIED_EVENT = 'unspecified'

/** An error as JSON, rather than as whatever Node's inspector prints. */
export interface SerialisedError {
  readonly name: string
  readonly code?: string
  /** Bounded — see {@link ERROR_MESSAGE_MAX_LENGTH}. The whole of it is on `stack`. */
  readonly message: string
  readonly cause?: SerialisedError
  /** The outermost error only. See {@link serialiseError}. */
  readonly stack?: string
}

const REDACTED_HOST = '[configured-host]'

/**
 * Removes deployment-specific hosts without making core know the environment.
 *
 * Invalid values are ignored: logging runs on the failure path, so bad optional
 * redaction configuration must not replace the original failure with another.
 */
export function redactConfiguredHosts(
  text: string,
  configuredUrls: readonly (string | undefined)[],
): string {
  return configuredUrls.reduce<string>((redacted, configuredUrl) => {
    if (configuredUrl === undefined || configuredUrl === '') return redacted

    try {
      const host = new URL(configuredUrl).hostname
      return host === '' ? redacted : redacted.replaceAll(host, REDACTED_HOST)
    } catch {
      return redacted
    }
  }, text)
}

/**
 * How much of one error's message survives (`#747`).
 *
 * **A message is a sentence about what went wrong, and a few libraries put a
 * document there instead.** Drizzle throws `Failed query: <the entire SQL>`, so
 * an authentication read — six columns, two joins — arrives as a `message`
 * several hundred characters long that says the same thing its first line says.
 *
 * That is not a cosmetic problem, because **a log line is read through
 * windows**. `apps/support-triage-runner` files one issue per error signature
 * from a 400-character sample, and on `api/mcp.tool.threw` the sample ended
 * mid-column-list: the `cause`, which is the only part that says *why*, never
 * appeared. The model judging it wrote *"the exact cause … is not clear from
 * this single log line"* on `#729` and again on `#747`, 145 lines apart. Both
 * times the detector was right and the log line was at fault.
 *
 * **Nothing is lost by cutting it.** `stack` begins with `Name: message` in
 * full, and `stack` is still here — the truncation moves the long text behind
 * the diagnosis rather than deleting it.
 *
 * 240 leaves room, inside that 400-character window, for the outer error's name
 * and code and for the first cause's name, code and message — which together are
 * what a person needs to know whether they are looking at a connection reset, a
 * statement timeout or a constraint.
 */
export const ERROR_MESSAGE_MAX_LENGTH = 240

/**
 * An error flattened to a few strings, on one line.
 *
 * **Serialised, not inspected.** The stack keeps its newlines as `\n` inside a
 * JSON string, so the record stays one line no matter how deep the throw was.
 *
 * A thrown non-`Error` — a string, a rejected fetch body, `undefined` — is not
 * discarded: it is stringified under the name `NonError`, because the thing
 * that gets thrown when something is truly wrong is exactly the thing least
 * likely to be an `Error`.
 *
 * ## The field order is load-bearing (`#747`)
 *
 * `name`, `code`, `message`, `cause`, `stack` — and `JSON.stringify` writes them
 * in that order, so **whatever reads a prefix of this line reads the diagnosis
 * first and loses the stack**. Everything downstream of a log line truncates it
 * somewhere: the issue detector at 400 characters, a terminal at its width, a
 * paste into a chat. The order decides what survives all of them.
 *
 * **Only the outermost error carries a stack**, for the same reason. A cause's
 * stack is where the *inner* library threw, which is almost never the question;
 * its name, code and message are. Three nested stacks ahead of the outer one is
 * how a chain that has been serialised correctly still arrives unreadable.
 */
export function serialiseError(
  error: unknown,
  configuredUrls: readonly (string | undefined)[] = [],
): SerialisedError {
  return serialiseErrorAtDepth(error, 0, configuredUrls)
}

/** One error's message, redacted and bounded. See {@link ERROR_MESSAGE_MAX_LENGTH}. */
function messageOf(text: string, configuredUrls: readonly (string | undefined)[]): string {
  const redacted = redactConfiguredHosts(text, configuredUrls)
  return redacted.length <= ERROR_MESSAGE_MAX_LENGTH
    ? redacted
    : `${redacted.slice(0, ERROR_MESSAGE_MAX_LENGTH)}… (truncated)`
}

function serialiseErrorAtDepth(
  error: unknown,
  depth: number,
  configuredUrls: readonly (string | undefined)[],
): SerialisedError {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    const cause = (error as { cause?: unknown }).cause
    return {
      name: error.name,
      ...(typeof code === 'string' ? { code } : {}),
      message: messageOf(error.message, configuredUrls),
      ...(depth >= 3 || cause === undefined
        ? {}
        : { cause: serialiseErrorAtDepth(cause, depth + 1, configuredUrls) }),
      ...(depth > 0 || error.stack === undefined
        ? {}
        : { stack: redactConfiguredHosts(error.stack, configuredUrls) }),
    }
  }

  return {
    name: 'NonError',
    message: messageOf(typeof error === 'string' ? error : String(error), configuredUrls),
  }
}

/** One log line, before it is written. */
export interface LogRecord {
  readonly ts: string
  readonly level: LogLevel
  readonly service: string
  readonly event: string
  readonly msg: string
  readonly err?: SerialisedError
  readonly [field: string]: unknown
}

/**
 * The record for one call.
 *
 * Exported so a test can assert the shape without capturing a stream, and so
 * that a caller wanting to write somewhere other than stdout has the same
 * record the logger would have written.
 *
 * **The fixed fields cannot be overwritten by a call site.** `fields` is spread
 * first and the five names below are written after it, so a call that happens
 * to carry a key named `level` adds noise rather than changing what the line
 * claims about itself.
 */
export function logRecord(input: {
  readonly level: LogLevel
  readonly service: string
  readonly message: string
  readonly now: Date
  readonly fields?: LogFields
  /** Absent, rather than `undefined`, when there was nothing thrown to report. */
  readonly error?: unknown
  readonly redactUrls?: readonly (string | undefined)[]
}): LogRecord {
  const { event, ...rest } = input.fields ?? {}

  return {
    ...rest,
    ts: input.now.toISOString(),
    level: input.level,
    service: input.service,
    event: event ?? UNSPECIFIED_EVENT,
    msg: input.message,
    ...(input.error === undefined ? {} : { err: serialiseError(input.error, input.redactUrls) }),
  }
}

/**
 * One line of JSON, and never more than one.
 *
 * A value that cannot be serialised — a circular object, a `BigInt` — must not
 * take the line down with it: the failure a logger is being asked to report is
 * usually worse than the failure of the logger. So an unserialisable record
 * degrades to a minimal one that still carries the level, the service and the
 * event, and says what happened to the rest.
 */
export function logLine(record: LogRecord): string {
  try {
    return JSON.stringify(record)
  } catch (error) {
    return JSON.stringify({
      ts: record.ts,
      level: record.level,
      service: record.service,
      event: record.event,
      msg: record.msg,
      err: serialiseError(error),
      unserialisable: true,
    })
  }
}

/**
 * A logger for one service.
 *
 * **`service` is set here and never passed per call**, because a call site that
 * can get it wrong will, and one mislabelled line is worse than none — it is a
 * line that answers a question incorrectly rather than not at all.
 *
 * **Everything goes to stdout, errors included.** Docker interleaves both
 * streams into the same file anyway, so splitting by stream buys nothing and
 * costs the guarantee that the file is line-delimited JSON throughout.
 *
 * `write` and `now` are injected so this is testable without capturing a
 * process stream or freezing a clock.
 */
export function createLog(options: {
  readonly service: string
  /** Configured URLs whose hosts must never enter an error log. */
  readonly redactUrls?: readonly (string | undefined)[]
  readonly write?: (line: string) => void
  readonly now?: () => Date
}): Log {
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`))
  const now = options.now ?? (() => new Date())

  const emit = (
    level: LogLevel,
    message: string,
    fields: LogFields | undefined,
    error: unknown,
  ): void => {
    write(
      logLine(
        logRecord({
          level,
          service: options.service,
          message,
          now: now(),
          fields,
          error,
          redactUrls: options.redactUrls,
        }),
      ),
    )
  }

  return {
    info: (message, fields) => emit('info', message, fields, undefined),
    warn: (message, fields) => emit('warn', message, fields, undefined),
    error: (message, error, fields) => emit('error', message, fields, error),
  }
}

/**
 * A logger that writes nothing.
 *
 * Exported because all three runners had one of these of their own, so that a
 * test could run the loop without printing to the test output.
 */
export const silentLog: Log = { info: () => {}, warn: () => {}, error: () => {} }
