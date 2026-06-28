#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { PDFDocument } from "pdf-lib";
import { ExifTool } from "exiftool-vendored";
import { PNG } from "pngjs";
// import ort from "onnxruntime-node";

const exiftoolInstanceOptions = {};

if (process.versions.electron) {
  const isPackaged =
    !process.defaultApp &&
    !process.execPath.includes("electron") &&
    !process.execPath.includes("Electron");

  if (isPackaged) {
    exiftoolInstanceOptions.exiftoolPath = (platform) => {
      const vendorPackage =
        platform === "win32" ? "exiftool-vendored.exe" : "exiftool-vendored.pl";
      const binaryName = platform === "win32" ? "exiftool.exe" : "exiftool";

      return join(
        process.resourcesPath,
        "app.asar.unpacked",
        "node_modules",
        vendorPackage,
        "bin",
        binaryName,
      );
    };
  }
}

const exiftool = new ExifTool(exiftoolInstanceOptions);

const DEFAULT_BASE_URL =
  "https://e14segundavueltapresidente.registraduria.gov.co";
const DEFAULT_OUT = "output/e14";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36";

function parseArgs(argv) {
  const args = {
    command: argv[2] || "help",
    out: DEFAULT_OUT,
    department: null,
    municipality: null,
    zone: null,
    stand: null,
    corporation: "001",
    limit: 0,
    concurrency: 4,
    skipExisting: true,
    metadata: true,
    keepOcrImages: false,
    ocrProvider: "tesseract",
    ocrModel: "",
    ocrLocalOnly: false,
    baseUrl: DEFAULT_BASE_URL,
  };

  if (args.command === "--help" || args.command === "-h") {
    args.command = "help";
  }

  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--out") args.out = next();
    else if (a === "--department") args.department = pad(next(), 2);
    else if (a === "--municipality") args.municipality = pad(next(), 3);
    else if (a === "--zone") args.zone = pad(next(), 2);
    else if (a === "--stand") args.stand = pad(next(), 2);
    else if (a === "--table") args.table = pad(next(), 3);
    else if (a === "--corporation") args.corporation = pad(next(), 3);
    else if (a === "--limit") args.limit = Number(next());
    else if (a === "--concurrency") args.concurrency = Number(next());
    else if (a === "--base-url") args.baseUrl = normalizeBaseUrl(next());
    else if (a === "--no-skip-existing") args.skipExisting = false;
    else if (a === "--no-metadata") args.metadata = false;
    else if (a === "--keep-ocr-images") args.keepOcrImages = true;
    else if (a === "--ocr-provider") args.ocrProvider = next();
    else if (a === "--ocr-model") args.ocrModel = next();
    else if (a === "--ocr-local-only") args.ocrLocalOnly = true;
    else if (a === "--help" || a === "-h") args.command = "help";
    else throw new Error(`Unknown argument: ${a}`);
  }

  return args;
}

function pad(value, width) {
  return String(value ?? "").padStart(width, "0");
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function normalizeBaseUrl(value = DEFAULT_BASE_URL) {
  const url = new URL(String(value || DEFAULT_BASE_URL).trim());
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (url.pathname === "/home") url.pathname = "/";
  url.search = "";
  url.hash = "";

  return url.toString().replace(/\/+$/, "");
}

function temisUrl(baseUrl = DEFAULT_BASE_URL) {
  return `${normalizeBaseUrl(baseUrl)}/assets/temis`;
}

function rawCacheDir(out, baseUrl = DEFAULT_BASE_URL) {
  const normalized = normalizeBaseUrl(baseUrl);

  if (normalized === DEFAULT_BASE_URL) {
    return join(out, "raw");
  }

  const key = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 12);

  return join(out, "raw", key);
}

async function fetchWithRetry(url, options = {}, attempts = 4) {
  let lastError;
  for (let i = 1; i <= attempts; i++) {
    assertNotAborted(options.signal);
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? 45000,
    );
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "user-agent": UA,
          accept: "*/*",
          ...(options.headers || {}),
        },
      });
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return res;
    } catch (error) {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      if (isAbortError(error) || options.signal?.aborted) throw error;
      lastError = error;
      if (i < attempts) await sleep(500 * i);
    }
  }
  throw lastError;
}

