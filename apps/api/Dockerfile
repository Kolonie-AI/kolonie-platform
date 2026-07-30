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
COPY --from=build /app/packages/verifiers/assets ./packages/verifiers/assets

# Never root — see kolonie-docs/ARCHITECTURE.md, Security.
USER node

EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
