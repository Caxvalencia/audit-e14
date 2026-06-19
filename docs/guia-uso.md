# Guia de uso

Esta herramienta permite inventariar, descargar y auditar formularios E14 desde la pagina publica de divulgacion de la Registraduria:

```text
https://divulgacione14presidente.registraduria.gov.co/home
```

La app usa los JSON y PDFs publicados por el sitio. No automatiza clics en la pagina oficial.

Si la fuente cambia de dominio pero conserva la estructura `/assets/temis`, se puede actualizar desde `Configuracion` en la interfaz o con `--base-url` en CLI.

## Requisitos

- Node.js con `fetch` nativo. Recomendado: Node 18 o superior.
- Dependencias instaladas con `pnpm install`.

### ExifTool (Extracción de Metadatos)

La aplicación utiliza **ExifTool** para enriquecer la extracción de metadatos de los PDFs descargados.

#### Decisión de Diseño: Opción B (Integración Embebida)
Para garantizar la portabilidad y asegurar que la herramienta funcione sin configuraciones adicionales ("plug-and-play"), se ha decidido integrar ExifTool directamente dentro del proyecto usando la dependencia de npm `exiftool-vendored` (Opción B). Esto incluye automáticamente los binarios correspondientes para **Windows, macOS y Linux** en `node_modules`, por lo que **no necesitas realizar ninguna instalación adicional en tu sistema**.

#### Opción A: Instalación Manual a Nivel de Sistema (Alternativa)
Si por cualquier motivo necesitas o prefieres utilizar una instalación de ExifTool propia a nivel de sistema (por ejemplo, para depurar fuera de Node o reducir el peso en otros entornos), puedes realizar la instalación manual siguiendo estos comandos según tu sistema operativo:

* **macOS:**
  Instalar mediante Homebrew:
  ```bash
  brew install exiftool
  ```
* **Linux (Debian/Ubuntu):**
  Instalar desde los repositorios oficiales:
  ```bash
  sudo apt update
  sudo apt install -y exiftool
  ```
