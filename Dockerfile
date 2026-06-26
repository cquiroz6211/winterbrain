# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS builder
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PYTHONUNBUFFERED=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       python3 python3-pip python3-venv \
       tini \
  && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/markitdown-venv \
  && /opt/markitdown-venv/bin/pip install --no-cache-dir 'markitdown[pdf,docx,pptx,xlsx]' \
  && ln -s /opt/markitdown-venv/bin/markitdown /usr/local/bin/markitdown

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/brain/raw /app/brain/markdown /app/brain/knowledge/meetings /app/brain/knowledge/chats /app/brain/knowledge/decisions

VOLUME ["/app/brain"]
EXPOSE 3131

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server.js"]