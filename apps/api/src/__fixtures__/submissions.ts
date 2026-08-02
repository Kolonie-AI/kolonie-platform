import { randomUUID } from 'node:crypto'
import { SubmissionSchema, type AgentId, type Submission } from '@kolonie-ai/core'
import type { CreateSubmissionCommand, CreateSubmissionResult } from '@kolonie-ai/db'
import type { TaskSubmissions } from '../submissions.js'

/**
 * A submission sink that records what it was asked and answers with what it was
 * told.
 *
 * Deliberately not an in-memory reimplementation of the storage rules. `apps/api`
 * is responsible for three things here — validating the request, taking the task
 * from the path and the agent from the credential rather than from the body, and
 * turning each refusal into a stable error code. All three are about what it
 * *asks for*. A fake that also enforced skills and attempt numbers would let a
 * test pass while the route sent someone else's agent id, because the fake would
 * quietly use the right one. Whether the attempt number is assigned without a
 * race is asserted in `packages/db`, against a real Postgres.
 */
export interface FakeSubmissions extends TaskSubmissions {
  /** Every command the route has sent, in order. */
  readonly commands: () => CreateSubmissionCommand[]
  /** The last one, which is what a single-call test is asking about. */
  readonly lastCommand: () => CreateSubmissionCommand | undefined
  /** What the next call answers with. */
  readonly answers: (result: CreateSubmissionResult) => void
  /** Submissions the list endpoint returns. Defaults to empty. */
  readonly setList: (submissions: Submission[]) => void
}

export function fakeSubmissions(): FakeSubmissions {
  const commands: CreateSubmissionCommand[] = []
  let answer: CreateSubmissionResult | undefined
  let listed: Submission[] = []

  return {
    submit: async (command) => {
      commands.push(command)
      return answer ?? { outcome: 'accepted', submission: aSubmission(command) }
    },
    list: async (_agentId: AgentId) => [...listed],
    commands: () => [...commands],
    lastCommand: () => commands.at(-1),
    answers: (result) => {
      answer = result
    },
    setList: (submissions) => {
      listed = [...submissions]
    },
  }
}

/**
 * A submission, valid by construction and consistent with the command that
 * produced it.
 *
 * Parsed rather than cast, for the same reason the other fixtures parse: a
 * fixture that can produce a shape core would reject makes a test believe it
 * checked something it did not.
 */
export function aSubmission(
  command: Pick<
    CreateSubmissionCommand,
    'taskId' | 'agentId' | 'payload' | 'assistance' | 'report'
  >,
  overrides: Partial<Submission> = {},
): Submission {
  return SubmissionSchema.parse({
    id: randomUUID(),
    taskId: command.taskId,
    agentId: command.agentId,
    payload: command.payload,
    status: 'pending',
    // Echoed from the command, so a route test can see its own declaration come
    // back rather than a value the fixture chose. Absent is `unknown`, which is
    // what storage writes when nothing was declared (`#39`).
    assistance: command.assistance ?? 'unknown',
    attempt: 1,
    // Echoed like `assistance`, and `reportOutcome` stays null: what a report
    // becomes is decided by a verdict that has not happened yet (#56).
    report: command.report ?? null,
    reportOutcome: null,
    evidence: null,
    submittedAt: new Date().toISOString(),
    verifiedAt: null,
    ...overrides,
  })
}
