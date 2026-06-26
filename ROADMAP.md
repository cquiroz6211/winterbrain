# Winterbrain Roadmap

Este roadmap es vivo. Se actualiza cada vez que avanzamos, retrocedemos o cambiamos de opinion.
Cada item lleva estado, owner sugerido y fecha de ultima actualizacion.

## Como se actualiza

1. Cambia el estado de un item cuando aplique (mover el `- [ ]` a `- [x]` o mover a "Hecho").
2. Agrega nuevos descubrimientos a la columna "Decisiones / Cambios recientes".
3. Si una fase cambia de prioridad, moverla de bloque.
4. Toda actualizacion importante tambien va a Engram como decision o discovery.

Leyenda de estados:

- `[ ]` pendiente
- `[~]` en curso
- `[x]` hecho
- `[!]` bloqueado o re-priorizado

---

## Fase 0 — Bootstrap (hecho)

- [x] Inicializar repo `winterbrain` en GitHub.
- [x] Scaffold TypeScript con `@modelcontextprotocol/sdk` y Zod.
- [x] Herramientas MVP: `save_note`, `save_chat_summary`, `ingest_meeting`, `ask_brain`.
- [x] Estructura `brain/{raw,markdown,knowledge}`.
- [x] Templates: `meeting-note`, `chat-summary`, `decision-record`.
- [x] `docs/QUICKSTART.md` y `INSTALL_FOR_USERS.md` para adopcion C-level.
- [x] `Dockerfile` multi-stage + `docker-compose.yml` + `.dockerignore`.
- [x] Validacion local: build, initialize, tools/list, save_note, ask_brain, volumen persistente.
- [x] Push inicial al remoto.

## Fase 1 — Despliegue en Dokploy

Razon: convertir el codigo en un servicio vivo accesible para todos los usuarios internos.

- [ ] Crear servicio en Dokploy apuntando al repo `cquiroz6211/winterbrain`.
- [ ] Configurar volumen persistente `/app/brain`.
- [ ] Configurar HTTPS interno (ej: `brain.winterkpital.local` con Caddy/Traefik de Dokploy).
- [ ] Definir backup automatico del volumen (cron tar.gz diario).
- [ ] Configurar env vars: `MCP_TRANSPORT=http`, `PORT=3131`, `WINTERBRAIN_PUBLIC_URL`, `WINTERBRAIN_TOKENS`.
- [ ] Emitir un token por usuario C-level (Sergio, Mariana, Don Dario, CFO).
- [ ] Smoke test desde Dokploy con `tools/list` + `save_note` + `whoami`.
- [ ] Documentar operacion (`docs/RUNBOOK.md`).

## Fase 2 — Gateway HTTP MCP con autenticacion Bearer (hecho)

Razon: hoy el gateway hablaba stdio. Cada C-level necesitaba correr un subproceso local. Con HTTP MCP + tokens, Mariana, Sergio y Don Dario se conectan desde su laptop sin instalar nada.

- [x] Refactor: `src/gateway.ts` arma el `McpServer` con las tools; `src/server.ts` despacha segun `MCP_TRANSPORT`.
- [x] `StreamableHTTPServerTransport` con session management via UUID.
- [x] Bearer auth via `requireBearerAuth` del SDK oficial.
- [x] Token store simple desde `WINTERBRAIN_TOKENS` con formato `token:userId|scope|ttlSeconds`.
- [x] Identidad propagada a los tools via `extra.authInfo.extra.userId` (autor del Markdown se autocompleta).
- [x] Tool `whoami` para verificar la identidad en cada sesion.
- [x] Endpoints `/health` (healthcheck Dokploy), `/.well-known/oauth-protected-resource` (OAuth metadata).
- [x] 401 limpio con `WWW-Authenticate` para tokens invalidos.
- [x] Validacion end-to-end con cliente MCP real: 3 tokens distintos (sergio, marina, dario), author correcto en cada nota.
- [x] Dockerfile ahora arranca en HTTP mode por default (`MCP_TRANSPORT=http`).
- [x] `INSTALL_FOR_USERS.md` actualizado con bloques HTTP para Claude Desktop, Claude Code, Codex CLI, OpenCode.
- [ ] Rate limiting basico (pendiente).
- [ ] Logs estructurados con request id / user / tool / duracion (pendiente).
- [ ] Smoke test contra Dokploy real (post-despliegue).

## Fase 3 — Ingestion real con MarkItDown (hecho, adelantado)

Razon: `ingest_meeting` recibia texto plano. Necesitamos que Sergio suba una carpeta entera con PDFs/DOCX/PPTX y se conviertan solos a Markdown.

