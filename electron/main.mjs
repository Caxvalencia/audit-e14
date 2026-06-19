import electron from "electron";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../server.mjs";

const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = electron;
const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, "..");
const publicDir = resolve(appRoot, "public");
const preload = resolve(__dirname, "preload.cjs");
const iconPath = resolve(appRoot, "build", "icon.png");
const appName = "Auditoria E14";
const appDescription =
  "App local para inventariar, descargar y auditar metadatos de formularios E14 publicados por la Registraduria.";

let mainWindow;
let serverHandle;

app.setName(appName);

function showAboutDialog() {
  dialog.showMessageBox(mainWindow, {
    type: "info",
    title: `Acerca de ${appName}`,
    message: appName,
    icon: iconPath,
    detail: [
      `Version ${app.getVersion()}`,
      appDescription,
      "",
      "Fuente por defecto:",
      "https://divulgacione14presidente.registraduria.gov.co",
      "",
      "Los archivos generados se guardan localmente en la carpeta de salida configurada.",
      "Licencia MIT",
    ].join("\n"),
    buttons: ["OK"],
    defaultId: 0,
    noLink: true,
  });
}

function createMenu() {
  const template = [
    {
      label: appName,
      submenu: [
        {
          label: `Acerca de ${appName}`,
          click: showAboutDialog,
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide", label: `Ocultar ${appName}` },
        { role: "hideOthers", label: "Ocultar otras" },
        { role: "unhide", label: "Mostrar todo" },
        { type: "separator" },
        { role: "quit", label: `Salir de ${appName}` },
      ],
    },
    {
      label: "Archivo",
      submenu: [{ role: "close", label: "Cerrar ventana" }],
    },
    {
      label: "Editar",
      submenu: [
        { role: "undo", label: "Deshacer" },
        { role: "redo", label: "Rehacer" },
        { type: "separator" },
        { role: "cut", label: "Cortar" },
        { role: "copy", label: "Copiar" },
        { role: "paste", label: "Pegar" },
        { role: "selectAll", label: "Seleccionar todo" },
      ],
    },
    {
      label: "Ver",
      submenu: [
        { role: "reload", label: "Recargar" },
        { role: "toggleDevTools", label: "Herramientas de desarrollo" },
        { type: "separator" },
        { role: "resetZoom", label: "Tamano real" },
        { role: "zoomIn", label: "Acercar" },
        { role: "zoomOut", label: "Alejar" },
        { type: "separator" },
        { role: "togglefullscreen", label: "Pantalla completa" },
      ],
    },
    {
      label: "Ventana",
      submenu: [
        { role: "minimize", label: "Minimizar" },
        { role: "zoom", label: "Zoom" },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow() {
  serverHandle = await startServer({
    root: appRoot,
    publicDir,
    port: 0,
    host: "127.0.0.1",
  });

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1024,
    minHeight: 720,
    title: "Auditoria E14",
    icon: iconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload,
      sandbox: false,
    },
  });

  await mainWindow.loadURL(serverHandle.url);
}

ipcMain.handle("desktop:select-output-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Seleccionar carpeta de salida",
    properties: ["openDirectory", "createDirectory"],
  });

  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("desktop:open-path", async (_event, targetPath) => {
  if (!targetPath) {
    return { ok: false, error: "Ruta vacia" };
  }

  const error = await shell.openPath(String(targetPath));

  return error ? { ok: false, error } : { ok: true };
});

ipcMain.handle("desktop:show-item-in-folder", async (_event, targetPath) => {
  if (!targetPath) {
    return { ok: false, error: "Ruta vacia" };
  }

  shell.showItemInFolder(String(targetPath));

  return { ok: true };
});

app.whenReady().then(() => {
  createMenu();

  return createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("before-quit", async (event) => {
  if (!serverHandle) return;

  event.preventDefault();
  const handle = serverHandle;
  serverHandle = null;
  await handle.close();
  app.quit();
});
