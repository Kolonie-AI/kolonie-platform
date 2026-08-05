# Build context is the repository root, not this directory.
#   docker build -f apps/support-triage-runner/Dockerfile .

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
# Every workspace's manifest has to be here before `npm ci`, including ones this
# image does not ship: `npm run build` is `tsc -b` over the root project
# references, so it builds them all and they need their dependencies installed.
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/verifiers/package.json packages/verifiers/
COPY apps/api/package.json apps/api/
COPY apps/verifier-runner/package.json apps/verifier-runner/
COPY apps/moderation-runner/package.json apps/moderation-runner/
COPY apps/support-triage-runner/package.json apps/support-triage-runner/
COPY apps/badge-runner/package.json apps/badge-runner/
RUN npm ci

COPY packages/ packages/
COPY apps/ apps/
RUN npm run build

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
# this label off the pulled image and refuses the deploy — before any container is
# recreated — if the host defines no such variable.
#
# packages/db/src/required-env.ts is the source; this line is a copy, because a
# label cannot import TypeScript. required-env.test.ts fails if they disagree, and
# that test lists this Dockerfile.
LABEL ai.kolonie.required-env="DATABASE_URL,BAN_MARK_SALT"

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
# The loop reads and writes support tickets through packages/db, so this image
# needs it at run time. Like the other two runners it does not carry `drizzle/`:
# migrations are applied once per deploy from the api image (kolonie-infra#9), and
# a fourth process that could migrate is a fourth process that could migrate at
# the wrong moment.
#
# `packages/verifiers` is absent, as in the moderation runner: this process reads
# what citizens wrote to the Colony and verifies nothing.
COPY --from=build /app/packages/db/package.json ./packages/db/package.json
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/apps/support-triage-runner/package.json ./apps/support-triage-runner/package.json
COPY --from=build /app/apps/support-triage-runner/dist ./apps/support-triage-runner/dist

USER node

# No Traefik route: this process reads Postgres and reaches out to OpenRouter and
# GitHub. Nothing on the internet needs to reach it. The port below is for the
# container runtime's healthcheck alone — it answers whether the polling loop is
# still turning, which `process.exit(0)` could never tell it (kolonie-infra#11).
#
# It also serves the queue depth beside that, and deliberately does not let a deep
# queue make the container unhealthy: a backlog is the failure this service exists
# to prevent, and restarting the container would do nothing about it.
EXPOSE 3003
CMD ["node", "apps/support-triage-runner/dist/main.js"]
