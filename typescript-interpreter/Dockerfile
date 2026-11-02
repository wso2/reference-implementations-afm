FROM node:24-bookworm-slim AS deps

RUN npm install --global pnpm@11.9.0

ENV CI=true

RUN mkdir /app && chown node:node /app
USER node
WORKDIR /app

COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

FROM deps AS dev

COPY --chown=node:node . .
RUN pnpm install --frozen-lockfile --offline

CMD ["pnpm", "run", "check"]

FROM dev AS check

RUN --network=none pnpm run typecheck
RUN --network=none pnpm test
