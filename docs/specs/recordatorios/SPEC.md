# Sistema de Recordatorios — Especificación

## Problema

Recordatorios y pendientes dispersos en notas mentales, conversaciones y memoria. Sin una fuente de verdad única para qué hay que hacer, qué viene, qué se venció. Sin forma de preguntar "¿qué tengo pendiente?" y recibir una respuesta organizada.

## Solución

Un sistema de recordatorios basado en archivos, operado enteramente por conversación. El asistente mantiene una lista estructurada de recordatorios, registra contexto de conversaciones, trackea cambios de estado con historial completo, y provee listas cronológicas de pendientes bajo demanda — filtradas por fecha, proyecto, tags o cualquier combinación.

El objetivo es un **tracker de recordatorios simple**: nunca perder de vista un pendiente, recibir avisos a tiempo, y poder consultar qué viene.

---

## Modelo de Datos

### Recordatorio

Cada recordatorio es un objeto YAML con los siguientes campos:

| Campo | Tipo | Requerido | Default | Descripción |
|---|---|---|---|---|
| `id` | string | auto | — | Identificador único. Formato: `t-YYYYMMDD-NNN` (fecha de creación + secuencia). |
| `name` | string | **sí** | — | Título corto. El "qué". Único campo obligatorio del usuario. |
| `desc` | string | no | `""` | Descripción más larga. El "por qué" o "cómo". |
| `context` | string | no | `null` | Pasos, partes, info extra, datos relacionados. Campo vivo — se actualiza a medida que se acumula contexto. |
| `project` | string | no | `null` | Nombre del proyecto (ej: `trabajo`, `personal`, `facultad`). |
| `priority` | int (1-5) | no | `null` | 1=crítico, 2=alto, 3=medio, 4=bajo, 5=algún día. Solo si el usuario lo indica. |
| `state` | enum | auto | `pendiente` | Uno de: `pendiente`, `completado`, `cancelado`. |
| `due` | datetime | no | `null` | Fecha/hora límite o del evento. Formato: `YYYY-MM-DD HH:mm` (UTC-3). Recomendado pero no obligatorio. |
| `notificaciones` | list | no | `[]` | Lista de avisos programados (ver abajo). |
| `created` | datetime | auto | — | Timestamp ISO 8601 de creación. |
| `completed` | datetime | auto | `null` | Timestamp de cuando se completó (automático al vencer due, o manual). |
| `tags` | list | no | `[]` | Etiquetas libres (ej: `urgente`, `reunion`, `medico`). |
| `effort` | enum | no | `null` | `small`, `medium`, `large`. Solo si el usuario lo indica. |
| `blocked_by` | list | no | `[]` | Bloqueadores externos: fechas, eventos, personas, descripciones libres. |
| `depends_on` | list | no | `[]` | IDs de recordatorios que deben completarse antes de que este pueda proceder. |
| `history` | list | auto | `[]` | Log append-only de cambios de estado y mutaciones (ver abajo). |

### Notificación

Cada entrada en la lista `notificaciones` de un recordatorio:

| Campo | Tipo | Descripción |
|---|---|---|
| `hora` | datetime | Fecha/hora del aviso en formato `YYYY-MM-DD HH:mm` (UTC-3). |
| `enviada` | bool | `false` hasta que el bot envía el aviso, luego `true`. |

### Entrada de Historial

Cada entrada en el array `history` de un recordatorio:

| Campo | Tipo | Descripción |
|---|---|---|
| `at` | datetime | Timestamp ISO 8601 del cambio. |
| `change` | string | Qué cambió (ej: `"estado: pendiente → completado"`, `"creado"`). |
| `reason` | string | Opcional. Por qué cambió — del contexto de la conversación o input explícito. |

### Estados

| Estado | Significado |
|---|---|
| `pendiente` | Activo. Esperando su fecha/hora o acción del usuario. |
| `completado` | Terminado. Se completó automáticamente al llegar la hora de `due`, o manualmente. Espera barrido semanal de archivo. |
| `cancelado` | El usuario canceló explícitamente. No se ejecuta. Espera barrido semanal de archivo. |