* **Windows:**
  Instalar a través de Scoop o Chocolatey:
  ```bash
  scoop install exiftool
  # o bien:
  choco install exiftool
  ```
  *(Alternativamente, puedes descargar el archivo ejecutable oficial `.zip` de [exiftool.org](https://exiftool.org/), renombrar `exiftool(-k).exe` a `exiftool.exe` y guardarlo en una carpeta agregada al `PATH` del sistema).*

Para verificar que esté disponible en tu sistema si decides instalarlo manualmente, puedes ejecutar:
```bash
exiftool -ver
```

La extracción base de metadatos se hace con la librería `pdf-lib` (siempre disponible después de `pnpm install`), y la herramienta la combina automáticamente con la obtenida a través de `exiftool-vendored`.

## Desplegar en local

Desde la carpeta del proyecto:

```bash
cd /Users/cax/Desktop/formularios-e-14
pnpm install
node server.mjs
```

Abrir en el navegador:

```text
http://localhost:4173
```

Para cambiar el puerto:

```bash
PORT=5000 node server.mjs
```

## Flujo recomendado en la interfaz

1. Seleccionar filtros: departamento, municipio, zona y puesto.
2. Abrir `Configuracion`.
3. Definir `Limite`, `Hilos`, `Carpeta salida`, `Omitir existentes` y `Metadatos`.
4. Si se necesita otra fuente, cambiar `URL base`.
5. Hacer clic en `Cargar base de datos` para revisar cuantos registros entran en la consulta.
6. Hacer clic en `Descargar y auditar`.
7. Revisar progreso, tabla y panel de detalle.
8. Usar `Cancelar descarga` si el lote es demasiado grande o se eligieron filtros incorrectos.

## Tabla, paginacion y busqueda

La interfaz carga todos los registros que coinciden con los filtros, pero solo renderiza una pagina a la vez para mantener la tabla fluida.

- El selector `Filas` controla cuantas filas se muestran por pagina: 25, 50, 100 o 250.
- Los botones `«`, `‹`, `›`, `»` navegan a primera, anterior, siguiente y ultima pagina.
- La busqueda revisa todas las columnas y campos disponibles del inventario y auditoria.
- La busqueda ignora mayusculas, minusculas, tildes y separadores. Por ejemplo, `San Cristobal Merida` encuentra `San Cristóbal - Mérida`.
- Si se busca una palabra parcial, tambien puede coincidir. Por ejemplo, `amazona` encuentra `AMAZONAS`.

## Campos de filtro

`Departamento`
: Filtra por codigo de departamento. Ejemplo: `60 - AMAZONAS`.

`Municipio`
: Filtra los municipios del departamento seleccionado. Ejemplo: `010 - EL ENCANTO`.

`Zona`
: Filtra la zona electoral. En la ruta del PDF la zona se usa con 3 digitos, por ejemplo `00` en pantalla se convierte en `000`.

`Puesto`
: Filtra el puesto de votacion. Ejemplo: `00 - CORREGIMIENTO DEPARTAMENTAL`.

`Corporacion`
: Actualmente aparece `001 - PRESIDENTE`. La ruta PDF usa el acronimo `PRE`.

## Configuracion

La modal `Configuracion` agrupa los ajustes operativos que no cambian la ubicacion electoral filtrada:

`URL base`
: Fuente de datos usada para los JSON y PDFs. Por defecto: `https://divulgacione14presidente.registraduria.gov.co`.

`Carpeta salida`
: Carpeta local donde se escriben inventarios, auditoria, cache JSON y PDFs. Por defecto: `output/e14`.

`Limite`
: Cantidad maxima de registros que se procesan. `0` procesa todo lo filtrado.

`Hilos`
: Concurrencia de descarga/auditoria de PDFs.

`Omitir existentes`
: Reutiliza PDFs ya descargados en la carpeta de salida cuando estan presentes.

`Metadatos`
: Extrae metadata del PDF con `pdf-lib` y, si esta disponible, `exiftool`.

## Que significa Limite

`Limite` controla cuantos registros maximos procesa la consulta.

- `0`: sin limite. Procesa todo lo que coincida con los filtros.
- `1`, `3`, `100`, etc.: procesa solo esa cantidad de registros.

Usos recomendados:

- Prueba rapida: `Limite = 3`.
- Validar un puesto pequeno: `Limite = 0` con departamento, municipio, zona y puesto seleccionados.
- Descarga nacional: `Limite = 0` sin filtros, solo si realmente se quiere procesar todo.

## Que significa Hilos

`Hilos` es la concurrencia de descarga, es decir, cuantos PDFs se descargan/auditan en paralelo.

- `1`: mas lento, menor carga para el servidor, util para pruebas o cancelacion controlada.
- `4`: valor recomendado por defecto.
- `6`: razonable para lotes grandes si la conexion es estable.
- `12`: agresivo; usar con cautela.

Aunque se llame `Hilos`, no crea threads del sistema para cada PDF. Es concurrencia asincrona de red en Node.js.

## Boton Cancelar descarga

Durante una descarga aparece `Cancelar descarga`.

Al hacer clic:

- El navegador aborta la peticion activa.
- El servidor recibe la senal y deja de encolar nuevos PDFs.
- Pueden quedar algunos archivos ya descargados si estaban en proceso cuando se cancelo.
- El archivo `audit.jsonl` queda con las filas auditadas hasta el momento.

## Salidas generadas

Para una carpeta de salida `output/e14`, se generan:

```text
output/e14/
  raw/
    allCorporations.json
    allTransmissionCodes.json
    departmentsTree.json
  inventory.csv
  inventory.jsonl
  audit.jsonl
  pdf/
    {dep}/{mun}/{zona3}/{puesto}/{mesa}/PRE/{archivo.pdf}
```

`inventory.csv`
: Inventario plano con ubicacion, mesa, estado, ruta relativa y URL del PDF.

`inventory.jsonl`
: Mismo inventario en JSON Lines.

`audit.jsonl`
: Resultado por PDF descargado/auditado. Incluye estado, ruta local, bytes, SHA-256, cabecera PDF y metadata.

`pdf/`
: PDFs descargados, conservando la estructura del sitio oficial.

Si se usa una URL base personalizada, el cache JSON se guarda en una subcarpeta hash dentro de `raw/` para no mezclar fuentes.

## Metadata

El panel de detalle muestra:

- Departamento, municipio, zona, puesto y mesa.
- Nombre del archivo PDF.
- SHA-256 calculado localmente.
- Tamano.
- Error, si lo hubo.
- Paginas y version PDF cuando estan disponibles.
- Metadata base extraida con `pdf-lib`.
- Metadata adicional reportada por `exiftool`, si esta instalado.

Ejemplos de campos de metadata:

- `MetadataSource`
- `NodePdfLibrary`
- `FileType`
- `MIMEType`
- `PDFVersion`
- `PageCount`
- `Linearized`
- `FileModifyDate`
- `FileSize`
- `SourceFile`

La metadata disponible depende de lo que contenga cada PDF y de lo que `exiftool` pueda leer.

## Uso por CLI

Cargar base de datos para Amazonas:

```bash
node scripts/e14-audit.mjs inventory --department 60
```

Descargar el puesto de ejemplo:

```bash
node scripts/e14-audit.mjs download --department 60 --municipality 010 --zone 00 --stand 00
```

Prueba pequena:

```bash
node scripts/e14-audit.mjs download --department 60 --municipality 010 --zone 00 --stand 00 --limit 3
```

Cambiar carpeta de salida:

```bash
node scripts/e14-audit.mjs download --department 60 --out output/amazonas
```

Cambiar URL base:

```bash
node scripts/e14-audit.mjs inventory --base-url https://nuevo-dominio.example
```

Descarga con concurrencia moderada:

```bash
node scripts/e14-audit.mjs download --concurrency 6
```

Omitir metadata:

```bash
node scripts/e14-audit.mjs download --department 60 --no-metadata
```

Redescargar aunque ya existan PDFs:

```bash
node scripts/e14-audit.mjs download --department 60 --no-skip-existing
```

## Recomendaciones operativas

- Empezar siempre con filtros y `Limite = 3`.
- Revisar el inventario antes de una descarga grande.
- Usar `Hilos = 4` como valor base.
- Para descargas nacionales, usar horarios de baja carga y evitar concurrencias altas.
- No versionar `output/`; ya esta incluido en `.gitignore`.
