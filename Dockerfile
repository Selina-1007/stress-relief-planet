FROM node:20-slim AS build
WORKDIR /app
# better-sqlite3 需要原生编译工具链（若预编译二进制可用，此步可省）
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# 先装依赖（利用缓存层）
COPY server/package.json server/package-lock.json /app/server/
WORKDIR /app/server
RUN npm ci --omit=dev

# 拷贝整个项目
WORKDIR /app
COPY . .

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "server.js"]