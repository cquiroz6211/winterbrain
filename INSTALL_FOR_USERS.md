# Winterbrain Install for Users

Esta guia es la que tu agente (Claude Code, Codex, OpenCode, etc.) debe seguir para dejar Winterbrain funcionando en la maquina de un usuario ejecutivo (CEO, CFO, Director, etc.).

## Goal

Dejar el MCP `winterbrain` conectado en el cliente del usuario, apuntando al cerebro compartido de la empresa. Sin requerir que el usuario instale Node, clone repos ni edite JSON a mano.

## Prerequisites

Solo uno:

- El cliente del usuario (Claude Desktop, Claude Code, Codex CLI, OpenCode u otro MCP-compatible) ya esta instalado y abierto.
- El usuario conoce la URL del cerebro compartido (por ejemplo: `https://brain.winterkpital.com/mcp`).

No instales Node, ni clones el repo en la maquina del usuario todavia. Eso es responsabilidad del servidor compartido.

## Step 1. Decide el camino segun el cliente

Winterbrain expone un servidor MCP HTTP con autenticacion Bearer. Cada usuario tiene su propio token emitido por el administrador.

### Path A. Claude Desktop (HTTP remoto)

Editar `claude_desktop_config.json`:

- Mac: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```jsonc
{
  "mcpServers": {
    "winterbrain": {
      "url": "https://brain.winterkpital.com/mcp",
      "headers": {
        "Authorization": "Bearer <token del usuario>"
      }
    }
  }
}
```

### Path B. Claude Code (HTTP remoto)

```bash
claude mcp add --transport http winterbrain https://brain.winterkpital.com/mcp \
  --header "Authorization: Bearer <token del usuario>"
```

### Path C. Codex CLI (HTTP remoto)

```bash
codex mcp add winterbrain --url https://brain.winterkpital.com/mcp \
  --bearer-token "<token del usuario>"
```

### Path D. OpenCode (HTTP remoto)

Editar `~/.config/opencode/opencode.json`:

```jsonc
{
  "mcp": {
    "winterbrain": {
      "type": "http",
      "url": "https://brain.winterkpital.com/mcp",
      "headers": {
        "Authorization": "Bearer <token del usuario>"
      }
    }
  }
}
```

## Step 2. Reiniciar el cliente

Pedile al usuario que cierre y vuelva a abrir su cliente (Claude Desktop / Claude Code / Codex / OpenCode). El MCP `winterbrain` debe aparecer listado como conectado.

## Step 3. Verificar

Manda a tu agente:

```text
Usa la herramienta save_note del MCP winterbrain para guardar una nota llamada "smoke test" con body "verificacion inicial".
```

Si responde con la ruta del archivo o un OK del gateway, la instalacion termino.

## Step 4. Explicarle al usuario

Mostrale al usuario el archivo `docs/QUICKSTART.md` del repositorio o resumenle las frases naturales que ya puede usar:

```text
Guarda esta conversacion en el cerebro.
Crea esto como resumen de reunion y subelo al cerebro.
Que aprendimos del sector X?
Que debemos priorizar en Cliente X segun la reunion que subio Sergio?
```

## Troubleshooting

- "no aparece winterbrain en mis MCP": confirma que el JSON quedo guardado y reinicia el cliente completo.
- "401/403 al conectar": el `WINTERBRAIN_TOKEN` no coincide con el usuario autorizado en el servidor compartido.
- "tool not found": el gateway remoto no expone esa herramienta todavia. Ver `docs/MCP_TOOLS.md` para el set actual.
- "No quiero clonar repo en mi maquina": correcto, este modo usa `npx` contra el gateway remoto. Solo el servidor central hospeda el cerebro.