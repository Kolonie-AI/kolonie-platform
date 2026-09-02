import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { auditRoot, auditSources } from './check-llm-callers.mjs'

type LlmManifest = Parameters<typeof auditSources>[1]

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const manifest = (overrides: Partial<LlmManifest> = {}): LlmManifest => ({
  chatClients: [],
  embeddingClients: [],
  modelReaders: [],
  routes: [],
  ...overrides,
})

describe('the production LLM inventory', () => {
  it('accounts for every current production caller', async () => {
    expect(await auditRoot(ROOT)).toEqual([])
  })

  it('rejects a new direct chat caller', () => {
    const findings = auditSources(
      { 'apps/new-runner/src/main.ts': "export const run = () => fetch('/chat/completions')\n" },
      manifest(),
    )
    expect(findings).toEqual(['unclassified chat client at apps/new-runner/src/main.ts:run'])
  })

  it('rejects a direct chat caller whose endpoint is held in a constant', () => {
    const findings = auditSources(
      {
        'apps/new-runner/src/main.ts':
          "const CHAT_PATH = '/chat/completions'\nexport const ask = () => fetch(CHAT_PATH)\n",
      },
      manifest(),
    )
    expect(findings).toEqual(['unclassified chat client at apps/new-runner/src/main.ts:ask'])
  })

  it('rejects a free-form chat model environment reader', () => {
    const findings = auditSources(
      {
        'apps/new-runner/src/main.ts': 'export const chosen = process.env.NEW_CHAT_MODEL\n',
      },
      manifest(),
    )
    expect(findings).toEqual([
      'unclassified model environment reader at apps/new-runner/src/main.ts:chosen:NEW_CHAT_MODEL',
    ])
  })

  it('rejects a tier-2 vision route', () => {
    const findings = auditSources(
      {
        'apps/new-runner/src/main.ts':
          "const gateways = gatewaysFromEnvironment('verifier')\nexport const visionFetch = gatewayRoutedFetch(gatewaysWithTier(gateways, TIER_2))\n",
        'packages/verifiers/src/new-vision.ts':
          "export function readImage() { return fetchImpl('/chat/completions') }\n",
      },
      manifest({
        chatClients: [
          {
            file: 'packages/verifiers/src/new-vision.ts',
            symbol: 'readImage',
            routes: ['vision'],
          },
        ],
        routes: [
          {
            id: 'vision',
            mode: 'primary-fallback',
            file: 'apps/new-runner/src/main.ts',
            symbol: 'visionFetch',
            helper: 'gatewayRoutedFetch',
            tier: 'tier-1',
          },
        ],
      }),
    )
    expect(findings).toEqual([
      'vision route is not tier 1 at apps/new-runner/src/main.ts:visionFetch',
    ])
  })

  it('accepts an explicitly classified embedding-only client', () => {
    const sources = {
      'apps/embed-runner/src/main.ts':
        "export function embed() { const model = process.env.EMBEDDING_MODEL; return fetch('/embeddings', { body: model }) }\n",
    }
    const findings = auditSources(
      sources,
      manifest({
        embeddingClients: [{ file: 'apps/embed-runner/src/main.ts', symbol: 'embed' }],
        modelReaders: [
          {
            file: 'apps/embed-runner/src/main.ts',
            symbol: 'embed',
            variable: 'EMBEDDING_MODEL',
            kind: 'embedding-only',
          },
        ],
      }),
    )
    expect(findings).toEqual([])
  })

  it('accepts a primary-only client with its decision record', () => {
    const sources = {
      'apps/publisher/src/main.ts': 'export const publishFetch = gatewayOnlyFetch(gateways)\n',
      'apps/publisher/src/client.ts':
        "export function judge() { return publishFetch('/chat/completions') }\n",
      'docs/decisions/D-122-routing.md':
        'A decision the Colony cannot take back does not fall back.\n',
    }
    const findings = auditSources(
      sources,
      manifest({
        chatClients: [
          { file: 'apps/publisher/src/client.ts', symbol: 'judge', routes: ['publish'] },
        ],
        routes: [
          {
            id: 'publish',
            mode: 'primary-only',
            file: 'apps/publisher/src/main.ts',
            symbol: 'publishFetch',
            helper: 'gatewayOnlyFetch',
            decision: 'docs/decisions/D-122-routing.md',
          },
        ],
      }),
    )
    expect(findings).toEqual([])
  })

  it('rejects a classified caller whose transport is unmanaged', () => {
    const findings = auditSources(
      {
        'apps/new-runner/src/main.ts':
          "export const modelFetch = fetch\nexport function ask() { return modelFetch('/chat/completions') }\n",
      },
      manifest({
        chatClients: [{ file: 'apps/new-runner/src/main.ts', symbol: 'ask', routes: ['new'] }],
        routes: [
          {
            id: 'new',
            mode: 'primary-fallback',
            file: 'apps/new-runner/src/main.ts',
            symbol: 'modelFetch',
            helper: 'gatewayRoutedFetch',
          },
        ],
      }),
    )
    expect(findings).toEqual(['unmanaged route at apps/new-runner/src/main.ts:modelFetch'])
  })

  it('rejects a routed caller that did not construct the gateway pair', () => {
    const findings = auditSources(
      {
        'apps/new-runner/src/main.ts':
          "const gateways = { primary: gateway }\nexport const modelFetch = gatewayRoutedFetch(gateways)\nexport function ask() { return modelFetch('/chat/completions') }\n",
      },
      manifest({
        chatClients: [{ file: 'apps/new-runner/src/main.ts', symbol: 'ask', routes: ['new'] }],
        routes: [
          {
            id: 'new',
            mode: 'primary-fallback',
            file: 'apps/new-runner/src/main.ts',
            symbol: 'modelFetch',
            helper: 'gatewayRoutedFetch',
          },
        ],
      }),
    )
    expect(findings).toEqual([
      'fallback route does not use the gateway pair at apps/new-runner/src/main.ts:modelFetch',
    ])
  })
})
