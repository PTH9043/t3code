# syntax=docker/dockerfile:1
# Official multi-platform Node 24 image, resolved on 2026-10-18.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5

FROM ${NODE_IMAGE} AS build
WORKDIR /src
ENV CI=true \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git python3 make g++ \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@11.10.0

# Dockerfile.dockerignore also keeps local state and credentials out of the
# context. Deployment settings do not invalidate the application build layers.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json vite.config.ts ./
COPY patches ./patches
COPY assets ./assets
COPY packages ./packages
COPY scripts ./scripts
COPY oxlint-plugin-t3code ./oxlint-plugin-t3code
COPY apps/server ./apps/server
COPY apps/web ./apps/web
RUN --mount=type=cache,id=newautousage-server-pnpm,target=/pnpm/store \
    pnpm --filter t3... --filter @t3tools/scripts... install --frozen-lockfile --store-dir /pnpm/store
RUN node node_modules/vite-plus/bin/vp run --filter t3 build
RUN test -s apps/server/dist/bin.mjs \
    && test -s apps/server/dist/client/index.html
# Internal workspace packages are bundled. Keep the production graph pinned to
# the existing lockfile rather than resolving it again through legacy deploy.
RUN --mount=type=cache,id=newautousage-server-pnpm,target=/pnpm/store \
    pnpm --filter t3 --prod deploy --config.injectWorkspacePackages=true /release --store-dir /pnpm/store

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOME=/home/node \
    T3CODE_HOME=/home/node/.t3 \
    T3CODE_HOST=0.0.0.0 \
    T3CODE_PORT=3773 \
    NPM_CONFIG_PREFIX=/home/node/.local \
    PATH=/home/node/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git openssh-client python3 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /workspaces /home/node/.t3 /home/node/.local \
    && chown -R node:node /workspaces /home/node
COPY --from=build --chown=node:node /release /app
COPY --chown=node:node infra/server/healthcheck.mjs /app/healthcheck.mjs
USER node
WORKDIR /workspaces
EXPOSE 3773
HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
    CMD ["node", "/app/healthcheck.mjs"]
CMD ["node", "/app/dist/bin.mjs", "serve"]
