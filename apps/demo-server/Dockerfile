# Build from the repository root, so the pnpm workspace and lockfile are available:
#   docker build -f apps/demo-server/Dockerfile -t steady-socket-demo-server .
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
# Only this app's dependencies, and then a standalone copy of it without the dev dependencies.
RUN pnpm install --frozen-lockfile --filter @steady-socket/demo-server...
RUN pnpm --filter @steady-socket/demo-server --prod deploy --legacy /out

FROM node:22-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
WORKDIR /app
COPY --from=build /out .
USER node
EXPOSE 8787
# Setting ALLOWED_ORIGINS turns on public mode (see the README). `GET /state` is a health check.
CMD ["node_modules/.bin/tsx", "src/main.ts"]