function assertNotAborted(signal) {
  if (signal?.aborted)
    throw new DOMException("Download canceled", "AbortError");
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

async function fetchJsonCached(url, cacheFile) {
  ensureDir(dirname(cacheFile));
  let lastError;

  for (let i = 1; i <= 3; i++) {
    const remoteUrl = `${url}${url.includes("?") ? "&" : "?"}uuid=${Date.now()}-${i}`;

    try {
      const res = await fetchWithRetry(
        remoteUrl,
        {
          timeoutMs: 12000,
          headers: {
            accept: "application/json, text/plain, */*",
            "cache-control": "no-cache",
            pragma: "no-cache",
          },
        },
        1,
      );

      const text = await res.text();
      const json = JSON.parse(text);
      writeFileSync(cacheFile, text);

      return json;
    } catch (error) {
      lastError = error;

      if (i < 3) {
        await sleep(500 * i);
      }
    }
  }

  if (existsSync(cacheFile)) {
    try {
      return JSON.parse(readFileSync(cacheFile, "utf8"));
    } catch (error) {
      throw new Error(`Invalid cached JSON at ${cacheFile}: ${error.message}`);
    }
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class LocalDatabase {
  constructor(out) {
    this.out = out;
    ensureDir(out);
    this.configPath = join(out, "config.json");
    this.inventoryPath = join(out, "inventory.jsonl");
    this.auditPath = join(out, "audit.jsonl");
    this.ocrPath = join(out, "ocr-results.jsonl");
  }

  // --- CONFIGURACIÓN ---
  loadConfig(defaults = {}) {
    if (!existsSync(this.configPath)) {
      return defaults;
    }

    try {
      const data = JSON.parse(readFileSync(this.configPath, "utf8"));
      return { ...defaults, ...data };
    } catch {
      return defaults;
    }
  }

  saveConfig(config) {
    ensureDir(this.out);
    writeFileSync(this.configPath, JSON.stringify(config, null, 2), "utf8");
  }

  // --- INVENTARIO ---
  loadInventory() {
    const records = [];

    if (!existsSync(this.inventoryPath)) {
      return records;
    }

    const content = readFileSync(this.inventoryPath, "utf8");

    for (const line of content.split("\n")) {
      if (!line.trim()) {
        continue;
      }

      try {
        records.push(JSON.parse(line));
      } catch {}
    }

    return records;
  }

  saveInventory(records) {
    ensureDir(this.out);

    writeFileSync(
      this.inventoryPath,
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
      "utf8",
    );

    const headers = [
      "department",
      "departmentName",
      "municipality",
      "municipalityName",
      "zone",
      "zoneName",
      "stand",
      "standName",
      "table",
      "corporation",
      "acronym",
      "status",
      "expectedName",
      "relativePdfPath",
      "pdfUrl",
    ];

    const csv = [
      headers.join(","),
      ...records.map((r) => headers.map((h) => csvEscape(r[h])).join(",")),
    ].join("\n");

    writeFileSync(join(this.out, "inventory.csv"), csv, "utf8");
  }

  // --- AUDITORÍAS (DESCARGA Y METADATOS) ---
  loadAudits(recordKeys) {
    const audits = {};

    if (!existsSync(this.auditPath)) {
      return audits;
    }

    const content = readFileSync(this.auditPath, "utf8");

    for (const line of content.split("\n")) {
      if (!line.trim()) {
        continue;
      }

      try {
        const row = JSON.parse(line);
        const key = recordKey(row);

        if (!recordKeys || recordKeys.has(key)) {
          if (row.localPath && existsSync(row.localPath)) {
            audits[key] = row;
          }
        }
      } catch {}
    }

    return audits;
  }

  saveAudit(row) {
    ensureDir(this.out);
    appendJsonl(this.auditPath, row);
  }

  // --- OCR ---
  loadOcr() {
    const rows = new Map();
    if (!existsSync(this.ocrPath)) {
      return rows;
    }

    const content = readFileSync(this.ocrPath, "utf8");

    for (const line of content.split("\n")) {
      if (!line.trim()) {
        continue;
      }

      try {
        const row = JSON.parse(line);
        rows.set(recordKey(row), row);
      } catch {}
    }

    return rows;
  }

  saveOcrRow(row) {
    ensureDir(this.out);
    appendJsonl(this.ocrPath, row);
  }

  saveOcrOutputs(rows) {
    ensureDir(this.out);
    writeFileSync(
      this.ocrPath,
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      "utf8",
    );

    const resultsCsv = join(this.out, "ocr-results.csv");
    const summaryCsv = join(this.out, "ocr-zone-summary.csv");
    const resultHeaders = ocrResultHeaders();
    const summaryHeaders = [
      "department",
      "departmentName",
      "municipality",
      "municipalityName",
      "zone",
      "zoneName",
      "stand",
      "standName",
      "corporation",
      "mesas_validadas",
      "candidato_1",
      "candidato_2",
      "votos_blanco",
      "votos_nulos",
      "votos_no_marcados",
      "total_votos_urna",
    ];

    writeFileSync(
      resultsCsv,
      [
        resultHeaders.join(","),
        ...rows.map((row) => ocrCsvRow(flattenOcrRow(row))),
      ].join("\n"),
      "utf8",
    );

    writeFileSync(
      summaryCsv,
      [
        summaryHeaders.join(","),
        ...zoneSummaryRows(rows).map((row) =>
          summaryHeaders.map((header) => csvEscape(row[header])).join(","),
        ),
      ].join("\n"),
      "utf8",
    );

    return { resultsJsonl: this.ocrPath, resultsCsv, summaryCsv };
  }
}

async function loadData(out, baseUrl = DEFAULT_BASE_URL) {
  const raw = rawCacheDir(out, baseUrl);
  const temis = temisUrl(baseUrl);
  const [transmission, departmentsTree, corporations] = await Promise.all([
    fetchJsonCached(
      `${temis}/divipol_json/allTransmissionCodes.json`,
      join(raw, "allTransmissionCodes.json"),
    ),
    fetchJsonCached(
      `${temis}/divipol_json/departmentsTree.json`,
      join(raw, "departmentsTree.json"),
    ),
    fetchJsonCached(
      `${temis}/divipol_json/allCorporations.json`,
      join(raw, "allCorporations.json"),
    ),
  ]);

  return {
    transmission,
    departmentsTree,
    corporations:
      corporations?.data?.allCorporations?.edges?.map((e) => e.node) ?? [],
  };
}

function buildLocationMaps(departmentsTree) {
  const departments =
    departmentsTree?.data?.departmentsTree?.edges?.map((e) => e.node) ?? [];
  const names = new Map();
  const standCounts = new Map();

  for (const dep of departments) {
    names.set(`dep:${pad(dep.idDepartmentCode, 2)}`, dep.departmentName);
    for (const mun of dep.municipalities ?? []) {
      const depCode = pad(dep.idDepartmentCode, 2);
      const munCode = pad(mun.municipalityCode, 3);
      names.set(`mun:${depCode}:${munCode}`, mun.municipalityName);
      for (const zone of mun.zones ?? []) {
        const zone2 = pad(zone.idZoneCode, 2);
        const zone3 = pad(zone.idZoneCode, 3);
        names.set(`zone:${depCode}:${munCode}:${zone2}`, zone.zoneName);
        for (const stand of zone.stands ?? []) {
          const standCode = pad(stand.standCode, 2);
          names.set(
            `stand:${depCode}:${munCode}:${zone2}:${standCode}`,
            stand.standName,
          );
          standCounts.set(
            `${depCode}|${munCode}|${zone2}|${standCode}`,
            Number(stand.countTable || 0),
          );
          standCounts.set(
            `${depCode}|${munCode}|${zone3}|${standCode}`,
            Number(stand.countTable || 0),
          );
        }
      }
    }
  }

  return { names, standCounts };
}

function recordsFromData(data, args) {
  const temis = temisUrl(args.baseUrl);
  const status3 = data.transmission?.data?.status3?.nodes ?? [];
  const status11 = data.transmission?.data?.status11?.nodes ?? [];
  const corpAcronyms = new Map(
    data.corporations.map((c) => [
      pad(c.idCorporationCode, 3),
      c.acronym || "XXX",
    ]),
  );
  const { names } = buildLocationMaps(data.departmentsTree);

  let records = [...status3, ...status11].map((n) => {
    const department = pad(n.idDepartmentCode, 2);
    const municipality = pad(n.municipalityCode, 3);
    const zone2 = pad(n.idZoneCode, 2);
    const zone3 = pad(n.idZoneCode, 3);
    const stand = pad(n.standCode, 2);
    const table = pad(n.numberStand, 3);
    const corporation = pad(n.idCorporationCode, 3);
    const acronym = corpAcronyms.get(corporation) || "XXX";
    const expectedName = String(n.expectedName || "");
    const relativePdfPath = `${department}/${municipality}/${zone3}/${stand}/${table}/${acronym}/${expectedName}`;

    return {
      idTransmissionCode: n.idTransmissionCode || "",
      status: n.idTransmissionCodeStatus,
      department,
      departmentName: names.get(`dep:${department}`) || "",
      municipality,
      municipalityName: names.get(`mun:${department}:${municipality}`) || "",
      zone: zone2,
      zoneName: names.get(`zone:${department}:${municipality}:${zone2}`) || "",
      stand,
      standName:
        names.get(`stand:${department}:${municipality}:${zone2}:${stand}`) ||
        "",
      table,
      corporation,
      acronym,
      expectedName,
      relativePdfPath,
      pdfUrl: `${temis}/pdf/${relativePdfPath}`,
    };
  });

  records = records.filter((r) => {
    if (args.department && r.department !== args.department) return false;
    if (args.municipality && r.municipality !== args.municipality) return false;
    if (args.zone && r.zone !== args.zone) return false;
    if (args.stand && r.stand !== args.stand) return false;
    if (args.table && r.table !== args.table) return false;
    if (args.corporation && r.corporation !== args.corporation) return false;

    return true;
  });

  records.sort((a, b) =>
    [a.department, a.municipality, a.zone, a.stand, a.table, a.corporation]
      .join("|")
      .localeCompare(
        [
          b.department,
          b.municipality,
          b.zone,
          b.stand,
          b.table,
          b.corporation,
        ].join("|"),
      ),
  );

  return args.limit > 0 ? records.slice(0, args.limit) : records;
}

function buildCatalog(data) {
  const departments =
    data.departmentsTree?.data?.departmentsTree?.edges?.map((e) => e.node) ??
    [];
  const byCode = (a, b) => Number(a.code) - Number(b.code);
  const corporations = data.corporations
    .map((c) => ({
      code: pad(c.idCorporationCode, 3),
      name: c.nameCorporation || "",
      acronym: c.acronym || "XXX",
    }))
    .sort(byCode);

  return {
    corporations,
    departments: departments
      .map((dep) => ({
        code: pad(dep.idDepartmentCode, 2),
        name: dep.departmentName,
        municipalities: (dep.municipalities ?? [])
          .map((mun) => ({
            code: pad(mun.municipalityCode, 3),
            name: mun.municipalityName,
            zones: (mun.zones ?? [])
              .map((zone) => ({
                code: pad(zone.idZoneCode, 2),
                code3: pad(zone.idZoneCode, 3),
                name: zone.zoneName,
                corporations: zone.corporations ?? [],
                stands: (zone.stands ?? [])
                  .map((stand) => ({
                    code: pad(stand.standCode, 2),
                    name: stand.standName,
                    countTable: Number(stand.countTable || 0),
                  }))
                  .sort(byCode),
              }))
              .sort(byCode),
          }))
          .sort(byCode),
      }))
      .sort(byCode),
  };
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function writeInventory(records, out) {
  const db = new LocalDatabase(out);
  db.saveInventory(records);
}

function localPdfPath(out, record) {
  return join(out, "pdf", record.relativePdfPath);
}

function ocrDebugDir(out, record) {
  return join(
    out,
    "ocr-debug",
    record.department,
    record.municipality,
    pad(record.zone, 3),
    record.stand,
    record.table,
  );
}

const OCR_FIELDS_2PAGE = [
  {
    key: "total_votos_urna",
    label: "Total votos en la urna",
    x: 0.7,
    y: 0.217,
    width: 0.25,
    height: 0.04,
  },
  {
    key: "candidato_1",
    label: "Candidato 1",
    x: 0.69,
    y: 0.411,
    width: 0.27,
    height: 0.055,
  },
  {
    key: "candidato_2",
    label: "Candidato 2",
    x: 0.69,
    y: 0.582,
    width: 0.27,
    height: 0.055,
  },
  {
    key: "votos_blanco",
    label: "Votos en blanco",
    x: 0.69,
    y: 0.709,
    width: 0.27,
    height: 0.025,
  },
  {
    key: "votos_nulos",
    label: "Votos nulos",
    x: 0.69,
    y: 0.739,
    width: 0.27,
    height: 0.025,
  },
  {
    key: "votos_no_marcados",
    label: "Votos no marcados",
    x: 0.69,
    y: 0.772,
    width: 0.27,
    height: 0.025,
  },
];

const OCR_FIELDS_3PAGE = [
  {
    key: "total_votos_urna",
    label: "Total votos en la urna",
    x: 0.7,
    y: 0.257,
    width: 0.25,
    height: 0.04,
  },
  {
    key: "candidato_1",
    label: "Candidato 1",
    x: 0.69,
    y: 0.399,
    width: 0.27,
    height: 0.055,
  },
  {
    key: "candidato_2",
    label: "Candidato 2",
    x: 0.69,
    y: 0.563,
    width: 0.27,
    height: 0.055,
  },
  {
    key: "votos_blanco",
    label: "Votos en blanco",
    x: 0.69,
    y: 0.788,
    width: 0.27,
    height: 0.025,
  },
  {
    key: "votos_nulos",
    label: "Votos nulos",
    x: 0.69,
    y: 0.800,
    width: 0.27,
    height: 0.025,
  },
  {
    key: "votos_no_marcados",
    label: "Votos no marcados",
    x: 0.69,
    y: 0.813,
    width: 0.27,
    height: 0.025,
  },
];

function getOcrFields(pageCount) {
  return pageCount === 2 ? OCR_FIELDS_2PAGE : OCR_FIELDS_3PAGE;
}

function detectTableYBounds(imagePath) {
  try {
    if (!existsSync(imagePath)) return null;
    const png = PNG.sync.read(readFileSync(imagePath));
    const height = png.height;
    const width = png.width;

    const xStart = Math.round(width * 0.15);
    const xEnd = Math.round(width * 0.85);
    const tableWidth = xEnd - xStart;

    const rowSums = Array(height).fill(0);
    for (let y = 0; y < height; y++) {
      for (let x = xStart; x < xEnd; x++) {
        const index = (width * y + x) << 2;
        const gray =
          png.data[index] * 0.299 +
          png.data[index + 1] * 0.587 +
          png.data[index + 2] * 0.114;
        if (gray < 170) {
          rowSums[y]++;
        }
      }
    }

    const lineThreshold = tableWidth * 0.25; // Reducido del 60% al 25% para mayor tolerancia global

    let yStart = null;
    const startLimit = Math.round(height * 0.38);
    for (let y = Math.round(height * 0.23); y < startLimit; y++) {
      if (rowSums[y] > lineThreshold) {
        let isMax = true;
        for (let dy = -5; dy <= 5; dy++) {
          if (rowSums[y + dy] > rowSums[y]) {
            isMax = false;
            break;
          }
        }
        if (isMax) {
          yStart = y;
          break;
        }
      }
    }

    let yEnd = null;
    const endLimit = Math.round(height * 0.80); // Extendido de 0.85 a 0.80 para PDFs de 2 páginas
    for (let y = Math.round(height * 0.92); y > endLimit; y--) {
      if (rowSums[y] > lineThreshold) {
        let isMax = true;
        for (let dy = -5; dy <= 5; dy++) {
          if (rowSums[y + dy] > rowSums[y]) {
            isMax = false;
            break;
          }
        }
        if (isMax) {
          yEnd = y;
          break;
        }
      }
    }

    if (yStart === null || yEnd === null) {
      return null;
    }

    return {
      yStartPct: yStart / height,
      yEndPct: yEnd / height,
    };
  } catch (error) {
    return null;
  }
}

function getAlignedOcrFields(imagePath, pageCount) {
  const fields = getOcrFields(pageCount);
  const bounds = detectTableYBounds(imagePath);
  console.log(`[OCR Global] PageCount: ${pageCount} | Bounds:`, bounds);
  if (!bounds) {
    return fields;
  }

  const { yStartPct, yEndPct } = bounds;
  const yStartRef = 0.205;
  const yEndRef = pageCount === 2 ? 0.835 : 0.878;

  return fields.map((field) => {
    const valRel = (field.y - yStartRef) / (yEndRef - yStartRef);
    const newY = yStartPct + valRel * (yEndPct - yStartPct);
    console.log(`  => Field ${field.key}: theoryY=${field.y} | alignedY=${newY.toFixed(4)}`);
    return {
      ...field,
      y: newY,
    };
  });
}

function ensureOcrTools(args = {}) {
  if (!commandExists("pdftoppm") && !commandExists("qlmanage")) {
    throw new Error("OCR requiere pdftoppm o qlmanage para renderizar PDFs");
  }

  if (!commandExists("tesseract")) {
    throw new Error("OCR requiere tesseract instalado en el sistema");
  }
}

function normalizeOcrProvider(provider = "tesseract") {
  return "tesseract";
}

function renderPdfPage(file, dir, pageNumber = 1) {
  if (commandExists("pdftoppm")) {
    const prefix = join(dir, "page");
    const result = spawnSync(
      "pdftoppm",
      [
        "-f",
        String(pageNumber),
        "-l",
        String(pageNumber),
        "-singlefile",
        "-png",
        "-r",
        "120",
        file,
        prefix,
      ],
      {
        encoding: "utf8",
        timeout: 30000,
      },
    );

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      throw new Error(
        result.stderr || result.stdout || "No se pudo renderizar PDF",
      );
    }

    const rendered = `${prefix}.png`;
    if (!existsSync(rendered)) {
      throw new Error("No se genero imagen para OCR");
    }

    return rendered;
  }

  const result = spawnSync("qlmanage", ["-t", "-s", "1800", "-o", dir, file], {
    encoding: "utf8",
    timeout: 30000,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || "No se pudo renderizar PDF",
    );
  }

  const files = spawnSync("find", [dir, "-maxdepth", "1", "-name", "*.png"], {
    encoding: "utf8",
  })
    .stdout.trim()
    .split("\n")
    .filter(Boolean)
    .sort();

  const rendered = files[pageNumber - 1] || files[0];

  if (!rendered) {
    throw new Error("No se genero imagen para OCR");
  }

  return rendered;
}

function imageSize(file) {
  const image = PNG.sync.read(readFileSync(file));

  return {
    width: image.width,
    height: image.height,
  };
}

function cropRegion(imageFile, dir, field, size, pageCount = 3) {
  const crop = {
    x: Math.round(size.width * field.x),
    y: Math.round(size.height * field.y),
    width: Math.round(size.width * field.width),
    height: Math.round(size.height * field.height),
  };
  const out = join(dir, `${field.key}.png`);
  const source = PNG.sync.read(readFileSync(imageFile));

  // --- LOCALIZADOR DINÁMICO ESTRUCTURAL 1D PARA VOTOS ---
  if (field.key.startsWith("votos_")) {
    try {
      const startSearchY = Math.round(source.height * 0.70);
      const endSearchY = Math.round(source.height * 0.95);

      // 1. Escanear el ANCHO CENTRAL COMPLETO de la imagen (30%-70%) para detectar líneas
      //    Las líneas de la grilla cruzan todo el formulario, así son mucho más fuertes
      //    que cualquier trazo de lápiz o firma localizada.
      const scanXStart = Math.round(source.width * 0.30);
      const scanXEnd = Math.round(source.width * 0.70);
      const scanWidth = scanXEnd - scanXStart;

      const rowSums = Array(source.height).fill(0);
      for (let y = startSearchY; y < endSearchY; y++) {
        for (let x = scanXStart; x < scanXEnd; x++) {
          const idx = (source.width * y + x) << 2;
          const gray =
            source.data[idx] * 0.299 +
            source.data[idx + 1] * 0.587 +
            source.data[idx + 2] * 0.114;
          if (gray < 140) rowSums[y]++;
        }
      }

      // 2. Detectar picos — solo líneas horizontales que cubren al menos 25% del ancho escaneado (umbral menor para tolerancia a firmas/ruido)
      const lineThreshold = scanWidth * 0.25;
      const detectedLines = [];

      for (let y = startSearchY + 3; y < endSearchY - 3; y++) {
        if (rowSums[y] > lineThreshold) {
          // Verificar que es un máximo local (±3 px)
          let isMax = true;
          for (let dy = -3; dy <= 3; dy++) {
            if (dy !== 0 && rowSums[y + dy] > rowSums[y]) {
              isMax = false;
              break;
            }
          }
          if (isMax) {
            // Distancia mínima de separación para detectar líneas consecutivas (proporcional al alto)
            const minLineSeparation = Math.round(source.height * 0.0045); // aprox 20px en H=4347
            if (detectedLines.length === 0 || y - detectedLines[detectedLines.length - 1] > minLineSeparation) {
              detectedLines.push(y);
            }
          }
        }
      }

      console.log(`[OCR Dynamic Grid] Field: ${field.key} | H: ${source.height} | fullWidth detectedLines:`, detectedLines);

      // Calcular límites de gaps adaptativamente según pageCount para excluir líneas de dígitos internas
      const minGap = pageCount === 2 ? 110 : 35;
      const maxGap = pageCount === 2 ? 165 : 85;
      const maxGapDiff = pageCount === 2 ? 20 : 25;

      // 3. Buscar la grilla de celdas uniformes (4 o 5 líneas) y seleccionar la celda más cercana al centro teórico del campo
      const targetCenterTheory = crop.y + crop.height / 2;

      let bestGridCell = null;
      let minDistance = Infinity;

      // Buscar combinaciones de 5 líneas (subsecuencia)
      for (let i = 0; i < detectedLines.length; i++) {
        const y0 = detectedLines[i];
        for (let j = i + 1; j < detectedLines.length; j++) {
          const y1 = detectedLines[j];
          const g0 = y1 - y0;
          if (g0 < minGap || g0 > maxGap) continue;
          for (let k = j + 1; k < detectedLines.length; k++) {
            const y2 = detectedLines[k];
            const g1 = y2 - y1;
            if (g1 < minGap || g1 > maxGap || Math.abs(g1 - g0) > maxGapDiff) continue;
            for (let l = k + 1; l < detectedLines.length; l++) {
              const y3 = detectedLines[l];
              const g2 = y3 - y2;
              if (g2 < minGap || g2 > maxGap || Math.abs(g2 - g1) > maxGapDiff || Math.abs(g2 - g0) > maxGapDiff) continue;
              for (let m = l + 1; m < detectedLines.length; m++) {
                const y4 = detectedLines[m];
                const g3 = y4 - y3;
                if (g3 < minGap || g3 > maxGap || Math.abs(g3 - g2) > maxGapDiff || Math.abs(g3 - g1) > maxGapDiff || Math.abs(g3 - g0) > maxGapDiff) continue;

                // Evaluar las 4 celdas formadas
                const celdas = [
                  [y0, y1],
                  [y1, y2],
                  [y2, y3],
                  [y3, y4]
                ];
                for (const [yA, yB] of celdas) {
                  const cellCenter = (yA + yB) / 2;
                  const dist = Math.abs(cellCenter - targetCenterTheory);
                  if (dist < minDistance) {
                    minDistance = dist;
                    bestGridCell = { yStart: yA, yEnd: yB, grid: [y0, y1, y2, y3, y4] };
                  }
                }
              }
            }
          }
        }
      }

      // Fallback: Buscar combinaciones de 4 líneas (subsecuencia)
      if (!bestGridCell || minDistance > 60) {
        for (let i = 0; i < detectedLines.length; i++) {
          const y0 = detectedLines[i];
          for (let j = i + 1; j < detectedLines.length; j++) {
            const y1 = detectedLines[j];
            const g0 = y1 - y0;
            if (g0 < minGap || g0 > maxGap) continue;
            for (let k = j + 1; k < detectedLines.length; k++) {
              const y2 = detectedLines[k];
              const g1 = y2 - y1;
              if (g1 < minGap || g1 > maxGap || Math.abs(g1 - g0) > maxGapDiff) continue;
              for (let l = k + 1; l < detectedLines.length; l++) {
                const y3 = detectedLines[l];
                const g2 = y3 - y2;
                if (g2 < minGap || g2 > maxGap || Math.abs(g2 - g1) > maxGapDiff || Math.abs(g2 - g0) > maxGapDiff) continue;

                // Evaluar las 3 celdas formadas
                const celdas = [
                  [y0, y1],
                  [y1, y2],
                  [y2, y3]
                ];
                for (const [yA, yB] of celdas) {
                  const cellCenter = (yA + yB) / 2;
                  const dist = Math.abs(cellCenter - targetCenterTheory);
                  if (dist < minDistance) {
                    minDistance = dist;
                    bestGridCell = { yStart: yA, yEnd: yB, grid: [y0, y1, y2, y3] };
                  }
                }
              }
            }
          }
        }
      }

      if (bestGridCell && minDistance <= 60) {
        console.log(`[OCR Dynamic Grid Debug] Field: ${field.key} | crop.y=${crop.y} | crop.height=${crop.height} | targetCenterTheory=${targetCenterTheory.toFixed(1)}`);
        console.log(`[OCR Dynamic Grid] SUCCESS! Field: ${field.key} | Grid: [${bestGridCell.grid.join(', ')}] | Selected cell: [${bestGridCell.yStart}, ${bestGridCell.yEnd}] (dist: ${minDistance.toFixed(1)}px)`);
        const cellCenter = (bestGridCell.yStart + bestGridCell.yEnd) / 2;
        crop.y = Math.round(cellCenter - 25);
        crop.height = 50;
        console.log(`  => Centered Y: ${crop.y} (center: ${cellCenter.toFixed(1)})`);
      } else {
        console.log(`[OCR Dynamic Grid Debug] FAILED Field: ${field.key} | crop.y=${crop.y} | crop.height=${crop.height} | targetCenterTheory=${targetCenterTheory.toFixed(1)}`);
        console.log(`[OCR Dynamic Grid] FAILED to detect grid or too far. Using calibrated coordinates (dist: ${minDistance.toFixed(1)}px).`);
        crop.height = 50;
      }
    } catch (err) {
      console.error("[OCR Dynamic Grid] Error during search:", err);
      crop.height = 50;
    }
  } else {
    // --- REFINAMIENTO TRADICIONAL DE BORDES HORIZONTALES PARA CANDIDATOS ---
    try {
      const xStart = crop.x;
      const xEnd = crop.x + crop.width;
      const yStart = crop.y;
      const yEnd = crop.y + crop.height;

      const getRowDensity = (png, y) => {
        let dark = 0;
        for (let x = xStart; x < xEnd; x++) {
          const idx = (png.width * y + x) << 2;
          const gray =
            png.data[idx] * 0.299 +
            png.data[idx + 1] * 0.587 +
            png.data[idx + 2] * 0.114;
          if (gray < 160) dark++;
        }
        return dark;
      };

      const findHorizontalLine = (png, ySearch, range = 45) => {
        let maxDensity = 0;
        let bestY = null;
        const colWidth = xEnd - xStart;
        const minDensityThreshold = colWidth * 0.20; // Reducido del 35% al 20% para mayor tolerancia

        for (let y = ySearch - range; y <= ySearch + range; y++) {
          if (y < 0 || y >= png.height) continue;
          const density = getRowDensity(png, y);
          if (density > maxDensity && density > minDensityThreshold) {
            maxDensity = density;
            bestY = y;
          }
        }
        return bestY;
      };

      const refinedTop = findHorizontalLine(source, yStart, 40);
      const refinedBottom = findHorizontalLine(source, yEnd, 40);

      console.log(`[OCR Refine] Field: ${field.key} | yStart: ${yStart}, yEnd: ${yEnd} | refinedTop: ${refinedTop}, refinedBottom: ${refinedBottom}`);

      if (refinedTop !== null && refinedBottom !== null) {
        crop.y = Math.round((refinedTop + refinedBottom) / 2 - crop.height / 2);
        console.log(`  => Centered Y: ${crop.y} (offset: ${crop.y - yStart})`);
      } else if (refinedTop !== null) {
        crop.y = refinedTop + 6;
        console.log(`  => Top-anchored Y: ${crop.y} (offset: ${crop.y - yStart})`);
      } else if (refinedBottom !== null) {
        crop.y = refinedBottom - crop.height - 6;
        console.log(`  => Bottom-anchored Y: ${crop.y} (offset: ${crop.y - yStart})`);
      } else {
        console.log(`  => Fallback Y (no lines found): ${crop.y}`);
      }
    } catch (err) {
      console.error("  => ERROR IN REFINEMENT LOCAL Y:", err);
    }
  }
  // -----------------------------------------------------------------

  const cropped = new PNG({ width: crop.width, height: crop.height });

  for (let y = 0; y < crop.height; y++) {
    for (let x = 0; x < crop.width; x++) {
      const sourceX = crop.x + x;
      const sourceY = crop.y + y;
      const targetIndex = (crop.width * y + x) << 2;

      if (
        sourceX < 0 ||
        sourceX >= source.width ||
        sourceY < 0 ||
        sourceY >= source.height
      ) {
        cropped.data[targetIndex] = 255;
        cropped.data[targetIndex + 1] = 255;
        cropped.data[targetIndex + 2] = 255;
        cropped.data[targetIndex + 3] = 255;
        continue;
      }

      const sourceIndex = (source.width * sourceY + sourceX) << 2;
      cropped.data[targetIndex] = source.data[sourceIndex];
      cropped.data[targetIndex + 1] = source.data[sourceIndex + 1];
      cropped.data[targetIndex + 2] = source.data[sourceIndex + 2];
      cropped.data[targetIndex + 3] = source.data[sourceIndex + 3];
    }
  }

  writeFileSync(out, PNG.sync.write(cropped));

  return { file: out, crop };
}

function keepOcrDebugImage(file, debugDir, name) {
  ensureDir(debugDir);
  copyFileSync(file, join(debugDir, name));
}

const onnxSessions = new Map();

function readGray(png, x, y) {
  const index = (png.width * y + x) << 2;

  return (
    png.data[index] * 0.299 +
    png.data[index + 1] * 0.587 +
    png.data[index + 2] * 0.114
  );
}

function binarizePng(png, threshold = 170) {
  const pixels = Array.from({ length: png.height }, () =>
    Array(png.width).fill(0),
  );

  const marginY = 4;
  const marginX = 4;

  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (
        y < marginY ||
        y >= png.height - marginY ||
        x < marginX ||
        x >= png.width - marginX
      ) {
        pixels[y][x] = 0;
      } else {
        pixels[y][x] = readGray(png, x, y) < threshold ? 1 : 0;
      }
    }
  }

  return pixels;
}

function connectedComponents(pixels) {
  const height = pixels.length;
  const width = pixels[0]?.length || 0;
  const seen = Array.from({ length: height }, () => Array(width).fill(false));
  const components = [];
  const directions = [];

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx || dy) directions.push([dx, dy]);
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!pixels[y][x] || seen[y][x]) continue;

      const queue = [[x, y]];
      const component = {
        minX: x,
        maxX: x,
        minY: y,
        maxY: y,
        area: 0,
      };
      seen[y][x] = true;

      for (let i = 0; i < queue.length; i++) {
        const [cx, cy] = queue[i];
        component.area++;
        component.minX = Math.min(component.minX, cx);
        component.maxX = Math.max(component.maxX, cx);
        component.minY = Math.min(component.minY, cy);
        component.maxY = Math.max(component.maxY, cy);

        for (const [dx, dy] of directions) {
          const nx = cx + dx;
          const ny = cy + dy;

          if (
            nx < 0 ||
            nx >= width ||
            ny < 0 ||
            ny >= height ||
            seen[ny][nx] ||
            !pixels[ny][nx]
          ) {
            continue;
          }

          seen[ny][nx] = true;
          queue.push([nx, ny]);
        }
      }

      component.width = component.maxX - component.minX + 1;
      component.height = component.maxY - component.minY + 1;
      components.push(component);
    }
  }

  return components;
}

