import type { OperatorPageView } from '@kolonie-ai/db'
import { operatorDurablePage } from './autonomy-page.js'
import { FALLBACK_ZONE } from './console/time.js'
import type { RouteDependencies } from './routes/dependencies.js'

/**
 * The operator page's body, for both doors (`#428`).
 *
 * **One renderer, two routes**, and this file exists so that is literally true
 * rather than nearly true. The page opens from a bearer link a person clicks out
 * of a mail, and from a session in the console — and `#428` is explicit that this
 * is *a second door to one page, not a second page*: two renderings of an
 * operator's view disagree within a month, and the one being read is the wrong
 * one.
 *
 * It lived as a closure inside the token route until the console needed it, which
 * is the moment a shared thing has to move rather than be copied.
 *
 * **The token is what everything is resolved by, on both doors.** It reaches this
 * function already authorised: the mail route holds it because the operator
 * presented it, and the console route looked it up *after* checking the join
 * table. Nothing downstream takes an id from the caller, which is the property
 * `#241` and `#399` both rest on.
 *
 * **`action` is the only thing that differs between the doors.** The console's
 * page must not carry the token — `#428` refuses a durable bearer link inside a
 * page behind a login — so the forms post to the console's own path and the token
 * stays on the server.
 */
export async function operatorPageBody(
  deps: RouteDependencies,
  token: string,
  action: string,
  view: {
    /** The subject the token named (`#1265`) — what the Autonomy console link needs. */
    agentId: OperatorPageView['agentId']
    agentName: string
    badges: OperatorPageView['badges']
    contract: OperatorPageView['contract']
    /** The other agents the same form answered for (`#514`). */
    contractAlsoCovered?: OperatorPageView['contractAlsoCovered'] | undefined
    facts: OperatorPageView['facts']
    declaredRhythmMinutes: OperatorPageView['declaredRhythmMinutes']
  },
  errors: {
    /**
     * Where this door's inbox is rooted (`#1547`).
     *
     * The door's own, like `action` beside it. Absent renders no messages
     * section at all, which is what a deployment with no messaging gets.
     */
    readonly inboxBase?: string
    /** Where this address's other agents are listed (`#1577`). The door's own. */
    readonly agentsIndex?: string
    /** What to say if an operator's addition was just refused (`#1440`). */
    readonly shareError?: string
    /**
     * Where a share's write and hand-back forms post (`#1440`).
     *
     * **Both doors get one**, unlike `fillDrops` above — that flag exists
     * because a drop's value may only be posted from a console, and `#1437`
     * frozen decision 1 deliberately does not carry that rule across. What
     * differs between the doors is the path, exactly as `action` does.
     */
    readonly shareAction?: string
    /** The authenticated console may use its existing drop-id route; the bearer page may not. */
    readonly fillDrops?: boolean
    /**
     * Render only the operator's own sections, for the agent page (`#453`).
     *
     * **The same function, not a second one.** `#453` requires the operator view
     * on `/agents/:agentId` be produced by this body rather than reimplemented
     * inline, because two renderings of the form would be two places for the
     * permission boundary to drift. What changes is where the fragment is
     * placed; what it can reach is decided by the handlers it posts to, which
     * are the same handlers either way.
     */
    readonly as?: 'page' | 'section' | undefined
    /**
     * The zone a share's expiry is rendered in (`#1634`).
     *
     * **The door's own, exactly as `action` is**, because only a route holds the
     * request the zone is read off. Absent is `UTC`, which is what `zoneFrom`
     * itself answers when no header arrives — a named clock rather than the
     * stored string, which is `#461`'s whole finding.
     */
    readonly zone?: string
  } = {},
): Promise<string> {
  const [threads, shares, telegram] = await Promise.all([
    deps.operatorThreads.store.forPageToken(token),
    /**
     * The entries this agent is sharing (`#1440`).
     *
     * Resolved by the page's own token like everything else here, and empty when
     * the deployment has no sealing key — a page offering a channel this Colony
     * cannot carry would be worse than one that never mentions it.
     */
    deps.operatorShares?.forPageToken(token) ?? Promise.resolve([]),
    /**
     * How the Colony reaches this operator (`#793`).
     *
     * Resolved by the page's own token like everything else here, and skipped
     * entirely when no bot is configured — a page that offered a channel this
     * deployment does not have would be worse than one that never mentions it.
     */
    deps.telegram === undefined
      ? Promise.resolve(undefined)
      : deps.telegram.store.bindingForPageToken(token),
  ])

  /**
   * What the inbox link says before it is clicked (`#1547`).
   *
   * **Counted from the threads this page already read, not from a second query.**
   * `forPageToken` is still called — it is what `wishesWaiting` and the answered
   * check are built on — so the two numbers are arithmetic over rows already in
   * hand rather than a read added to every render.
   *
   * `waiting` is `isWaitingOnTheOperator`'s question asked per thread: a live
   * thread the operator has not written into is a question in front of a person.
   * `unread` is looser and is the count that moves when anything at all happens.
   */
  const waiting = threads.filter(
    (thread: (typeof threads)[number]) =>
      !thread.closed && !thread.messages.some((message) => message.author === 'operator'),
  ).length

  return operatorDurablePage({
    agentId: view.agentId,
    agentName: view.agentName,
    // The wall (`#241`), resolved with the page's own subject: the token
    // names the agent, and nothing here takes an id from the caller.
    badges: view.badges,
    contract:
      view.contract === null
        ? null
        : { ...view.contract, alsoCovered: view.contractAlsoCovered ?? [] },
    // What it has proved and what it has been doing (`#399`), resolved by the
    // same token and by nothing the caller sent.
    facts: view.facts,
    declaredRhythmMinutes: view.declaredRhythmMinutes,
    action,
    ...(errors.as === undefined ? {} : { as: errors.as }),
    /**
     * Where the threads are, rather than the threads (`#1547`).
     *
     * **`inboxBase` is the door's own**, exactly as `action` is and for the
     * identical reason: the console must not put a durable bearer link inside a
     * page served behind a login (`#428`), so each caller passes the root it is
     * being served at and the token never leaves the server on that door.
     *
     * Absent where the caller names none, and then the page says nothing about
     * messages rather than linking somewhere that answers 404.
     */
    ...(errors.agentsIndex === undefined ? {} : { agentsIndex: errors.agentsIndex }),
    ...(errors.inboxBase === undefined
      ? {}
      : {
          inbox: {
            href: errors.inboxBase,
            unread: threads.length,
            waiting,
          },
        }),
    shares,
    zone: errors.zone ?? FALLBACK_ZONE,
    ...(errors.shareAction === undefined ? {} : { shareAction: errors.shareAction }),
    ...(errors.shareError === undefined ? {} : { shareError: errors.shareError }),
    ...(deps.telegram === undefined
      ? {}
      : {
          telegram: {
            boundAt: telegram?.boundAt ?? null,
            unreachable: telegram?.unreachableAt != null,
          },
        }),
    /**
     * Whether this Colony can carry a secret to this person at all (`#1444`).
     *
     * It used to mean *a sealed box can be opened*; the box is retired, and what
     * it means now is *an entry can be shared*. Same key, same condition, and
     * the page's sentence changed with it.
     */
    secretHandoff: deps.operatorShares !== undefined,
    fillDrops: errors.fillDrops === true,
  })
}

/** Where the console's door posts, for one agent. Both routes derive it from here. */
export function consoleOperatorPath(agentId: string): string {
  return `/agents/${agentId}/operator`
}

/**
 * Where a contract is revised (`#1265`).
 *
 * **A pointer, not a permission.** The durable page and the thank-you page both
 * name this path so an operator who changes their mind is not told to ask the
 * agent whose permissions they are revising. Signing in is still what authorises
 * the revise form; the link is words (D-081).
 */
export function consoleAutonomyPath(agentId: string): string {
  return `/agents/${agentId}/autonomy`
}