**Completado automático:** cuando `due` < ahora y estado es `pendiente`, el estado pasa a `completado` automáticamente. No requiere acción del usuario.

**Cancelación:** solo por comando explícito del usuario.

---

## Zona Horaria

**Toda referencia temporal se asume en UTC-3 (Argentina).** Si el usuario no especifica fecha, asumir hoy. Si no especifica zona horaria, asumir UTC-3.

Almacenar fechas/horas en formato `YYYY-MM-DD HH:mm` (UTC-3). Timestamps de sistema (`created`, `completed`, `history[].at`) en ISO 8601.

---

## Estructura de Archivos

```
~/tasks/                          # Datos de recordatorios
├── SPEC.md                       # Este archivo
├── backlog.yml                   # Todos los recordatorios activos + recién completados
├── daily/
│   └── YYYY-MM-DD.md             # Log de contexto diario
└── archive/
    └── YYYY-WXX.yml              # Archivo semanal de completados, agrupados por proyecto
```

### backlog.yml

Archivo YAML único. Lista plana de todos los objetos de recordatorio. Fuente de verdad para todo lo no archivado.

### daily/YYYY-MM-DD.md

Markdown libre. No específico de un recordatorio. Captura contexto de conversaciones que afecta priorización:

- Cambios de prioridad desde conversaciones ("llamó el cliente, se movió la fecha")
- Bloqueadores que aparecieron o se resolvieron
- Decisiones que reordenan trabajo
- Cualquier info que fortalezca el contexto de recordatorios o ayude en futuras consultas

El asistente escribe en este archivo durante la conversación cuando emerge contexto relevante. Se referencia durante consultas.

### archive/YYYY-WXX.yml

Recordatorios completados/cancelados, barridos semanalmente de `backlog.yml`. Agrupados por proyecto:

```yaml
proyecto1:
  - id: t-20260210-003
    name: "Reunión con proveedor"
    completed: 2026-02-14
    # ... datos completos del recordatorio preservados
```

Datos completos (incluyendo historial) se preservan para referencia.

---

## Operaciones

### 1. Crear Recordatorio

Activado por pedido del usuario. Ejemplos:

- "haceme acordar a las 17hs de una reunion a las 18:30"
- "recordame mañana llamar al dentista"
- "anotame que tengo que pagar el seguro el viernes"

Extraer del mensaje:
1. **name** — obligatorio, extraer del contenido del pedido
2. **due** — hora del evento si se menciona. Si solo hay una hora, es el due.
3. **notificaciones** — si hay hora de aviso separada de hora de evento. Ej: "a las 17" es la notificación, "a las 18:30" es el due.
4. **project** — si se puede inferir del contexto. Si es un proyecto nuevo, preguntar "¿trabajo o personal?" y actualizar config.categories.
5. **tags** — si se mencionan o se pueden inferir
6. Todo lo demás queda en su default (null/vacío)

**Regla clave:** si el usuario da suficiente info en un mensaje, confirmar con resumen breve en una sola respuesta. No preguntar campo por campo. Minimizar preguntas — solo preguntar si algo es genuinamente ambiguo.

Auto-set: `id`, `created`, `state=pendiente`, `history=[{created}]`.

### 2. Actualizar Recordatorio

Cualquier mutación de campo via conversación. El asistente:
- Actualiza el campo en `backlog.yml`
- Agrega entrada a `history` con timestamp, descripción del cambio, y razón (si se provee o se puede inferir del contexto)

### 3. Consultar Recordatorios

El usuario pregunta: "¿qué tengo pendiente?" / "¿qué viene?" / "mis recordatorios"

**Proceso:**
1. Leer `~/tasks/backlog.yml` (incluyendo `config.categories` para filtrado por tono)
2. Filtrar por: categoría (detección de tono), estado (excluir `completado`, `cancelado`), fecha, proyecto/tags si se especifican
3. **Ordenar cronológicamente por `due`** (más próximo primero). Sin `due` van al final.
4. Presentar lista ordenada

