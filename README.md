# Cerebro de compañía

Este repositorio es el punto de partida del **cerebro compartido** para una firma de venture capital / business builder. Su objetivo es convertir reuniones, conversaciones, decisiones y aprendizajes de clientes/startups en conocimiento reutilizable por el equipo ejecutivo.

## Flujo MVP

1. Una persona sube o guarda una reunión, chat o nota desde Claude/Codex usando un MCP.
2. El gateway MCP normaliza el contenido a Markdown.
3. Una capa de extracción estructura aprendizajes, decisiones, riesgos, prioridades y próximos pasos.
4. El backend de conocimiento guarda y recupera esa información para preguntas de negocio.

En este scaffold, el MCP todavía escribe archivos Markdown locales bajo `brain/`. Más adelante se conectará a MarkItDown y GBrain.

## Quick start

```bash
npm install
npm run build
npm start
```

Para desarrollo:

```bash
npm run dev
```

## Cómo lo usaría el equipo

Los usuarios no deberían pensar en carpetas ni bases de datos. Desde Claude o Codex, el flujo esperado es conversacional:

- “Guarda todo en el cerebro.”
- “Crea esto como nota y súbelo al cerebro.”
- “Qué debemos priorizar en Cliente X en base a la reunión que subió Sergio?”
- “Resumí los aprendizajes recientes sobre startups de healthtech.”

### Instalación rápida para usuarios no técnicos

El CEO, el CFO o cualquier director no necesitan instalar Node, ni clonar el repo, ni tocar archivos de configuración a mano. La guía completa está en:

- `docs/QUICKSTART.md` — pasos en lenguaje humano.
- `INSTALL_FOR_USERS.md` — instrucciones que el propio agente del usuario sigue para dejar todo conectado.

## Herramientas MCP iniciales

El servidor registra cuatro herramientas placeholder:

| Tool | Para qué sirve hoy |
| --- | --- |
| `save_note` | Guarda una nota de negocio en Markdown. |
| `save_chat_summary` | Guarda un resumen de chat o conversación. |
| `ingest_meeting` | Guarda una reunión/transcripción ya convertida a Markdown. |
| `ask_brain` | Busca respuestas simples leyendo Markdown local en `brain/knowledge`. |

## Regla de acceso MVP

En el MVP, **todos pueden ver todo**. No se implementan permisos por cliente, startup o persona todavía. Eso evita diseñar de más antes de probar si el flujo de captura y recuperación realmente genera valor.

Los permisos por cliente, rol o sensibilidad quedan como trabajo futuro.

## Estructura principal

```text
brain/
  raw/                 # Insumos originales o referencias a archivos fuente
  markdown/            # Contenido normalizado a Markdown
  knowledge/
    meetings/          # Reuniones procesadas
    chats/             # Resúmenes de conversaciones
    decisions/         # Decisiones y notas ejecutivas
docs/                  # Arquitectura y modelo operativo
templates/             # Plantillas de conocimiento en Markdown
src/                   # Gateway MCP TypeScript
```

## Próximo foco

El próximo paso no es construir un sistema enorme. Es probar el ciclo completo con pocos documentos reales:

1. subir una reunión,
2. convertirla a Markdown,
3. extraer conocimiento útil,
4. preguntar prioridades por cliente/startup,
5. ajustar el formato hasta que el equipo lo use sin fricción.
