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

## Fase 1 — Despliegue en Dokploy (en curso)

- [ ] Crear servicio en Dokploy apuntando al repo `cquiroz6211/winterbrain`.
- [ ] Configurar volumen persistente `/app/brain`.
- [ ] Configurar dominio HTTPS interno (ej: `brain.winterkpital.local`).
- [ ] Definir backup automatico del volumen (cron tar.gz diario).
- [ ] Smoke test en Dokploy: `tools/list` + `save_note` desde el contenedor desplegado.
- [ ] Documentar operacion (`docs/RUNBOOK.md`).

## Fase 2 — Gateway HTTP MCP (critico)

Razon: hoy el gateway habla stdio. Para que cada C-level se conecte sin instalar nada en su maquina, hay que exponerlo por HTTP con autenticacion.

- [ ] Agregar `StreamableHTTPServerTransport` al server.
- [ ] Endpoint `/health`, `/mcp`, `/admin/tokens`.
- [ ] Autenticacion por bearer token (uno por usuario / rol).
- [ ] Rate limiting basico.
- [ ] Logs estructurados (request id, user, tool, duracion).
- [ ] Actualizar `INSTALL_FOR_USERS.md` con la URL remota.
- [ ] Probar Claude Desktop remoto contra Dokploy.

## Fase 3 — Ingestion real con MarkItDown

Razon: hoy `ingest_meeting` recibe texto plano. Necesitamos aceptar archivos Office/PDF/audio.

- [ ] Servicio interno o job que invoque MarkItDown contra `/app/brain/raw`.
- [ ] Manejar PDF, DOCX, PPTX, XLSX, imagenes (OCR), audio (transcripcion).
- [ ] Versionar Markdown normalizado en `/app/brain/markdown`.
- [ ] Hash de archivo para deduplicacion.
- [ ] Manejo de errores y archivos fallidos (`brain/raw/_failed/`).

## Fase 4 — Extraccion estructurada

Razon: Markdown crudo no es conocimiento. Hay que extraer entidades, decisiones, riesgos, aprendizajes.

- [ ] Schema de negocio: `client`, `investor`, `sector`, `meeting`, `decision`, `insight`, `risk`, `playbook`.
- [ ] LLM extractor por tipo (Claude / OpenAI).
- [ ] Prompts versionados en `prompts/extract/`.
- [ ] Generacion automatica de notas estructuradas en `brain/knowledge/{meetings,decisions,insights,...}`.
- [ ] Citation linking: cada insight apunta al archivo Markdown original.

## Fase 5 — Backend de conocimiento (GBrain / embeddings)

Razon: `ask_brain` hoy hace keyword search. Necesitamos busqueda semantica + grafo.

- [ ] Decidir backend: GBrain self-hosted, vector store simple, Postgres + pgvector, o servicio externo.
- [ ] Embeddings de cada `brain/knowledge/*.md`.
- [ ] Indice por cliente, sector, inversionista, fecha.
- [ ] Reemplazar `ask_brain` por retrieval hibrido (vector + keyword + filtro).
- [ ] Respuesta sintetizada con citas y gap analysis.
- [ ] Cron de reindex incremental.

## Fase 6 — Preguntas de negocio reales

Validar que el sistema contesta las preguntas que importan:

- [ ] "Que aprendimos del sector healthtech ultimamente?"
- [ ] "Que debemos priorizar en Cliente X segun la reunion que subio Sergio?"
- [ ] "Cuales fueron las objeciones mas repetidas del Inversionista Y?"
- [ ] "Que patrones reaparecen entre clientes B2B SaaS en fase seed?"
- [ ] "Que decisiones tomamos con Cliente A y por que?"
- [ ] "Que prometimos y aun no cumplimos?"
- [ ] "Que inversionistas ya mostraron senales parecidas a esta?"

Cada pregunta debe responderse con fuentes verificables y gaps explicitos.

## Fase 7 — Adopcion y operacion

- [ ] Onboarding 1-a-1 con cada C-level (Sergio, Mariana, Don Dario, CFO).
- [ ] Demo en vivo cargando una reunion real.
- [ ] Mini-guia de frases naturales (3 paginas maximo).
- [ ] Cuestionario de adopcion a las 2 semanas.
- [ ] KPIs: reuniones ingestadas, preguntas respondidas, tiempo a primera respuesta util.

## Fase 8 — Evolucion del modelo de acceso

- [ ] Introducir scopes por usuario (read/admin) sin aun segmentar por cliente.
- [ ] Logs de auditoria: quien guardo, quien pregunto, sobre que cliente.
- [ ] Evaluacion de permisos por cliente/startup solo si el equipo lo pide.
- [ ] Politica de retencion y borrado.

## Fase 9 — Integraciones opcionales

- [ ] Sincronizacion con Google Drive / Notion / SharePoint.
- [ ] Ingestion automatica de transcripciones (Granola, Fireflies, Otter).
- [ ] Notificaciones Slack/email cuando una reunion importante entra al brain.
- [ ] Resumen semanal ejecutivo automatico.

## Fase 10 — Productos derivados

- [ ] Wiki navegable (Obsidian / sitio estatico) sobre el brain.
- [ ] Visualizacion de relaciones (cliente similar a cliente, inversionista conectado a tesis).
- [ ] Briefs automaticos pre-reunion.

---

## Decisiones / Cambios recientes

- **2026-06-26** Decidido: todos pueden ver todo en MVP (sin permisos por cliente/rol).
- **2026-06-26** Decidido: nombre del proyecto `winterbrain`. Repo `cquiroz6211/winterbrain`.
- **2026-06-26** Decidido: gateway inicial corre stdio MCP. HTTP MCP va en Fase 2.
- **2026-06-26** Descubierto: el usuario objetivo son C-levels (CEO, CFO, director de inversiones). Las herramientas MCP deben hablar lenguaje de negocio, no primitives tecnicos.

## Backlog de ideas (no priorizadas)

- Versionado de prompts de extraccion.
- Evaluaciones automaticas de calidad de respuesta.
- Multi-idioma (ingles espanol) para notas estructuradas.
- API publica para integraciones externas (CRM, etc.).
- Marca blanca si Winterkpital lo ofrece a portfolio companies.

## Riesgos conocidos

- **Adopcion C-level**: si el flujo no es una sola frase en espanol, no se usa. Mitigacion: fase 7 + smoke test real con cada uno.
- **Calidad de extraccion**: si el LLM alucina, el brain llena de basura. Mitigacion: prompts auditados, citas obligatorias, gap analysis explicito.
- **Costo de embeddings/LLM**: cada reunion cuesta. Mitigacion: solo extraer, no reembebir en cada consulta.
- **Privacidad**: hoy no hay scopes. Mitigacion: postergar hasta que el caso de uso lo pida.
- **Lock-in tecnologico**: si elegimos GBrain y luego no convence, migracion dolorosa. Mitigacion: Markdown siempre es la fuente de verdad, el backend de conocimiento es reemplazable.

## Como contribuir al roadmap

1. Abrir issue con etiqueta `roadmap`.
2. Proponer cambio con justificacion y tradeoffs.
3. Si hay disenso, discutir en review antes de mergear al `ROADMAP.md`.
4. Cualquier cambio que toque arquitectura, permisos o alcance se guarda tambien en Engram.