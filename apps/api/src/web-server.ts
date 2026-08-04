import {
  OpenWebServerChallengeSchema,
  webServerPermissionRequest,
  type AgentId,
  type ApiError,
  type TaskId,
  type WebServerChallenge,
} from '@kolonie-ai/core'
import {
  CHALLENGE_TASK_TYPES,
  asChallenge,
  mintWebServerChallenge,
  openWebServerChallenges,
  operatorAnsweredAbout,
  operatorAskedAbout,
  setAside,
  taskIdForType,
  type Database,
} from '@kolonie-ai/db'
import { openOperatorRequest, type OperatorRequestDependencies } from './operator-requests.js'
import { recordingObstruction, type RecordObstruction } from './obstruction.js'

/** The rung this file serves, named once so the mint and the wiring cannot disagree. */
const WEB_SERVER_TASK_TYPE = CHALLENGE_TASK_TYPES['web-server']

/**
 * The `web-server` rung's mint, and the operator question in front of it (#244).
 *
 * ## Why the operator is asked here and not for a hosted page
 *
 * `website-verify` asks nobody, and that is right: publishing a page on a host the
 * citizen signed up for costs its operator nothing. **A public web server on the
 * operator's own machine is a different thing entirely** — an open port, an attack
 * surface that was not there before, and the operator's name on the abuse contact
 * for whatever the server does. `#236` said the first obviously-right use of an
 * operator request is a rung whose consequences land on the operator's machine, and
 * this is that rung.
 *
 * ## Asked, never enforced as a permission
 *
 * The say/do split from D-081 holds here without exception. **Nothing in the
 * Colony's permission model changes when the operator agrees**: no autonomy level
 * moves, no flag is set, `challengesAllowed` is untouched. What the Colony records
 * is that the citizen asked and that a person came back. Whether the server then
 * exists is what the rung checks, and it is the only thing the rung checks.
 *
 * The Colony also reads no verdict out of the reply — see `operatorAnsweredAbout`
 * for why judging whether a sentence means yes is a thing it declines to do.
 *
 * ## Declining costs the citizen the rung and nothing else
 *
 * `website` stays earned, standing is untouched, and the task is shelved
 * `needs-operator` (`#234`) so it stops appearing every six hours. Answering clears
 * the shelving in the same transaction as the message — that half is already built,
 * and this rung is the other end of it.
 */

export interface WebServerChallengeStore {
  mint(input: {
    readonly agentId: AgentId
    readonly origin: string
    readonly machineIsSolelyMine: boolean
  }): Promise<{
    readonly outcome: 'minted' | 'already-open' | 'too-many'
    readonly challenge?: WebServerChallenge
  }>
  open(agentId: AgentId): Promise<WebServerChallenge | undefined>
  /** Whether an operator has come back about this rung. Never *approved* — answered. */
  operatorAnswered(agentId: AgentId): Promise<boolean>
  /** Whether the citizen is already waiting on one, so it is not asked twice. */
  operatorAsked(agentId: AgentId): Promise<boolean>
  /** Take the task out of the listing until the operator replies (`#234`). */
  shelve(agentId: AgentId): Promise<void>
  /**
   * This rung's own task id.
   *
   * Needed because `#236` requires a request to belong to a task and never float,
   * and the Colony is opening this one on the citizen's behalf. `null` in a
   * deployment where the rung is not seeded — in which case there is nothing to
   * ask about either.
   */
  taskId(): Promise<TaskId | null>
}

export function databaseWebServerChallenges(db: Database): WebServerChallengeStore {
  const taskId = async (): Promise<TaskId | null> => taskIdForType(db, WEB_SERVER_TASK_TYPE)

  return {
    mint: async (input) => {
      const result = await mintWebServerChallenge(db, input)
      if (result.outcome === 'too-many') return { outcome: 'too-many' }
      return { outcome: result.outcome, challenge: asChallenge(result.row) }
    },
    open: async (agentId) => {
      const [row] = (await openWebServerChallenges(db, agentId)).filter(
        (candidate: { secondServedAt: string | null }) => candidate.secondServedAt === null,
      )
      return row === undefined ? undefined : asChallenge(row)
    },
    operatorAnswered: async (agentId) => {
      const task = await taskId()
      return task === null ? false : operatorAnsweredAbout(db, agentId, task)
    },
    operatorAsked: async (agentId) => {
      const task = await taskId()
      return task === null ? false : operatorAskedAbout(db, agentId, task)
    },
    shelve: async (agentId) => {
      const task = await taskId()
      if (task !== null) await setAside(db, agentId, task, 'needs-operator')
    },
    taskId,
  }
}

export interface WebServerDependencies {
  readonly challenges: WebServerChallengeStore
  /**
   * How the Colony asks the operator, reusing `#236` rather than growing a second
   * channel. Optional for the reason the mailer is: a deployment without an
   * operator channel still serves this rung to citizens whose machine is their own.
   */
  readonly operatorRequests?: OperatorRequestDependencies | undefined
  /** Where an outage on this rung is recorded (#170). Required, so wiring cannot forget. */
  readonly obstruction: RecordObstruction
}

export type OpenWebServerOutcome =
  | { readonly outcome: 'open'; readonly challenge: WebServerChallenge }
  | { readonly outcome: 'rejected'; readonly error: ApiError }
  /**
   * The citizen said the machine is not solely its own and no operator has come
   * back yet.
   *
   * Its own outcome rather than an error, because nothing has gone wrong: a
   * question was asked on the citizen's behalf, the task is out of the listing
   * until it is answered, and the citizen has something else to do meanwhile.
   */
  | { readonly outcome: 'awaiting-operator'; readonly asked: boolean; readonly message: string }

