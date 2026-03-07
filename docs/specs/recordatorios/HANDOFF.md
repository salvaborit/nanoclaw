# Handoff: Sistema de Recordatorios para Sofibot

## Contexto

Estas instrucciones son para un agente AI que opera en la máquina destino. El objetivo es reemplazar el sistema de tareas actual del grupo WhatsApp "Bot" con un sistema de recordatorios en español, operado por "Sofibot".

Los archivos de este directorio contienen las configuraciones adaptadas. Este documento explica dónde va cada uno y qué pasos seguir.

## Entorno Destino

- Home: `/home/sbarreto/`
- NanoClaw: `/home/sbarreto/nanoclaw/`
- Grupo WhatsApp existente: "Bot" (actualmente gestiona tareas)

## Mapeo de Archivos

| Archivo fuente (este directorio) | Destino en NanoClaw | Acción |
|---|---|---|
| `SKILL.md` | `container/skills/recordatorios/SKILL.md` | Crear directorio y copiar |
| `SPEC.md` | Directorio de datos de tareas del grupo Bot (ver abajo) | Copiar |
| `jarvis-agenda-CLAUDE.md` | `groups/{carpeta-del-grupo-bot}/CLAUDE.md` | Reemplazar existente |
| `global-CLAUDE.md` | `groups/global/CLAUDE.md` | Reemplazar existente |

## Pasos

### 1. Identificar la carpeta del grupo Bot

Leer `/home/sbarreto/nanoclaw/data/registered_groups.json` y encontrar la entrada del grupo "Bot". Anotar el campo `folder` — ese es el nombre de la carpeta bajo `groups/`.

### 2. Identificar el directorio de datos de tareas

El grupo Bot debería tener un mount de tareas configurado. Buscar en `registered_groups.json` la entrada del grupo Bot:
- Si tiene `containerConfig.additionalMounts` con un mount de tareas, anotar el `hostPath`
- Si el directorio de tareas está en `~/tasks/` o similar, usar esa ruta

El `SPEC.md` va en la raíz de ese directorio de tareas (donde están `backlog.yml`, `daily/`, `archive/`).

### 3. Crear el skill de recordatorios

```bash
mkdir -p /home/sbarreto/nanoclaw/container/skills/recordatorios/
cp SKILL.md /home/sbarreto/nanoclaw/container/skills/recordatorios/SKILL.md
```

### 4. Copiar el SPEC.md al directorio de datos

```bash
# Ajustar la ruta según lo encontrado en el paso 2
cp SPEC.md /home/sbarreto/tasks/SPEC.md
```

### 5. Actualizar el CLAUDE.md del grupo Bot

```bash
# Ajustar {carpeta-del-grupo-bot} según lo encontrado en el paso 1
cp jarvis-agenda-CLAUDE.md /home/sbarreto/nanoclaw/groups/{carpeta-del-grupo-bot}/CLAUDE.md
```

### 6. Actualizar el CLAUDE.md global

```bash
cp global-CLAUDE.md /home/sbarreto/nanoclaw/groups/global/CLAUDE.md
```

**Nota:** esto cambia la personalidad del bot para TODOS los grupos, no solo Bot. Si hay otros grupos que necesitan mantener la personalidad actual, hacer backup primero y evaluar si el cambio global es deseado. Si solo se quiere cambiar para el grupo Bot, omitir este paso y poner el contenido de `global-CLAUDE.md` al inicio del CLAUDE.md del grupo Bot directamente.

### 7. Eliminar o renombrar el skill viejo (opcional)

Si existe `container/skills/tasks/SKILL.md` y ya no se necesita:

```bash
# Opción A: renombrar
mv /home/sbarreto/nanoclaw/container/skills/tasks/ /home/sbarreto/nanoclaw/container/skills/tasks.bak/

# Opción B: eliminar
rm -rf /home/sbarreto/nanoclaw/container/skills/tasks/
```

### 8. Reconstruir el container (si aplica)

Si los skills se incluyen en el container image:

```bash
cd /home/sbarreto/nanoclaw
./container/build.sh
```

### 9. Reiniciar NanoClaw

```bash
systemctl --user restart nanoclaw
```

## Migración de Datos

Si ya existe un `backlog.yml` con tareas del sistema anterior:

- **Las tareas existentes siguen siendo válidas.** El esquema nuevo es un superset compatible.
- Campos nuevos que no existan en tareas viejas se tratan como su default:
  - `notificaciones` → `[]` (sin notificaciones)
  - `priority` → `null` (antes era obligatorio con default 3, ahora es nullable)
  - `effort` → `null` (antes era obligatorio con default unknown, ahora es nullable)
  - `project` → `null` (antes era obligatorio, ahora es nullable)
  - `tags` → `[]`
- **No es necesario migrar** los datos existentes. El sistema nuevo los lee sin problemas.
- Los estados viejos (`backlog`, `pending`, `in_progress`, `paused`, `blocked`, `depends_on`) no existen en el sistema nuevo. Si hay tareas con esos estados, convertirlas:
  - `backlog`, `pending`, `in_progress`, `paused` → `pendiente`
  - `blocked`, `depends_on` → `pendiente`
  - `completed` → `completado`

## Cambios Clave vs. Sistema Anterior

| Aspecto | Antes (tasks) | Ahora (recordatorios) |
|---|---|---|
| Idioma | Inglés | Español |
| Nombre del bot | Jarvis | Sofibot |
| Campos requeridos | name, project, priority, effort, tags, state | Solo name |
| Estados | 7 (backlog, pending, in_progress, paused, blocked, depends_on, completed) | 3 (pendiente, completado, cancelado) |
| Completado | Manual | Automático al vencer due |
| Notificaciones | No existían | Lista de avisos programados con hora |
| Consultas | Scoring algorithm (prioridad, veces pospuesto, etc.) | Cronológico (próximo due primero) |
| Zona horaria | No especificada | UTC-3 (Argentina), siempre |
| Skill name | `tasks` | `recordatorios` |

## Verificación

Después de aplicar los cambios:

1. Enviar al grupo Bot: "haceme acordar mañana a las 9 de llamar al banco"
2. Verificar que Sofibot responda en español con un resumen del recordatorio creado
3. Verificar que se creó la entrada en `backlog.yml` con `notificaciones` o `due` correctos
4. Enviar: "qué tengo pendiente"
5. Verificar que responde con lista cronológica en español
6. Enviar: "cancelá el recordatorio de llamar al banco"
7. Verificar que cambia estado a `cancelado`
