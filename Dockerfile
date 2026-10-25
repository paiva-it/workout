# syntax=docker/dockerfile:1
FROM node:24.22.1-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN pnpm install --frozen-lockfile
COPY contracts contracts
COPY packages packages
COPY apps apps
RUN pnpm --filter @workout/contracts build && pnpm --filter @workout/api build && pnpm --filter @workout/web build \
 && pnpm --filter @workout/api deploy --prod --legacy /out

FROM node:24.22.1-bookworm-slim
ENV NODE_ENV=production PORT=3000
WORKDIR /app/apps/api
COPY --from=build --chown=root:root /out ./
COPY --from=build /app/apps/web/dist /app/apps/web/dist
COPY contracts/training-pack.schema.json /app/contracts/training-pack.schema.json
COPY data/training-pack.v1.json /app/data/training-pack.v1.json
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/v1/health/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