function digitComponents(pixels, width, height) {
  return mergeDigitFragments(
    connectedComponents(pixels)
      .filter((component) => component.area > 10)
      .filter(
        (component) =>
          component.minX > 3 &&
          component.maxX < width - 4 &&
          component.minY > 2 &&
          component.maxY < height - 3 &&
          component.width < width * 0.5 &&
          component.height < height * 0.85,
      )
      .sort((a, b) => a.minX - b.minX),
  );
}

function mergeDigitFragments(components) {
  const merged = [];

  for (const component of components) {
    const previous = merged[merged.length - 1];
    if (!previous) {
      merged.push({ ...component });
      continue;
    }

    const gap = component.minX - previous.maxX - 1;
    const yOverlap =
      Math.min(previous.maxY, component.maxY) -
      Math.max(previous.minY, component.minY) +
      1;
    const hasSmallFragment = Math.min(previous.area, component.area) < 25;

    if (hasSmallFragment && gap <= 4 && yOverlap > 0) {
      previous.minX = Math.min(previous.minX, component.minX);
      previous.maxX = Math.max(previous.maxX, component.maxX);
      previous.minY = Math.min(previous.minY, component.minY);
      previous.maxY = Math.max(previous.maxY, component.maxY);
      previous.area += component.area;
      previous.width = previous.maxX - previous.minX + 1;
      previous.height = previous.maxY - previous.minY + 1;
      continue;
    }

    merged.push({ ...component });
  }

  return merged;
}

