# Build context is the repository root, not this directory.
#   docker build -f apps/verifier-runner/Dockerfile .

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
COPY --from=build /app/packages/verifiers/package.json ./packages/verifiers/package.json
COPY --from=build /app/packages/verifiers/dist ./packages/verifiers/dist
COPY --from=build /app/apps/verifier-runner/package.json ./apps/verifier-runner/package.json
COPY --from=build /app/apps/verifier-runner/dist ./apps/verifier-runner/dist

USER node

# No EXPOSE and no Traefik route: this process reaches out to third-party APIs
# and to Postgres. Nothing on the internet needs to reach it.
CMD ["node", "apps/verifier-runner/dist/main.js"]
