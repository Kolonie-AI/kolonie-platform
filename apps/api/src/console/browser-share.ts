import { createHash } from 'node:crypto'
import type { WaitingShare } from '@kolonie-ai/db'
import { escape } from './escape.js'
import { CONSOLE_HEADERS } from './html.js'
import { CONSOLE_MAST } from './mark.js'
import { CONSOLE_STYLE } from './theme.js'

/**
 * The one page in the console that carries script, and why it has to (`#738`).
 *
 * Every other console page is forms and tables, and `./html.ts` says so at the
 * top: no framework, no bundle, `default-src 'none'`. This page is the exception
 * and it is a narrow one. What `#736` built is a screencast in one direction and
 * clicks in the other, over a socket — there is no form that renders a stream of
 * JPEGs and no `<a>` that dispatches a mouse event at a coordinate. A page that
 * refused to run script here would be a page that could not do the one thing the
 * channel exists for.
 *
 * So the exception is bounded in three ways rather than waved through:
 *
 * - **The script is inline and pinned by its own hash.** {@link SHARE_PAGE_CSP}
 *   carries a `sha256-` for exactly this string, computed from it at module load,
 *   so the page permits *this* script and no other. Nothing is fetched, and the
 *   console still has no static asset route to add one to.
 * - **It lives here and not in `./html.ts`.** That file's claim about its own
 *   output stays true, and a reader looking for the console's script finds all of
 *   it in one module.
 * - **The CSP is this page's alone.** `connect-src 'self'` for the socket and
 *   `img-src data:` for the frames are additions no other page gets, and
 *   {@link SHARE_PAGE_HEADERS} is what the route sets over `CONSOLE_HEADERS`.
 *
 * ## What is deliberately not here
 *
 * **No navigation surface of any kind.** No address bar, no back, no reload, no
 * second tab, no way to name a URL — the decision record's limit is that an
 * operator clicks and types on the page the agent chose, and a field that took an
 * address would be the whole of the distance between this and a remote browser.
 * The script sends three CDP methods and it is the same three
 * `CDP_RELAY_METHODS` names, which the agent-side sharer is what actually
 * enforces.
 *
 * **Nothing is stored.** A frame arrives, becomes the `src` of one `<img>`, and
 * is replaced by the next one. There is no buffer, no canvas the page reads back,
 * no download, and no history entry per frame.
 */

/**
 * The viewer, as one string.
 *
 * Written as a constant rather than assembled, because the CSP hash below is
 * taken over these exact bytes: a template that interpolated anything would be a
 * page whose own script violated its own header the first time a value changed.
 * **Everything variable reaches it through the document** — the agent's name is
 * text in a paragraph, the share's id is the path this page is already on.
 *
 * ES5 and no modules on purpose. There is no build step in this repository's
 * console, so what is written here is what runs.
 */
const SHARE_SCRIPT = `(function () {
  var view = document.getElementById('view')
  var state = document.getElementById('state')
  var done = document.getElementById('done')
  var live = false

  function say(text) { state.textContent = text }

  var socket = new WebSocket(
    (location.protocol === 'https:' ? 'wss://' : 'ws://') +
      location.host + location.pathname + '/socket'
  )

  function send(method, params) {
    if (!live) return
    socket.send(JSON.stringify({ type: 'input', method: method, params: params }))
  }

  function at(event) {
    var box = view.getBoundingClientRect()
    if (box.width === 0 || box.height === 0 || view.naturalWidth === 0) return null
    return {
      x: Math.round((event.clientX - box.left) * (view.naturalWidth / box.width)),
      y: Math.round((event.clientY - box.top) * (view.naturalHeight / box.height))
    }
  }

  function mouse(type, event) {
    var point = at(event)
    if (point === null) return
    send('Input.dispatchMouseEvent', {
      type: type,
      x: point.x,
      y: point.y,
      button: type === 'mouseMoved' ? 'none' : 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1,
      modifiers: 0
    })
  }

  socket.addEventListener('open', function () {
    live = true
    say('Connected. Waiting for the agent\\u2019s tab.')
  })
  socket.addEventListener('error', function () { say('The connection failed.') })
  socket.addEventListener('close', function () {
    live = false
    if (state.textContent.indexOf('ended') === -1) say('The session has ended.')
  })

  socket.addEventListener('message', function (event) {
    var message
    try { message = JSON.parse(event.data) } catch (error) { return }

    if (message.type === 'frame') {
      view.src = 'data:image/jpeg;base64,' + message.data
      return
    }
    if (message.type === 'peer') {
      say(message.present ? 'Live.' : 'The agent is not attached right now.')
      return
    }
    if (message.type === 'closed') {
      live = false
      say('The session has ended.')
    }
  })

  view.addEventListener('mousedown', function (event) {
    event.preventDefault()
    mouse('mousePressed', event)
  })
  view.addEventListener('mouseup', function (event) {
    event.preventDefault()
    mouse('mouseReleased', event)
  })
  view.addEventListener('mousemove', function (event) { mouse('mouseMoved', event) })
  view.addEventListener('contextmenu', function (event) { event.preventDefault() })
  view.addEventListener('dragstart', function (event) { event.preventDefault() })

  window.addEventListener('keydown', function (event) {
    if (!live || event.ctrlKey || event.metaKey) return
    event.preventDefault()

    if (event.key.length === 1 && !event.altKey) {
      send('Input.insertText', { text: event.key })
      return
    }
    send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: event.key,
      code: event.code,
      windowsVirtualKeyCode: event.keyCode
    })
  })

  window.addEventListener('keyup', function (event) {
    if (!live || event.ctrlKey || event.metaKey) return
    event.preventDefault()
    send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: event.key,
      code: event.code,
      windowsVirtualKeyCode: event.keyCode
    })
  })

  done.addEventListener('click', function () {
    if (live) socket.send(JSON.stringify({ type: 'closed', reason: 'completed' }))
    live = false
    say('The session has ended. You closed it.')
    socket.close()
  })
})()`

