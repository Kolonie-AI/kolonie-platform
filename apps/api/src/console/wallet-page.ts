import { CONSOLE_HEADERS, escape, page } from './html.js'

/**
 * The page that asks a browser wallet to sign (`#539`).
 *
 * ## The gap this closes
 *
 * The `solana-wallet` rung is an Ed25519 signature over a nonce, and every one
 * of the addresses verified in production was signed **programmatically**, by an
 * agent holding its own key in its own process. A person holding a wallet in a
 * browser has no equivalent: neither Phantom nor MetaMask offers a *sign this
 * text* button of its own. **A wallet signs when a page asks it to, and no page
 * asked.**
 *
 * That is not cosmetic. Attribution under D-106 is by sender address, and a
 * payment from an address nobody verified is quarantined and cannot be claimed
 * afterwards — deliberately, because *believe me, it was me* must not be a
 * payment route. An unverifiable address is a wallet that cannot pay the Colony
 * for anything, ever. It closed the Colony to every human sponsor, including the
 * maintainer, who funded an agent's wallet instead on 2026-08-07 — which worked
 * and is not a thing an outside sponsor would do.
 *
 * ## This is the first console page that carries script, and that is the cost
 *
 * `CONSOLE_HEADERS` says the CSP *"can be this strict precisely because the
 * pages carry no script"*. A wallet signature cannot be obtained any other way:
 * the key is in the browser, the wallet exposes it through a JavaScript API, and
 * no server-side flow reaches it. So this page pays for the exception and
 * nothing else does.
 *
 * **The exception is as narrow as it can be made.** {@link WALLET_PAGE_HEADERS}
 * adds exactly two sources to `CONSOLE_HEADERS`, both `'self'`:
 *
 * - `script-src 'self'` — the script is a **separate same-origin file**, not
 *   inline. Inline would need `'unsafe-inline'` or a per-response nonce; a file
 *   needs neither, and it means nothing this page renders can become script.
 * - `connect-src 'self'` — `default-src 'none'` covers `connect-src`, so
 *   without it the page's own `fetch` back to the console is blocked.
 *
 * Everything else is unchanged: no third-party origin, no `unsafe-eval`, no
 * frame, no form action off-origin.
 *
 * ## What the page must say before it asks
 *
 * **A signature is not a transaction and moves no money.** `#539` names this as
 * the one thing a cautious person will want to know, and it is above the button
 * rather than below it. The page also never asks for a private key or a seed
 * phrase, never triggers a transaction signing request, and says so — the same
 * property `WalletAnswerSchema` enforces on the wire with `.strict()`.
 */

/**
 * `CONSOLE_HEADERS`, plus the two sources a wallet signature cannot be had
 * without. Both `'self'`. See this file's header for why each is needed and why
 * neither is `'unsafe-inline'`.
 */
export const WALLET_PAGE_HEADERS: Readonly<Record<string, string>> = {
  ...CONSOLE_HEADERS,
  'content-security-policy':
    "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'self'; " +
    "connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
}

/** Where the script lives. Same origin, one file, referenced by both. */
export const WALLET_SCRIPT_PATH = '/assets/wallet.js'

/**
 * The client half.
 *
 * **Wallet-agnostic, and that is a requirement rather than a preference**
 * (`#539`): the rung verifies a signature and does not care where it came from,
 * so nothing here names a wallet in a branch. Two discovery routes are tried,
 * in this order, because between them they cover what is actually installed:
 *
 * 1. **The Wallet Standard** — `wallet-standard:app-ready`. The registration
 *    protocol every current Solana wallet implements, including MetaMask's
 *    Solana support, and the one that will still be right when a wallet nobody
 *    here has heard of is installed. It is a handful of lines because the app
 *    half of the standard is an event and an array; the libraries that wrap it
 *    add discovery caching and a React context, neither of which a single-button
 *    page needs — and this page may load no third-party script at all.
 * 2. **The injected provider** — `window.solana` / `window.phantom.solana`, the
 *    older interface Phantom and several others still expose. Kept as a fallback
 *    rather than as the path, so a wallet that only has this one still works.
 *
 * **`signMessage` and never `signTransaction`.** The page has no transaction to
 * offer and no code that could build one, which is the strongest form of the
 * promise above the button.
 */
