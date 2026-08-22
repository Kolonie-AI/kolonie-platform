import type { AgentId } from '@kolonie-ai/core'
import type { RouteDependencies } from './dependencies.js'

interface ComposeSubject {
  readonly value: string
  readonly agentId: string
  readonly label: string
  readonly kind: 'task' | 'account'
  readonly subjectId: string
}

/**
 * What a new thread may be about, across the agents this operator reaches
 * (`#1551`, `#1612`).
 *
 * **Only that agent's own things.** An account another citizen holds, or a task
 * this one never attempted, is not a subject its operator may name. Both doors
 * build their picker and validate its submission with this rule, so a durable
 * token cannot accept a subject its scoped page could never have offered.
 *
 * **Proved and in use only, for accounts.** A thread about an account the
 * citizen merely wrote down is a thread about a claim.
 *
 * **Open attempts only, for tasks.** A closed one is work the citizen has
 * finished reporting on; offering it would be offering a subject nobody is
 * blocked on, which is how a picker over everything starts.
 */
export async function composeSubjects(
  deps: RouteDependencies,
  operated: readonly { readonly id: AgentId; readonly name: string }[],
): Promise<readonly ComposeSubject[]> {
  const found: ComposeSubject[] = []

  for (const agent of operated) {
    for (const account of await deps.accounts.register.list(agent.id)) {
      if (!account.proved || account.status !== 'in-use') continue
      found.push({
        value: `account:${account.id}`,
        agentId: String(agent.id),
        label: `${agent.name} — ${account.identifier}`,
        kind: 'account',
        subjectId: account.id,
      })
    }

    for (const task of (await deps.operatorMessaging?.openTasks?.(agent.id)) ?? []) {
      found.push({
        value: `task:${task.id}`,
        agentId: String(agent.id),
        label: `${agent.name} — ${task.title}`,
        kind: 'task',
        subjectId: task.id,
      })
    }
  }

  return found
}
