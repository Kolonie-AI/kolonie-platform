import type { Log } from '@kolonie-ai/core'
import {
  noDefectWriter,
  openRouterDefectWriter,
  openRouterModel,
  unavailableModel,
  OPENROUTER_API_KEY_VAR,
  type DefectWriter,
} from './llm.js'
import type { TriageModel } from './triage.js'

/**
 * Every model client this runner builds, constructed in one place (`#780`).
 *
 * This used to be four lines in `main.ts`, a hundred lines apart, and one of them
 * was missing its `fetchImpl` — so the defect writer bought its prose from
 * OpenRouter while the classifier went through the LLM gateway, in the same
 * process, eleven seconds apart. Nothing caught it: the wiring compiles either
 * way, the runner works either way, and the only symptom is a bill and a model
 * nobody chose.
 *
 * **What fixes it is not the missing argument, it is that the argument is passed
 * once.** A fifth client added to this record inherits the transport by
 * construction, and `clients.test.ts` fails until it is exercised — a test
 * written against the one line that was wrong would have passed the next time.
 *
 * `main.ts` stays what it was, wiring with nothing tested in it, because this is
 * reachable without starting a process.
 */
export interface ModelClients {
  /** Which of the four things a ticket is. */
  readonly model: TriageModel
  /** The prose half of the log detector. */
  readonly writer: DefectWriter
}

export interface ModelClientOptions {
  /**
   * The transport all of them share — `gatewayRoutedFetch(...)` in the process,
   * a double in a test. Required rather than defaulted: a default is how the
   * missing argument stayed invisible.
   */
  readonly fetchImpl: typeof fetch
  /** Which model to ask. Unset leaves each client on its own default. */
  readonly model?: string
  readonly log?: Log
}

/**
 * The clients, or the ones that say they cannot answer.
 *
 * **An empty key degrades this process; it does not stop it**, and both clients
 * degrade together because they are bought with the same key. The classifier
 * throws when asked and the writer reports `available: false` — an issue is
 * complete without a reading, a ticket is not triaged without a verdict, and
 * those two differences are settled in `llm.ts` rather than here.
 */
export function modelClients(apiKey: string, options: ModelClientOptions): ModelClients {
  const { fetchImpl, log } = options
  const model = options.model

  if (apiKey === '') {
    return {
      model: unavailableModel(`${OPENROUTER_API_KEY_VAR} not set`),
      writer: noDefectWriter,
    }
  }

  return {
    model: openRouterModel(apiKey, {
      ...(model === undefined ? {} : { model }),
      fetchImpl,
      ...(log === undefined ? {} : { log }),
    }),
    writer: openRouterDefectWriter(apiKey, {
      ...(model === undefined ? {} : { model }),
      fetchImpl,
      ...(log === undefined ? {} : { log }),
    }),
  }
}
