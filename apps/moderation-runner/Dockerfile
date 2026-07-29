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

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
# The loop reads and writes struggles and tips through packages/db, so this
# image needs it at run time. Like the verifier runner it does not carry
# `drizzle/`: migrations are applied once per deploy from the api image
# (kolonie-infra#9), and a third process that could migrate is a third process
# that could migrate at the wrong moment.
#
# `packages/verifiers` is absent, which is the difference from the other runner:
# this process judges text and verifies nothing.
COPY --from=build /app/packages/db/package.json ./packages/db/package.json
COPY --from=build /app/packages/db/dist ./packages/db/dist
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
