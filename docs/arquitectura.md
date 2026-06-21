# Arquitectura y funcionamiento tecnico

## Componentes

```text
server.mjs
public/
  index.html
  styles.css
  app.js
scripts/
  e14-audit.mjs
```

`server.mjs`
: Servidor HTTP local sin dependencias externas. Expone la interfaz web y una API local.

`public/`
: Interfaz grafica. Maneja filtros, inventario, descarga, cancelacion, progreso y panel de detalle.

`scripts/e14-audit.mjs`
: Motor compartido entre CLI y servidor. Carga JSON fuente, arma inventarios, descarga PDFs, valida cabecera PDF, calcula SHA-256 y lee metadata con `pdf-lib`; si `exiftool` existe, agrega sus campos como complemento.

## Fuentes de datos

La fuente por defecto es:

```text
https://e14segundavueltapresidente.registraduria.gov.co
```

La interfaz permite cambiar esta URL desde `Configuracion`. El backend conserva la fuente por defecto si no se envia `baseUrl`.

La pagina oficial carga informacion desde archivos publicados bajo `/assets/temis`:

```text
https://e14segundavueltapresidente.registraduria.gov.co/assets/temis/divipol_json/departmentsTree.json
https://e14segundavueltapresidente.registraduria.gov.co/assets/temis/divipol_json/allCorporations.json
https://e14segundavueltapresidente.registraduria.gov.co/assets/temis/divipol_json/allTransmissionCodes.json
```

El codigo no hace scraping visual. Usa esos archivos para construir el inventario.

## Construccion de URL PDF

Cada registro de `allTransmissionCodes.json` contiene:

- `idDepartmentCode`
- `municipalityCode`
- `idZoneCode`
- `standCode`
- `numberStand`
- `idCorporationCode`
- `expectedName`

La ruta PDF se construye asi:

```text
assets/temis/pdf/{departamento}/{municipio}/{zona3}/{puesto}/{mesa}/{acronimo}/{expectedName}
```

Ejemplo:

```text
assets/temis/pdf/60/010/000/00/001/PRE/da8a0ec5a8f7df708bae53b9ea00394738de11707aadc05b959a5444f06999e1.pdf
```

Reglas de padding:

- Departamento: 2 digitos.
- Municipio: 3 digitos.
- Zona para filtros: 2 digitos.
- Zona en ruta PDF: 3 digitos.
- Puesto: 2 digitos.
- Mesa: 3 digitos.
- Corporacion: 3 digitos.

## API local

El servidor local expone:

### `GET /api/config`

Entrega valores de configuracion que la interfaz necesita antes de cargar catalogos.

Respuesta:

```json
{
  "defaultBaseUrl": "https://e14segundavueltapresidente.registraduria.gov.co"
}
```

### `GET /api/catalog`

Carga catalogo para selects:

- corporaciones
- departamentos
- municipios
- zonas
- puestos

Parametro opcional:

```text
out=output/e14
baseUrl=https://e14segundavueltapresidente.registraduria.gov.co
```

### `GET /api/inventory`

Genera inventario segun filtros.

Parametros:

```text
department=60
municipality=010
zone=00
stand=00
corporation=001
limit=3
out=output/e14
baseUrl=https://e14segundavueltapresidente.registraduria.gov.co
pageSize=1000
```

Respuesta:

```json
{
  "summary": {
    "total": 3,
    "published": 3,
    "pending": 0,
    "departments": 1,
    "municipalities": 1,
    "stands": 1
  },
  "records": [],
  "output": {
    "inventoryCsv": "output/e14/inventory.csv",
    "inventoryJsonl": "output/e14/inventory.jsonl"
  }
}
```

### `POST /api/download`

Inicia descarga/auditoria y responde como NDJSON para progreso en vivo.

Body:

```json
{
  "department": "60",
  "municipality": "010",
  "zone": "00",
  "stand": "00",
  "corporation": "001",
  "limit": 3,
  "concurrency": 4,
  "out": "output/e14",
  "baseUrl": "https://e14segundavueltapresidente.registraduria.gov.co",
  "skipExisting": true,
  "metadata": true
}
```

Eventos:

```json
{"type":"start","summary":{},"total":3}
{"type":"row","done":1,"failed":0,"total":3,"row":{}}
{"type":"complete","auditFile":"output/e14/audit.jsonl","failed":0,"total":3}
```

Si se cancela:

```json
{"type":"canceled","auditFile":"output/e14/audit.jsonl","failed":0,"total":100,"done":12,"canceled":true}
```

### `GET /api/file`

Sirve un archivo local dentro del workspace.

Ejemplo:

```text
/api/file?path=output/e14/pdf/60/010/000/00/001/PRE/archivo.pdf
```

## Cancelacion

La interfaz usa `AbortController` para cancelar `POST /api/download`.

El servidor escucha `close` en la peticion. Si el navegador cierra el stream:

- se aborta la senal interna;
- el motor deja de iniciar nuevas descargas;
- las tareas que ya estaban en curso pueden terminar o abortar segun el momento;
- el archivo `audit.jsonl` conserva lo que ya se escribio.

## Validaciones por PDF

Por cada PDF:

1. Descarga el archivo o reutiliza el existente si `skipExisting = true`.
2. Lee el archivo local.
3. Valida que la cabecera empiece con `%PDF-`.
4. Calcula SHA-256.
5. Extrae metadata base con `pdf-lib`.
6. Deriva campos locales como `PDFVersion`, `MIMEType`, `FileSize`, `FileName` y `SourceFile`.
7. Ejecuta `exiftool -json archivo.pdf` si esta disponible para enriquecer la metadata.
8. Escribe una fila en `audit.jsonl`.

`MetadataSource` indica que fuente se uso:

- `pdf-lib`: solo metadata Node/base.
- `pdf-lib+exiftool`: metadata base mas campos adicionales de `exiftool`.

## Archivos ignorados por Git

`.gitignore` excluye:

- `output/`
- `.playwright-mcp/`
- capturas `*.png`
- logs
- `node_modules/`
- `.env`

Esto evita versionar PDFs, caches, inventarios generados y archivos temporales.

## Riesgos y mantenimiento

- Si la Registraduria cambia de dominio pero conserva `assets/temis`, se puede actualizar `baseUrl` desde la modal `Configuracion`.
- Si la Registraduria cambia la estructura de `assets/temis`, habra que ajustar la construccion de rutas.
- Si `allTransmissionCodes.json` deja de publicarse, habria que volver a GraphQL/AWS Amplify o inspeccionar el nuevo flujo.
- Si el sitio limita descargas, reducir `Hilos` y usar lotes filtrados.
- `exiftool` agrega metadata del archivo local ademas de metadata del PDF. Campos como `FileAccessDate` dependen de la maquina donde se audita.
- El cache de `raw/*.json` se mantiene en `output/e14/raw` para la fuente por defecto. Las fuentes personalizadas usan subcarpetas hash dentro de `raw/` para evitar mezclar datos de dominios distintos.
