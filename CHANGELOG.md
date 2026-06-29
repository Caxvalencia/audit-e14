# Changelog

Todos los cambios relevantes del proyecto se documentan en este archivo.

## Unreleased

## 1.1.3 - 2026-06-29

### Agregado

- Nuevo flujo OCR local para extraer votos por mesa desde PDFs E14 existentes.
- Nuevo comando CLI `node scripts/e14-audit.mjs ocr [filters]`.
- Nuevo endpoint `POST /api/ocr` con progreso NDJSON.
- Exportacion de `ocr-results.jsonl`, `ocr-results.csv` y `ocr-zone-summary.csv`.
- Boton `Extraer votos OCR` en la interfaz con estado por mesa y resumen de consistencia.
- Modal de progreso OCR con contadores, cancelacion y acceso a tablas de detalle/resumen.
- Opcion `--keep-ocr-images` y checkbox `Guardar recortes OCR` para conservar imagenes de depuracion.
- Proveedor OCR `Transformers.js` para clasificar digitos manuscritos con modelo local/ONNX configurable.

### Cambiado

- Renovado el README con encabezado visual, logo centrado, badges del stack y descripcion actualizada del proyecto.
- El OCR usa `Transformers.js` como proveedor por defecto y mantiene `tesseract` como alternativa.
- El OCR conserva resultados previos de `ocr-results.jsonl` y omite mesas ya procesadas cuando `skipExisting` esta activo.
- Las columnas numericas OCR del CSV y de la tabla solo se llenan para mesas consistentes; las lecturas dudosas quedan en columnas `raw_*`.

### Verificado

- Validacion sintactica del proyecto con `pnpm run check`.
- Prueba CLI OCR con `--limit 3`.
- Prueba API OCR con `POST /api/ocr` y `limit=2`.
- Prueba API OCR con resultados existentes validando `skipped`.

## 1.1.2 - 2026-06-21

### Corregido

- La normalizacion de URL base ahora acepta la URL publica con `/home` y la convierte a la base usada para cargar `/assets/temis`.
- La carga de JSON fuente ahora intenta refrescar datos remotos y usa `raw/*.json` solo como respaldo si falla la red.
- El boton `Abrir PDF` ahora sirve los PDFs remotos desde la app local para evitar navegar al visor web de la Registraduria.

### Verificado

- Validacion sintactica del proyecto con `pnpm run check`.
- Carga de inventario con la URL publica `/home` contra `/api/inventory`.
- Apertura de PDF remoto mediante `/api/remote-file` validada con respuesta `application/pdf`.

## 1.1.1 - 2026-06-21

### Cambiado

- Actualizada la fuente por defecto de la Registraduria a `https://e14segundavueltapresidente.registraduria.gov.co`.

### Verificado

- Validacion sintactica del proyecto con `pnpm run check`.

## 1.1.0 - 2026-06-19

### Agregado

- Nueva accion de validacion/auditoria para PDFs ya existentes en el sistema de archivos local.
- Comparacion de checksum SHA-256 entre el PDF local y el PDF remoto publicado por la Registraduria.
- Comparacion de metadata local contra metadata remota, con reporte de campos diferentes.
- Nuevo endpoint `POST /api/verify` para ejecutar validaciones desde la interfaz.
- Nuevo comando CLI `node scripts/e14-audit.mjs verify [filters]`.
- Boton `Validar` por fila en la tabla de inventario cuando existe un archivo local cargado.
- Detalle de validacion en la interfaz: checksum remoto, resultado de checksum, resultado de metadata, bytes remotos, fecha de validacion y diferencias encontradas.
- Estilos diferenciados para los botones de fila: `Cargar` en azul y `Validar` en verde, con estado deshabilitado neutral.

### Cambiado

- La auditoria ahora distingue entre descargar/cargar un PDF y validar un PDF local contra la fuente remota.
- Los resultados de validacion quedan registrados en `audit.jsonl` junto con los datos de auditoria existentes.

### Verificado

- Validacion sintactica del proyecto con `pnpm run check`.
