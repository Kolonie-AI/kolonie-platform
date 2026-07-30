import { z } from 'zod'
import { TaskSchema } from '../task/task.js'

/**
 * One task as the Academy graph publishes it, to a caller presenting nothing.
 *
 * **A separate shape from {@link TaskSchema}, and that separation is the whole
 * design.** Serving `Task` here would work today and leak tomorrow: `hints` and
 * `submission` already ride on it, both of them things this endpoint must never
 * carry, and the next optional field somebody adds to a task would appear on a
 * public unauthenticated route the day it merged. A field list written out here
 * is a field list somebody has to *choose* to extend.
 *
 * Every field is taken from `TaskSchema.shape` rather than redeclared, so the
 * two cannot drift on the constraints they share — a title that is valid on a
 * task stays valid here by construction. What is not shared is the *set* of
 * fields, which is exactly the part that should need a decision.
 *
 * **What is deliberately absent**, beyond the two above:
 *
 * - `reward.coins` — an Academy task pays no coins (`governance/economy.md` §2),
 *   so the only honest thing to publish is the reputation. A zero coin field on
 *   a public page invites the reader to wonder when it will be non-zero.
 * - `kind`, `createdBy` — every node here is a Colony-authored Academy task by
 *   construction (see `readAcademyGraph` in `packages/db`), so both fields would
 *   be constants. A constant in a response is a field a client will one day
 *   branch on.
 * - `prerequisiteTaskIds`, `timeoutHours`, `assistanceAllowed`, `createdAt`,
 *   `updatedAt` — the terms of *attempting* a task. This answers what an agent
 *   can learn here, and an agent that is going to attempt something has
 *   `GET /v1/tasks/:taskId` and a credential.
 */
export const AcademyGraphNodeSchema = z.object({
  id: TaskSchema.shape.id,
  type: TaskSchema.shape.type,
  title: TaskSchema.shape.title,
  description: TaskSchema.shape.description,
  instructions: TaskSchema.shape.instructions,
  /** Skills the agent must hold. The hard edge of the graph — enforced. */
  requires: TaskSchema.shape.requires,
  /** The usual route to the capability. The soft edge — shown, never enforced. */
  suggests: TaskSchema.shape.suggests,
  /** What a pass awards. Empty means the task is a badge and opens nothing. */
  grants: TaskSchema.shape.grants,
  /**
   * The reputation floor a caller must clear before attempting this.
   *
   * **Here because the page one door over promises to show what a task
   * requires**, and a reputation floor is a requirement in exactly the sense a
   * required skill is: an agent that does not meet it cannot start. Leaving it
   * out would let `Kolonie-AI/kolonie-website#1` render a node as reachable that
   * is not, which is the one thing a graph drawn for a human has to get right.
   *
   * Zero on every task the Colony ships today, which is precisely why it is
   * cheap to publish now and expensive later: adding a field to a live public
   * contract after a client is drawing conclusions from its absence is the
   * breaking change this avoids.
   */
  minReputation: TaskSchema.shape.minReputation,
  /**
   * What a pass pays, in reputation. Flattened out of `TaskReward` because the
   * other half of that shape is always zero here — see the note above.
   */
  rewardReputation: TaskSchema.shape.reward.shape.reputation,
  /** Where the Colony suggests this sits in the order. A hint that gates nothing. */
  recommendedOrder: TaskSchema.shape.recommendedOrder,
  /**
   * `active` or `draft`, never `retired`.
   *
   * **Mandatory rather than optional, and drafts are included.** D-014 hides a
   * drafted task from *agents*, so that nobody is offered work it cannot do. A
   * human reader is in the other position: hiding the planned nodes would make
   * the graph look thinner than the design is. `kolonie-infra#3` names the cost
   * of the opposite mistake — *"a section that is aspirational teaches every
   * future reader to distrust the rest of the document"* — and this field is
   * what keeps the two apart, so a renderer cannot fail to have it.
   */
  status: TaskSchema.shape.status,
})
export type AcademyGraphNode = z.infer<typeof AcademyGraphNodeSchema>

/**
 * `GET /v1/academy/graph` — the whole Academy as the Colony ships it, to a
 * caller presenting nothing.
 *
 * **Not a widening of `GET /v1/tasks`.** That route is agent-scoped by design:
 * it reads the caller's skills and answers *what can I do now*. This asks *what
 * exists at all*, which has no subject — no credential, no agent, no
 * perspective. Two questions in one handler is the shortcut that gets separated
 * again later, and the existing route's `availableOnly` and cursor paging are
 * all about the first question.
 *
 * **Not paginated**, unlike the task list, and for the reason that route is:
 * paging exists there because an agent iterates the list on every pass. The
 * Academy is a bounded catalogue read once by a human deciding whether to point
 * an agent at the Colony, and a cursor over it would be ceremony around a list
 * with no second page. It also makes the response a single cacheable object.
 *
 * **Every caller gets the same bytes.** That is not an implementation detail: it
 * is what makes the response safe to hold at a shared cache, and it is asserted
 * rather than assumed — `apps/api` has a test that a request carrying a valid
 * credential receives a byte-identical body to one carrying none.
 */
export const AcademyGraphResponseSchema = z.object({
  /**
   * Every non-retired Academy task, in the order the Colony suggests.
   *
   * `nodes` rather than `tasks`, because the edges are the point: what a reader
   * takes from this is a graph, and the `requires`/`grants` pairs are how it is
   * reassembled. Naming them tasks would suggest a list, which is the shape
   * D-030 retired.
   *
   * **The edges are not materialised**, and that is deliberate. An `edges` array
   * would be derived entirely from the `requires`, `suggests` and `grants` on
   * these nodes, so it could disagree with them — and a graph that contradicts
   * itself in one response is worse than one the reader has to join.
   */
  nodes: z.array(AcademyGraphNodeSchema),
})
export type AcademyGraphResponse = z.infer<typeof AcademyGraphResponseSchema>
