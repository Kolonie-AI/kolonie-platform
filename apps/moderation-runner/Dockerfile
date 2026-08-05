# Build context is the repository root, not this directory.
#   docker build -f apps/moderation-runner/Dockerfile .

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
# Every workspace's manifest has to be here before `npm ci`, including ones
# this image does not ship: `npm run build` is `tsc -b` over the root project
# references, so it builds them all and they need their dependencies installed.
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/verifiers/package.json packages/verifiers/
COPY apps/api/package.json apps/api/
COPY apps/verifier-runner/package.json apps/verifier-runner/
COPY apps/moderation-runner/package.json apps/moderation-runner/
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
# this label off the pulled image and refuses the deploy — before any container
# is recreated — if the host defines no such variable. Without it, a variable
# made mandatory here is invisible to every check that repository has, which is
# what cost twelve and a half hours on 2026-07-31.
#
# packages/db/src/required-env.ts is the source; this line is a copy, because a
# label cannot import TypeScript. required-env.test.ts fails if they disagree.
LABEL ai.kolonie.required-env="DATABASE_URL,BAN_MARK_SALT"

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
# The loop reads and writes struggles and tips through packages/db, so this
# image needs it at run time. Like the verifier runner it does not carry
# `drizzle/`: migrations are applied once per deploy from the api image
# (kolonie-infra#9), and a third process that could migrate is a third process
# that could migrate at the wrong moment.
COPY --from=build /app/packages/db/package.json ./packages/db/package.json
COPY --from=build /app/packages/db/dist ./packages/db/dist
# **`packages/verifiers` is here, and this comment used to say it was absent** —
# *"which is the difference from the other runner: this process judges text and
# verifies nothing"*. True until `#140` imported `openRouterDirectionClassifier`
# from it to sort what a citizen wants to become.
#
# **This one had not failed yet, which is the part worth knowing.** The build
# serving production still predates that import, so the image was correct and the
# next deploy of this service would have been the outage — the same one the badge
# runner was already in. Found by `scripts/check-image-workspaces.test.ts`, which
# was written for the badge runner and caught this on its first run.
COPY --from=build /app/packages/verifiers/package.json ./packages/verifiers/package.json
COPY --from=build /app/packages/verifiers/dist ./packages/verifiers/dist
COPY --from=build /app/apps/moderation-runner/package.json ./apps/moderation-runner/package.json
COPY --from=build /app/apps/moderation-runner/dist ./apps/moderation-runner/dist

USER node

# No Traefik route: this process reaches out to OpenRouter and to Postgres, and
# nothing on the internet needs to reach it. The port below is for the container
# runtime's healthcheck alone — it answers whether the polling loop is still
# turning, which is the one thing `process.exit(0)` could never tell it. A
# stalled moderator publishes nothing, and a Colony that publishes nothing looks
# exactly like one where nobody has written anything.
EXPOSE 3002
CMD ["node", "apps/moderation-runner/dist/main.js"]