- [x] `ingest_folder` tool: recorre carpeta, copia originales a `brain/raw/`, convierte binarios con MarkItDown, versiona Markdown, genera manifest.
- [x] Imagen del contenedor incluye Python venv + `markitdown[pdf,docx,pptx,xlsx]` oficial de Microsoft (no wrapper de Node).
- [x] Shell-out a `markitdown` desde el gateway TypeScript via `child_process.execFile`.
- [x] Markdown resultante con frontmatter (source_file, original_format, client, uploaded_by, ingested_at, converter).
- [x] Hash de archivo para deduplicacion (pendiente - bajo impacto para MVP).
- [x] Manejo de errores: conversion_errors reportados en manifest (no rompen el flujo).
- [ ] Soporte para imagenes (OCR) y audio (transcripcion). Hoy `[all]` no esta instalado para minimizar tamano; agregar `[audio-transcription]` cuando haya caso real.
- [ ] Carpeta `brain/raw/_failed/` para cuarentena manual.

## Fase 4 — Extraccion estructurada con LLM (proximo critico)

Razon: hoy una reunion queda como Markdown crudo. Para que Mariana pregunte "que aprendimos del sector X" y reciba respuesta util, el Markdown tiene que descomponerse en entidades, decisiones, riesgos y aprendizajes.

- [ ] Schema de negocio canonico: `client`, `investor`, `sector`, `meeting`, `decision`, `insight`, `risk`, `opportunity`, `playbook`.
- [ ] Prompts versionados en `prompts/extract/{meeting,note,chat}.md`.
- [ ] Job nocturno o por webhook: cada Markdown nuevo en `brain/markdown/` se procesa y emite notas estructuradas en `brain/knowledge/{meetings,decisions,insights,...}`.
- [ ] Cada insight lleva cita al archivo Markdown original (path + offset + snippet).
- [ ] Extraccion inicial con Claude Haiku 4.5 o equivalente (costo bajo, latencia baja).
- [ ] Re-extraccion idempotente: si el Markdown no cambio, no se reprocesa.
- [ ] Validacion humana: el `uploader` puede corregir el insight extraido via MCP `correct_extraction`.

## Fase 5 — Backend de embeddings y busqueda semantica

Razon: `ask_brain` hoy hace keyword search. Sin embeddings las preguntas ejecutivas no escalan y solo matchean texto literal.

- [ ] Decidir backend: GBrain self-hosted, vector store simple (Qdrant), Postgres + pgvector, o servicio externo.
- [ ] Embeddings de cada archivo en `brain/knowledge/` (OpenAI / Voyage / ZeroEntropy).
- [ ] Indice secundario por metadatos: cliente, sector, inversionista, fecha, autor.
- [ ] Reemplazar `ask_brain` por retrieval hibrido: vector similarity + keyword score + filtros por metadatos.
- [ ] Respuesta sintetizada por LLM con citas inline y gap analysis ("no tenemos datos sobre X todavia").
- [ ] Cron incremental de reindex (no re-embebir todo cada vez).
- [ ] Endpoint `GET /search?q=...&client=...&sector=...` para integraciones externas.

## Fase 6 — Smoke test con reuniones reales

Razon: con HTTP MCP + MarkItDown ya funcionando, validar que el flujo completo sirve para preguntas ejecutivas reales antes de invertir en embeddings.

- [ ] Elegir 5 reuniones reales de clientes diferentes (1 por sector).
- [ ] Sergio sube las carpetas a Winterbrain via HTTP MCP.
- [ ] Mariana pregunta 7 preguntas ejecutivas (ver lista abajo).
- [ ] Medir: cuantas se responden bien con keyword search, cuales necesitan embeddings/LLM.
- [ ] Ajustar templates y nombres de archivo segun friction real.
- [ ] Documentar gaps concretos que justifican inversion en Fase 4 y 5.

Preguntas de validacion:

- "Que aprendimos del sector healthtech ultimamente?"
- "Que debemos priorizar en Cliente X segun la reunion que subio Sergio?"
- "Cuales fueron las objeciones mas repetidas del Inversionista Y?"
- "Que patrones reaparecen entre clientes B2B SaaS en fase seed?"
- "Que decisiones tomamos con Cliente A y por que?"
- "Que prometimos y aun no cumplimos?"
- "Que inversionistas ya mostraron senales parecidas a esta?"

## Fase 7 — Adopcion C-level

- [ ] Onboarding 1-a-1 con cada C-level (Sergio, Mariana, Don Dario, CFO).
- [ ] Demo en vivo cargando una reunion real desde Claude/Codex.
- [ ] Mini-guia de frases naturales (1 pagina, no mas).
- [ ] Cuestionario de adopcion a las 2 semanas.
- [ ] KPIs: reuniones ingestadas/semana, preguntas respondidas/semana, tiempo a primera respuesta util.
- [ ] Costo por usuario (LLM + embeddings) bajo control.

## Fase 8 — Evolucion del modelo de acceso

