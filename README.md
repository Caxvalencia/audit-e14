<p align="center">
  <img src="docs/logo.png" alt="Auditoria E14" width="120" />
</p>

# Auditoria formularios E14 Registraduria

App local para inventariar, descargar y auditar metadatos de formularios E14 publicados por la Registraduria.

Sitio fuente:

```text
https://divulgacione14presidente.registraduria.gov.co/home
```

## Descargas (Última versión)

Los instaladores y ejecutables son generados automáticamente por el pipeline de GitHub Actions en cada versión.

| Sistema Operativo                                                                                                                       | Formato     | Enlace de Descarga                                                                                                        |
| :-------------------------------------------------------------------------------------------------------------------------------------- | :---------- | :------------------------------------------------------------------------------------------------------------------------ |
| <img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/apple/apple-original.svg" width="32" height="32" /> **macOS**              | `.dmg`      | [Descargar para macOS](https://github.com/Caxvalencia/audit-e14/releases/latest/download/Auditoria%20E14-1.0.0-arm64.dmg)         |
| <img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/windows8/windows8-original.svg" width="32" height="32" /> **Windows**      | `.exe`      | [Descargar para Windows](https://github.com/Caxvalencia/audit-e14/releases/latest/download/Auditoria%20E14%20Setup%201.0.0.exe) |
| <img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/linux/linux-original.svg" width="32" height="32" /> **Linux (AppImage)**   | `.AppImage` | [Descargar AppImage](https://github.com/Caxvalencia/audit-e14/releases/latest/download/Auditoria%20E14-1.0.0.AppImage)      |
| <img src="https://cdn.jsdelivr.net/gh/devicons/devicon/icons/linux/linux-original.svg" width="32" height="32" /> **Linux (Deb/Ubuntu)** | `.deb`      | [Descargar .deb](https://github.com/Caxvalencia/audit-e14/releases/latest/download/audit-e-14_1.0.0_amd64.deb)         |

> [!NOTE]
> Puedes encontrar todos los compilados y versiones previas en la sección de [Releases de GitHub](https://github.com/Caxvalencia/audit-e14/releases).

## Documentacion

- [Guia de uso](docs/guia-uso.md): instalacion local, interfaz, filtros, limite, hilos, salidas, metadata y CLI.
- [Arquitectura](docs/arquitectura.md): endpoints, construccion de rutas PDF, API local, cancelacion y validaciones.

## Inicio rapido

Desde esta carpeta:

```bash
pnpm install
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
pnpm run desktop
```

Build local sin instalador:

```bash
pnpm run pack
```

Distribuible:

```bash
pnpm run dist
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
