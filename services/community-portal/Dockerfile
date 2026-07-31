FROM ghcr.io/thelounge/thelounge:4.5.2@sha256:ec3e798d7d9243e49f4f268a4d83c03606fb7e8ace07191e8d1260faceb68d13

USER root
WORKDIR /app

COPY server.js /app/server.js
COPY public /app/public
COPY agent-kit /app/agent-kit
COPY tests /app/tests

RUN node /app/tests/test-public-app.js \
    && node /app/tests/test-agent-installers.js \
    && node /app/tests/test-agent-app.js \
    && node /app/tests/test-invite-retry.js \
    && chown -R node:node /app

USER node
ENTRYPOINT ["node", "--no-warnings", "/app/server.js"]
