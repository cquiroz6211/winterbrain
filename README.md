# Winterbrain

Company brain para una firma de venture capital y business builder. Convierte reuniones, briefs, decks y conversaciones ejecutivas en conocimiento reutilizable que cualquier C-level puede consultar desde Claude o Codex.

## Que es hoy

Un gateway MCP que guarda el conocimiento del equipo en archivos Markdown estructurados dentro de un cerebro versionable. MarkItDown ya esta integrado para que PDFs, DOCX, PPTX y XLSX se conviertan automaticamente a Markdown cuando Sergio o Mariana suben una carpeta de cliente.

## Que valor da hoy

- Una conversacion ejecutiva ya no se pierde en el chat de una persona. Cualquiera del equipo puede decir "guarda esto en el cerebro" y queda persistido.
- Una carpeta completa de un cliente (reuniones + briefs + decks) se sube en una sola frase y queda convertida a Markdown buscable.
- Las notas ejecutivas quedan con autor, cliente, fecha, tipo y tags, listas para ser consultadas despues.
- Mariana puede preguntarle a Claude "que subio Sergio sobre Cliente X" y el cerebro devuelve el Markdown correspondiente con score.

## Que valor falta (honesto)

- La busqueda es por keywords todavia. No hay embeddings.
- El gateway corre stdio MCP. Falta HTTP para que los C-levels se conecten sin instalar nada.
- La extraccion de resumen, riesgos, decisiones y aprendizajes es manual. Falta el extractor LLM.
- No hay permisos. Por ahora todos ven todo, por diseno de MVP.

## Quick start

### Para el equipo tecnico

```bash
npm install
npm run build
npm start
```

Desarrollo:

```bash
npm run dev
```

### Para el equipo ejecutivo

Los C-levels (CEO, CFO, Mariana, Sergio, Don Dario) no tocan codigo. Pegan esto en Claude o Codex:

```text
Retrieve and follow the instructions at:
https://raw.githubusercontent.com/cquiroz6211/winterbrain/main/INSTALL_FOR_USERS.md
```

El agente del usuario se autoinstala el MCP. Guia humana:

- `docs/QUICKSTART.md` — pasos en lenguaje humano, sin tecnicismos.
- `INSTALL_FOR_USERS.md` — instrucciones que sigue el agente del usuario.

## Como se usa una vez conectado

Desde Claude o Codex, hablando en espanol:

```text
Guarda esta conversacion en el cerebro como nota.
Crea esto como resumen de reunion y subelo al cerebro.
Sube la carpeta "C:\Users\...\Cliente X" al cerebro para cliente-x.
Que aprendimos del inversionista de cliente-x?
Que debemos priorizar en Cliente X segun la reunion que subio Sergio?
Preparame un brief del inversionista Y antes de la reunion.
Que funciono y que no funciono en los ultimos clientes?
```

## Herramientas MCP

| Tool | Que hace hoy | Que falta |
| --- | --- | --- |
| `save_note` | Guarda una nota ejecutiva con autor, cliente, tipo, tags | Solo Markdown plano |
| `save_chat_summary` | Guarda resumen de una conversacion con participantes y next actions | Solo Markdown plano |
| `ingest_meeting` | Guarda una reunion a partir de texto o Markdown | No extrae resumen automatico |
| `ingest_folder` | Sube una carpeta entera. PDFs/DOCX/PPTX/XLSX se convierten con MarkItDown a Markdown | No genera notas estructuradas todavia |
| `ask_brain` | Busca por keywords en el Markdown del cerebro | Embeddings y respuesta sintetizada |

## Arquitectura

```text
Claude / Codex / OpenCode
        |  stdio MCP
        v
Gateway Winterbrain (este repo)
   |- save_note / save_chat_summary / ingest_meeting / ingest_folder / ask_brain
   |- MarkItDown oficial (Python venv) para PDF/DOCX/PPTX/XLSX
        |
        v
   brain/
     raw/                <- archivos originales tal como llegaron
     markdown/           <- versiones normalizadas por MarkItDown
     knowledge/
        meetings/        <- reuniones procesadas
        chats/           <- resumenes de conversaciones
        decisions/       <- notas ejecutivas y decisiones
```

