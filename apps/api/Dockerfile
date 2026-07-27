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
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist

# Never root — see kolonie-docs/ARCHITECTURE.md, Security.
USER node

EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
