---
name: sales
description: "Seguimiento de ventas: clientes, reuniones, demos, entregables y propuestas. Usar cuando pregunten sobre clientes, proximas reuniones, que hay pendiente, agenda de ventas, pipeline comercial, o cuando llegue un mensaje de nuevo lead."
---

# Seguimiento de Ventas

Datos en `/workspace/extra/sales/`. Un archivo `.yml` por cliente.

## Schema del Cliente

Archivo: `/workspace/extra/sales/{slug}.yml`

Slug = nombre del cliente en minusculas, espacios reemplazados por guiones, sin acentos ni caracteres especiales. Ejemplos: `jose-bejarano.yml`, `acme-corp.yml`, `banco-nacional.yml`.

```yaml
nombre: "Jose Alberto Bejarano Meneses"
aliases:
  - "jose bejarano"
  - "soyjosebejarano"
empresa: "Soyjosebejano"
web_redes: "@soyjosebejarano en Tiktok"
descripcion: "Tiene un proyecto ya aterrizado en App movil y busca un equipo que lo desarrolle"
inversion: "$7.000 a $20.000 USD"
idea: "Una aplicacion para que soliciten servicio de moto"
correo: "josebejaranoj075@gmail.com"
telefono: "+573107392249"
nicho: "ADV | TRANSPORTE - APP UBER - GPT 2 - 22/1"
fecha_ingreso: "2026-03-06 18:00"
contacto: ""
notas: ""

items:
  - nombre: "Reunion inicial"
    tipo: reunion
    contexto: "Primera reunion para entender requerimientos"
    fecha: "2026-03-10 15:00"
    estado: pendiente
    notas: ""
```

### Campos del Cliente

| Campo | Obligatorio | Descripcion |
|-------|-------------|-------------|
| nombre | si | Nombre completo del cliente/lead |
| aliases | si | Lista de nombres alternativos para busqueda |
| empresa | no | Nombre de la empresa |
| web_redes | no | Pagina web o redes sociales |
| descripcion | no | Como se identifica el lead, que busca |
| inversion | no | Rango de inversion declarado |
| idea | no | Descripcion breve del proyecto |
| correo | no | Email de contacto |
| telefono | no | Numero de telefono |
| nicho | no | Clasificacion interna del lead |
| fecha_ingreso | si | Fecha en que ingreso el lead (UTC-3) |
| contacto | no | Nombre del contacto principal si difiere del nombre |
| notas | no | Notas libres sobre el cliente |

### Campos de Items

| Campo | Obligatorio | Valores |
|-------|-------------|---------|
| nombre | si | Nombre descriptivo del item |
| tipo | si | `reunion` / `demo` / `entregable` / `propuesta` / `seguimiento` / `otro` |
| contexto | no | Contexto adicional |
| fecha | si | Fecha y hora local UTC-3, formato `YYYY-MM-DD HH:MM` |
| estado | si | `pendiente` / `completado` / `cancelado` |
| notas | no | Notas adicionales |

## Ingestion de Leads

Cuando llegue un mensaje con el patron de nuevo lead, detectalo y crea automaticamente el archivo YAML del cliente.

### Deteccion

El mensaje contiene indicadores como:
- `*Nuevo Lead*` o `Nuevo Lead`
- Campos con formato `*Campo:*` valor (Nombre, Empresa, Correo, Numero, etc.)
- Emojis de fuego/cohete al inicio

### Parseo

Extraer los siguientes campos del mensaje:

| Campo del mensaje | Campo YAML |
|-------------------|------------|
| `*Nombre:*` | `nombre` |
| `*Nombre de la empresa:*` | `empresa` |
| `*Pagina Web/Redes sociales:*` | `web_redes` |
| `*Como te identificas:*` | `descripcion` |
| `*Inversion:*` | `inversion` |
| `*Idea del proyecto:*` | `idea` |
| `*Correo:*` | `correo` |
| `*Numero:*` | `telefono` |
| `*Fecha:*` | `fecha_ingreso` |
| `*Nicho:*` | `nicho` |

### Proceso

1. Parsear todos los campos disponibles del mensaje
2. Ejecutar la Resolucion de Cliente (ver seccion abajo) con el nombre parseado
3. Si ya existe un match, actualizar el archivo existente con los campos nuevos del lead (no sobreescribir campos que ya tienen valor) y agregar una nota mencionando el lead duplicado
4. Si no existe ningun match, generar el slug y crear el archivo YAML con todos los campos parseados
6. Generar `aliases` automaticamente: nombre en minusculas, primer nombre + apellido, nombre de usuario de redes si hay
7. Dejar `items` como lista vacia (o con un item de "Contacto inicial" si se desea)
8. Confirmar con un mensaje corto:

```
Nuevo lead registrado: *{nombre}*
Empresa: {empresa}
Inversion: {inversion}
```

Si faltan campos, dejarlos vacios en el YAML (no preguntar al usuario).

## Resolucion de Cliente (CRITICO)

SIEMPRE antes de crear un archivo nuevo, ejecutar esta busqueda:

1. Leer TODOS los archivos `.yml` en `/workspace/extra/sales/`
2. Para cada archivo, comparar el texto buscado contra:
   - `nombre` (coincidencia parcial: "lucas" matchea "Lucas Silvestri")
   - Cada entrada en `aliases`
   - `empresa`
   - Nombre del archivo (slug)
