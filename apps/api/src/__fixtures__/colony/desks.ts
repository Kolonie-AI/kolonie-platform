import type { AutonomyDependencies } from '../../autonomy.js'
import type { OperatorClaimDependencies } from '../../operator-claim.js'
import type { AccountDependencies } from '../../accounts.js'
import { support as supportSurface, type Support } from '../../support.js'
import { erasure as erasureSurface, type Erasure } from '../../erasure.js'
import { fakeAutonomy, fakeOperatorPages } from '../autonomy.js'
import { fakeOperatorClaim } from '../operator-claim.js'
import { fakeAccounts } from '../accounts.js'
import { fakeSupportDesk, type FakeSupportDesk } from '../support.js'
import { fakeOperatorRequests, type FakeOperatorRequestStore } from '../operator-requests.js'
import type { OperatorRequestDependencies } from '../../operator-requests.js'
import { fakeErasureDesk, type FakeErasureDesk } from '../erasure.js'

/**
 * The surfaces somebody sits behind: a steward, an operator, an account holder.
 *
 * Two of them are exposed twice on purpose — the surface a route is wired to,
 * and the desk behind it a test writes through. That pairing is the reason they
 * are together in one file rather than filed under whatever they are about: the
 * fixture's job here is to hold both ends of the same seam.
 */
export interface FakeDesks {
  /**
   * The support surface, plus the desk behind it.
   *
   * Both, because the tests need each: `support` is what the MCP tools are wired to,
   * and `desk` is how a test puts a ticket into a state no citizen can write.
   */
  readonly support: Support
  readonly desk: FakeSupportDesk
  /**
   * The erasure surface, plus the desk behind it.
   *
   * Both, for the reason `support` gives: `erasure` is what the tools and routes
   * are wired to, and `erasureDesk` is how a test says *refuse the next
   * confirmation* or asserts which agent id actually reached the transaction.
   */
  readonly erasure: Erasure
  readonly erasureDesk: FakeErasureDesk
  /** The account register, behind both surfaces. Overridable the same way (#150). */
  readonly accounts: AccountDependencies
  readonly operatorClaim: OperatorClaimDependencies
  readonly autonomy: AutonomyDependencies
  /**
   * The operator channel (#236), and the store behind it.
   *
   * Both, for the reason `support` gives: the surface is what the tools are wired
   * to, and the store is how a test gives a citizen a page, a task, or a
   * `needs-operator` shelving to be cleared.
   *
   * **Its allowance is the same `support` surface above**, not a second limiter —
   * which is what `#236` requires and what `server.ts` wires. A test that exhausts
   * the ticket allowance therefore sees a request refused, and that is a property
   * of the fixture rather than a thing each test has to arrange.
   */
  readonly operatorRequests: OperatorRequestDependencies
  readonly operatorRequestStore: FakeOperatorRequestStore
}

export function fakeDesks(): FakeDesks {
  const desk = fakeSupportDesk()
  const erasureDesk = fakeErasureDesk()

  const support = supportSurface({ desk })
  /**
   * One page store, read by both the autonomy module and the operator channel —
   * which is what production does, where both resolve a token through
   * `operator_pages`. Two independent stores here would let a test answer through
   * a page the request path had never heard of.
   */
  const pages = fakeOperatorPages()
  const operatorRequests = fakeOperatorRequests({ allowance: support, pages })

  return {
    support,
    desk,
    operatorRequests,
    operatorRequestStore: operatorRequests.store,
    erasure: erasureSurface({ desk: erasureDesk }),
    erasureDesk,
    accounts: fakeAccounts(),
    operatorClaim: fakeOperatorClaim(),
    autonomy: fakeAutonomy(pages),
  }
}