export const WALLET_SCRIPT = String.raw`
'use strict'

// The nonce is signed as UTF-8 bytes, which is what the verifier reads.
const encoder = new TextEncoder()

const state = {
  wallets: [],
}

function say(kind, message) {
  const box = document.getElementById('wallet-status')
  if (box === null) return
  box.className = 'status status--' + kind
  box.textContent = message
}

/** Base58, because that is what Solana tooling emits and the API accepts. */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58(bytes) {
  const digits = [0]
  for (const byte of bytes) {
    let carry = byte
    for (let i = 0; i < digits.length; i += 1) {
      carry += digits[i] << 8
      digits[i] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }

  // Every leading zero byte is one leading '1', which is what makes the
  // encoding round-trip rather than merely decode to the same number.
  let leading = ''
  for (const byte of bytes) {
    if (byte !== 0) break
    leading += '1'
  }

  let out = ''
  for (let i = digits.length - 1; i >= 0; i -= 1) out += ALPHABET[digits[i]]

  return leading + out
}

/**
 * Everything that can sign, from both discovery routes, de-duplicated by name.
 *
 * The Wallet Standard's app half: dispatch wallet-standard:app-ready with a
 * register callback, and every wallet already on the page answers immediately.
 */
function discover() {
  const found = []

  const register = (...wallets) => {
    for (const wallet of wallets.flat()) {
      const feature = wallet.features && wallet.features['solana:signMessage']
      if (feature === undefined || typeof feature.signMessage !== 'function') continue
      found.push({
        name: wallet.name,
        sign: async (message) => {
          const account = wallet.accounts && wallet.accounts[0]
          if (account === undefined) throw new Error('no account')
          const [output] = await feature.signMessage({ account, message })
          return { address: base58(account.publicKey), signature: base58(output.signature) }
        },
      })
    }
    return () => {}
  }

  window.dispatchEvent(
    new CustomEvent('wallet-standard:app-ready', { detail: { register } }),
  )

  // The older injected provider, kept so a wallet that has only this still
  // works. Named nowhere in a branch: this is an interface, not a product.
  const injected = (window.phantom && window.phantom.solana) || window.solana
  if (injected !== undefined && typeof injected.signMessage === 'function') {
    found.push({
      name: 'the wallet in this browser',
      sign: async (message) => {
        if (typeof injected.connect === 'function') await injected.connect()
        const result = await injected.signMessage(message, 'utf8')
        const address =
          result.publicKey !== undefined
            ? result.publicKey.toString()
            : injected.publicKey.toString()
        const signature =
          typeof result.signature === 'string' ? result.signature : base58(result.signature)
        return { address, signature }
      },
    })
  }

  const seen = new Set()
  return found.filter((wallet) => {
    if (seen.has(wallet.name)) return false
    seen.add(wallet.name)
    return true
  })
}

async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    credentials: 'same-origin',
    body: body === undefined ? '{}' : JSON.stringify(body),
  })

  const text = await response.text()
  let payload
  try {
    payload = text === '' ? {} : JSON.parse(text)
  } catch (error) {
    throw new Error('The Colony answered something this page could not read.')
  }

  if (!response.ok) throw new Error(payload.message || 'The Colony refused that.')
  return payload
}

async function prove(wallet, choices) {
  const button = choices.querySelector('button')
  if (button === null) return

  try {
    say('working', 'Asking the Colony for a nonce…')
    const challenge = await post(button.dataset.challenge)

    say('working', 'Waiting for ' + wallet.name + ' to sign. Nothing is being spent.')
    const signed = await wallet.sign(encoder.encode(challenge.nonce))

    say('working', 'Checking the signature…')
    const verified = await post(button.dataset.signature, signed)

    say('done', 'Verified. ' + verified.address + ' is now this agent’s address.')
    if (button !== null) button.hidden = true
  } catch (error) {
    // A refusal in the wallet is the ordinary case, not a fault: somebody read
    // the prompt and said no, which is exactly what the prompt is for.
    const message = error && error.message ? error.message : String(error)
    say('failed', message)
    // Every choice comes back, so a refusal in one wallet can be retried in
    // another rather than needing a reload.
    for (const other of choices.querySelectorAll('button')) other.disabled = false
  }
}

/**
 * One button per wallet that answered, and that is not a flourish.
 *
 * The first version labelled the single button after wallets[0] and signed with
 * it. On a browser holding two wallets that makes the second unreachable — so a
 * page written to be wallet-agnostic would have offered whichever wallet
 * happened to register first and no way to reach the other. #539 asks that this
 * work in at least two wallets, and a person cannot demonstrate that on a page
 * that only ever offers one.
 *
 * With one wallet installed it renders exactly as before: a single button that
 * names it.
 */
function start() {
  state.wallets = discover()

  const button = document.getElementById('wallet-sign')
  if (button === null) return

  if (state.wallets.length === 0) {
    button.disabled = true
    say(
      'failed',
      'No wallet answered in this browser. Install one, or unlock the one you have, and reload.',
    )
    return
  }

  const choices = document.createElement('p')
  choices.id = 'wallet-choices'

  for (const wallet of state.wallets) {
    // Cloned from the rendered button so every choice carries the same data
    // attributes — the two paths the page posts to live on it.
    const choice = button.cloneNode(false)
    choice.id = ''
    choice.disabled = false
    choice.textContent = 'Sign with ' + wallet.name
    choice.addEventListener('click', () => {
      for (const other of choices.querySelectorAll('button')) other.disabled = true
      void prove(wallet, choices)
    })
    choices.appendChild(choice)
    choices.appendChild(document.createTextNode(' '))
  }

  button.replaceWith(choices)
  say('ready', state.wallets.length === 1 ? '' : state.wallets.length + ' wallets answered.')
}

// The wallets register on app-ready, and a wallet whose own script has not run
// yet answers nothing. DOMContentLoaded is after every deferred script.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start)
} else {
  start()
}
`

