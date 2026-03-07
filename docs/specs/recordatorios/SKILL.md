---
name: recordatorios
description: "Gestionar recordatorios, tareas pendientes y notificaciones. Usar cuando el usuario pida crear un recordatorio, consultar qué tiene pendiente, cancelar una tarea, revisar su agenda, o cualquier cosa relacionada con sus pendientes, avisos o fechas límite."
---

# Gestión de Recordatorios

Datos en `/workspace/extra/tasks/`. Spec: `/workspace/extra/tasks/SPEC.md`. Leer para detalles completos del esquema si es necesario.

## Archivos

- `/workspace/extra/tasks/backlog.yml` — todos los recordatorios (fuente de verdad)
- `/workspace/extra/tasks/daily/YYYY-MM-DD.md` — log de contexto diario
- `/workspace/extra/tasks/archive/YYYY-WXX.yml` — archivo semanal de completados por proyecto

## Fecha/Hora (paso obligatorio)

Antes de CUALQUIER operación (consulta, crear, actualizar, heartbeat), ejecutar `date -u '+%A %Y-%m-%d %H:%M UTC'` para obtener fecha y hora actual. Nunca confiar en contexto de conversación ni fechas del sistema — siempre verificar en vivo. Usar este valor para comparaciones de fecha, generación de IDs, nombres de archivos de log diario, y cálculos de vencimiento.

**Zona horaria: UTC-3.** Toda referencia temporal del usuario se asume en UTC-3 (Argentina). Si no se especifica fecha, asumir hoy. Convertir a UTC solo para almacenamiento interno si es necesario.

## Configuración de Categorías

El bloque `config` al inicio de `backlog.yml` mapea proyectos a categorías:

```yaml
config:
  categories:
    personal: [personal]
    trabajo: [proyecto1, proyecto2]
```

Proyectos nuevos: preguntar "¿trabajo o personal?" una vez, luego agregar al config.

## Esquema de Recordatorio (referencia rápida)

Campos: id, name, desc, context, project, priority (1-5), state, due, notificaciones[], created, completed, tags, effort, history[]

Estados: `pendiente | completado | cancelado`

### Campos y valores por defecto

| Campo | Requerido | Default | Notas |
|---|---|---|---|
| name | **sí** | — | Lo único obligatorio |
| due | no | `null` | Fecha/hora límite. Recomendado pero opcional. Formato: `YYYY-MM-DD HH:mm` (UTC-3) |
| notificaciones | no | `[]` | Lista de `{hora: "YYYY-MM-DD HH:mm", enviada: false}`. Horas en las que el bot avisa. |
| desc | no | `""` | Descripción larga |
| context | no | `null` | Info adicional, pasos, datos relacionados |
| project | no | `null` | Nombre del proyecto |
| priority | no | `null` | 1-5 (1=crítico, 5=algún día). Solo si el usuario lo indica. |
| effort | no | `null` | small/medium/large. Solo si el usuario lo indica. |
| tags | no | `[]` | Etiquetas libres |
| blocked_by | no | `[]` | Bloqueadores externos |
| depends_on | no | `[]` | IDs de recordatorios que deben completarse antes |

## Crear Recordatorio

El usuario envía algo como: "haceme acordar a las 17hs de una reunion de trabajo a las 18:30"

Extraer del mensaje:
- **name**: "reunion de trabajo"
- **due**: hoy 18:30 (UTC-3) — la hora del evento
- **notificaciones**: [{hora: hoy 17:00, enviada: false}] — la hora del aviso

Reglas:
1. Solo `name` es obligatorio. Todo lo demás se infiere o queda null.
2. Si el usuario da una hora de aviso Y una hora de evento → aviso va a `notificaciones`, evento va a `due`.
3. Si solo da una hora → es el `due` (el evento mismo). No crear notificación previa automáticamente.
4. Si da suficiente info en un mensaje, confirmar con resumen breve. Si no, preguntar solo lo que falta para entender el pedido.
5. Minimizar preguntas. Ante la duda sobre zona horaria, asumir UTC-3.
6. Si no se especifica fecha, asumir hoy.

Auto-set: id (`t-YYYYMMDD-NNN`), created (ahora), state (`pendiente`), history ([{created}]).

## Actualizar Recordatorio

En cualquier mutación: actualizar campo en backlog.yml, agregar entrada a history con timestamp + cambio + razón opcional.

## Completado Automático

Cuando la fecha/hora `due` llega (due < ahora), el estado pasa automáticamente a `completado` y se registra `completed` con el timestamp. No requiere acción del usuario.

## Cancelar

Solo por comando explícito del usuario ("cancelá el recordatorio X", "ya no necesito eso"). Cambiar estado a `cancelado`, registrar en history.

## Consulta ("qué tengo pendiente")

1. Leer `/workspace/extra/tasks/backlog.yml` (incluyendo `config.categories`)
2. Leer `/workspace/extra/tasks/daily/*.md` recientes (últimos 2-3 días) para contexto
3. **Detectar categoría por tono:**
   - Tono trabajo ("qué tengo del trabajo", "tareas de [proyecto]", "pendientes laborales") → filtrar a `trabajo`
   - Tono personal ("qué tengo que hacer", "mis cosas", "mandados", "personal") → filtrar a `personal`
   - Neutro/sin especificar ("qué tengo", "mis pendientes") → mostrar todo
   - Override explícito siempre gana ("mostrame las personales" / "solo trabajo")
   - **Si el resultado filtrado está vacío:** mencionarlo y ofrecer la otra categoría. Nunca cambiar silenciosamente.
4. Filtrar: excluir completados y cancelados
5. Aplicar filtros: fecha, proyecto, tags si se especifican
6. **Ordenar cronológicamente por `due`** (más próximo primero). Recordatorios sin `due` van al final.

### Modo de Respuesta (crítico)

**Default: lista breve.** Mostrar los próximos recordatorios pendientes.

Detectar intención:
- **"Qué tengo pendiente" / "qué viene"** → Próximos 3-5 recordatorios con due, ordenados cronológicamente. Una línea por recordatorio.
- **"Qué tengo hoy"** → Solo recordatorios con due hoy o vencidos. Si no hay, decirlo.
- **"Todos mis recordatorios" / "lista completa"** → Lista completa ordenada cronológicamente.
- **"Qué sigue"** → El próximo recordatorio más cercano.

**Reglas de formato (para superficies de chat/texto):**
- Sin tablas. Sin headers. Sin formato markdown más allá de bold.
- Un recordatorio = una línea. Ej: *Reunión de trabajo* — hoy 18:30
- Detalles solo cuando se piden. Context, effort, tags — omitir a menos que se soliciten.

**Sé un Sofibot, no un project manager.** Rápido, directo, una respuesta. El usuario siempre puede pedir más.

## Log de Contexto

Cuando la conversación revela info que afecta prioridad, bloqueadores o fechas de recordatorios — agregar a `/workspace/extra/tasks/daily/YYYY-MM-DD.md`. Actualizar el campo context e history del recordatorio relevante si aplica.

## Chequeo en Heartbeat

En heartbeat, escanear backlog.yml para:
- Vencidos: due < ahora, estado no completado/cancelado → alertar y marcar completado
- Notificaciones pendientes: notificaciones con hora <= ahora y enviada == false → enviar aviso, marcar enviada = true

Silencio si no hay nada.

## Archivo Semanal

Cron (domingo 23:00 UTC-3). También se puede activar manualmente. Mover recordatorios completados/cancelados a `/workspace/extra/tasks/archive/YYYY-WXX.yml` agrupados por proyecto, eliminar de backlog.yml.
