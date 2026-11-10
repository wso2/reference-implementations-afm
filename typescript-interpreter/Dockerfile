FROM node:24-alpine AS build

RUN npm install --global pnpm@11.9.0

ENV CI=true
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json build.mjs ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm run build

FROM node:24-alpine

COPY --from=build /app/dist/main.js /app/main.js

RUN npm install --global npm@12.2.2

USER node
EXPOSE 8085
WORKDIR /agent
ENTRYPOINT ["node", "/app/main.js"]
