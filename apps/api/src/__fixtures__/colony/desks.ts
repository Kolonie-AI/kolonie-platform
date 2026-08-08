import type { AutonomyDependencies } from '../../autonomy.js'
import type { OperatorClaimDependencies } from '../../operator-claim.js'
import { fakeProviderRecipes, type FakeProviderRecipes } from '../provider-recipes.js'
import { fakeAtlasRenames } from '../atlas-renames.js'
import type { AtlasRenames } from '../../atlas/renames.js'
import type { AccountDependencies } from '../../accounts.js'
import { fakeHumans } from '../humans.js'
import type { HumanDependencies } from '../../humans/humans.js'
import { support as supportSurface, type Support } from '../../support.js'
import { erasure as erasureSurface, type Erasure } from '../../erasure.js'
import {
  fakeAutonomy,
  fakeAutonomyStore,
  fakeOperatorPages,
  type FakeAutonomyStore,
} from '../autonomy.js'
import { fakePermissionReports, type FakePermissionReportStore } from '../permission-reports.js'
import { fakeOperatorClaim } from '../operator-claim.js'
import { fakeAccounts } from '../accounts.js'
import { fakeSupportDesk, type FakeSupportDesk } from '../support.js'
import type { OperatorNoteDependencies } from '../../operator-notes.js'
import { fakeOperatorNotes, type FakeOperatorNoteStore } from '../operator-notes.js'
import { fakeOperatorRequests, type FakeOperatorRequestStore } from '../operator-requests.js'
import type { OperatorRequestDependencies } from '../../operator-requests.js'
import type { PermissionReportDependencies } from '../../permission-reports.js'
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
  /** The provider catalogue (`#521`). Empty until a test writes an entry. */
  readonly recipes: FakeProviderRecipes
  /** Where a provider used to be (`#546`). Empty until a test renames one. */
  readonly renames: AtlasRenames
  /** People with accounts, and the tenant they sign in through (`#425`). */
  readonly humans: HumanDependencies
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
  /** The unsolicited direction (#239), over the same page store. */
  readonly operatorNotes: OperatorNoteDependencies & { readonly store: FakeOperatorNoteStore }
  readonly operatorNoteStore: FakeOperatorNoteStore
  /**
   * Blocked by permission rather than by ability (#147), and the store behind it.
   *
   * **Its contract store is the autonomy module's own**, not a second one: the
   * recommendation compares what a citizen holds with what its blocked work needs, and
   * a test that granted a contract through `autonomy` would otherwise find the
   * recommendation had never heard of it.
   */
  readonly permissionReports: PermissionReportDependencies
  readonly permissionReportStore: FakePermissionReportStore
  /**
   * The contract store, exposed for the same reason `desk` is: `autonomy` is what the
   * tools are wired to, and this is how a test says *this citizen already holds
   * `independent`* without walking an operator through a form.
   *
   * It is the object **both** `autonomy` and `permissionReports` hold.
   */
  readonly autonomyStore: FakeAutonomyStore
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
  const autonomyStore = fakeAutonomyStore()
  const permissionReports = fakePermissionReports(autonomyStore)
  const operatorRequests = fakeOperatorRequests({ allowance: support, pages })
  /**
   * The same page store again (#239). A note is resolved through `operator_pages`
   * by token exactly as an answer is, so a third independent token map here would
   * let a test write a note through a page the revoke path had never heard of.
   *
   * **Its own limiter, not `support`.** Production wires it that way for the
   * reason the dependency split exists: the exchange's ceiling is the citizen's
   * budget for making a person read something, and this one is the page's budget
   * for making a citizen read something.
   */
  const operatorNotes = fakeOperatorNotes({ pages })

  return {
    support,
    desk,
    operatorRequests,
    operatorRequestStore: operatorRequests.store,
    operatorNotes,
    operatorNoteStore: operatorNotes.store,
    permissionReports,
    permissionReportStore: permissionReports.store,
    erasure: erasureSurface({ desk: erasureDesk }),
    erasureDesk,
    accounts: fakeAccounts(),
    recipes: fakeProviderRecipes(),
    renames: fakeAtlasRenames(),
    humans: fakeHumans(),
    operatorClaim: fakeOperatorClaim(),
    autonomy: fakeAutonomy(pages, autonomyStore),
    autonomyStore,
  }
}