function writeMnistDigitImage(pixels, component, file) {
  const size = 64;
  const padding = 10;
  const out = new PNG({ width: size, height: size });

  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 0;
    out.data[i + 1] = 0;
    out.data[i + 2] = 0;
    out.data[i + 3] = 255;
  }

  const scale = Math.min(
    (size - padding * 2) / component.width,
    (size - padding * 2) / component.height,
  );
  const targetWidth = Math.max(1, Math.round(component.width * scale));
  const targetHeight = Math.max(1, Math.round(component.height * scale));
  const offsetX = Math.floor((size - targetWidth) / 2);
  const offsetY = Math.floor((size - targetHeight) / 2);

  for (let y = component.minY; y <= component.maxY; y++) {
    for (let x = component.minX; x <= component.maxX; x++) {
      if (!pixels[y][x]) continue;

      const tx = Math.min(
        size - 1,
        Math.max(
          0,
          offsetX +
            Math.floor(((x - component.minX) / component.width) * targetWidth),
        ),
      );
      const ty = Math.min(
        size - 1,
        Math.max(
          0,
          offsetY +
            Math.floor(
              ((y - component.minY) / component.height) * targetHeight,
            ),
        ),
      );

      for (
        let yy = Math.max(0, ty - 1);
        yy <= Math.min(size - 1, ty + 1);
        yy++
      ) {
        for (
          let xx = Math.max(0, tx - 1);
          xx <= Math.min(size - 1, tx + 1);
          xx++
        ) {
          const index = (size * yy + xx) << 2;
          out.data[index] = 255;
          out.data[index + 1] = 255;
          out.data[index + 2] = 255;
          out.data[index + 3] = 255;
        }
      }
    }
  }

  writeFileSync(file, PNG.sync.write(out));
}

