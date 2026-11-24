FROM node:24.15.0-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates tar \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global --ignore-scripts pnpm@11.19.0

RUN mkdir -p /home/test && chown 10001:10001 /home/test

WORKDIR /workspace
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN --network=none pnpm run build \
    && rm -rf node_modules \
    && printf '%s\n' '{"schemaVersion":1,"studyId":"loop-mechanism-ci","dedicatedVm":true,"noHostMounts":true,"networkRestricted":true}' > /etc/praxis-loop-test-sandbox.json \
    && chmod 0444 /etc/praxis-loop-test-sandbox.json

ENV HOME=/home/test
ENV PRAXIS_LOOP_EVIDENCE_DIR=/tmp/evidence
USER 10001:10001
CMD ["sh", "scripts/linux-container-evaluation.sh"]
