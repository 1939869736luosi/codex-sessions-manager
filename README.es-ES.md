# codex-sessions-manager

[![npm](https://img.shields.io/npm/v/codex-sessions-manager)](https://www.npmjs.com/package/codex-sessions-manager)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

[简体中文](./README.zh-CN.md)

> Codex Oficial es la primera opción para la gestión normal de tareas y el borrado permanente. Desde Codex 0.144.1, el comando oficial `thread/delete` elimina hilos persistidos, descendientes generados, archivos de despliegue (rollout) y el estado asociado. Este proyecto verifica de forma independiente qué es lo que realmente permanece y gestiona el estado local recuperable, legado, dañado o huérfano.

**codex-sessions-manager** es una herramienta de auditoría y recuperación de historial local de Codex enfocada en CLI. Su **Skill**, **CLI** y servidor **MCP** delimitado comparten el mismo núcleo. Utilízala para verificar el borrado oficial, encontrar residuos locales antiguos o dañados, realizar limpiezas recuperables con vista previa y verificar únicamente las superficies de almacenamiento que esta versión ha revisado realmente.

Está construida para trabajos de historial local críticos en seguridad: privacidad de prompts/historial, eliminación exacta de sesiones, rollback seguro o recuperación explícita, comprobaciones de conflictos de restauración, consistencia de SQLite/estado global y verificación post-eliminación.

Se agradecen los informes de seguridad. Consulta [SECURITY.md](./SECURITY.md) para conocer el modelo de seguridad soportado y la vía de reporte.

Referencias del proyecto: [Arquitectura](./ARCHITECTURE.md) · [Hoja de ruta](./ROADMAP.md) · [Contribución](./CONTRIBUTING.md) · [Lista de verificación de lanzamiento](./docs/RELEASE.md)

## ¿Por qué usar esta herramienta?

Codex Oficial es la parada obligatoria para la lectura normal de tareas, búsqueda, renombrado, archivado, reanudación, bifurcación (fork), mensajería y borrado permanente. Esta herramienta es para un trabajo diferente: probar qué es lo que permanece, recuperarse de fallos de limpieza, manejar almacenamiento legado o dañado, y limpiar periódicamente residuos verificados en lotes.

El proyecto combina estas capacidades en una sola herramienta local:

- Limpieza de las capas de sesión que esta versión comprende: archivos, índices JSONL, filas de SQLite conocidas y claves de estado global en lista blanca;
- Un diario de mutaciones duradero, rollback seguro cuando el estado registrado demuestre que es posible, y recuperación explícita en caso contrario;
- Papelera recuperable con restauración segura frente a conflictos;
- Verificación post-eliminación sobre el alcance de limpieza declarado;
- Acceso MCP delimitado para agentes de IA;
- Detección de solo lectura de relaciones padre/hijo de `/side` y `/fork`.

## Solapamiento oficial y valor retenido

Esta tabla se revisa cada vez que cambia la línea base de Codex anclada y antes de cada lanzamiento. La evidencia rastreada reside en [la línea base de capacidades oficiales](https://github.com/1939869736luosi/codex-sessions-manager/blob/main/compat/upstream-capabilities.json).

| Área | Estado de Codex Oficial | Decisión del Proyecto |
|---|---|---|
| Lista normal, búsqueda, lectura, renombrado, archivado, reanudación, fork, envío, dirección y metas | Disponible | Prioridad oficial; no añadir controles competitivos |
| Borrado permanente normal de hilos | Disponible desde 0.144.1 | Prioridad oficial; mantener verificación independiente y limpieza excepcional |
| Papelera recuperable, comprobaciones de conflicto de restauración y recuperación de operaciones interrumpidas | No se encontró contrato público equivalente | Retener |
| Auditoría de estado local legado, dañado, parcial o huérfano | No se encontró contrato público equivalente | Retener |
| Controles de uso/generación de memoria por tarea y restablecimiento total de memoria | Disponible | Usar controles oficiales |
| Edición/borrado por entrada o por sesión de memoria consolidada | No se encontró contrato soportado | Solo observación; no mutar directamente |
| Paginación de turnos/elementos del Servidor de App | Experimental | Mantener el marcador de página local del proceso; no expandirlo a un protocolo de traspaso/recurso entre hosts sin evidencia |

El proceso de compatibilidad, por lo tanto, verifica dos preguntas conjuntamente:

1. ¿Puede este proyecto seguir leyendo y manejando de forma segura el formato de almacenamiento actual de Codex?
2. ¿Ha reemplazado, reducido o habilitado Codex Oficial alguna capacidad del proyecto?

Las capacidades pueden moverse entre prioridad oficial, retenido, solo verificación, diferido y eliminado según cambien las versiones upstream. Un lanzamiento oficial modificado dispara una revisión; no borra código automáticamente ni publica un paquete.

### Controles de memoria actuales

Codex Oficial no expone actualmente una interfaz soportada de listado/edición/borrado para entradas individuales en la memoria consolidada final, ni puede prometer que un párrafo final pertenezca a una sola sesión. Utiliza estas rutas soportadas en su lugar:

- Usa `/memories` para controlar si la tarea actual utiliza memorias o contribuye a memorias futuras;
- Indica a Codex explícitamente qué recordar, olvidar o corregir para que su entrada de corrección (solo anexo) pueda consolidarse de forma segura;
- Usa **Reset all memories** solo cuando pretendas borrar todo el almacén de memoria local;
- Para eliminar una sesión como fuente de memoria, usa el borrado oficial de hilos y espera la reconsolidación en segundo plano. Este proyecto actualmente informa solo una asociación limitada de Etapa 1 vinculada al hilo y puede devolver `unknown`; aún no puede probar que un párrafo haya desaparecido de la memoria consolidada final.

La procedencia precisa de la memoria y la verificación de reconsolidación post-borrado siguen estando en la hoja de ruta y se reconsiderarán cuando la vigilancia de compatibilidad encuentre un contrato oficial soportado o suficiente evidencia fiable.

No edites directamente `memories_N.sqlite`, y no trates las ediciones manuales de `MEMORY.md`, `memory_summary.md`, `raw_memories.md` o `rollout_summaries/` como un método de borrado fiable. Son estados generados y pueden reconstruirse. Consulta la [documentación oficial de Memories](https://learn.chatgpt.com/docs/customization/memories).

## Flujo de trabajo periódico recomendado

1. Usa Codex oficial para el borrado permanente normal.
2. Mensualmente o cuando el almacenamiento parezca inconsistente, ejecuta `monthly-review` para obtener una auditoría delimitada de solo lectura y un informe de vista previa.
3. Usa `audit <id>` para distinguir los residuos confirmados de un ID que nunca fue observado.
4. Previsualiza en lotes solo los IDs residuales confirmados, y luego prefiere `delete --trash --yes` cuando aún sea necesaria una limpieza local.
5. Ejecuta `verify` y conserva el resultado estructurado como el recibo de borrado local.

Límite de compatibilidad actual: Codex puede almacenar archivos SQLite fuera de la raíz de Codex mediante `sqlite_home` o `CODEX_SQLITE_HOME`. Esta herramienta resuelve esa división en este orden: `config.toml sqlite_home`, luego `CODEX_SQLITE_HOME`, y finalmente la raíz de Codex. Advierte cuando ambas ubicaciones contienen bases de datos SQLite. Las líneas de tiempo legadas de `event_msg` / `response_item` y las líneas de tiempo paginadas de `item_completed` se analizan con diagnósticos explícitos de completitud. El orden de las sesiones sigue a `recency_at_ms`, luego `recency_at`, y luego `updated_at`; el `historyMode` se expone en la salida estructurada. Los archivos de despliegue comprimidos (`.jsonl.zst`) se preservan a través de la papelera/restauración como datos binarios. Si una sesión solo tiene `.jsonl.zst`, `show` no descomprime el cuerpo de la transcripción e informa `compressed_unread`; `export` almacena los bytes comprimidos originales como base64 dentro de su paquete de recuperación JSON. `memories_N.sqlite` es reconocido por `doctor` como una superficie de memoria oficial, pero las filas de memoria y las salidas de memoria de Fase 2 siguen siendo de solo lectura. Un borrado permanente confirmado elimina solo las filas de `logs.thread_id` que coincidan exactamente con el UUID seleccionado; la papelera mantiene esos registros recuperables hasta la purga final. El estado de control remoto sigue siendo solo de observación.

Las mutaciones confirmadas requieren UUIDs completos y canónicos de la sesión; borrar una sesión activa requiere el anulación adicional `--allow-active` / `allowActive=true`. Se rechazan los enlaces simbólicos gestionados, las uniones (junctions), los archivos con enlaces duros, las rutas fuera de la raíz y los planes obsoletos. Las mutaciones interrumpidas mantienen un registro de recuperación duradero y bloquean escrituras posteriores hasta que la operación de recuperación exacta se complete. Consulta la [Guía de Seguridad](./docs/SAFETY.md) para conocer los estados de salida, el alcance de la verificación y el límite de carrera del sistema de archivos del mismo usuario.

## Inicio Rápido

```bash
# Instalar globalmente
npm install -g codex-sessions-manager

# Verificar la versión del paquete instalado
codex-sessions --version
codex-sessions-mcp --version

# Listar sesiones recientes
codex-sessions list --limit 10

# Resumir fuentes de sesión (seguro, sin cambios)
codex-sessions sources

# Transmitir una sesión exacta como JSONL canónico (seguro, solo lectura)
codex-sessions events <exact-session-id>
codex-sessions events <exact-session-id> --output ./session-events.jsonl

# Inspeccionar sesiones padre e hijo (seguro, sin cambios)
codex-sessions family <session-id>
codex-sessions family <session-id> --children
codex-sessions family <session-id> --parents
codex-sessions family <session-id> --subagents
codex-sessions family <session-id> --impact

# Auditar qué permanece localmente después del borrado oficial (seguro, sin cambios)
codex-sessions audit <session-id>

# Escanear toda la raíz en busca de posibles candidatos a residuos (seguro, sin cambios)
codex-sessions audit-root --limit 50
codex-sessions audit-root --status risky-global-state --source global-state-unknown --limit 50

# Previsualizar en lote el borrado de candidatos a residuos de la raíz (seguro, sin cambios)
codex-sessions preview-root --limit 50
codex-sessions preview-root --source global-state-unknown --limit 20

# Construir un plan de borrado de solo lectura con IDs explícitos (seguro; archivo de plan opcional)
codex-sessions plan-delete <session-id...>
codex-sessions plan-delete <session-id...> --include-children
codex-sessions plan-delete <session-id...> --include-descendants --json
codex-sessions plan-delete --source-kind subagent --limit 20 --json
codex-sessions plan-delete --source-kind mcp --status archived --limit 20 --json
codex-sessions plan-delete <session-id...> --write-plan /tmp/codex-delete-plan.json --json
codex-sessions preview-plan /tmp/codex-delete-plan.json --json

# Previsualizar qué haría el borrado (seguro, sin cambios)
codex-sessions delete <session-id>

# Previsualizar la limpieza de estado global de claves exactas en lista blanca para una sesión explícita (seguro, sin cambios)
codex-sessions delete <session-id> --root <path-to-codex-root>

# Después de la previsualización, borrar con el UUID completo canónico (recomendado)
codex-sessions delete <full-session-uuid> --trash --yes

# ¿Cambiaste de opinión? Restáuralo
# La restauración confirmada siempre utiliza el trashId interno exacto.
codex-sessions restore <exact-trash-id> --yes

# Verificar las superficies activas cubiertas por este lanzamiento
codex-sessions verify <session-id>
```

## Cómo funciona realmente el borrado

Para una limpieza recuperable, huérfana, legada o seleccionada explícitamente, esta herramienta:

```
1. Vuelve a escanear y validar los objetivos gestionados exactos.
2. Adquiere el bloqueo de mutación y escribe un diario de operación duradero.
3. Precalcula reemplazos seguros para session_index.jsonl, history.jsonl y referencias de estado global en lista blanca.
4. Elimina los archivos de despliegue (rollout) y capturas de shell seleccionados.
5. Elimina solo las filas de sesión conocidas de las bases de datos SQLite de estado/metas y las filas exactas de `logs.thread_id` de la base de datos de registros dedicada.
6. Verifica los archivos declarados, índices, referencias de estado global y filas de SQLite.
```

Un fallo antes del commit no realiza ninguna mutación. Un fallo durante el commit se revierte (rollback) cuando el diario prueba que la recuperación es segura; de lo contrario, la operación pasa a estado `recovery_required` y bloquea mutaciones posteriores hasta que se complete la recuperación explícita. Una mutación que se cometió pero que luego falló o completó la verificación solo parcialmente permanece informada como cometida, con estado de salida `2` y el alcance verificado indicado explícitamente.

Después del borrado, ejecuta `verify` para confirmar que no queden residuos en las superficies que cubre este lanzamiento. Un borrado permanente debe informar cero filas de registros vinculadas exactamente al hilo. La papelera las conserva intencionadamente; la restauración las deja sin cambios; la purga final las elimina a menos que el mismo ID de sesión haya sido restaurado en el almacenamiento activo. El estado de la memoria en `memories_N.sqlite` permanece de solo lectura, y la verificación informa su asociación observable sin cambiarla.

## Características

| Característica | Qué hace |
|----------------|-------------|
| **Listar y filtrar** | Por proyecto, estado, rango de tiempo, metadatos de fuente, proveedor de modelo y modelo; agrupar por proyecto |
| **Resumen de fuentes** | Resumen de `sourceKind` de solo lectura preservando `source`, `thread_source`, `model_provider`, `model` y `agent_role` originales |
| **Fuentes de títulos divididas** | Las listas muestran el título buscable de la UI de Codex por defecto; la salida detallada muestra las diferencias entre `session_index`, SQLite y el título del primer mensaje |
| **Exportar** | Escribe un paquete de recuperación JSON que contiene archivos de sesión, índices, referencias de estado global seleccionadas, snapshots y filas de SQLite; los archivos comprimidos se incrustan como base64 para que sus bytes puedan reconstruirse exactamente |
| **Borrar** | Permanente o papelera recuperable, tú eliges |
| **Auditoría de residuos** | Informe de solo lectura para archivos de despliegue crudos, capturas de shell, índices de sesión, historial, filas de SQLite, refs de estado global, bordes de hilos, estado de familia y enlaces rotos padre/hijo |
| **Escaneo de residuos de raíz** | Escaneo de solo lectura a nivel de raíz para IDs probablemente residuales, sin requerir un ID de sesión previo |
| **Previsualización de borrado de raíz** | Previsualización de borrado en lotes de solo lectura para candidatos a residuos de la raíz, sin requerir que listes los IDs de sesión manualmente |
| **Revisión mensual de residuos** | Un informe delimitado de solo lectura que combina la auditoría de raíz y la previsualización; los detalles de advertencia requieren `--details` |
| **Diseño SQLite de Codex** | Resuelve `config.toml sqlite_home` / `CODEX_SQLITE_HOME` / fallback a la raíz, en ese orden; los registros vinculados exactamente al hilo siguen el ciclo de vida de borrado permanente/purga, mientras que `memories_N.sqlite` permanece de solo lectura. |
| **Plan de borrado explícito** | `plan-delete` de solo lectura para IDs de sesión explícitos; el plan en sí no puede ejecutarse, y cualquier borrado posterior debe volver a una previsualización y confirmación explícita de ID |
| **Papelera y Restauración** | Snapshot completo guardado; los archivos de sesión `.jsonl.zst` se almacenan como datos binarios seguros; la restauración comprueba conflictos de claves SQLite antes de escribir |
| **Verificar** | Informa sobre archivos, filas de índice y registros de BD restantes para las superficies que soporta este lanzamiento |
| **Limpieza** | Elimina entradas de índice obsoletas sin tocar los datos crudos |
| **Chequeo de salud** | `doctor` devuelve un resumen de salud de la raíz delimitado; `--details` solicita matrices de referencia completas |
| **Servidor MCP** | Los agentes de IA reciben operaciones delimitadas de auditoría, verificación, recuperación y limpieza aprobadas explícitamente |
| **Familia de sesiones** | Vistas de solo lectura de padre, hijo, ancestro, descendiente, hermano, subagente, `/fork`, `/side` e impacto; la salida humana usa etiquetas `source` cortas a menos que se use `--full` |
| **Conversaciones laterales** | Las sesiones padre e hijo permanecen separadas; el borrado/exportación/verificación nunca recurre automáticamente |

## Uso con Agentes de IA

### 1. CLI (Universal, todos los ecosistemas)

Cualquier agente de IA que pueda ejecutar comandos de shell puede usar codex-sessions-manager directamente:

```bash
codex-sessions list --limit 10
codex-sessions audit <session-id>
codex-sessions delete <session-id>   # solo previsualización sin --yes
```

Esto funciona en Amp, Claude Code, Codex, Cursor, Factory Droid y cualquier otro agente con acceso a la shell.

### 2. Skill (Codex, Claude Code, Amp)

Copia el directorio de skill autónomo para una integración más rica con el agente:

```bash
# Codex, alcance de proyecto (ruta de Skill compartida oficial)
mkdir -p .agents/skills/codex-sessions-manager
cp -r skills/codex-sessions-manager/* .agents/skills/codex-sessions-manager/

# Codex, alcance de usuario
mkdir -p "$HOME/.agents/skills/codex-sessions-manager"
cp -r skills/codex-sessions-manager/* "$HOME/.agents/skills/codex-sessions-manager/"

# Claude Code
mkdir -p ~/.claude/skills/codex-sessions-manager
cp -r skills/codex-sessions-manager/* ~/.claude/skills/codex-sessions-manager/

# La Skill distribuida incluye metadatos anidados en agents/openai.yaml.
```

### 3. MCP (Opcional, Avanzado)

Para Codex, usa el comando de registro oficial o el TOML equivalente en el [adaptador de Codex](adapters/codex/):

```bash
codex mcp add codex-sessions -- codex-sessions-mcp --profile read-only
```

Otros hosts de MCP pueden usar su propia configuración JSON, por ejemplo:

```json
{
  "mcpServers": {
    "codex-sessions": {
      "command": "codex-sessions-mcp",
      "args": ["--profile", "read-only"]
    }
  }
}
```

El perfil predeterminado es **read-only** (16 herramientas). Para operaciones destructivas, usa `--profile admin` (22 herramientas).

El comando MCP `get_session` está intencionadamente delimitado: `compact` devuelve como máximo 20 elementos / 64 KiB y lee como máximo 1 MiB del despliegue fuente; `full` devuelve como máximo 200 elementos / 256 KiB y lee como máximo 8 MiB. Los metadatos de la sesión también están delimitados. Ambos modos informan sobre la `completeness`, la `sourceCompleteness` subyacente, los recuentos devueltos/conocidos, el truncamiento de metadatos, la razón de la omisión y la disponibilidad de exportación exacta. Cuando se alcanza el límite de lectura de la fuente antes del EOF, `itemsKnown` es `null` en lugar de un total falso. El truncamiento de la salida de la herramienta también se informa como `truncated_limit`. Usa `codex-sessions show <id> --json` para todos los elementos semánticos analizables localmente y `export` para un paquete de recuperación JSON que incrusta archivos UTF-8 directamente y archivos comprimidos binarios como base64.

MCP `list_sessions` devuelve registros concisos, predetermina 50 sesiones, acepta como máximo 200 y limita la respuesta estructurada a 256 KiB. `totalMatches`, `sessionsReturned`, `hasMore`, `byteLimited` y `omittedReason` revelan cualquier omisión. Usa `codex-sessions list --json` cuando un llamador local necesite el conjunto de resultados completo o los metadatos completos de la sesión.

**Windows permanece en modo de solo lectura para operaciones destructivas en los lanzamientos actuales.** El borrado, la papelera, la restauración, la purga, la limpieza y la recuperación de operaciones interrumpidas fallan cerrando la operación hasta que se verifique la matriz real de Windows de junctions/puntos de re-análisis, manejo de mayúsculas/minúsculas y terminaciones abruptas. En Windows, solicitar el perfil MCP `admin` sigue registrando solo las herramientas de solo lectura.

### 4. Adaptadores del Ecosistema

Las guías de configuración específicas de la plataforma están en el directorio `adapters/`:

| Plataforma | Adaptador | Característica Clave |
|------------|----------|----------------------|
| Amp | [`adapters/amp/`](adapters/amp/) | `mcp.json` empaquetado en Skill para carga diferida |
| Claude Code | [`adapters/claude-code/`](adapters/claude-code/) | Directorio de Skill + config MCP |
| OpenAI Codex | [`adapters/codex/`](adapters/codex/) | Fragmento de AGENTS.md + plantillas CLI |
| Cursor | [`adapters/cursor/`](adapters/cursor/) | Ejemplo de `.cursor/mcp.json` |
| Factory Droid | [`adapters/factory-droid/`](adapters/factory-droid/) | Comando de una línea `droid mcp add` |

### Nota de migración (v0.5.x a v0.6.0)

El valor predeterminado de MCP cambió de 20 herramientas a 15 herramientas en v0.6.0. El soporte de recuperación llevó los perfiles a 16 y 22 herramientas. En 0.7.0, el lector de eventos canónicos delimitado reemplaza la herramienta `export_session_backup` no delimitada, por lo que los perfiles se mantienen en 16 y 22 herramientas. La exportación exacta sigue siendo exclusiva de la CLI. Si necesitas herramientas destructivas, añade `--profile admin`; la confirmación explícita sigue siendo obligatoria.

Cada respuesta estructurada de MCP pasa ahora por un límite final de 256 KiB / 200 elementos por colección. Si se alcanza ese límite, la respuesta informa `responseCompleteness=truncated_limit` y `responseOmittedReason`; el estado de mutación cometida permanece bajo su envoltorio `result` original. Las entradas de operación de sesión explícitas aceptan como máximo 50 IDs, y `list_trash` devuelve 50 entradas por defecto (200 máximo). Usa la salida CLI JSON o de archivo para obtener resultados locales completos.

## Referencia de la CLI

```bash
codex-sessions list [--status active|archived] [--limit N] [--project TEXT]
codex-sessions list --updated-after 2026-04-01 --updated-before 2026-04-30
codex-sessions list --group-by project
codex-sessions list --source-kind cli --model-provider openai
codex-sessions list --source mcp --thread-source mcp
codex-sessions list --agent-role subagent --agent-nickname helper
codex-sessions sources [--json]
codex-sessions projects
codex-sessions doctor [--json] [--details]
codex-sessions show <session-id> [--json]
codex-sessions events <exact-session-id> [--output ./session-events.jsonl]
codex-sessions family <session-id> [--json] [--children|--parents|--subagents|--impact] [--full] [--source-kind KIND]
codex-sessions audit <session-id> [--json]
codex-sessions audit-root [--json] [--limit 50] [--status STATUS...] [--source SOURCE...] [--all]
codex-sessions preview-root [--json] [--limit 50] [--status STATUS...] [--source SOURCE...] [--all]
codex-sessions monthly-review [--json] [--details] [--limit 50] [--status STATUS...] [--source SOURCE...] [--all]
codex-sessions export <session-id> [--output ./backup.json]
codex-sessions plan-delete <session-id...> [--json] [--write-plan FILE] [--include-children] [--include-subagents] [--include-descendants] [--include-family]
codex-sessions plan-delete --source-kind KIND [--source-kind KIND...] --limit N [--status STATUS...] [--json]
codex-sessions preview-plan <plan-file> [--json]
codex-sessions delete <full-session-uuid...> [--trash] [--yes] [--allow-active]
codex-sessions cleanup-index <full-session-uuid...> [--yes] [--allow-active]
codex-sessions recovery-status [--json]
codex-sessions recover <exact-operation-id> --yes
codex-sessions trash-list
codex-sessions restore <exact-trash-id> --yes
codex-sessions purge <exact-trash-id> --yes
codex-sessions cleanup-stale [--yes]
codex-sessions verify <session-id...> [--json]
```

**La seguridad es lo primero**: Todos los comandos destructivos requieren `--yes`. Sin él, solo obtienes una previsualización. Ejecuta primero una previsualización separada para los IDs de sesión exactos; `family`, `impact`, `audit-root`, `preview-root`, `plan-delete`, los archivos de plan y `preview-plan` nunca se consideran permiso para borrar.

Las búsquedas de solo lectura pueden resolver un prefijo corto único. Las mutaciones de sesión confirmadas requieren UUIDs completos en minúsculas; el borrado de sesiones activas requiere `--allow-active`. La restauración y purga confirmadas requieren un `trashId` exacto. El estado de salida `2` significa que una mutación se cometió pero la verificación fue parcial o falló; el estado `3` significa que se requiere recuperación y se bloquean más mutaciones.

`export` y los paquetes de papelera son datos de recuperación, no previsualizaciones. Pueden incluir valores exactos de claves de estado global, como el contenido del historial de prompts. Las previsualizaciones de borrado humanas muestran solo la ruta, la regla, la forma y el recuento de bytes.

`doctor` devuelve por defecto recuentos, riesgos, advertencias delimitadas y como máximo cinco muestras por clase de referencia. Usa `--details` solo cuando se requieran matrices de diagnóstico locales completas. El JSON de la sesión y el detalle de MCP incluyen un `memoryLink` de solo lectura; nunca incluye `raw_memory` ni texto de resumen de despliegue, y el borrado ordinario de sesiones conserva todas las superficies de memoria. La sola presencia en la base de datos no prueba que la memoria esté habilitada, por lo que doctor informa `enabled=unknown` a menos que una señal oficial futura pueda establecerlo. El `memory_mode` de la sesión mapea solo los valores exactos `enabled`/`disabled` a booleanos; los valores faltantes o futuros permanecen como `unknown`. Los metadatos de selección de Etapa 1 actuales tampoco prueban la procedencia final de la Fase 2; la influencia incierta se informa como `unknown`, no se adivina como `known` o `none`.

`events` requiere un UUID de sesión completo y transmite JSONL canónico sin acortar los datos de las herramientas. `--output` crea un nuevo archivo privado `0600` y rechaza la sobrescritura. MCP `get_session_events_page` está delimitado por separado a 100 eventos y 240 KiB de datos de evento; los eventos sobredimensionados se informan y se omiten de MCP, siendo la salida CLI/archivo la ruta completa.

**Entradas de papelera duplicadas**: `restore` no borra la entrada de la papelera. Si una sesión restaurada se mueve a la papelera nuevamente, `trash-list` puede mostrar múltiples copias recuperables para el mismo ID de sesión. Este es un estado normal de la papelera, no un residuo activo. Una copia más nueva no reemplaza a una más antigua. Cuando un ID de sesión tiene múltiples entradas de papelera, la restauración y purga confirmadas rechazan el ID de sesión y requieren el `trashId` exacto. No purgues duplicados automáticamente. `purge` elimina permanentemente solo la entrada de papelera seleccionada y nunca toca la sesión activa.

Usa `audit` después del borrado oficial de Codex cuando necesites un informe claro de residuos locales. Es de solo lectura. Informa si el archivo de despliegue crudo, la captura de shell, el `session_index`, el `history`, los registros de SQLite, las refs de estado global conocidas, las refs de estado global de claves exactas en lista blanca, las refs de estado global desconocidas y los `thread_spawn_edges` siguen presentes. También informa la membresía de familia y los enlaces rotos padre/hijo. Si queda algo, el siguiente comando sugerido es un comando `delete` solo de previsualización; nada se borra a menos que añadas `--yes`.

Después del archivado, el mismo comando es solo una vista de inventario: se espera que los archivos de despliegue y los índices archivados permanezcan y no son candidatos a residuos o limpieza solo porque existan.

Usa `audit-root` cuando no tengas ya el ID de la sesión. Escanea toda la raíz de Codex y enumera los posibles candidatos a residuos por riesgo: bordes padre/hijo rotos, archivos de despliegue faltantes con refs de estado global desconocidas, filas solo de SQLite, capturas de shell, filas solo de índice y otros restos parciales. Es de solo lectura, predetermina `--limit 50`, no imprime el contenido de la transcripción y recomienda un comando `audit` por sesión para cada candidato. Añade `--all` solo cuando quieras intencionadamente que se incluyan también las sesiones completas que no son residuos.

`audit-root` soporta filtros solo para visualización. Los candidatos coincidentes no son una lista de borrado ni una recomendación de borrado; audítalos uno por uno o inspecciona una previsualización de solo lectura antes de elegir cualquier limpieza:

- `--status risky-global-state`
- `--status global-state-exact-key`
- `--status db-only`
- `--status broken-family`
- `--status partial-residue`
- `--status global-state-unknown`
- `--source global-state-unknown`
- `--source global-state-exact-key`
- `--source global-state-known`
- `--source sqlite`
- `--source session-index`
- `--source history`
- `--source shell-snapshot`
- `--source thread-spawn-edges`

Puedes pasar `--status` o `--source` más de una vez. Varios valores del mismo tipo usan OR. Combinar estado y fuente usa AND. Estos filtros solo reducen lo que se muestra. Un candidato coincidente sigue necesitando un `audit` por sesión o una previsualización de borrado antes de cualquier decisión de limpieza, y no significa que el candidato deba ser borrado.

La salida humana y JSON incluye un resumen: `filters`, `totalCandidatesBeforeFilter`, `totalCandidatesAfterFilter`, `returnedCandidates`, `limit`, `byStatus` y `bySource`. Los recuentos de `byStatus` y `bySource` se calculan después de los filtros de estado/fuente y antes del `limit`.

Usa `sources` cuando necesites una visión general de solo lectura de dónde provienen las sesiones. Agrupa por `sourceKind` inferido, `source` crudo, `thread_source`, `model_provider`, `model` y `agent_role`. `sourceKind` puede ser `subagent`, `mcp`, `vscode`, `cli`, `exec` o `unknown`. El valor `source` crudo se mantiene en la salida JSON y se muestra en la salida humana, porque `sourceKind` es solo la categoría inferida por esta herramienta.

`list` soporta los mismos filtros orientados a la fuente: `--source-kind`, `--source`, `--thread-source`, `--agent-role`, `--agent-nickname`, `--model-provider` y `--model`. Los filtros se combinan con AND entre diferentes campos. Repetir el mismo campo usa OR. MCP `list_sessions` acepta los mismos campos pero devuelve una vista concisa delimitada (50 por defecto, 200 máximo, límite de respuesta de 256 KiB); usa JSON de la CLI para la lista local completa. MCP `summarize_sources` devuelve la misma forma de resumen que `sources --json` de la CLI.

Límites de fuente importantes:

- `source=vscode` es una etiqueta de fuente de hilo cruda de Codex. No debe tratarse como prueba de que el chat provenga del IDE de VS Code.
- No infieras "Desktop" por exclusión. Las sesiones que no estén marcadas como `cli`, `mcp`, `vscode` o `exec` son `unknown`, no Desktop automáticamente.
- `source=mcp` significa que el hilo fue registrado con esa fuente. No es un registro de cada llamada a herramienta MCP dentro de la conversación.
- `model_provider` solo se muestra y se filtra aquí. Esta herramienta no repara la identidad del proveedor ni reescribe el historial del proveedor.

Usa `preview-root` cuando quieras una previsualización de borrado en lote de solo lectura para los mismos candidatos que seleccionaría `audit-root`. Reutiliza los mismos filtros de estado/fuente y el límite conservador predeterminado de `--limit 50`, luego resume archivos de despliegue, archivos `.jsonl.zst` comprimidos, capturas de shell, índices, filas de SQLite vinculadas exactamente al hilo (incluidos los registros dedicados), referencias de estado global y bordes de familia. La memoria nunca es una superficie de borrado. No borra, no acepta `--yes`, no recomienda borrar una sesión y no añade familiares recursivamente. El borrado real sigue requiriendo una previsualización de ID explícito y una confirmación separadas.

Usa `monthly-review` para la comprobación periódica normal. Combina `audit-root` y `preview-root` sin cambiar datos, predetermina cinco muestras de advertencia y expande las advertencias solo con `--details`. Sus siguientes pasos son auditorías de solo lectura por sesión, nunca comandos de borrado confirmados.

Usa `plan-delete` cuando ya tengas IDs de sesión explícitos y quieras un plan más seguro y consciente de las relaciones antes de cualquier previsualización o escritura de borrado. Es de solo lectura, tiene `readOnly: true` y `executionSupported: false`, y también está disponible a través de la herramienta MCP de solo lectura `plan_delete_sessions`. Por defecto, solo se seleccionan los IDs semilla. Los padres relacionados, hijos, subagentes, descendientes, miembros de la familia y sesiones ambiguas de side/fork se informan en `availableIncludes` o advertencias. `--include-children`, `--include-subagents`, `--include-descendants` e `--include-family` solo cambian los `selectedIds`; no ejecutan el borrado. `--include-family` es el de mayor riesgo y emite una advertencia fuerte. La salida de estado global de clave exacta muestra solo la ruta, la regla, la forma y los metadatos de bytes; el estado global desconocido permanece solo como advertencia.

También está disponible una forma de candidato de fuente a nivel de raíz conservadora: `plan-delete --source-kind subagent --limit 20 [--status archived] [--json]`. Los valores repetidos de `--source-kind` usan OR, y los valores repetidos de `--status` usan OR. `--limit` es obligatorio y debe ser de máximo 50. `sourceKind=unknown` es rechazado a nivel de raíz; revisa las sesiones desconocidas mediante un ID de sesión explícito. Este modo escribe las coincidencias en `candidateIds`, nunca en `selectedIds`, y las coincidencias activas/actuales permanecen en `rejectedIds`. Es solo una lista de candidatos: `sourceKind` es una dimensión de filtro, no una autorización de borrado. `mcp` significa la fuente del hilo, no cada llamada a herramienta MCP; `vscode` es la etiqueta cruda de Codex, no prueba del IDE de VS Code; `exec` no significa que los registros de ejecución sean seguros para el borrado en lote. `--write-plan` no está soportado intencionadamente para planes de candidatos de sourceKind en este lanzamiento.

MCP `plan_delete_sessions` soporta la misma semántica de candidatos de sourceKind: pasa `sourceKind` más el `limit` obligatorio y el `status` opcional; `selectedIds` permanece vacío, `candidateIds` lleva las coincidencias, el `unknown` a nivel de raíz es rechazado y las coincidencias activas/actuales permanecen en `rejectedIds`. La herramienta MCP no soporta `writePlan`, no crea tokens de previsualización y no puede ejecutar el borrado.

`plan-delete --write-plan FILE` escribe un artefacto de auditoría JSON estable `codex-sessions-delete-plan.v1`. El archivo incluye `scanTimestamp`, `planHash`, una huella digital de la raíz, recuentos de superficies seleccionadas, bordes de familia y rutas de estado global de clave exacta. No debe contener cuerpos de transcripciones, texto de prompts ni valores completos de estado global; las entradas de estado global de clave exacta se limitan a metadatos de ruta/regla/forma/estimación de bytes. Un archivo de plan no es una autorización, ni un token de previsualización, ni una confirmación de borrado, y no puede pasarse a ningún comando de ejecución de borrado.

Usa `preview-plan <plan-file>` para volver a escanear la raíz en modo de solo lectura y comparar el plan con el estado actual. Comprueba la ruta real de la raíz, la ruta/fuente real del hogar de SQLite, `session_index`, `history`, `.codex-global-state.json`, mtime/tamaño/analizabilidad de SQLite de estado/log/metas/memorias, recuentos de superficies seleccionadas, bordes de familia y rutas de clave exacta. Los recuentos de superficies seleccionadas incluyen archivos de despliegue `.jsonl.zst` comprimidos cuando una sesión seleccionada los tenga. Si algo difiere dentro de la huella digital cubierta, `stale=true` y no se produce ninguna previsualización de borrado, por lo que un plan antiguo no puede tratarse como la previsualización actual. `preview-plan` no acepta `--yes`, `--trash`, `--force` ni ningún modo de ejecución de borrado.

MCP `preview_delete_plan` acepta ya sea un `planFile` o un objeto `plan` en línea y utiliza la misma detección de obsolescencia. Es de solo lectura, no acepta `confirm`, `trash`, `yes` o `force`, y no devuelve ninguna `deletePreview` actual cuando `stale=true`.

Por diseño, este conjunto de herramientas no soporta el borrado por plan, tokens de previsualización, `--force`, ejecución de borrado basada en sourceKind, ni orquestación automática avanzada de borrado de familia/sourceKind. El borrado real debe volver a una previsualización de borrado de ID explícito y una confirmación humana explícita.

### Limpieza de estado global de claves exactas en lista blanca

Solo dos rutas de `.codex-global-state.json` anteriormente desconocidas pueden ser eliminadas mediante un borrado confirmado:

- `$.electron-persisted-atom-state.prompt-history.<session-id>`
- `$.electron-persisted-atom-state.heartbeat-thread-permissions-by-id.<session-id>`

Son eliminables solo cuando el id de la sesión es la clave completa del objeto y la forma del valor coincide con la regla. La previsualización muestra la ruta exacta, el id de la regla, la forma del valor, la estimación de bytes, las superficies afectadas, las advertencias de familia y que se requiere confirmación. Nunca imprime texto de prompt ni valores completos de estado global.

Todas las demás refs de estado global desconocidas permanecen como advertencias. Los valores de cadena con forma de UUID, los UUIDs dentro de matrices, las coincidencias de ruta parciales, las formas de heartbeat inesperadas, los ids de instalación y los candidatos de escaneo de raíz no se eliminan. El borrado confirmado rechaza un ID que coincida solo con refs de estado global desconocidas no elegibles.

Usa el flujo de borrado de sesión explícita existente:

```bash
codex-sessions delete <session-id> --root <path-to-codex-root>
codex-sessions delete <session-id> --root <path-to-codex-root> --yes
codex-sessions delete <session-id> --root <path-to-codex-root> --trash --yes
```

MCP sigue el mismo modelo de seguridad: llama a `preview_delete_sessions` para inspeccionar las rutas exactas, luego llama a `delete_sessions` con `confirm=true` solo cuando la previsualización coincida con el alcance previsto. No hay un token de previsualización que vincule la llamada de previsualización con la llamada confirmada. El comando confirmado vuelve a escanear la raíz y rechaza la operación si el archivo de estado global cambia nuevamente dentro de ese comando confirmado antes de su escritura, no puede analizarse o no puede protegerse mediante rollback.

Usa `family` antes de borrar una sesión padre o hija. Las sesiones padre e hijo son sesiones independientes con sus propios IDs. Borrar un padre no borra a los hijos, y borrar un hijo no borra a su padre. Las previsualizaciones de borrado y las auditorías advierten cuando los registros de relación apuntan a sesiones faltantes o superficies de archivo/índice faltantes. Para procesar múltiples sesiones relacionadas, pon cada ID de sesión previsto en el comando de previsualización/borrado explícitamente. La herramienta nunca recurre a sesiones padre o hijo automáticamente.

`thread_spawn_edges` es una tabla de bordes de relación padre/hijo genérica. No es una tabla exclusiva de subagentes. Los hilos hijos de `/side`, `/fork`, subagente, MCP, exec, VS Code, CLI y desconocidos pueden aparecer todos como hilos hijos. El tipo de hijo se infiere de la propia sesión hija: `sourceKind` inferido, `source` crudo, `thread_source`, `agent_role`, `agent_nickname` y `agent_path`. Un hijo puede tener más de una etiqueta, como `subagent` y `side/fork` a la vez; JSON/MCP exponen `childTypeLabels` y `relationshipLabels` para que la identidad mixta no se colapse en una sola etiqueta.

Los modos de familia son todos de solo lectura:

- `family <id> --children` muestra solo los hijos directos, incluyendo `sourceKind`, estado del borde, etiquetas de tipo de hijo, título, hora de actualización, metadatos del agente y presencia de archivo/índice/hilo.
- `family <id> --parents` muestra solo los padres directos con la misma fuente y metadatos de borde.
- `family <id> --subagents` muestra los miembros de la familia cuyo `sourceKind` es `subagent` o que tienen metadatos de agente.
- `family <id> --impact` muestra qué riesgos de padre, hijo, miembro de familia, padre/hijo faltante y superficies de archivo/índice/hilo faltantes quedarían si más adelante eligieras procesar solo esta sesión. Agrupa `selected`, `unselected parents`, `unselected children`, `unselected family members`, `missing relations` y `missing surfaces`. No borra nada, no recomienda la eliminación y no genera `--yes`.
- `family <id> --full` mantiene la `source` cruda completa y los títulos completos en la salida de bloque en lugar de una tabla ancha. La salida JSON y MCP siempre mantienen los campos completos.

Usa `--source-kind subagent|mcp|vscode|cli|exec|unknown` con los modos de familia cuando solo quieras nodos de familia coincidentes. La salida humana predeterminada es compacta y puede acortar textos largos; usa `--full`, `family --json` o MCP `get_session_family` cuando los campos crudos exactos sean importantes. El borrado real aún debe usar una previsualización de ID explícito y una confirmación explícita separadas.

La capa de compatibilidad de metadatos de fuente mantiene el campo estable `sourceKind` como la categoría general (`subagent`, `mcp`, `vscode`, `cli`, `exec`, `unknown`). La salida JSON también puede incluir `sourceInfo` con `source` crudo, `thread_source` crudo, metadatos de source-kind de Codex v2 oficiales cuando se derivan de forma fiable, metadatos de analítica de fuente de hilo y evidencia compacta. Esto es solo observabilidad: no cambia los filtros, las previsualizaciones de borrado, la selección de plan-delete, la planificación de MCP ni la autorización de borrado. En particular, los valores crudos internos de `mcp`, `appServer` y `app-server` se informan como `sourceKind=mcp` estable con metadatos oficiales `appServer`; no son prueba de llamadas individuales a herramientas MCP.

## Títulos de Sesión

Una sesión local de Codex puede tener múltiples fuentes de título:

- `displayTitle`: el título predeterminado que se muestra en las listas, preferido de `session_index.jsonl.thread_name`, y generalmente el más cercano a lo que la búsqueda de la UI de Codex puede encontrar.
- `indexTitle`: el título de `session_index.jsonl`.
- `sqliteTitle`: el valor de `threads.title` de `state_N.sqlite`, que puede ser un título interno largo más antiguo.
- `firstUserMessage`: la primera solicitud del usuario.
- `titleSource`: de dónde proviene el título de visualización actual.
- `titleMismatch`: si las fuentes de título discrepan.
- `titleCandidates`: todos los títulos candidatos.

`list` y los resultados de búsqueda muestran `displayTitle` por defecto. `show` legible para humanos imprime un `sqliteTitle` acortado, `firstUserMessage`, candidatos a título y una previsualización de la línea de tiempo para que la deriva del título sea visible sin volcar grandes cantidades de texto similar a una transcripción. Usa `show --json` para obtener los valores de metadatos completos y todos los elementos semánticos analizables localmente. Las salidas de herramientas individuales aún pueden estar truncadas, y los registros fuente comprimidos, no soportados o malformados permanecen revelados a través de los metadatos de completitud.

## Qué almacena Codex (y qué limpiamos)

El borrado oficial de Codex 0.144.1 elimina el hilo persistido, los descendientes generados, los archivos de despliegue y una parte sustancial del estado asociado. Este proyecto no asume que las superficies legadas, dañadas, retrasadas o desconocidas estén limpias sin verificarlo. `audit-root` encuentra posibles IDs residuales, `preview-root` previsualiza en lote los candidatos seleccionados, `audit` informa sobre un ID y `verify` registra el alcance soportado post-limpieza. Usa `delete --trash --yes` o `cleanup-index --yes` solo para el estado residual confirmado que aún necesite manejo local.

```
~/.codex/
├── sessions/            ← archivos crudos de despliegue .jsonl / .jsonl.zst    ✅ limpiados
├── archived_sessions/   ← archivos .jsonl / .jsonl.zst archivados       ✅ limpiados
├── shell_snapshots/     ← scripts de captura de shell         ✅ limpiados
├── session_index.jsonl  ← índice de metadatos de sesión         ✅ limpiados
├── history.jsonl        ← índice de historial de conversación     ✅ limpiados
├── state_N.sqlite       ← hilos y registros relacionados     ✅ limpiados
├── goals_N.sqlite       ← metas del hilo, cuando están separadas    ✅ limpiados
├── logs_N.sqlite        ← los registros vinculados exactamente al hilo siguen el borrado permanente/purga; se conservan en la papelera
├── memories_N.sqlite    ← estado de memoria oficial           👁 solo doctor/vigilancia de esquema
└── .codex-global-state.json ← refs de sesión activa conocidas   ✅ limpiados
```

Las bases de datos SQLite pueden residir directamente bajo `~/.codex` o bajo un hogar de SQLite separado seleccionado por `config.toml sqlite_home` / `CODEX_SQLITE_HOME`. `config.toml sqlite_home` prevalece cuando ambos están configurados. `doctor` informa el hogar de SQLite activo y advierte cuando ambas ubicaciones contienen bases de datos candidatas.

Los archivos `.jsonl.zst` comprimidos están cubiertos como archivos de sesión para escaneo, previsualización, borrado, papelera, restauración y detección de obsolescencia. No se descomprimen para mostrar la transcripción; las sesiones que solo están comprimidas informan `compressed_unread`, y cualquier previsualización de índice/historial se etiqueta como historial en lugar de texto de transcripción.

## Documentación

- [Política de seguridad](./SECURITY.md) — informa sobre pérdida de datos, borrado incompleto, restauración, rollback, rutas y problemas de exposición del historial local
- [Guía de seguridad](./docs/SAFETY.md) — lee antes de borrar/papelera/restaurar/purgar
- [Registro de cambios](./CHANGELOG.md) — notas de lanzamiento
- [Programa de seguridad, compatibilidad y arquitectura](https://github.com/1939869736luosi/codex-sessions-manager/tree/main/docs/plans/2026-07-security-compat-architecture) — plan mantenido, secuencia real de lanzamientos, evidencia y proyectos diferidos
- [SKILL.md](./SKILL.md) — instrucciones de skill de IA (archivo de enrutamiento simplificado, ~90 líneas)
- [Referencia detallada de herramientas](./skills/codex-sessions-manager/docs/SKILL_DETAIL.md) — referencia completa de parámetros CLI/MCP
- [Adaptadores del ecosistema](./adapters/) — configuración específica de plataforma para Amp, Claude Code, Codex, Cursor, Factory Droid
- [Línea base de compatibilidad](https://github.com/1939869736luosi/codex-sessions-manager/tree/main/compat) — versión de Codex anclada, fixtures sintéticos, resúmenes de ejecución públicos y reglas de frescura de lanzamiento

## Desarrollo

```bash
git clone https://github.com/1939869736luosi/codex-sessions-manager.git
cd codex-sessions-manager
npm install
npm run build
npm test
```

## Licencia

Apache-2.0
