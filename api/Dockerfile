# 1. 安装 Prisma 和 HTTPS 请求需要的系统运行库。
FROM node:20-bookworm-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

# 2. 安装完整依赖，用于编译应用。
FROM base AS dependencies

WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci

# 3. 生成 Prisma Client 并编译 Nest 应用。
FROM dependencies AS build

COPY prisma ./prisma
COPY nest-cli.json tsconfig.json ./
COPY src ./src

RUN npm run prisma:generate && npm run build

# 4. 只安装生产依赖，减小最终 API 镜像体积。
FROM base AS production-dependencies

WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 5. 组装最终运行镜像。
FROM base AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8000

COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY .agents ./.agents
COPY package.json ./

EXPOSE 8000

CMD ["sh", "-c", "npx prisma migrate deploy && exec node dist/main.js"]
