# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY *.mjs package.json ./
RUN node --test job.test.mjs
ARG BOT_VERSION=0.1.0
ARG BOT_VARIANT=complete
RUN BOT_VERSION=${BOT_VERSION} BOT_VARIANT=${BOT_VARIANT} node build.mjs

FROM ${NODE_IMAGE}
ARG BOT_VERSION=0.1.0
ARG BOT_VARIANT=complete
LABEL org.newautousage.lab.contract="probe-bot-v1" \
      org.newautousage.lab.version=${BOT_VERSION} \
      org.newautousage.lab.variant=${BOT_VARIANT}
ENV NODE_ENV=production BOT_DATA_DIR=/data
COPY --from=build --chown=node:node /src/build /app
RUN mkdir -p /data && chown node:node /data
USER 1000:1000
WORKDIR /app
EXPOSE 8080
HEALTHCHECK --interval=2s --timeout=2s --start-period=5s --retries=2 \
    CMD ["node", "/app/healthcheck.mjs"]
CMD ["node", "/app/supervisor.mjs"]