function parseDigitLabel(label) {
  const match = String(label ?? "").match(/\d/);

  return match ? match[0] : "";
}

function bestDigitPredictionFromOnnx(outputData) {
  let maxIdx = 0;
  let maxVal = -Infinity;
  for (let i = 0; i < outputData.length; i++) {
    if (outputData[i] > maxVal) {
      maxVal = outputData[i];
      maxIdx = i;
    }
  }

  const exps = Array.from(outputData).map((v) => Math.exp(v));
  const sumExps = exps.reduce((a, b) => a + b, 0);
  const prob = sumExps > 0 ? exps[maxIdx] / sumExps : 0;

  return {
    digit: String(maxIdx),
    score: prob,
  };
}

async function downloadMnistModelIfMissing(destPath) {
  if (existsSync(destPath)) return;

  ensureDir(dirname(destPath));
  const modelUrl =
    "https://huggingface.co/Kalray/mnist/resolve/main/mnist.onnx";
  console.log(`Downloading MNIST model from ${modelUrl}...`);

  const res = await fetch(modelUrl);
  if (!res.ok) {
    throw new Error(
      `Failed to download MNIST model: ${res.statusText} (${res.status})`,
    );
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  writeFileSync(destPath, buffer);
  console.log("Model downloaded successfully.");
}

async function getOnnxSession(args = {}) {
  let modelPath;
  const isElectron = !!(process.versions && process.versions.electron);

  let resourcesModelPath = null;
  if (isElectron && process.resourcesPath) {
    resourcesModelPath = join(process.resourcesPath, "models", "mnist.onnx");
  }

  if (resourcesModelPath && existsSync(resourcesModelPath)) {
    modelPath = resourcesModelPath;
  } else if (process.env.E14_OCR_LOCAL_MODEL_PATH) {
    modelPath = join(process.env.E14_OCR_LOCAL_MODEL_PATH, "mnist.onnx");
  } else {
    modelPath = join(args.out || DEFAULT_OUT, "models", "mnist.onnx");
  }

  if (!args.ocrLocalOnly && modelPath !== resourcesModelPath) {
    await downloadMnistModelIfMissing(modelPath);
  }

  if (!existsSync(modelPath)) {
    throw new Error(
      `Modelo ONNX de MNIST no encontrado en la ruta: ${modelPath}`,
    );
  }

  const cacheKey = modelPath;
  if (!onnxSessions.has(cacheKey)) {
    const session = await ort.InferenceSession.create(modelPath);
    onnxSessions.set(cacheKey, session);
  }

  return onnxSessions.get(cacheKey);
}

function isAsterisk(pixels, component) {
  const w = component.maxX - component.minX + 1;
  const h = component.maxY - component.minY + 1;

  if (w < 8 || h < 8) return false;

  const midX = component.minX + w / 2;
  const midY = component.minY + h / 2;

  let qTL = 0,
    qTR = 0,
    qBL = 0,
    qBR = 0;
  let total = 0;

  for (let y = component.minY; y <= component.maxY; y++) {
    for (let x = component.minX; x <= component.maxX; x++) {
      if (pixels[y][x]) {
        total++;
        if (x < midX && y < midY) qTL++;
        else if (x >= midX && y < midY) qTR++;
        else if (x < midX && y >= midY) qBL++;
        else if (x >= midX && y >= midY) qBR++;
      }
    }
  }

  if (total === 0) return false;

  const pTL = qTL / total;
  const pTR = qTR / total;
  const pBL = qBL / total;
  const pBR = qBR / total;

  const minProp = Math.min(pTL, pTR, pBL, pBR);
  const aspect = w / h;
  const density = total / (w * h);

  // Asterisco (*) o Cruz (X) manuscritos de tachado:
  // Tienen píxeles distribuidos de forma uniforme en los 4 cuadrantes,
  // con aspecto de bounding box razonablemente cuadrado y densidad relativamente alta.
  return minProp >= 0.18 && aspect >= 0.75 && aspect <= 1.35 && density > 0.35;
}

function preprocessMnistDigitToTensor(pixels, component) {
  const size = 28;
  const padding = 4;
  const data = new Float32Array(size * size).fill(0);

  const scale = Math.min(
    (size - padding * 2) / component.width,
    (size - padding * 2) / component.height,
  );
  const targetWidth = Math.max(1, Math.round(component.width * scale));
  const targetHeight = Math.max(1, Math.round(component.height * scale));
  const offsetX = Math.floor((size - targetWidth) / 2);
  const offsetY = Math.floor((size - targetHeight) / 2);

  for (let y = component.minY; y <= component.maxY; y++) {
    for (let x = component.minX; x <= component.maxX; x++) {
      if (!pixels[y][x]) continue;

      const tx = Math.min(
        size - 1,
        Math.max(
          0,
          offsetX +
            Math.floor(((x - component.minX) / component.width) * targetWidth),
        ),
      );
      const ty = Math.min(
        size - 1,
        Math.max(
          0,
          offsetY +
            Math.floor(
              ((y - component.minY) / component.height) * targetHeight,
            ),
        ),
      );

      data[size * ty + tx] = 1.0;
    }
  }

  return data;
}

async function runTransformersDigitOcr(image, dir, field, args = {}) {
  const png = PNG.sync.read(readFileSync(image));
  const pixels = binarizePng(png);
  const components = digitComponents(pixels, png.width, png.height);

  if (!components.length) {
    return { raw: "", confidence: 0, provider: "transformers" };
  }

  const session = await getOnnxSession(args);
  const reads = [];

  for (let i = 0; i < components.length; i++) {
    // Si detectamos un asterisco o cruz de tachado manuscrito, lo omitimos
    if (isAsterisk(pixels, components[i])) {
      continue;
    }

    const digitFile = join(dir, `${field.key}-digit-${i + 1}.png`);
    writeMnistDigitImage(pixels, components[i], digitFile);

    if (args.keepOcrImages && args.debugDir) {
      keepOcrDebugImage(
        digitFile,
        args.debugDir,
        `${field.key}-digit-${i + 1}.png`,
      );
    }

    const floatData = preprocessMnistDigitToTensor(pixels, components[i]);
    const inputTensor = new ort.Tensor("float32", floatData, [1, 1, 28, 28]);

    const feeds = { [session.inputNames[0]]: inputTensor };
    const results = await session.run(feeds);
    const outputData = results[session.outputNames[0]].data;

    const prediction = bestDigitPredictionFromOnnx(outputData);
    reads.push(prediction);
  }

  return {
    raw: reads.map((read) => read.digit).join(""),
    confidence: reads.length
      ? Math.round(
          reads.reduce((sum, read) => sum + read.score * 100, 0) / reads.length,
        )
      : 100, // 100% de confianza si todo el campo estaba tachado/vacío
    provider: "transformers",
  };
}

function runTesseract(image) {
  const result = spawnSync(
    "tesseract",
    [
      image,
      "stdout",
      "-l",
      "snum",
      "--psm",
      "7",
      "-c",
      "tessedit_char_whitelist=0123456789*",
      "tsv",
    ],
    { encoding: "utf8", timeout: 20000 },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(result.stderr || "Tesseract no pudo leer la region");
  }

  return parseTesseractTsv(result.stdout);
}

async function readOcrRegion(image, dir, field, args = {}) {
  if (!commandExists("tesseract")) {
    throw new Error("OCR requiere tesseract instalado en el sistema");
  }

  const tesseractResult = runTesseract(image);

  return {
    raw: tesseractResult.raw,
    confidence: tesseractResult.confidence,
    provider: "tesseract",
    tesseract: {
      raw: tesseractResult.raw,
      confidence: tesseractResult.confidence,
    },
    ai: {
      raw: tesseractResult.raw,
      confidence: tesseractResult.confidence,
    },
  };
}

function parseTesseractTsv(tsv) {
  const lines = String(tsv || "")
    .trim()
    .split("\n");
  const headers = lines.shift()?.split("\t") || [];
  const textIndex = headers.indexOf("text");
  const confIndex = headers.indexOf("conf");
  const parts = [];
  const confidences = [];

  for (const line of lines) {
    const cols = line.split("\t");
    const text = cols[textIndex] || "";
    const conf = Number(cols[confIndex]);

    if (text.trim()) {
      parts.push(text.trim());
    }

    if (Number.isFinite(conf) && conf >= 0) {
      confidences.push(conf);
    }
  }

  const raw = parts.join(" ");
  const confidence = confidences.length
    ? Math.round(
        confidences.reduce((sum, value) => sum + value, 0) / confidences.length,
      )
    : 0;

  return { raw, confidence };
}

function normalizeOcrNumber(raw) {
  const text = String(raw || "").trim();
  const digits = text.replace(/\*/g, "0").replace(/\D/g, "");

  if (!digits) return null;

  const normalized = digits.length > 3 ? digits.slice(-3) : digits;

  return Number(normalized);
}

function emptyOcrValues() {
  return Object.fromEntries(OCR_FIELDS_2PAGE.map((field) => [field.key, null]));
}

function ocrCsvRow(row) {
  const headers = ocrResultHeaders();

  return headers.map((header) => csvEscape(row[header])).join(",");
}

function ocrResultHeaders() {
  return [
    "department",
    "departmentName",
    "municipality",
    "municipalityName",
    "zone",
    "zoneName",
    "stand",
    "standName",
    "table",
    "corporation",
    "expectedName",
    "candidato_1",
    "candidato_2",
    "votos_blanco",
    "votos_nulos",
    "votos_no_marcados",
    "total_votos_urna",
    "raw_candidato_1",
    "raw_candidato_2",
    "raw_votos_blanco",
    "raw_votos_nulos",
    "raw_votos_no_marcados",
    "raw_total_votos_urna",
    "suma_votos",
    "diferencia_total_urna",
    "consistente",
    "confianza_promedio",
    "proveedor_ocr",
    "requiere_revision",
    "error",
    "localPath",
  ];
}

function flattenOcrRow(row) {
  const trusted = row.ocr?.consistente;

  return {
    department: row.department,
    departmentName: row.departmentName,
    municipality: row.municipality,
    municipalityName: row.municipalityName,
    zone: row.zone,
    zoneName: row.zoneName,
    stand: row.stand,
    standName: row.standName,
    table: row.table,
    corporation: row.corporation,
    expectedName: row.expectedName,
    candidato_1: trusted ? (row.ocr?.values?.candidato_1 ?? "") : "",
    candidato_2: trusted ? (row.ocr?.values?.candidato_2 ?? "") : "",
    votos_blanco: trusted ? (row.ocr?.values?.votos_blanco ?? "") : "",
    votos_nulos: trusted ? (row.ocr?.values?.votos_nulos ?? "") : "",
    votos_no_marcados: trusted
      ? (row.ocr?.values?.votos_no_marcados ?? "")
      : "",
    total_votos_urna: trusted ? (row.ocr?.values?.total_votos_urna ?? "") : "",
    raw_candidato_1: row.ocr?.fields?.candidato_1?.raw ?? "",
    raw_candidato_2: row.ocr?.fields?.candidato_2?.raw ?? "",
    raw_votos_blanco: row.ocr?.fields?.votos_blanco?.raw ?? "",
    raw_votos_nulos: row.ocr?.fields?.votos_nulos?.raw ?? "",
    raw_votos_no_marcados: row.ocr?.fields?.votos_no_marcados?.raw ?? "",
    raw_total_votos_urna: row.ocr?.fields?.total_votos_urna?.raw ?? "",
    suma_votos: row.ocr?.suma_votos ?? "",
    diferencia_total_urna: row.ocr?.diferencia_total_urna ?? "",
    consistente: row.ocr?.consistente ? "true" : "false",
    confianza_promedio: row.ocr?.confianza_promedio ?? "",
    proveedor_ocr: row.ocr?.proveedor ?? "",
    requiere_revision: row.ocr?.requiere_revision ? "true" : "false",
    error: row.error || "",
    localPath: row.localPath || "",
  };
}

function zoneSummaryRows(rows) {
  const grouped = new Map();

  for (const row of rows) {
    if (!row.ocr?.consistente) continue;

    const key = [
      row.department,
      row.departmentName,
      row.municipality,
      row.municipalityName,
      row.zone,
      row.zoneName,
      row.stand,
      row.standName,
      row.corporation,
    ].join("|");

    if (!grouped.has(key)) {
      grouped.set(key, {
        department: row.department,
        departmentName: row.departmentName,
        municipality: row.municipality,
        municipalityName: row.municipalityName,
        zone: row.zone,
        zoneName: row.zoneName,
        stand: row.stand,
        standName: row.standName,
        corporation: row.corporation,
        mesas_validadas: 0,
        candidato_1: 0,
        candidato_2: 0,
        votos_blanco: 0,
        votos_nulos: 0,
        votos_no_marcados: 0,
        total_votos_urna: 0,
      });
    }

    const summary = grouped.get(key);
    summary.mesas_validadas++;
    for (const field of [
      "candidato_1",
      "candidato_2",
      "votos_blanco",
      "votos_nulos",
      "votos_no_marcados",
      "total_votos_urna",
    ]) {
      summary[field] += Number(row.ocr.values[field] || 0);
    }
  }

  return [...grouped.values()];
}
function writeOcrOutputs(rows, out) {
  const db = new LocalDatabase(out);
  return db.saveOcrOutputs(rows);
}

function loadExistingOcrRows(out) {
  const db = new LocalDatabase(out);
  return db.loadOcr();
}

function recordKey(record) {
  return [
    record.department,
    record.municipality,
    record.zone,
    record.stand,
    record.table,
    record.corporation,
  ].join("|");
}

function validateOcrValues(values, confidences) {
  const voteKeys = [
    "candidato_1",
    "candidato_2",
    "votos_blanco",
    "votos_nulos",
    "votos_no_marcados",
  ];
  const missing = ["total_votos_urna", ...voteKeys].filter(
    (key) => !Number.isFinite(values[key]),
  );
  const suma_votos = voteKeys.reduce(
    (sum, key) => sum + (Number.isFinite(values[key]) ? values[key] : 0),
    0,
  );
  const total = values.total_votos_urna;
  const diferencia_total_urna = Number.isFinite(total)
    ? suma_votos - total
    : "";
  const confianza_promedio = confidences.length
    ? Math.round(
        confidences.reduce((sum, value) => sum + value, 0) / confidences.length,
      )
    : 0;
  const bajaConfianza = confianza_promedio < 60;
  const consistente =
    missing.length === 0 &&
    Number(diferencia_total_urna) === 0 &&
    !bajaConfianza;

  return {
    suma_votos,
    diferencia_total_urna,
    consistente,
    confianza_promedio,
    requiere_revision: !consistente,
    missing,
    baja_confianza: bajaConfianza,
  };
}

async function ocrOne(record, out, args = {}) {
  assertNotAborted(args.signal);
  ensureOcrTools(args);
  const provider = normalizeOcrProvider(args.ocrProvider);
  const file = localPdfPath(out, record);
  const base = {
    ...record,
    localPath: file,
    ocr: {
      values: emptyOcrValues(),
      fields: {},
      regions: {},
      suma_votos: "",
      diferencia_total_urna: "",
      consistente: false,
      confianza_promedio: 0,
      requiere_revision: true,
      proveedor: provider,
    },
  };

  if (!existsSync(file)) {
    return { ...base, error: `PDF local no encontrado: ${file}` };
  }

  const header = readFileSync(file).subarray(0, 5).toString();
  if (header !== "%PDF-") {
    return { ...base, error: "El archivo local no es un PDF valido" };
  }

  const dir = mkdtempSync(join(tmpdir(), "e14-ocr-"));

  try {
    const bytes = readFileSync(file);
    const pdfDoc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    const pageCount = pdfDoc.getPageCount();
    const targetPage = pageCount === 3 ? 2 : 1;

    const image = renderPdfPage(file, dir, targetPage);
    const size = imageSize(image);
    const debugDir = args.keepOcrImages ? ocrDebugDir(out, record) : "";

    if (debugDir) {
      keepOcrDebugImage(image, debugDir, "page.png");
    }

    const values = {};
    const fields = {};
    const regions = {};
    const confidences = [];

    const fieldsList = getAlignedOcrFields(image, pageCount);

    for (const field of fieldsList) {
      assertNotAborted(args.signal);
      const crop = cropRegion(image, dir, field, size, pageCount);

      if (debugDir) {
        keepOcrDebugImage(crop.file, debugDir, `${field.key}.png`);
      }

      const read = await readOcrRegion(crop.file, dir, field, {
        ...args,
        debugDir,
      });
      const value = normalizeOcrNumber(read.raw);
      values[field.key] = value;
      fields[field.key] = {
        label: field.label,
        raw: read.raw,
        value,
        confidence: read.confidence,
        provider: read.provider,
        tesseract: read.tesseract,
        ai: read.ai,
      };
      regions[field.key] = crop.crop;
      confidences.push(read.confidence);
    }

    const validation = validateOcrValues(values, confidences);

    return {
      ...base,
      ocr: {
        values,
        fields,
        regions,
        proveedor: provider,
        ...validation,
      },
    };
  } catch (error) {
    return { ...base, error: error.message };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function downloadOne(record, out, args) {
  assertNotAborted(args.signal);
  const file = localPdfPath(out, record);
  ensureDir(dirname(file));

  let downloaded = false;
  if (!args.skipExisting || !existsSync(file)) {
    const res = await fetchWithRetry(`${record.pdfUrl}?uuid=${Date.now()}`, {
      signal: args.signal,
    });
    const buffer = Buffer.from(await res.arrayBuffer());
    assertNotAborted(args.signal);
    writeFileSync(file, buffer);
    downloaded = true;
  }

  const buffer = readFileSync(file);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const isPdf = buffer.subarray(0, 5).toString() === "%PDF-";
  const meta = args.metadata ? await readMetadata(file, buffer) : {};

  return {
    ...record,
    localPath: file,
    downloaded,
    ok: isPdf,
    bytes: buffer.length,
    sha256,
    pdfHeader: buffer.subarray(0, 12).toString("latin1").replace(/\s+/g, " "),
    metadata: meta,
  };
}

async function fetchRemotePdf(record, args) {
  const res = await fetchWithRetry(`${record.pdfUrl}?uuid=${Date.now()}`, {
    signal: args.signal,
  });

  return Buffer.from(await res.arrayBuffer());
}

async function verifyOne(record, out, args) {
  assertNotAborted(args.signal);
  const file = localPdfPath(out, record);

  if (!existsSync(file)) {
    throw new Error(`Local PDF not found: ${file}`);
  }

  const localBuffer = readFileSync(file);
  const remoteBuffer = await fetchRemotePdf(record, args);
  assertNotAborted(args.signal);

  const localSha256 = createHash("sha256").update(localBuffer).digest("hex");
  const remoteSha256 = createHash("sha256").update(remoteBuffer).digest("hex");
  const localMetadata = args.metadata
    ? await readMetadata(file, localBuffer)
    : {};
  const remoteMetadata = args.metadata
    ? await readMetadataFromBuffer(remoteBuffer, record.expectedName)
    : {};
  const metadataDiff = args.metadata
    ? diffMetadata(localMetadata, remoteMetadata)
    : [];
  const checksumOk = localSha256 === remoteSha256;
  const metadataOk = !args.metadata || metadataDiff.length === 0;
  const ok = checksumOk && metadataOk;

  return {
    ...record,
    localPath: file,
    downloaded: false,
    verified: true,
    ok,
    bytes: localBuffer.length,
    sha256: localSha256,
    pdfHeader: localBuffer
      .subarray(0, 12)
      .toString("latin1")
      .replace(/\s+/g, " "),
    metadata: localMetadata,
    verification: {
      verifiedAt: new Date().toISOString(),
      localSha256,
      remoteSha256,
      checksumOk,
      metadataOk,
      remoteBytes: remoteBuffer.length,
      metadataDiff,
      remoteMetadata,
    },
  };
}

async function runDownload(records, args, onRow = () => {}) {
  ensureDir(args.out);
  writeInventory(records, args.out);
  const auditFile = join(args.out, "audit.jsonl");
  writeFileSync(auditFile, "");

  let done = 0;
  let failed = 0;

  try {
    await mapLimit(records, args.concurrency, async (record) => {
      assertNotAborted(args.signal);

      try {
        const row = await downloadOne(record, args.out, args);
        appendJsonl(auditFile, row);
        done++;

        if (!row.ok) {
          failed++;
        }

        onRow({ type: "row", done, failed, total: records.length, row });
      } catch (error) {
        if (isAbortError(error) || args.signal?.aborted) {
          throw error;
        }

        failed++;
        done++;
        const row = { ...record, ok: false, error: error.message };

        appendJsonl(auditFile, row);
        onRow({ type: "row", done, failed, total: records.length, row });
      }
    });
  } catch (error) {
    if (isAbortError(error) || args.signal?.aborted) {
      return { auditFile, failed, total: records.length, done, canceled: true };
    }

    throw error;
  }

  return { auditFile, failed, total: records.length, done, canceled: false };
}

async function runVerification(records, args, onRow = () => {}) {
  ensureDir(args.out);
  writeInventory(records, args.out);

  const auditFile = join(args.out, "audit.jsonl");
  let done = 0;
  let failed = 0;

  try {
    await mapLimit(records, args.concurrency, async (record) => {
      assertNotAborted(args.signal);

      try {
        const row = await verifyOne(record, args.out, args);
        appendJsonl(auditFile, row);
        done++;

        if (!row.ok) {
          failed++;
        }

        onRow({ type: "row", done, failed, total: records.length, row });
      } catch (error) {
        if (isAbortError(error) || args.signal?.aborted) {
          throw error;
        }

        failed++;
        done++;

        const row = {
          ...record,
          localPath: localPdfPath(args.out, record),
          verified: true,
          ok: false,
          error: error.message,
        };

        appendJsonl(auditFile, row);
        onRow({ type: "row", done, failed, total: records.length, row });
      }
    });
  } catch (error) {
    if (isAbortError(error) || args.signal?.aborted) {
      return { auditFile, failed, total: records.length, done, canceled: true };
    }

    throw error;
  }

  return { auditFile, failed, total: records.length, done, canceled: false };
}

async function runOcr(records, args, onRow = () => {}) {
  ensureDir(args.out);
  writeInventory(records, args.out);

  const rowsByKey = loadExistingOcrRows(args.out);
  let done = 0;
  let failed = 0;
  let consistent = 0;
  let needsReview = 0;
  let skipped = 0;

  try {
    await mapLimit(records, args.concurrency, async (record) => {
      assertNotAborted(args.signal);
      const key = recordKey(record);

      if (args.skipExisting && rowsByKey.has(key)) {
        const row = rowsByKey.get(key);
        skipped++;
        done++;

        if (row.error) failed++;
        if (row.ocr?.consistente) consistent++;
        if (row.ocr?.requiere_revision) needsReview++;

        onRow({
          type: "row",
          done,
          failed,
          consistent,
          needsReview,
          skipped,
          total: records.length,
          row,
        });

        return;
      }

      try {
        const row = await ocrOne(record, args.out, args);
        rowsByKey.set(key, row);
        done++;

        if (row.error) failed++;
        if (row.ocr?.consistente) consistent++;
        if (row.ocr?.requiere_revision) needsReview++;

        onRow({
          type: "row",
          done,
          failed,
          consistent,
          needsReview,
          skipped,
          total: records.length,
          row,
        });
      } catch (error) {
        if (isAbortError(error) || args.signal?.aborted) {
          throw error;
        }

        failed++;
        needsReview++;
        done++;

        const row = {
          ...record,
          localPath: localPdfPath(args.out, record),
          error: error.message,
          ocr: {
            values: emptyOcrValues(),
            consistente: false,
            confianza_promedio: 0,
            proveedor: normalizeOcrProvider(args.ocrProvider),
            requiere_revision: true,
          },
        };

        rowsByKey.set(key, row);
        onRow({
          type: "row",
          done,
          failed,
          consistent,
          needsReview,
          skipped,
          total: records.length,
          row,
        });
      }
    });
  } catch (error) {
    const rows = [...rowsByKey.values()];
    const output = writeOcrOutputs(rows, args.out);

    if (isAbortError(error) || args.signal?.aborted) {
      return {
        ...output,
        failed,
        consistent,
        needsReview,
        skipped,
        total: records.length,
        done,
        canceled: true,
      };
    }

    throw error;
  }

  return {
    ...writeOcrOutputs([...rowsByKey.values()], args.out),
    failed,
    consistent,
    needsReview,
    skipped,
    total: records.length,
    done,
    canceled: false,
  };
}

async function readMetadata(file, buffer = readFileSync(file)) {
  const metadata = {
    ...readLocalPdfMetadata(file, buffer),
    ...(await readPdfLibMetadata(buffer)),
  };

  try {
    const exiftoolMetadata = await exiftool.read(file);

    return {
      MetadataSource: "pdf-lib+exiftool",
      ...metadata,
      ...(exiftoolMetadata || {}),
    };
  } catch (error) {
    return {
      MetadataSource: "pdf-lib",
      ...metadata,
      ExifToolError: error.message,
    };
  }
}

async function readMetadataFromBuffer(buffer, filename = "remote.pdf") {
  const dir = mkdtempSync(join(tmpdir(), "e14-remote-"));
  const file = join(dir, basename(filename || "remote.pdf"));

  try {
    writeFileSync(file, buffer);
    return await readMetadata(file, buffer);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const METADATA_COMPARE_IGNORE = new Set([
  "Directory",
  "ExifToolVersion",
  "FileAccessDate",
  "FileInodeChangeDate",
  "FileModifyDate",
  "FileName",
  "MetadataSource",
  "SourceFile",
]);

function comparableMetadata(metadata) {
  return Object.fromEntries(
    Object.entries(metadata || {})
      .filter(([key]) => !METADATA_COMPARE_IGNORE.has(key))
      .map(([key, value]) => [key, normalizeMetadataValue(value)])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

function normalizeMetadataValue(value) {
  if (value === undefined || value === null) {
    return "";
  }

  if (Array.isArray(value)) {
    return value.map(normalizeMetadataValue);
  }

  if (typeof value === "object") {
    if (value.rawValue !== undefined) {
      return String(value.rawValue);
    }

    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .map(([key, entryValue]) => [key, normalizeMetadataValue(entryValue)])
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  }

  return String(value);
}

function metadataValueEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffMetadata(localMetadata, remoteMetadata) {
  const local = comparableMetadata(localMetadata);
  const remote = comparableMetadata(remoteMetadata);
  const keys = [...new Set([...Object.keys(local), ...Object.keys(remote)])];

  return keys
    .filter((key) => !metadataValueEqual(local[key], remote[key]))
    .map((key) => ({
      key,
      local: local[key],
      remote: remote[key],
    }));
}

function readLocalPdfMetadata(file, buffer) {
  const header = buffer.subarray(0, 12).toString("latin1").replace(/\s+/g, " ");
  const version = header.match(/%PDF-([0-9.]+)/)?.[1];

  return removeEmptyValues({
    SourceFile: file,
    FileName: basename(file),
    FileSizeBytes: buffer.length,
    FileSize: `${buffer.length} bytes`,
    FileType: "PDF",
    FileTypeExtension: "pdf",
    MIMEType: "application/pdf",
    PDFVersion: version,
    PDFHeader: header,
  });
}

async function readPdfLibMetadata(buffer) {
  try {
    const doc = await PDFDocument.load(buffer, {
      ignoreEncryption: true,
      updateMetadata: false,
    });

    return removeEmptyValues({
      NodePdfLibrary: "pdf-lib",
      PageCount: doc.getPageCount(),
      Title: callPdfGetter(doc, "getTitle"),
      Author: callPdfGetter(doc, "getAuthor"),
      Subject: callPdfGetter(doc, "getSubject"),
      Keywords: callPdfGetter(doc, "getKeywords"),
      Creator: callPdfGetter(doc, "getCreator"),
      Producer: callPdfGetter(doc, "getProducer"),
      CreationDate: formatPdfDate(callPdfGetter(doc, "getCreationDate")),
      ModificationDate: formatPdfDate(
        callPdfGetter(doc, "getModificationDate"),
      ),
      Language: callPdfGetter(doc, "getLanguage"),
    });
  } catch (error) {
    return {
      NodePdfLibrary: "pdf-lib",
      PdfLibError: error.message,
    };
  }
}

function callPdfGetter(doc, name) {
  return typeof doc[name] === "function" ? doc[name]() : undefined;
}

function removeEmptyValues(values) {
  return Object.fromEntries(
    Object.entries(values).filter(
      ([, value]) => value !== undefined && value !== null && value !== "",
    ),
  );
}

function formatPdfDate(value) {
  return value instanceof Date && !Number.isNaN(value.valueOf())
    ? value.toISOString()
    : value;
}

function commandExists(name) {
  return (
    spawnSync("sh", ["-lc", `command -v ${name} >/dev/null 2>&1`]).status === 0
  );
}

async function mapLimit(items, limit, worker) {
  const results = [];
  let index = 0;

  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (index < items.length) {
      const current = index++;
      results[current] = await worker(items[current], current);
    }
  });

  await Promise.all(workers);

  return results;
}

function appendJsonl(path, row) {
  createWriteStream(path, { flags: "a" }).end(JSON.stringify(row) + "\n");
}

function usage() {
  console.log(`Usage:
  node scripts/e14-audit.mjs inventory [filters]
  node scripts/e14-audit.mjs download [filters]
  node scripts/e14-audit.mjs verify [filters]
  node scripts/e14-audit.mjs ocr [filters]

Filters:
  --department 60        Departamento, 2 digits after padding
  --municipality 010     Municipio, 3 digits after padding
  --zone 00              Zona, 2 digits after padding
  --stand 00             Puesto, 2 digits after padding
  --corporation 001      Corporacion, default PRESIDENTE
  --limit 10             Limit records for tests
  --concurrency 4        Parallel PDF downloads
  --out output/e14       Output folder
  --base-url URL         Source site, defaults to Registraduria E14 Presidente
  --no-metadata          Skip exiftool metadata extraction
  --no-skip-existing     Re-download existing PDFs
  --keep-ocr-images      Keep OCR page render and field crops under out/ocr-debug
  --ocr-provider transformers
                         OCR provider: transformers or tesseract
  --ocr-model MODEL      Transformers.js model id or local ONNX model path
  --ocr-local-only       Do not download remote Transformers.js model files
`);
}

async function main() {
  try {
    const args = parseArgs(process.argv);

    if (args.command === "help") return usage();

    if (!["inventory", "download", "verify", "ocr"].includes(args.command))
      throw new Error(`Unknown command: ${args.command}`);

    ensureDir(args.out);
    const data = await loadData(args.out, args.baseUrl);
    const records = recordsFromData(data, args);
    writeInventory(records, args.out);
    console.log(
      `Inventory: ${records.length} records -> ${join(args.out, "inventory.csv")}`,
    );

    if (args.command === "inventory") {
      return;
    }

    const runner =
      args.command === "verify"
        ? runVerification
        : args.command === "ocr"
          ? runOcr
          : runDownload;
    const { auditFile, failed } = await runner(
      records,
      args,
      ({ done, total }) => {
        if (done % 25 === 0 || done === total) {
          console.log(
            `${args.command === "verify" ? "Verified" : args.command === "ocr" ? "OCR" : "Downloaded/audited"} ${done}/${total}`,
          );
        }
      },
    );

    if (args.command === "ocr") {
      console.log(`OCR results: ${join(args.out, "ocr-results.csv")}`);
      console.log(`OCR summary: ${join(args.out, "ocr-zone-summary.csv")}`);
    } else {
      console.log(`Audit: ${auditFile}`);
      console.log(`PDF dir: ${join(args.out, "pdf")}`);
    }
    console.log(`Failures: ${failed}`);
  } finally {
    await exiftool.end();
  }
}

export {
  DEFAULT_BASE_URL,
  DEFAULT_OUT,
  buildCatalog,
  downloadOne,
  loadData,
  normalizeBaseUrl,
  pad,
  recordsFromData,
  runOcr,
  runVerification,
  runDownload,
  temisUrl,
  verifyOne,
  writeInventory,
  LocalDatabase,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
