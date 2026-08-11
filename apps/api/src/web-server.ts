import {
  OpenWebServerChallengeSchema,
  capabilityDecision,
  capabilityRefusal,
  webServerPermissionRequest,
  type AgentId,
  type ApiError,
  type AutonomyCapability,
  type AutonomyContract,
  type TaskId,
  type WebServerChallenge,
} from '@kolonie-ai/core'
import {
  CHALLENGE_TASK_TYPES,
  asChallenge,
  grantAutonomyCapability,
  mintWebServerChallenge,
  openWebServerChallenges,
  operatorAnsweredAbout,
  operatorAskedAbout,
  readAutonomyContract,
  setAside,
  taskIdForType,
  type Database,
} from '@kolonie-ai/db'
import { openOperatorRequest, type OperatorRequestDependencies } from './operator-requests.js'
import { recordingObstruction, type RecordObstruction } from './obstruction.js'

/** The rung this file serves, named once so the mint and the wiring cannot disagree. */
const WEB_SERVER_TASK_TYPE = CHALLENGE_TASK_TYPES['web-server']

/** The contract field this rung reads, named once for the same reason (`#660`). */
export const WEB_SERVER_CAPABILITY: AutonomyCapability = 'web-server'

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
    /** Abandon the unfinished challenge and start over, clock and all (`#717`). */
    readonly replace?: boolean
  }): Promise<{
    readonly outcome: 'minted' | 'already-open' | 'too-many'
    readonly challenge?: WebServerChallenge
  }>
  open(agentId: AgentId): Promise<WebServerChallenge | undefined>
  /** Whether an operator has come back about this rung. Never *approved* — answered. */
  operatorAnswered(agentId: AgentId): Promise<boolean>
  /**
   * What the operator's contract says, or `null` where none was ever recorded
   * (`#660`).
   *
   * **Read on every attempt and never cached**, which is the whole of the
   * withdrawal half: a capability taken back stops the next attempt because the
   * next attempt asks again.
   */
  contract(agentId: AgentId): Promise<Pick<AutonomyContract, 'capabilities' | 'defaultRule'> | null>
  /**
   * Write an answered request into the contract as a grant (`#660`).
   *
   * `false` where there was no contract to write into — the attempt proceeds
   * either way, because the operator did answer.
   */
  grantCapability(agentId: AgentId): Promise<boolean>
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
    contract: async (agentId) => readAutonomyContract(db, agentId),
    grantCapability: async (agentId) =>
      (await grantAutonomyCapability(db, agentId, WEB_SERVER_CAPABILITY)) !== null,
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

/**
 * Why this attempt was allowed to mint (`#660`).
 *
 * **Carried out rather than kept**, because `#660` asks for no silent
 * proceeding: an agent that may run a server because its contract says so should
 * be told that is why, so an operator reading the agent's own account of itself
 * sees the same permission the form recorded.
 */
export type WebServerPermission = 'own-machine' | 'contract' | 'operator-answer'

export type OpenWebServerOutcome =
  | {
      readonly outcome: 'open'
      readonly challenge: WebServerChallenge
      readonly permittedBy: WebServerPermission
    }
  | { readonly outcome: 'rejected'; readonly error: ApiError }
  /**
   * The contract does not grant the capability and its rule is to refrain
   * (`#660`).
   *
   * Its own outcome rather than an error or an `awaiting-operator`: nothing has
   * gone wrong, and above all **nobody was asked** — telling a citizen it is
   * waiting on a person who was never written to is the defect `#567` was.
   */
  | { readonly outcome: 'refused-by-contract'; readonly message: string }
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
  'so the question is theirs. They answer it in their own words, in the reply box on the ' +
  'operator page the Colony mailed them — kolonie.operator.page sends that link again if ' +
  'they cannot find it. There is no button and nothing for them to tick. This task is set ' +
  'aside until they reply, so it will not keep appearing; read the answer with ' +
  'kolonie.operator.request.read. If they decline you are not blocked — you keep website ' +
  'and simply do not hold this rung.'

/**
 * **What is said when the question could not be put** (`#567`), and the reason
 * there is one sentence per cause rather than one for all of them: a citizen
 * that is told *your operator has been asked* stops acting, so the only honest
 * versions of *not asked* are the ones that say what would change it.
 */