- [ ] Introducir scopes por usuario (`read`, `write`, `admin`) sin segmentar por cliente.
- [ ] Audit log centralizado: tabla `audit_log` con `who, action, target, when` (hoy vive solo en el frontmatter del Markdown).
- [ ] Rotacion automatica de tokens (job mensual).
- [ ] Rate limiting por usuario (60 req/min default).
- [ ] Evaluacion de permisos por cliente/startup solo si el equipo lo pide.
- [ ] Politica de retencion y borrado.

## Fase 9 — Integraciones

- [ ] Sincronizacion con Google Drive / Notion / SharePoint (watcher sobre una carpeta designada).
- [ ] Ingestion automatica de transcripciones (Granola, Fireflies, Otter, Read.ai).
- [ ] Notificaciones Slack/email cuando una reunion importante entra al brain.
- [ ] Resumen semanal ejecutivo automatico (cron lunes 9am).
- [ ] Webhook entrante para que otras herramientas empujen notas.

## Fase 10 — Productos derivados

- [ ] Wiki navegable (sitio estatico Astro/Next) sobre `brain/knowledge/`.
- [ ] Visualizacion de relaciones (cliente similar a cliente, inversionista conectado a tesis).
- [ ] Briefs automaticos pre-reunion: dado un cliente/inversionista, generar PDF/Markdown con todo lo relevante.
- [ ] API publica para integraciones externas (CRM, etc.) - con rate limiting y tokens separados.

---

## Decisiones / Cambios recientes

- **2026-06-26** Decidido: gateway opera en HTTP mode por default en produccion (`MCP_TRANSPORT=http`). Stdio queda solo para debug local.
- **2026-06-26** Decidido: tokens de usuario se almacenan en variable de entorno (`WINTERBRAIN_TOKENS`), no en archivo. Formato canonico: `token:userId|scope|ttlSeconds`.
- **2026-06-26** Decidido: imagen Docker usa `node:22-bookworm-slim` (no alpine) para incluir MarkItDown oficial via Python venv.
- **2026-06-26** Decidido: la identidad del usuario se autocompleta como `author` / `uploaded_by` en cada Markdown persistido. Esto resuelve "quien subio que" sin pedirlo explicitamente.
- **2026-06-26** Adelantada Fase 3 (MarkItDown) dentro de Fase 2: se integro oficial Microsoft en lugar del wrapper de Node para evitar binarios faltantes.
- **2026-06-26** Decidido: todos pueden ver todo en MVP (sin permisos por cliente/rol). Permisos son Fase 8.
- **2026-06-26** Decidido: nombre del proyecto `winterbrain`. Repo `cquiroz6211/winterbrain`.
- **2026-06-26** Descubierto: el usuario objetivo son C-levels (CEO, CFO, director de inversiones). Las herramientas MCP deben hablar lenguaje de negocio, no primitives tecnicos.

## Backlog de ideas (no priorizadas)

- Versionado de prompts de extraccion con eval set.
- Evaluaciones automaticas de calidad de respuesta (precision@5 sobre preguntas de prueba).
- Multi-idioma (ingles espanol) para notas estructuradas segun audiencia.
- Marca blanca si Winterkpital lo ofrece a portfolio companies.
- Fine-grained ACL por cliente/inversionista.
- Encriptacion at-rest del volumen `/app/brain` para datos sensibles.
- Single-sign-on corporativo (Google Workspace, Okta).

## Riesgos conocidos

- **Adopcion C-level**: si el flujo no es una sola frase en espanol, no se usa. Mitigacion: Fase 7 + smoke test real con cada uno.
- **Calidad de extraccion LLM**: si el LLM alucina, el brain se llena de basura. Mitigacion: prompts auditados, citas obligatorias, gap analysis explicito, validacion humana via MCP.
- **Costo de embeddings/LLM**: cada reunion cuesta. Mitigacion: solo extraer una vez (no en cada consulta), usar modelos baratos para extraccion, embeddings incrementales.
- **Privacidad**: hoy no hay scopes. Mitigacion: postergar hasta que el caso de uso lo pida (Fase 8).
- **Lock-in de backend de conocimiento**: si elegimos un vector store y luego no convence, migracion dolorosa. Mitigacion: Markdown siempre es la fuente de verdad, el backend de embeddings es reemplazable.
- **Tokens en plaintext en env vars**: rotacion manual hoy. Mitigacion: job de rotacion en Fase 8 + Vault/SSM a futuro.
- **Volumen `brain/` sin encriptar**: si el server se compromete, se filtran reuniones. Mitigacion: encriptacion at-rest cuando se justifique (portfolio companies con datos sensibles).

## Como contribuir al roadmap

1. Abrir issue con etiqueta `roadmap`.
2. Proponer cambio con justificacion y tradeoffs.
3. Si hay disenso, discutir en review antes de mergear al `ROADMAP.md`.
4. Cualquier cambio que toque arquitectura, permisos o alcance se guarda tambien en Engram.