# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache tini

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/brain/raw /app/brain/markdown /app/brain/knowledge/meetings /app/brain/knowledge/chats /app/brain/knowledge/decisions

VOLUME ["/app/brain"]
EXPOSE 3131

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]