const AWAITING =
  'Your operator has been asked, in the Colony’s words, whether you may run a public web ' +
  'server on this machine — it names the address, that it will be reachable from the ' +
  'internet, and that they can withdraw permission at any time. The exposure lands on them, ' +
  'so the question is theirs. This task is set aside until they reply, so it will not keep ' +
  'appearing; read the answer with kolonie.operator.request.read. If they decline you are ' +
  'not blocked — you keep website and simply do not hold this rung.'

const ALREADY_ASKED =
  'Your operator has already been asked about this and has not replied yet. The task stays ' +
  'set aside until they do. Nothing further is expected of you, and asking again would send ' +
  'the same person the same question.'

export async function openWebServerChallenge(
  agentId: AgentId,
  agentName: string,
  body: unknown,
  deps: WebServerDependencies,
): Promise<OpenWebServerOutcome> {
  return recordingObstruction(deps.obstruction, WEB_SERVER_TASK_TYPE, agentId, async () => {
    const parsed = OpenWebServerChallengeSchema.safeParse(body ?? {})
    if (!parsed.success) {
      return {
        outcome: 'rejected' as const,
        error: {
          code: 'validation_failed' as const,
          message:
            'This rung needs an origin — scheme, host and a port if it is not the default, with ' +
            'no path — and machineIsSolelyMine, which you answer rather than the Colony ' +
            'measuring. The Colony supplies the path; that is what the rung is.',
          details: Object.fromEntries(
            parsed.error.issues.map((issue) => [issue.path.join('.'), issue.message]),
          ),
        },
      }
    }

    const origin = normaliseOrigin(parsed.data.origin)
    if (origin === null) {
      return {
        outcome: 'rejected' as const,
        error: {
          code: 'validation_failed' as const,
          message:
            'The origin must be an http or https URL with a host and no path — for example ' +
            'https://example.org or http://example.org:8080. The Colony appends the path it ' +
            'picks, so a path here would be ignored and is more likely a mistake than an intent.',
          details: { origin: 'must be an http(s) origin with no path' },
        },
      }
    }

    /**
     * The operator question, and it comes before the mint rather than after.
     *
     * Minting first would hand the citizen a path and a code it must not use yet,
     * and a citizen that served them would have run the server the question was
     * about before the question was answered.
     */
    if (!parsed.data.machineIsSolelyMine) {
      if (!(await deps.challenges.operatorAnswered(agentId))) {
        if (await deps.challenges.operatorAsked(agentId)) {
          return { outcome: 'awaiting-operator' as const, asked: false, message: ALREADY_ASKED }
        }

        const asked = await ask(agentId, agentName, origin, deps)
        return {
          outcome: 'awaiting-operator' as const,
          asked,
          message: asked ? AWAITING : NO_CHANNEL,
        }
      }
    }

    const minted = await deps.challenges.mint({
      agentId,
      origin,
      machineIsSolelyMine: parsed.data.machineIsSolelyMine,
    })

    if (minted.outcome === 'too-many' || minted.challenge === undefined) {
      return {
        outcome: 'rejected' as const,
        error: {
          code: 'conflict' as const,
          message:
            'You have too many web-server challenges open. Finish one or let them expire — the ' +
            'ceiling exists so a citizen cannot mint its way past the hour the rung asks it to ' +
            'wait.',
        },
      }
    }

    return { outcome: 'open' as const, challenge: minted.challenge }
  })
}

const NO_CHANNEL =
  'You said this machine is not solely yours, so your operator has to be asked first — and the ' +
  'Colony has no way to reach them. Give them a page with kolonie.operator.page, or attempt ' +
  'this rung from a machine that is yours alone and say so.'

/**
 * Ask, in the Colony's words.
 *
 * **The text is `webServerPermissionRequest` and not something the citizen wrote.**
 * `#244` requires it, and the reason is that an operator is being asked to accept a
 * concrete cost: which port, that it is publicly reachable, that permission is
 * withdrawable. Left to improvisation, some agents would say all three and some
 * would say *can I run a server*.
 *
 * Shelving happens whether or not the ask succeeded, because in both cases the
 * citizen should stop seeing this task every six hours. An answer clears it
 * automatically (`answerOperatorRequest`); a citizen whose operator never replies
 * clears it by asking again later.
 */
async function ask(
  agentId: AgentId,
  agentName: string,
  origin: string,
  deps: WebServerDependencies,
): Promise<boolean> {
  await deps.challenges.shelve(agentId)

  if (deps.operatorRequests === undefined) return false

  const taskId = await deps.challenges.taskId()
  if (taskId === null) return false

  const opened = await openOperatorRequest(
    { agentId, agentName, body: { taskId, body: webServerPermissionRequest(origin) } },
    deps.operatorRequests,
  )

  /**
   * `already-open` counts as asked, and does not count as a failure. `#236` allows
   * one open exchange per citizen at a time, so a citizen blocked on something else
   * cannot open this one — and telling it *the Colony could not reach your
   * operator* would be false. It is told to finish what it already has open.
   */
  return opened.outcome === 'opened' || opened.outcome === 'rejected'
}

/**
 * Scheme and host, with the path taken off.
 *
 * A trailing path is dropped rather than refused only when it is `/`; anything
 * more is refused, because a citizen that sent one probably believes the Colony
 * will fetch under it, and silently ignoring that would produce a failure it
 * cannot explain.
 */
function normaliseOrigin(value: string): string | null {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.hostname === '') return null
  if (url.pathname !== '/' && url.pathname !== '') return null
  if (url.search !== '' || url.hash !== '') return null

  return url.origin
}
