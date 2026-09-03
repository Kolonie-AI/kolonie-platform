import { GUEST_VAULT_HANDOFF_PASSPHRASE_MAX_LENGTH } from '@kolonie-ai/core'
import type {
  ConsumeGuestVaultHandoffOutcome,
  PreviewGuestVaultHandoffOutcome,
} from '@kolonie-ai/db'
import { escape } from './console/escape.js'
import { CONSOLE_MARK } from './console/mark.js'
import { CONSOLE_STYLE } from './console/theme.js'

export const GUEST_HANDOFF_PATH_PREFIX = '/handoff/'
export const GUEST_HANDOFF_CSRF_COOKIE = '__Host-kolonie_handoff_csrf'
export const GUEST_HANDOFF_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex, nofollow, noarchive',
}

const page = (title: string, body: readonly string[]): string =>
  [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    `<title>${escape(title)} — Kolonie</title>`,
    `<style>${CONSOLE_STYLE}</style>`,
    '</head>',
    '<body>',
    '<header class="console-mast">',
    CONSOLE_MARK,
    '<strong>Kolonie</strong>',
    '</header>',
    '<main>',
    ...body,
    '</main>',
    '</body>',
    '</html>',
  ].join('')

export function guestHandoffClosedPage(): string {
  return page('Handoff unavailable', [
    '<h1>Handoff unavailable</h1>',
    '<p>This handoff cannot be revealed. It may have expired, been revoked, or already been used.</p>',
  ])
}

export function guestHandoffPreviewPage(
  preview: Extract<PreviewGuestVaultHandoffOutcome, { outcome: 'active' }>,
  csrf: string,
): string {
  return page('Secret handoff', [
    '<h1>Secret handoff</h1>',
    preview.creator === null
      ? ''
      : `<p>Created by <strong>${escape(preview.creator)}</strong>.</p>`,
    `<p><strong>Purpose:</strong> ${escape(preview.purpose)}</p>`,
    `<p><strong>Expires:</strong> <time datetime="${escape(preview.expiresAt)}">${escape(preview.expiresAt)}</time></p>`,
    '<p>The value is not on this page. Revealing consumes this handoff immediately.</p>',
    '<form method="post">',
    `<input type="hidden" name="csrf" value="${escape(csrf)}">`,
    ...(preview.passphraseRequired
      ? [
          '<label for="passphrase">Passphrase</label>',
          `<input id="passphrase" name="passphrase" type="password" required autocomplete="off" maxlength="${GUEST_VAULT_HANDOFF_PASSPHRASE_MAX_LENGTH}">`,
        ]
      : []),
    '<button type="submit">Reveal once</button>',
    '</form>',
  ])
}

export function guestHandoffRevealPage(
  revealed: Extract<ConsumeGuestVaultHandoffOutcome, { outcome: 'revealed' }>,
): string {
  return page('Secret revealed', [
    '<h1>Secret revealed</h1>',
    '<p>This is the only disclosure. Save it before leaving this page.</p>',
    ...(revealed.description === null
      ? []
      : [`<p><strong>Description:</strong> ${escape(revealed.description)}</p>`]),
    `<pre aria-label="Revealed secret">${escape(revealed.value)}</pre>`,
  ])
}

export function guestHandoffRetryPage(
  preview: Extract<PreviewGuestVaultHandoffOutcome, { outcome: 'active' }>,
  csrf: string,
  limited: boolean,
): string {
  const form = guestHandoffPreviewPage(preview, csrf)
  const message = limited
    ? 'Too many passphrase attempts from this source. Try later from another trusted connection.'
    : 'The passphrase was not accepted. Nothing was revealed or consumed.'
  return form.replace(
    '<h1>Secret handoff</h1>',
    `<h1>Secret handoff</h1><p role="alert">${message}</p>`,
  )
}
