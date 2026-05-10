# syntax=docker/dockerfile:1.6
#
# Unified Dockerfile for all Nova services.
#
# Build args (set via docker-compose.yml or `docker build --build-arg`):
#   SERVICE         workspace name under packages/, e.g. "a2a-server"
#   NPM_WORKSPACES  space-separated --workspace=... flags for npm ci/prune
#                   (must include shared workspace deps)
#   ENTRY           path within the package to the entrypoint JS,
#                   defaults to dist/index.js (gate-service uses dist/server.js)
#   PORT            port the service listens on (used for EXPOSE only)

ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS builder
ARG SERVICE
ARG NPM_WORKSPACES
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci ${NPM_WORKSPACES}
RUN npx tsc --build packages/${SERVICE}
RUN npm prune --omit=dev ${NPM_WORKSPACES}

FROM ${NODE_IMAGE}
ARG SERVICE
ARG ENTRY=dist/index.js
ARG PORT=3000
ENV NODE_ENV=production
ENV NOVA_ENTRY=packages/${SERVICE}/${ENTRY}
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages ./packages
EXPOSE ${PORT}
CMD ["sh", "-c", "exec node \"$NOVA_ENTRY\""]