const STYLE = `
  .wallet__lede { font-size: 1.05rem; }
  .wallet__promise { border-left: 3px solid currentColor; padding: 0.4rem 0 0.4rem 1rem; margin: 1.2rem 0; }
  .wallet__promise strong { display: block; }
  .status { margin-top: 1rem; min-height: 1.4em; }
  .status--failed { font-weight: 600; }
  .status--done { font-weight: 600; }
  button[disabled] { opacity: 0.6; cursor: not-allowed; }
`

/**
 * One agent's wallet page.
 *
 * `verifiedAddress` is what the agent has already proved, if anything. A page
 * that showed nothing would leave a person who has already done this wondering
 * whether it took.
 */
export function walletPage(input: {
  readonly agentId: string
  readonly agentName: string
  readonly verifiedAddress: string | null
}): string {
  const base = `/agents/${encodeURIComponent(input.agentId)}/wallet`

  const already =
    input.verifiedAddress === null
      ? ''
      : `<p class="wallet__lede">This agent has already proved
         <code>${escape(input.verifiedAddress)}</code>. Signing again replaces nothing —
         one wallet belongs to one citizen, and the Colony refuses a wallet another
         citizen has already cleared with.</p>`

  return page({
    title: `Prove a wallet — ${input.agentName}`,
    signedIn: true,
    body: `
      <style>${STYLE}</style>
      <h1>Prove a wallet for ${escape(input.agentName)}</h1>

      ${already}

      <p class="wallet__lede">The Colony recognises a payment by the address it came
      from. To pay for a quest from a wallet you hold in this browser, that wallet has to
      prove it is yours once — by signing a short phrase the Colony hands it.</p>

      <div class="wallet__promise">
        <strong>A signature is not a transaction.</strong>
        It moves no money, approves no spending, and costs no fee. Your wallet will show
        you the exact text it is signing. The Colony never sees your private key or your
        seed phrase, has no field to put one in, and will never ask you to approve a
        transaction on this page.
      </div>

      <p><button id="wallet-sign" type="button" disabled
                 data-challenge="${escape(`${base}/challenge`)}"
                 data-signature="${escape(`${base}/signature`)}">Looking for a wallet…</button></p>
      <p id="wallet-status" class="status" role="status" aria-live="polite"></p>

      <p><a href="/agents/${encodeURIComponent(input.agentId)}">Back to ${escape(
        input.agentName,
      )}</a></p>

      <script src="${WALLET_SCRIPT_PATH}" defer></script>
    `,
  })
}
