# Build context is the repository root, not this directory: a workspace build
# needs the root lockfile and every sibling package it depends on.
#   docker build -f apps/api/Dockerfile .

FROM node:22-alpine AS build
WORKDIR /app

# Manifests first, so a source-only change reuses the cached install layer.
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
# Every workspace's manifest has to be here before `npm ci`, including ones
# this image does not ship: `npm run build` is `tsc -b` over the root project
# references, so it builds them all and they need their dependencies installed.
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/verifiers/package.json packages/verifiers/
COPY apps/api/package.json apps/api/
COPY apps/verifier-runner/package.json apps/verifier-runner/
RUN npm ci

COPY packages/ packages/
COPY apps/ apps/
RUN npm run build

# Drop devDependencies from the tree that gets copied into the runtime stage.
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# npm's update notifier, off (kolonie-infra#81).
#
# It writes five lines into the log on every container boot — a production
# container being told about an npm release — and on a day with roughly fifteen
# deploys that is a few hundred lines whose information content is zero. Worse,
# they are unlabelled, so they were the reason this image's unlabelled count
# looked alarming while its own logging was in fact properly structured.
#
# Set in the image rather than as a flag at one call site, so it holds for every
# command the container runs, including one a later hand adds.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

# What this image cannot start without, for the deploy that has to provide it
# (kolonie-infra#42). `preflight_env()` in kolonie-infra/scripts/deploy.sh reads
# this label off the pulled image and refuses the deploy — before any container
# is recreated — if the host defines no such variable. Without it, a variable
# made mandatory here is invisible to every check that repository has, which is
# what cost twelve and a half hours on 2026-07-31.
#
# packages/db/src/required-env.ts is the source; this line is a copy, because a
# label cannot import TypeScript. required-env.test.ts fails if they disagree.
#
# This list is API_REQUIRED_ENV, not the shared REQUIRED_ENV: DEPOSIT_SEALING_KEY
# is read by this image alone, and declaring it on the three runners would stop
# their deploys over a variable they never read.
LABEL ai.kolonie.required-env="DATABASE_URL,BAN_MARK_SALT"

# The compose healthcheck calls curl; alpine ships without it.
RUN apk add --no-cache curl

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
# packages/db is here for two separate reasons, and both are load-bearing.
# `apps/api` imports it at startup (server.ts opens the pool), so without it the
# process does not survive its first line. And the deploy runs its two one-shot
# steps out of this image — `npm run migrate` and `npm run seed`, both
# `-w @kolonie-ai/db` — rather than building a third image for work that takes
# two seconds. See kolonie-infra#9.
COPY --from=build /app/packages/db/package.json ./packages/db/package.json
COPY --from=build /app/packages/db/dist ./packages/db/dist
# The SQL itself, not only the code that applies it: migrate.js resolves its
# migrations folder relative to its own location, so `dist` without `drizzle` is
# a migrator that finds nothing pending and reports success.
COPY --from=build /app/packages/db/drizzle ./packages/db/drizzle
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
# The challenge page is served from this process (D-022), and `tsc` does not
# copy it — `dist` without `public` is a route that answers 404 for every file.
COPY --from=build /app/apps/api/public ./apps/api/public
# packages/verifiers, and it is a runtime dependency now rather than a types-only
# one. `assets` alone was enough while the api imported nothing but types from
# this package — those vanish at compile time — but `kolonie.contributions.list`
# calls `httpContributionReader` (kolonie-docs#43), and an import that TypeScript
# resolves against the workspace resolves against nothing inside this image.
#
# The failure mode is not subtle and is worth naming, because it is invisible in
# CI: the build is green, the image is built and pushed, and the container exits
# on its first import. It cost one rolled-back deploy on 2026-07-31 — the
# rollback worked, which is why it cost only that.
COPY --from=build /app/packages/verifiers/package.json ./packages/verifiers/package.json
COPY --from=build /app/packages/verifiers/dist ./packages/verifiers/dist
COPY --from=build /app/packages/verifiers/assets ./packages/verifiers/assets

# Never root — see kolonie-docs/ARCHITECTURE.md, Security.
USER node

EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
