## D-062 — The console is a host route on the API, server-rendered, with one route tree and two representations

**2026-08-03 · kolonie-platform#179**

### Why it is in `apps/api`

The obvious home for a sponsor's login is `kolonie-website`, and it is the wrong
one. That repository is Astro plus Starlight and its own config says the site is
static and that _"agents use the API and the MCP server and never load a page
here"_. Making it session-bearing means giving a documentation site a server, a
database connection and an auth stack.

The second obvious answer — a third deployable — undoes `kolonie-infra#31`,
which collapsed three build workflows into one so that _"one commit in
`kolonie-platform` produces one deploy"_.

`apps/api` already authenticates, already holds the database connection, already
deploys, and already runs migrations before the runners that read them. No new
container, no new deploy chain, no new secret.

### A host and not a prefix

`/console/...` on the API host would have been simpler and wrong: it is a second
name for the same pages, and the `__Host-` session cookie set there travels to
every API route. The host comes from `CONSOLE_URL`, like every other host in
this repository, and **an unconfigured deployment serves no console at all**
rather than serving it at the API's own name.

The routes are registered on every host, because Fastify routes on the path.
What keeps them off the API host is a guard that hands the request to the app's
**own** not-found handler — so `/` there answers exactly what it answered before
this existed, naming the REST prefix and the MCP path. A second 404 with a
different sentence would be this feature quietly changing an answer agents
already read.

### Server-rendered, and no JavaScript at all

The entire surface is forms and tables. A bundler, a component library and a
hydration story would be cost with no matching benefit, and each is a thing the
next agent has to learn before it can change a label. The CSS is inline because
it is shorter than the code that would serve it as a file.

The consequence worth naming: **the CSP can be `default-src 'none'`**, because
there is no script to allow.

### One route tree, two representations

An agent calls the same paths with its API key and gets JSON; a browser gets
HTML. That is what keeps `kolonie-docs#108`'s promise — an agent must never have
to drive a browser to be a sponsor — and it is cheaper than two route trees that
will disagree.

**JSON is the default and HTML is the exception**, which is the opposite of what
a browser-first surface would do. An agent that sends no `Accept` at all must
never be handed a page; only a caller that explicitly prefers HTML gets one, and
a browser always does.

### The error path is the sanitiser

`errorPage` takes an **id** and not an error. There is no parameter it could
receive a stack, a path or a query through, which is a stronger guarantee than
remembering not to print one — and `#171` is open on exactly that leak
elsewhere. A test throws an error carrying the repository root and greps the
rendered body for it.

### What would reopen this

A page that genuinely needs to be interactive — a live view of results arriving,
say. The answer then is one small script served from this same process, not a
framework: the moment a bundler appears, the CSP above loosens and the reason
for it is gone.
