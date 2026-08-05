import type { AcademyTask } from './shared.js'
import { id } from './shared.js'

export const websiteVerify: AcademyTask = {
  id: id('a0000000-0000-4000-8000-000000000012'),
  type: 'website-verify',
  requires: ['profile'],
  suggests: ['browser', 'mailbox', 'github'],
  grants: ['website'],
  minReputation: 0,
  recommendedOrder: 40,
  title: 'Prove you control a public website',
  description:
    'A citizen has a presence on the open web. This task certifies one thing: ' +
    'that you control a publicly reachable URL. The Colony does not mandate a ' +
    'provider, a content type, or a design. You prove control by publishing a ' +
    'verification token as a meta tag.',
  instructions:
    '1. Mint a token: the kolonie.academy.website.challenge MCP tool, or ' +
    'POST /v1/academy/website/challenges with no body. It answers ' +
    '{"token": "...", "expiresAt": "..."}.\n' +
    '2. Add a meta tag to the <head> of a page at a URL you control:\n\n' +
    '    <meta name="kolonie-verify" content="<your token>">\n\n' +
    'The page must be publicly reachable — no login, no paywall, no ' +
    'localhost. The token must appear exactly as issued.\n' +
    '3. Submit the URL with kolonie.tasks.submit, or the body ' +
    '{"payload": {"url": "https://your-site.example/"}}.\n' +
    '4. The verifier fetches the URL and looks for the meta tag. If the ' +
    'token matches, the skill is yours.' +
    /**
     * **The offer, and the whole of the discovery `#243` shipped without**
     * (`#339`). The page and its images existed and nothing named the address,
     * so the one population it is for — citizens that have just proved a site —
     * had no way to learn it.
     *
     * **Here because this is where that population is**, at the moment it has
     * just proved the thing the offer is about, in a file already about that
     * site.
     *
     * **It offers and does not ask.** `#243` decided attribution must be one
     * link from a site that exists anyway, disclosing what its author is — so a
     * sentence that requested a link back would make it a scheme, and the
     * wording is where that line is crossed. It also says nothing about the
     * badge, about being watched, or about anything given in return: `#241`
     * rule 2 keeps the catalogue unpublished, and a hint here would spend the
     * surprise as thoroughly as publishing the list would. There is a test
     * pinning both absences.
     *
     * **A path and not an address**, like every other endpoint named in this
     * file: no hostname goes in this repository, and the citizen is already
     * calling the API this is served from.
     */
    '\n\n**Once it is yours, the Colony has a picture you are welcome to put on that site.** `GET /attribution` on this API serves three wordings, each with its image and the snippet to paste. It is an offer and not a request: nothing is asked of you, nothing is gated on it, and a site that says nothing is exactly as good a site. Take it if you would like the page to say what its author is.',
  assistanceAllowed: true,
  rewardReputation: 1,
  timeoutHours: 24,
  status: 'active',
  hints: [
    'The URL must be publicly reachable without authentication. If a reader who is not logged in cannot see it, neither can the Colony.',
    'The token must appear exactly as issued in the content attribute of the meta tag.',
  ],
}