3. La comparacion es case-insensitive y parcial (substring match)
4. Si hay match, usar ese archivo. NUNCA crear uno nuevo.
5. Si hay multiples matches, preguntar al usuario cual es.
6. Si no hay match pero el nombre es parcial o ambiguo (ej: solo un primer nombre como "lucas", "maria"), preguntar al usuario antes de crear: "No encontre un cliente que coincida con '{nombre}'. Creo uno nuevo?"
7. Solo crear un archivo nuevo si NO hay ningun match Y el nombre es suficientemente especifico (nombre completo o empresa), o si el usuario confirma.

Ejemplo: si existe `lucas-silvestri.yml` con `nombre: "Lucas Silvestri"` y el usuario dice "reunion con lucas", usar ese archivo.

## Crear Cliente (manual)

Cuando el usuario menciona un cliente nuevo fuera del formato de lead:
1. Ejecutar la Resolucion de Cliente (ver arriba)
2. Si ya existe, agregar al archivo existente
3. Si no existe, crear el archivo con los datos proporcionados
4. Campos no proporcionados quedan vacios
5. Confirmar brevemente

Minimo necesario: nombre del cliente.

## Agregar Items

Cuando el usuario pide agregar una reunion, demo, propuesta, etc:
1. Ejecutar la Resolucion de Cliente (ver arriba) para identificar el archivo
2. Inferir `tipo` del contexto:
   - "reunion con X" -> reunion
   - "demo para X" -> demo
   - "mandar propuesta" -> propuesta
   - "entregar X" -> entregable
   - "hacer seguimiento" -> seguimiento
3. Agregar el item a la lista `items` del cliente
4. Default estado: `pendiente`
5. Confirmar con una linea

## Actualizar Items

Buscar el item por nombre (coincidencia aproximada). Actualizar el campo indicado (estado, fecha, notas). Si hay ambiguedad entre items, preguntar.

## Consultas

### Logica de Filtrado por Fecha

Todas las fechas se interpretan en UTC-3 (Argentina).

- `hoy` / `today` -> items donde fecha es hoy
- `esta semana` -> lunes a domingo de la semana actual
- `proxima semana` -> lunes a domingo de la semana siguiente
- `proximos N dias` -> desde hoy hasta hoy + N dias
- `pendientes de [cliente]` -> todos los items con estado=pendiente de ese cliente
- `todo` / `pipeline` / `todos los pendientes` -> todos los items pendiente de todos los clientes
- `vencidos` / `overdue` -> items con fecha < hoy y estado=pendiente

### Proceso de Consulta

1. Leer TODOS los archivos `.yml` en `/workspace/extra/sales/`
2. Filtrar por rango de fecha y/o estado segun la consulta
3. Ordenar por fecha ascendente
4. Aplicar filtros adicionales (cliente especifico, tipo, etc.)

## Formato de Respuesta

CRITICO: las respuestas deben ser cortas y optimizadas para pantalla de celular.

### Reglas

- Una linea por item
- Formato por item: `* *{cliente}* -- {nombre item}, {fecha abreviada}`
- Fecha abreviada: `lun 10/3 15:00` (dia-semana DD/MM HH:MM)
- Agrupar por dia cuando el rango abarca varios dias
- NO usar headers, tablas, ni markdown mas alla de *bold* con asteriscos simples
- Si no hay resultados, decirlo en una linea
- Maximo ~10 items por respuesta. Si hay mas, mostrar los 10 mas urgentes y mencionar cuantos quedan

### Ejemplos

Consulta: "que hay para hoy?"
```
*Hoy, mie 5/3:*
* *Acme Corp* -- Demo plataforma, 15:00
* *Banco Nacional* -- Seguimiento propuesta, 17:00
```

Consulta: "que hay esta semana?"
```
*Mie 5/3:*
* *Acme Corp* -- Demo plataforma, 15:00

*Jue 6/3:*
* *TechSol* -- Entrega modulo reportes, 10:00

*Vie 7/3:*
* *Banco Nacional* -- Reunion cierre, 14:00
```

Consulta: "pendientes de acme?"
```
* Demo plataforma -- mie 5/3 15:00
* Propuesta fase 2 -- lun 10/3
```

Consulta: "pipeline"
```
*3 clientes, 7 items pendientes:*

* *Acme Corp* -- Demo plataforma, mie 5/3 15:00
* *Acme Corp* -- Propuesta fase 2, lun 10/3
* *TechSol* -- Entrega modulo, jue 6/3 10:00
* *Banco Nacional* -- Reunion cierre, vie 7/3 14:00
* *Banco Nacional* -- Seguimiento propuesta, mie 5/3 17:00
```

## Heartbeat

En cada heartbeat, escanear todos los archivos de clientes:

### Items de hoy (estado=pendiente, fecha=hoy)
Si hay items para hoy, enviar:
```
*Recordatorio:*
* *Acme Corp* -- Demo plataforma, 15:00
* *Banco Nacional* -- Seguimiento propuesta, 17:00
```

### Items vencidos (estado=pendiente, fecha < hoy)
Si hay items vencidos, enviar:
```
*Atencion -- vencidos:*
* *TechSol* -- Entrega modulo reportes, lun 3/3
* *Banco Nacional* -- Propuesta comercial, vie 28/2
```

### Ambos
Si hay items de hoy Y vencidos, combinar en un solo mensaje:
```
*Atencion -- vencidos:*
* *TechSol* -- Entrega modulo reportes, lun 3/3

*Hoy:*
* *Acme Corp* -- Demo plataforma, 15:00
```

### Silencio
Si no hay items para hoy ni vencidos, no enviar nada.
