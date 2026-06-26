# Winterbrain Quick Start

Esta guia esta pensada para Don Dario (CEO), Mariana (Inversiones) o cualquier C-level.
No necesitas entender programacion. Son tres pasos.

## 1. Pedile a tu agente que instale Winterbrain

Abre Claude o Codex y pega literalmente:

```text
Retrieve and follow the instructions at:
https://raw.githubusercontent.com/cquiroz6211/winterbrain/main/INSTALL_FOR_USERS.md
```

Tu agente hace todo por vos. Te va a pedir un solo dato importante: **la URL del cerebro compartido de la empresa**.

## 2. Cuando el agente termine

Reinicia Claude o Codex y verifica que aparece **winterbrain** como MCP conectado.
Si no aparece, mandale a tu agente:

```text
Verifica que el MCP winterbrain este conectado y funcione.
```

## 3. Usa el cerebro con frases naturales

Ya esta. No hay mas instalacion. Desde ahora podes decir:

```text
Guarda esta conversacion en el cerebro como nota.
Crea esto como resumen de reunion y subelo al cerebro.
Guarda el resumen de esta reunion para Cliente X.
Que aprendimos del sector healthtech ultimamente?
Que debemos priorizar en Cliente X segun la reunion que subio Sergio?
Preparame un brief del inversionista Y antes de la reunion.
Que funciono y que no funciono en los ultimos clientes?
```

---

## Que pasa cuando decis "guarda esto en el cerebro"

1. Tu agente recibe el mensaje y dispara una herramienta del MCP.
2. El gateway de Winterbrain normaliza el contenido a Markdown.
3. Se genera una nota estructurada con resumen, participantes, decisiones, riesgos y proximos pasos.
4. La nota se guarda en el repositorio compartido del cerebro de la empresa.
5. Cualquier otra persona del equipo puede preguntarle al cerebro y obtener esa misma nota como evidencia.

Tu no ves carpetas, archivos, ni bases de datos. Solo decis una frase en espanol.

---

## Si algo falla

Manda este mensaje a tu agente:

```text
Winterbrain no esta funcionando. Diagnostica el MCP, valida la conexion al servidor compartido y reporta que falta.
```

El agente corre los chequeos y te dice que arreglar.

---

## Regla de uso

- "Guarda en el cerebro" = guardar nota o resumen de conversacion.
- "Sube al cerebro" = guardar archivo o transcripcion.
- "Que aprendimos de X" = consultar conocimiento historico.
- "Preparame para X" = generar brief ejecutivo con fuentes.