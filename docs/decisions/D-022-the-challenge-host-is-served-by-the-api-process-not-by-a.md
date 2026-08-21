## D-022 — The challenge host is served by the API process, not by a container of its own

**Date:** 2026-07-28

**Problem.** The Browser Capability Gate needs a page a browser can load at a
hostname of its own. `kolonie-infra#18` named two ways to serve it and settled
neither: an Nginx sidecar, which it marked _recommended_, or the API process
serving the files directly, which it marked _simpler, but mixes concerns_.

**Decision.** The API process serves it, from `apps/api/public/captcha/`, behind
a `/captcha/` prefix. Traefik gives `challenge.kolonie.ai` its own router
pointing at the same container.

Three things decided it, and the first is the strongest: **this is already the
established pattern.** `api.kolonie.ai` and `academy.kolonie.ai` have shared the
API container since the first deploy, and `mcp.kolonie.ai` was deliberately given
a separate _router_ to the same _service_ — the comment in `routes.yml` spells
out why. A fourth hostname on that container is the shape this system already
has, not a new one.

Second, **the page and its endpoint belong to one service anyway.** The token the
form produces is verified by `POST /v1/academy/verify-captcha` (#22), which lives
in this API. Splitting the page from the endpoint that reads its output would put
a CORS boundary between two halves of a single interaction, for nothing.

Third, **a sidecar is not free.** A separate image means a fourth GHCR package, a
fourth build workflow, and a fourth _Manage Actions access_ grant before the
deploy can pull it (`kolonie-infra#1`). That is real recurring cost, paid to
separate a directory of static files from a process that is already running.

**Rejected: serving the files at the root prefix.** Registering static files at
`/` puts a wildcard in front of every API route, so a filename that collided with
a path would shadow it silently. The narrow `/captcha/` prefix can only ever
serve what is in that one directory.

**Consequence, stated rather than hidden.** The page is reachable at
`api.kolonie.ai/captcha/` as well, because host-based restriction would mean
teaching the application which hostname it is answering on — and `AGENTS.md` §9
keeps hostnames out of this repository. It is a public static page with no
secrets and no state; being reachable at a second address costs nothing. If that
ever stops being true, the router in `routes.yml` is where it gets fixed, which
is where routing already lives.

The concern-mixing objection is real and is accepted as a debt rather than
dismissed. The migration path is cheap: the files are a plain directory, and
moving them to a sidecar later changes one router and one `COPY` line. That is
the same reasoning D-008 used for the monorepo — take the reversible option
while reversing is still nearly free.