**Detección de categoría por tono:**
- Tono trabajo ("qué tengo del trabajo", nombres de proyectos, phrasing laboral) → filtrar a `trabajo`
- Tono personal ("qué tengo que hacer", "mandados", "cosas personales") → filtrar a `personal`
- Neutro/sin especificar ("qué tengo", "mis pendientes") → mostrar todo
- Override explícito siempre gana ("mostrame las personales" / "solo trabajo")
- **Resultado vacío:** mencionarlo y ofrecer la otra categoría. Nunca cambiar silenciosamente.

**Excluidos de resultados:** `completado`, `cancelado`. Se mencionan solo si el usuario pregunta explícitamente.

### 4. Archivo Semanal

Activado manualmente o por schedule:
- Barrer todos los recordatorios `completado` y `cancelado` de `backlog.yml`
- Escribir a `archive/YYYY-WXX.yml` agrupados por proyecto
- Eliminar de `backlog.yml`

### 5. Log de Contexto

Durante cualquier conversación, si emerge información que:
- Afecta prioridad u orden de recordatorios
- Agrega contexto a un recordatorio existente
- Introduce un bloqueador nuevo o resuelve uno
- Cambia fechas de proyectos

El asistente agrega a `daily/YYYY-MM-DD.md` y opcionalmente actualiza el campo `context` e `history` del recordatorio relevante.

---

## Lógica Operativa

### Trigger del Skill

El sistema de recordatorios se implementa como skill de NanoClaw en `container/skills/recordatorios/SKILL.md`. Se activa cuando el mensaje del usuario matchea semánticamente gestión de recordatorios — crear recordatorios, consultar pendientes, cancelar, revisar agenda, etc. No se precarga para pedidos no relacionados.

### Integración con Heartbeat

En cada ciclo de heartbeat, el asistente escanea `backlog.yml` para:

- **Notificaciones pendientes**: recordatorios con entradas en `notificaciones` donde `hora` <= ahora y `enviada` == false → enviar aviso al usuario, marcar `enviada = true`
- **Vencidos**: `due` < ahora, estado `pendiente` → marcar como `completado` automáticamente, alertar si tiene notificaciones no enviadas

Si no hay nada, silencio.

### Archivo Semanal (Cron)

Cron ejecuta cada **domingo a las 23:00 UTC-3 (02:00 UTC lunes)**:

1. Leer `~/tasks/backlog.yml`
2. Extraer todos los recordatorios con estado `completado` o `cancelado`
3. Agrupar por `project` (los sin proyecto van bajo `sin_proyecto`)
4. Agregar a `~/tasks/archive/YYYY-WXX.yml` (número de semana ISO)
5. Eliminar archivados de `backlog.yml`
6. Reportar resumen al usuario ("Archivados N recordatorios de M proyectos")

### Sistema de Categorías

Los recordatorios se categorizan como `trabajo` o `personal` según su proyecto. El mapeo se define en `backlog.yml` bajo `config.categories`. Proyectos nuevos se preguntan una vez ("¿trabajo o personal?") y se agregan al config. Recordatorios sin proyecto no se filtran por categoría.

---

## Principios de Diseño

1. **Fuente de verdad única** — `backlog.yml` es la verdad. Ningún recordatorio vive solo en memoria o conversación.
2. **El contexto se acumula** — cada conversación que toca un recordatorio lo enriquece. Los logs diarios capturan contexto ambiental.
3. **El historial es inmutable** — append-only. Nunca borrar entradas de historial. El ciclo de vida completo de un recordatorio siempre es recuperable.
4. **Orden cronológico** — simple y predecible. Los más próximos primero.
5. **Fricción baja** — crear es rápido (solo nombre obligatorio), consultas en lenguaje natural, cambios de estado por conversación o automáticos.
6. **Nada se pierde** — todo queda registrado. Completado o cancelado, siempre se archiva.