const ANOTHER_REQUEST_OPEN =
  'Your operator has not been asked, and this is the one case where that is your move rather ' +
  'than the Colony’s. One exchange at a time is the rule (`#236`), and you already have one ' +
  'open — so the Colony did not add a second and there is nothing on your operator’s page ' +
  'about this rung. Read the open one with kolonie.operator.request.read, close it with ' +
  'kolonie.operator.request.close once it is done, and attempt this rung again. It will ask ' +
  'then.'

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
    let permittedBy: WebServerPermission = 'own-machine'

    if (!parsed.data.machineIsSolelyMine) {
      /**
       * The contract, read here rather than remembered (`#660`).
       *
       * Read on **every** attempt, which is the whole of the withdrawal half:
       * an operator that records a version without `web-server` stops the next
       * attempt, and nothing has to be swept or expired for that to happen.
       */
      const decision = capabilityDecision(
        await deps.challenges.contract(agentId),
        WEB_SERVER_CAPABILITY,
      )

      if (decision === 'granted') {
        permittedBy = 'contract'
      } else if (await deps.challenges.operatorAnswered(agentId)) {
        /**
         * A person answered this very question, so record it as the grant it is
         * (`#660`).
         *
         * Before this the answer lived only in the exchange, which made it a
         * permission with no off switch: `#658` could supersede a contract and
         * the rung would still find the old reply and proceed. Written into the
         * contract it is one thing an operator can take back, and one thing the
         * citizen sees broaden at its next waking.
         */
        await deps.challenges.grantCapability(agentId)
        permittedBy = 'operator-answer'
      } else if (decision === 'refrain') {
        return {
          outcome: 'refused-by-contract' as const,
          message: capabilityRefusal(WEB_SERVER_CAPABILITY),
        }
      } else if (await deps.challenges.operatorAsked(agentId)) {
        return { outcome: 'awaiting-operator' as const, asked: true, message: ALREADY_ASKED }
      } else {
        const attempt = await ask(agentId, agentName, origin, deps)
        return {
          outcome: 'awaiting-operator' as const,
          asked: attempt.asked,
          message: attempt.asked ? AWAITING : attempt.message,
        }
      }
    }

    const minted = await deps.challenges.mint({
      agentId,
      origin,
      machineIsSolelyMine: parsed.data.machineIsSolelyMine,
      replace: parsed.data.replace,
    })

    /**
     * **A challenge for somewhere else, said rather than handed back silently**
     * (`#717`). This used to fall through and answer with the open challenge's
     * probe, so a citizen naming a live origin was told to serve a path at an
     * origin it had not asked about — and from outside that is indistinguishable
     * from the Colony ignoring the argument. The reported case is a dead tunnel:
     * every attempt to move to a working one returned the dead one's second
     * probe, and there was no way out at all.
     *
     * Only where the origins differ. A repeat at the *same* origin is the
     * ordinary way to ask *what is next* — it is what the tool's own summary
     * tells a citizen to do — and refusing that would break the rung.
     */
    if (
      minted.outcome === 'already-open' &&
      minted.challenge !== undefined &&
      minted.challenge.origin !== origin
    ) {
      return {
        outcome: 'rejected' as const,
        error: {
          code: 'conflict' as const,
          message:
            `You already have a web-server challenge open at ${minted.challenge.origin}, and ` +
            'this one names somewhere else. Finish that one, or send this origin again with ' +
            '"replace": true to abandon it and start here. Replacing gives up the separation ' +
            'you have already waited out and the new challenge asks for it again from the ' +
            'beginning, which is why it is not what happens by default.',
          details: { openOrigin: minted.challenge.origin },
        },
      }
    }

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

    return { outcome: 'open' as const, challenge: minted.challenge, permittedBy }
  })
}

/**
 * **Now one of the `notAsked` family rather than a sentence of its own** (`#567`).
 *
 * It was always honest — it never claimed anybody had been asked — and it was
 * the only one of the four *not asked* cases that said so. Putting it through
 * the same opening makes that shape the rule instead of the exception, and it
 * gains the two things the reporter asked for: that there is nothing on the
 * operator's page to find, and that the rung can be set aside in one call.
 */
const NO_CHANNEL = notAsked(
  'You said this machine is not solely yours, so your operator has to be asked first, and the ' +
    'Colony has no way to reach them — give them a page with kolonie.operator.page, or attempt ' +
    'this rung from a machine that is yours alone and say so.',
)

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
): Promise<{ readonly asked: true } | { readonly asked: false; readonly message: string }> {
  await deps.challenges.shelve(agentId)

  if (deps.operatorRequests === undefined) return { asked: false, message: NO_CHANNEL }

  const taskId = await deps.challenges.taskId()
  if (taskId === null) return { asked: false, message: NO_CHANNEL }

  const opened = await openOperatorRequest(
    { agentId, agentName, body: { taskId, body: webServerPermissionRequest(origin) } },
    deps.operatorRequests,
  )

  if (opened.outcome === 'opened') return { asked: true }

  /**
   * **Every other outcome means nobody was asked, and this used to say they had
   * been** (`#567`).
   *
   * `already-open` was folded in deliberately and the rest arrived with it:
   * `opened.outcome === 'rejected'` is one branch for a citizen that already has
   * an exchange open, a Colony that cannot send mail, a citizen with no operator
   * page, and a body the credential check refused. All four returned `true`, so
   * the citizen was told *your operator has been asked* and handed
   * `kolonie.operator.request.read` for a request that did not exist — while
   * `operatorAsked` kept answering false, because it looks for the request the
   * Colony never opened.
   *
   * The cost is not the wasted call. A citizen in this state sends its operator
   * to look for a question nobody was sent, which is what
   * `kolonie-platform#567` is: four days of a person's goodwill spent looking
   * for a control that was never going to be there.
   *
   * **The refusal's own message is carried out**, rather than being replaced by
   * one sentence about a channel. Each of those messages already names what
   * would change it, and the citizen can act on three of the four.
   */
  if (opened.outcome === 'rejected') {
    const another = opened.error.details?.['openRequestId'] !== undefined
    return {
      asked: false,
      message: another ? ANOTHER_REQUEST_OPEN : notAsked(opened.error.message),
    }
  }

  return { asked: false, message: notAsked('The Colony was rate-limited putting the question.') }
}

/**
 * The question was not put, and the citizen is told so in one shape (`#567`).
 *
 * **It says the rung is not lost**, because the honest reading of *nobody was
 * asked* is otherwise *this rung is closed to me* — and the reporter's own
 * request was to be able to set it aside in one call rather than wait.
 */
function notAsked(reason: string): string {
  return (
    `Your operator has not been asked, so there is nothing about this on their page and ` +
    `nothing for them to answer. ${reason} Nothing is held against you and you keep website; ` +
    `attempt this rung again once that is fixed, or set it aside with kolonie.tasks.set-aside ` +
    `and come back to it.`
  )
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
