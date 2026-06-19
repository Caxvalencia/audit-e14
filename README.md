<p align="center">
  <img src="docs/logo.png" alt="Auditoria E14" width="120" />
</p>

# Auditoria formularios E14 Registraduria

App local para inventariar, descargar y auditar metadatos de formularios E14 publicados por la Registraduria.

Sitio fuente:

```text
https://divulgacione14presidente.registraduria.gov.co/home
```

## Documentacion

- [Guia de uso](docs/guia-uso.md): instalacion local, interfaz, filtros, limite, hilos, salidas, metadata y CLI.
- [Arquitectura](docs/arquitectura.md): endpoints, construccion de rutas PDF, API local, cancelacion y validaciones.

## Inicio rapido

Desde esta carpeta:

```bash
npm install
node server.mjs
```

Abrir:

```text
http://localhost:4173
```

Para cambiar el puerto:

```bash
PORT=5000 node server.mjs
```

## Aplicacion de escritorio

La app tambien puede ejecutarse con Electron. Usa el mismo motor local de inventario, descarga y auditoria, pero abre una ventana de escritorio y permite seleccionar la carpeta de salida con un dialogo nativo.

Modo desarrollo:

```bash
npm run desktop
```

Build local sin instalador:

```bash
npm run pack
```

Distribuible:

```bash
npm run dist
```

La build queda en `dist/`, que esta excluida de Git.

## Uso recomendado

1. Seleccionar departamento, municipio, zona y puesto.
2. Abrir `Configuracion`.
3. Usar `Limite = 3` para una prueba rapida.
4. Mantener `Hilos = 4` para una concurrencia moderada.
5. Revisar `Carpeta salida`, `Omitir existentes`, `Metadatos` y `URL base`.
6. Hacer clic en `Cargar base de datos`.
7. Hacer clic en `Descargar y auditar`.
8. Revisar tabla, progreso, hash SHA-256 y metadata completa del PDF en el panel de detalle.

Durante una descarga aparece `Cancelar descarga`.

## CLI

Inventario filtrado:

```bash
node scripts/e14-audit.mjs inventory --department 60 --municipality 010 --zone 00 --stand 00
```

Descarga y auditoria:

```bash
node scripts/e14-audit.mjs download --department 60 --municipality 010 --zone 00 --stand 00 --limit 3
```

Fuente personalizada:

```bash
node scripts/e14-audit.mjs inventory --base-url https://nuevo-dominio.example
```

## Salidas

Por defecto escribe en `output/e14`:

- `raw/*.json`: cache de JSON fuente.
- `inventory.csv`: inventario plano.
- `inventory.jsonl`: inventario en JSON Lines.
- `audit.jsonl`: resultado por PDF, hash y metadata.
- `pdf/...`: PDFs descargados.

`output/` esta excluido en `.gitignore`.