/**
 * The header this page carries instead of `CONSOLE_HEADERS`.
 *
 * Three differences from every other console page, and each one buys exactly one
 * thing:
 *
 * - `script-src 'sha256-…'` — the viewer, and only it. Not `'unsafe-inline'`,
 *   which would permit any script an injection managed to place; a hash permits
 *   the bytes below and nothing else, which is stronger than what a separate file
 *   with no `integrity` would have given.
 * - `img-src data:` — the frames. They arrive base64 on the socket and become the
 *   `src` of one `<img>`, so `'self'` alone would block the picture this page is.
 * - `connect-src 'self'` — the socket, same-origin, which it has to be anyway:
 *   `__Host-kolonie_session` is `SameSite=Lax` and would not travel on a
 *   cross-site upgrade.
 *
 * Everything else is inherited, including `frame-ancestors 'none'` — a live
 * browser session in somebody else's iframe is precisely the shape a clickjack
 * would want.
 */
const SHARE_PAGE_CSP = [
  "default-src 'none'",
  "img-src 'self' data:",
  "style-src 'unsafe-inline'",
  `script-src 'sha256-${createHash('sha256').update(SHARE_SCRIPT).digest('base64')}'`,
  "connect-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

export const SHARE_PAGE_HEADERS: Readonly<Record<string, string>> = {
  ...CONSOLE_HEADERS,
  'content-security-policy': SHARE_PAGE_CSP,
}

/** Whole minutes left, floored at one — *0 minutes* reads as *already over*. */
function minutesLeft(expiresAt: string, now: number): number {
  return Math.max(1, Math.round((Date.parse(expiresAt) - now) / 60_000))
}

/** " (mail.tm, step 3)", " (mail.tm)", " (step 3)", or nothing. */
function whereItIs(share: WaitingShare): string {
  const parts = [
    ...(share.provider === null ? [] : [share.provider]),
    ...(share.step === null ? [] : [`step ${share.step}`]),
  ]
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`
}

/**
 * The window, whole.
 *
 * Not routed through `page()`, and the reason is the issue's own refusal: that
 * layout carries the console's navigation, and *no navigation surface of any
 * kind* is easier to keep true when there is none in the document to begin with.
 * What is here is a masthead, one sentence, the picture, and one control.
 *
 * **The sentence is the whole of the briefing.** Whose browser this is, what
 * closes it, and that the agent carries on afterwards — because the person
 * arriving has a queue entry's worth of context and a couple of minutes, and an
 * operator who does not know the tab survives them is an operator who hesitates
 * to touch it.
 */
export function sharePage(share: WaitingShare, now: number): string {
  const minutes = minutesLeft(share.expiresAt, now)

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    `<title>${escape(share.agentName)}’s browser — Kolonie</title>`,
    `<style>${CONSOLE_STYLE}</style>`,
    '<style>',
    '.share-view{display:block;width:100%;max-width:100%;height:auto;background:#000;',
    'border-radius:0.5rem;cursor:crosshair;touch-action:none}',
    '.share-bar{display:flex;align-items:baseline;gap:1rem;flex-wrap:wrap;margin:1rem 0}',
    '.share-bar p{margin:0}',
    '</style>',
    '</head>',
    '<body>',
    CONSOLE_MAST,
    '<main class="console-main">',
    `<h1>${escape(share.agentName)}’s browser</h1>`,
    /**
     * One paragraph and no second one. The purpose is the agent's own sentence
     * — the only operator-facing wording in the Colony that is — and it is
     * escaped like any stranger's text, because that is what it is here.
     */
    `<p>This is ${escape(share.agentName)}’s own tab. It closes when you close it, or in ` +
      `${minutes} minute${minutes === 1 ? '' : 's'}, and the agent carries on with it afterwards. ` +
      'You can click and type on the page; there is nothing else to drive.</p>',
    `<p><strong>What ${escape(share.agentName)} asked for:</strong> ${escape(share.purpose)}` +
      `${escape(whereItIs(share))}</p>`,
    '<div class="share-bar">',
    '<button type="button" id="done">I’m done — close the session</button>',
    '<p id="state">Connecting…</p>',
    '</div>',
    /**
     * `alt` and no `src`. The picture only exists once a frame arrives, and a
     * placeholder image would be a second thing this page fetches.
     */
    `<img class="share-view" id="view" alt="The live view of ${escape(share.agentName)}’s tab">`,
    '</main>',
    `<script>${SHARE_SCRIPT}</script>`,
    '</body>',
    '</html>',
  ].join('\n')
}
