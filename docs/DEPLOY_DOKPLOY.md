# Deploy Winterbrain en Dokploy

Winterbrain es una imagen Docker standalone lista para correr en Dokploy como un servicio Node + MCP gateway.

## Imagen y servicio

- Build: multi-stage `node:22-bookworm-slim` con tini + Python + MarkItDown oficial.
- Runtime: `node dist/server.js` hablando MCP por **HTTP con autenticacion Bearer** (default) o **stdio** (debug).
- Puerto HTTP expuesto: `3131`.
- Volumen persistente: `/app/brain` (Markdown + knowledge).

## Variables de entorno para Dokploy

```bash
MCP_TRANSPORT=http
PORT=3131
WINTERBRAIN_PUBLIC_URL=https://brain.winterkpital.com
WINTERBRAIN_TOKENS=serge_token_sergio:sergio|tools|2592000,marina_token_mariana:marina|tools|2592000,ceo_token_dario:dario|tools|31536000
# Produccion recomendada: usar Postgres en lugar de WINTERBRAIN_TOKENS.
# WINTERBRAIN_DB_URL=postgres://postgres:password@postgres:5432/winterbrain
# WINTERBRAIN_ADMIN_TOKEN=<token-admin-largo-y-aleatorio>
# WINTERBRAIN_ADMIN_COOKIE_SECRET=<secret-largo-para-cookie-admin>
# WINTERBRAIN_INSTALL_LINK_SECRET=<secret-largo-para-links-de-instalacion-24h>
```

Los tokens se emiten uno por usuario (CEO, CFO, Mariana, Sergio, etc.) y van como `Authorization: Bearer <token>` desde el cliente MCP.

Si `WINTERBRAIN_DB_URL` esta configurado, Winterbrain usa la tabla `winterbrain_tokens` en Postgres y migra el schema al arrancar. Si `WINTERBRAIN_DB_URL` esta vacio, mantiene compatibilidad con `WINTERBRAIN_TOKENS`.

## Generar tokens seguros

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Ejemplo de token: `a4f9...e2c1`. Se guarda como `token:userId|scope|ttlSeconds` dentro de `WINTERBRAIN_TOKENS`.

## Administrar tokens con Postgres

1. Configurar `WINTERBRAIN_DB_URL`, `WINTERBRAIN_ADMIN_TOKEN` y `WINTERBRAIN_ADMIN_COOKIE_SECRET` en Dokploy.
   Configurar tambien `WINTERBRAIN_INSTALL_LINK_SECRET` si se quiere copiar links de instalacion desde la lista de tokens.
2. Abrir `https://brain.winterkpital.com/admin`.
3. Pegar el admin token. El servidor crea una cookie `winterbrain_admin` httpOnly, SameSite=Lax y Secure fuera de localhost. La lista de tokens se renderiza del lado servidor, sin depender de JavaScript.
4. Emitir un token por usuario con `user_id`, `ttl_seconds` y una etiqueta opcional.
5. Copiar el mensaje de instalacion o el token plano inmediatamente desde el aviso amarillo. El token se muestra una sola vez via cookie flash httpOnly y en la base queda su hash SHA-256; si `WINTERBRAIN_INSTALL_LINK_SECRET` esta configurado, se guarda ademas un JWT de instalacion por 24 horas para poder copiar el link desde la tabla.
6. Para rotar, usar el boton `Rotate`. El token viejo queda valido 24 horas para no cortar sesiones activas.
7. Para invalidar ya, usar `Revoke`.

API equivalente:

```bash
curl -H "Authorization: Bearer $WINTERBRAIN_ADMIN_TOKEN" \
  https://brain.winterkpital.com/admin/api/health

curl -X POST -H "Authorization: Bearer $WINTERBRAIN_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"sergio","ttl_seconds":2592000,"label":"Sergio laptop"}' \
  https://brain.winterkpital.com/admin/api/tokens
```

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
   WINTERBRAIN_DB_URL=postgres://postgres:<password>@<postgres-host>:5432/winterbrain
   WINTERBRAIN_ADMIN_TOKEN=<token-admin-largo-y-aleatorio>
   WINTERBRAIN_ADMIN_COOKIE_SECRET=<secret-largo-para-cookie-admin>
   WINTERBRAIN_INSTALL_LINK_SECRET=<secret-largo-para-links-de-instalacion-24h>
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

Debe devolver seis herramientas: `whoami`, `save_note`, `save_chat_summary`, `ingest_meeting`, `ingest_folder`, `ask_brain`.

## Backup

El unico estado que necesita backup hoy es el volumen `/app/brain`. Cron sugerido en Dokploy:

```bash
docker run --rm -v winterbrain-data:/app/brain -v $PWD:/backup alpine:3.20 \
  tar czf /backup/brain-$(date +%F).tar.gz -C /app brain
```

## Limitaciones actuales del MVP

- En modo sin `WINTERBRAIN_DB_URL`, la rotacion de tokens sigue siendo manual por variable de entorno.
- `ask_brain` hace busqueda por keyword local; cuando se conecte GBrain pasa a ser hibrida (vector + keyword + grafo).
- Sin scopes por rol: el MVP asume que todo usuario autenticado puede usar las tools disponibles.
