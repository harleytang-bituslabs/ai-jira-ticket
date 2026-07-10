# ─── Stage 1: 前端构建（vite 与全部 devDeps 只活在这一层）────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web ./web
RUN npm run build:web

# ─── Stage 2: 运行时（仅生产依赖；tsx 直跑 TS 源码，无编译产物需要维护）──────
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY config.json ./
COPY --from=build /app/web/dist ./web/dist

# .cache（规范/看板/名册缓存）与 data/（fs 模式用户表）运行时生成；
# 非 root 运行需要这两个目录可写
RUN mkdir -p .cache data drafts && chown -R node:node /app
USER node

# 容器内必须绑 0.0.0.0；对外暴露与 HTTPS 由 ALB/反代负责
ENV AJT_HOST=0.0.0.0 AJT_PORT=9300
EXPOSE 9300
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:9300/healthz || exit 1

CMD ["./node_modules/.bin/tsx", "src/server/index.ts"]
