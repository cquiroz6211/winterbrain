# Deploy Winterbrain en Dokploy

Winterbrain es una imagen Docker standalone lista para correr en Dokploy como un servicio Node + MCP gateway.

## Imagen y servicio

- Build: multi-stage `node:22-alpine` con tini.
- Runtime: `node dist/server.js` hablando MCP por **stdio** (hoy).
- Puerto HTTP expuesto: `3131` (reservado para cuando se sume transporte HTTP MCP).
- Volumen persistente: `/app/brain` (Markdown + knowledge).

## Opcion 1. Dokploy con GitHub

1. En Dokploy crear un nuevo servicio tipo **Application** o **Docker**.
2. Source: `https://github.com/cquiroz6211/winterbrain` (branch `main`).
3. Build method: **Dockerfile** (no Docker Compose).
4. Port: `3131`.
5. Persistent volume: montar `/app/brain`.
6. Restart policy: `unless-stopped`.
7. Healthcheck sugerido:

   ```text
   command: node -e "process.exit(0)"
   interval: 30s
   timeout: 5s
   retries: 3
   ```

8. Variables de entorno sugeridas:

   ```text
   NODE_ENV=production
   MCP_SERVER_NAME=winterbrain
   MCP_SERVER_VERSION=0.1.0
   BRAIN_DATA_DIR=/app/brain
   ```

9. Deploy.

## Opcion 2. Dokploy con Docker Compose

Dokploy tambien puede consumir el `docker-compose.yml` de este repo. En ese caso:

```text
services:
  winterbrain:
    build: .
    ports:
      - 3131:3131
    environment:
      - NODE_ENV=production
      - BRAIN_DATA_DIR=/app/brain
    volumes:
      - winterbrain-data:/app/brain
    restart: unless-stopped

volumes:
  winterbrain-data:
```

Dokploy detecta el compose, construye la imagen y provisiona el volumen.

## Variables de entorno futuras

| Variable | Uso futuro |
| --- | --- |
| `WINTERBRAIN_URL` | URL publica del gateway para que los MCP locales conecten por HTTP. |
| `WINTERBRAIN_TOKEN` | Token por usuario / cliente. |
| `GBRAIN_API_KEY` | API key del backend de conocimiento (cuando se conecte GBrain). |
| `OPENAI_API_KEY` / `ZEROENTROPY_API_KEY` | Embeddings para busqueda semantica. |
| `ANTHROPIC_API_KEY` | LLM para extraccion estructurada de reuniones. |

## Conexion desde el cliente del usuario

El cliente del usuario (Claude Desktop, Claude Code, Codex, OpenCode) instala el MCP via `npx` y consume el gateway expuesto por Dokploy. Hoy el gateway corre stdio, asi que para uso remoto hay dos caminos:

1. **Migrar el gateway a transporte HTTP MCP** (recomendado): agregar `StreamableHTTPServerTransport` en `src/server.ts` y aceptar conexiones HTTPS autenticadas por token.
2. **Mantener stdio y tunelar** con Dokploy + Wireguard/Tailscale hasta que el gateway HTTP este listo.

## Validacion post-deploy

Desde una maquina con Docker o desde el shell de Dokploy:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0.0.1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | docker run --rm -i -v winterbrain-data:/app/brain winterbrain:local
```

Debe devolver cuatro herramientas: `save_note`, `save_chat_summary`, `ingest_meeting`, `ask_brain`.

## Backup

El unico estado que necesita backup hoy es el volumen `/app/brain`. Cron sugerido en Dokploy:

```bash
docker run --rm -v winterbrain-data:/app/brain -v $PWD:/backup alpine:3.20 \
  tar czf /backup/brain-$(date +%F).tar.gz -C /app brain
```

## Limitaciones actuales del MVP

- Transporte stdio: cada cliente MCP necesita correr un subproceso local. Para C-levels remotos conviene migrar a HTTP MCP ASAP.
- `ask_brain` hace busqueda por keyword local; cuando se conecte GBrain pasa a ser hibrida (vector + keyword + grafo).
- Sin autenticacion: el MVP asume que solo el contenedor expone el servicio.