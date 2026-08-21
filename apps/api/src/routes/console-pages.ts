import type { FastifyInstance } from 'fastify'
import type { RouteDependencies } from './dependencies.js'
import { registerConsoleAgentAccounts } from './console-agent-accounts.js'
import { registerConsoleAgentPages } from './console-agent-pages.js'
import { registerConsoleBackendPages } from './console-backend-pages.js'
import { registerConsoleInboxPages } from './console-inbox-pages.js'
import { consolePageContext } from './console-page-context.js'
import { registerConsoleProfilePages } from './console-profile-pages.js'
import { registerSponsorPages } from './console-quest-pages.js'
import { registerConsoleSessionPages } from './console-session-pages.js'
import { consoleHost } from './console-shared.js'

/**
 * Re-exported so `app.ts` and `console-pages.test.ts` do not move (`#1498`).
 * They live in `console-shared.ts` now; this is the door they were already
 * knocking on.
 */
export {
  consoleError,
  consoleHost,
  consoleNotFound,
  isConsoleRequest,
  wantsHtml,
} from './console-shared.js'

/**
 * The console's pages, registered from seven modules (`#1498`).
 *
 * ## What this file used to be
 *
 * 6,676 lines and 79 routes, against eleven neighbours in this directory
 * averaging 370 — twelve times its biggest one. `registerConsolePages` alone was
 * one 5,221-line function.
 *
 * ## It was a move
 *
 * Every route body is byte-identical to what was here. What changed is where the
 * closures they capture come from: eleven were declared inside that function and
 * used across groups, so `consolePageContext` builds them once and hands them
 * over as `ctx`.
 *
 * **That shape was already in this file.** `registerSponsorPages` took
 * `(app, deps, ctx)` for the quest routes before any of this; the other six
 * groups now do what it did.
 *
 * ## Every route keeps its path
 *
 * `console-links.test.ts` crawls the console for links with no route and passes
 * unmodified, which is the check that would catch one lost in the move.
 * `BACKEND_PAGES` and `AGENT_PAGES` in `../console/navigation.ts` are untouched:
 * a nav entry pointing at a route that moved file points at the same path.
 */
export function registerConsolePages(app: FastifyInstance, deps: RouteDependencies): void {
  const host = consoleHost(deps.console.consoleUrl)
  if (host === undefined) return

  const ctx = consolePageContext(deps, host)

  registerConsoleSessionPages(app, deps, ctx)
  registerConsoleBackendPages(app, deps, ctx)
  registerConsoleAgentPages(app, deps, ctx)
  registerConsoleAgentAccounts(app, deps, ctx)
  registerConsoleInboxPages(app, deps, ctx)
  registerConsoleProfilePages(app, deps, ctx)
  registerSponsorPages(app, deps, ctx)
}