El Markdown es la fuente de verdad. Es legible, commiteable, buscable con grep y portable. Si manana agregamos un vector store o un knowledge graph, Markdown sigue siendo la base.

## Estado del proyecto

| Fase | Descripcion | Estado |
| --- | --- | --- |
| 0 | Bootstrap del repo, scaffold MCP, plantillas, docs | hecho |
| 1 | Despliegue en Dokploy via Docker | en curso |
| 2 | Gateway HTTP MCP con autenticacion por token | siguiente critico |
| 3 | MarkItDown oficial para ingesta de PDFs/DOCX/PPTX/XLSX | hecho (Fase 3 adelantada) |
| 4 | Extraccion LLM (resumen, decisiones, riesgos, aprendizajes) | pendiente |
| 5 | Backend de embeddings y busqueda semantica | pendiente |
| 6 | Validacion con preguntas reales del equipo ejecutivo | pendiente |
| 7 | Adopcion C-level (onboarding 1-a-1) | pendiente |
| 8 | Modelo de acceso y permisos | pendiente |
| 9 | Integraciones externas (Drive, Notion, Granola, Slack) | pendiente |
| 10 | Productos derivados (wiki navegable, briefs automaticos) | pendiente |

Roadmap completo con dependencias, riesgos y decisiones: `ROADMAP.md`.

## Deploy

### Dokploy

`docs/DEPLOY_DOKPLOY.md` describe el despliegue paso a paso. Resumen:

```bash
git clone https://github.com/cquiroz6211/winterbrain.git
cd winterbrain
docker compose up --build -d
```

El contenedor expone `/app/brain` como volumen persistente y tiene MarkItDown oficial dentro del venv `/opt/markitdown-venv`.

### Validacion local

```bash
docker volume create winterbrain-data
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"0.0.1"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | docker run --rm -i -v winterbrain-data:/app/brain winterbrain:local
```

Debe listar las cinco herramientas.

## Regla de acceso

En el MVP **todos pueden ver todo**. Los permisos por cliente, startup, inversionista o rol son trabajo futuro (Fase 8). Esto es una decision consciente: primero validamos que el flujo de captura y consulta genera valor; despues segmentamos.

## Estructura del repo

```text
winterbrain/
  README.md                este archivo
  ROADMAP.md               fases, dependencias, riesgos, decisiones
  INSTALL_FOR_USERS.md     instrucciones para el agente del usuario
  Dockerfile               imagen multi-stage con MarkItDown oficial
  docker-compose.yml       para Dokploy y local
  package.json             gateway TypeScript
  tsconfig.json
  src/
    server.ts              MCP server con 5 tools
    paths.ts               filesystem, ingestFolder, MarkItDown wrapper
    markdown.ts            helpers de frontmatter y Markdown
    types/markitdown.d.ts  declaraciones de tipos legacy
  docs/
    ARCHITECTURE.md
    OPERATING_MODEL.md
    INGESTION_PIPELINE.md
    MCP_TOOLS.md
    QUICKSTART.md
    DEPLOY_DOKPLOY.md
  templates/
    meeting-note.md
    chat-summary.md
    decision-record.md
  fixtures/                datos de prueba (no se commitean)
  brain/
    raw/                   insumos originales
    markdown/              versiones normalizadas
    knowledge/
      meetings/            reuniones procesadas
      chats/               resumenes de conversaciones
      decisions/           notas ejecutivas y decisiones
```

## Hacia donde vamos

1. **Corto plazo (esta semana).** Desplegar en Dokploy y cargar la primera reunion real con un cliente conocido. Validar que el ciclo completo (subir carpeta -> convertir a Markdown -> preguntar -> recibir respuesta) funciona para Sergio y Mariana.
2. **Mediano plazo (2-4 semanas).** Extraccion LLM para que cada Markdown genere notas estructuradas (resumen ejecutivo, decisiones, riesgos, aprendizajes). Backend de embeddings para busqueda semantica.
3. **Largo plazo (1-3 meses).** Gateway HTTP MCP para que cualquier C-level se conecte sin instalar nada. Permisos por cliente/rol. Integraciones con Drive, Notion, Granola. Wiki navegable del cerebro.

El roadmap completo con dependencias, riesgos y bitacora de decisiones vive en `ROADMAP.md`.