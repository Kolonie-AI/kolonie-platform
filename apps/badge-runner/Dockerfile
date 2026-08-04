# Build context is the repository root, not this directory.
#   docker build -f apps/badge-runner/Dockerfile .

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
# The sweep runs entirely inside packages/db, so this image needs it at run time.
# Like the other three runners it does not carry `drizzle/`: migrations are
# applied once per deploy from the api image (kolonie-infra#9), and a fifth
# process that could migrate is a fifth process that could migrate at the wrong
# moment.
#
# `packages/verifiers` is absent: this process gives out things that are worth
# nothing and verifies nothing at all.
COPY --from=build /app/packages/db/package.json ./packages/db/package.json
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/apps/badge-runner/package.json ./apps/badge-runner/package.json
COPY --from=build /app/apps/badge-runner/dist ./apps/badge-runner/dist

USER node

# No Traefik route, and no outbound calls either: this process reads and writes
# Postgres and speaks to nothing else. The port below is for the container
# runtime's healthcheck alone — it answers whether the polling loop is still
# turning, which `process.exit(0)` could never tell it (kolonie-infra#11).
#
# There is no queue report beside it, because this loop has no backlog: it sweeps
# every criterion every pass, so *how far behind* is not a question it can be
# asked.
EXPOSE 3004
CMD ["node", "apps/badge-runner/dist/main.js"]
