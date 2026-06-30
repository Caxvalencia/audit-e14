#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { PDFDocument } from "pdf-lib";
import { ExifTool } from "exiftool-vendored";
import { PNG } from "pngjs";

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
    ocrProvider: "transformers",
    ocrModel: "",
    ocrLocalOnly: false,
    debugDir: "",
    digitGateModel: "",
    digitGateThreshold: 0.45,
    epochs: 500,
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
    else if (a === "--debug-dir") args.debugDir = next();
    else if (a === "--digit-gate-model") args.digitGateModel = next();
    else if (a === "--digit-gate-threshold")
      args.digitGateThreshold = Number(next());
    else if (a === "--epochs") args.epochs = Number(next());
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
    key: "total_votantes_e11",
    label: "Total votantes formulario E-11",
    section: "nivelacion",
    rowIndex: 0,
    x: 0.72,
    y: 0.184,
    width: 0.215,
    height: 0.04,
  },
  {
    key: "total_votos_urna",
    label: "Total votos en la urna",
    section: "nivelacion",
    rowIndex: 1,
    x: 0.72,
    y: 0.217,
    width: 0.215,
    height: 0.04,
  },
  {
    key: "total_votos_incinerados",
    label: "Total votos incinerados",
    section: "nivelacion",
    rowIndex: 2,
    x: 0.72,
    y: 0.250,
    width: 0.215,
    height: 0.04,
  },
  {
    key: "candidato_1",
    label: "Candidato 1",
    x: 0.72,
    y: 0.411,
    width: 0.215,
    height: 0.055,
  },
  {
    key: "candidato_2",
    label: "Candidato 2",
    x: 0.72,
    y: 0.582,
    width: 0.215,
    height: 0.055,
  },
  {
    key: "votos_blanco",
    label: "Votos en blanco",
    section: "resumen",
    rowIndex: 0,
    x: 0.72,
    y: 0.709,
    width: 0.215,
    height: 0.025,
  },
  {
    key: "votos_nulos",
    label: "Votos nulos",
    section: "resumen",
    rowIndex: 1,
    x: 0.72,
    y: 0.739,
    width: 0.215,
    height: 0.025,
  },
  {
    key: "votos_no_marcados",
    label: "Votos no marcados",
    section: "resumen",
    rowIndex: 2,
    x: 0.72,
    y: 0.772,
    width: 0.215,
    height: 0.025,
  },
  {
    key: "suma_total_formulario",
    label: "Suma total formulario",
    section: "resumen",
    rowIndex: 3,
    x: 0.72,
    y: 0.805,
    width: 0.215,
    height: 0.025,
  },
];

const OCR_FIELDS_3PAGE = [
  {
    key: "total_votantes_e11",
    label: "Total votantes formulario E-11",
    section: "nivelacion",
    rowIndex: 0,
    x: 0.72,
    y: 0.225,
    width: 0.215,
    height: 0.04,
  },
  {
    key: "total_votos_urna",
    label: "Total votos en la urna",
    section: "nivelacion",
    rowIndex: 1,
    x: 0.72,
    y: 0.257,
    width: 0.215,
    height: 0.04,
  },
  {
    key: "total_votos_incinerados",
    label: "Total votos incinerados",
    section: "nivelacion",
    rowIndex: 2,
    x: 0.72,
    y: 0.290,
    width: 0.215,
    height: 0.04,
  },
  {
    key: "candidato_1",
    label: "Candidato 1",
    x: 0.72,
    y: 0.399,
    width: 0.215,
    height: 0.055,
  },
  {
    key: "candidato_2",
    label: "Candidato 2",
    x: 0.72,
    y: 0.563,
    width: 0.215,
    height: 0.055,
  },
  {
    key: "votos_blanco",
    label: "Votos en blanco",
    section: "resumen",
    rowIndex: 0,
    x: 0.72,
    y: 0.788,
    width: 0.215,
    height: 0.025,
  },
  {
    key: "votos_nulos",
    label: "Votos nulos",
    section: "resumen",
    rowIndex: 1,
    x: 0.72,
    y: 0.800,
    width: 0.215,
    height: 0.025,
  },
  {
    key: "votos_no_marcados",
    label: "Votos no marcados",
    section: "resumen",
    rowIndex: 2,
    x: 0.72,
    y: 0.813,
    width: 0.215,
    height: 0.025,
  },
  {
    key: "suma_total_formulario",
    label: "Suma total formulario",
    section: "resumen",
    rowIndex: 3,
    x: 0.72,
    y: 0.826,
    width: 0.215,
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

  const provider = normalizeOcrProvider(args.ocrProvider);
  if (provider === "tesseract" && !commandExists("tesseract")) {
    throw new Error("OCR requiere tesseract instalado en el sistema");
  }
}

function normalizeOcrProvider(provider = "transformers") {
  return String(provider || "transformers").toLowerCase() === "tesseract"
    ? "tesseract"
    : "transformers";
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

const MARKER_TARGETS = {
  topLeft: { x: 0.066, y: 0.018 },
  topRight: { x: 0.94, y: 0.018 },
  bottomLeft: { x: 0.058, y: 0.976 },
  bottomRight: { x: 0.94, y: 0.976 },
};

function alignPageForOcr(imageFile, dir) {
  const source = PNG.sync.read(readFileSync(imageFile));
  const markers = detectCornerMarkers(source);
  if (!markers) {
    return {
      file: imageFile,
      aligned: false,
      reason: "No se detectaron los 4 marcadores de esquina",
    };
  }

  const width = source.width;
  const height = source.height;
  const sourcePoints = [
    markers.topLeft,
    markers.topRight,
    markers.bottomRight,
    markers.bottomLeft,
  ];
  const targetPoints = [
    pctPoint(MARKER_TARGETS.topLeft, width, height),
    pctPoint(MARKER_TARGETS.topRight, width, height),
    pctPoint(MARKER_TARGETS.bottomRight, width, height),
    pctPoint(MARKER_TARGETS.bottomLeft, width, height),
  ];
  const homography = solveHomography(targetPoints, sourcePoints);
  if (!homography) {
    return {
      file: imageFile,
      aligned: false,
      reason: "No se pudo calcular homografia",
    };
  }

  const out = join(dir, "page-aligned.png");
  const aligned = warpPerspective(source, width, height, homography);
  writeFileSync(out, PNG.sync.write(aligned));

  return {
    file: out,
    aligned: true,
    markers,
  };
}

function pctPoint(point, width, height) {
  return {
    x: point.x * width,
    y: point.y * height,
  };
}

function detectCornerMarkers(png) {
  const pixels = binarizePng(png, 90);
  const components = connectedComponents(pixels)
    .filter((component) => {
      const fill = component.area / (component.width * component.height);
      const aspect = component.width / component.height;
      const minSide = Math.min(png.width, png.height) * 0.012;
      const maxSide = Math.min(png.width, png.height) * 0.075;

      return (
        component.width >= minSide &&
        component.height >= minSide &&
        component.width <= maxSide &&
        component.height <= maxSide &&
        aspect >= 0.65 &&
        aspect <= 1.45 &&
        fill >= 0.55
      );
    })
    .map((component) => ({
      ...component,
      x: (component.minX + component.maxX) / 2,
      y: (component.minY + component.maxY) / 2,
    }));

  const pick = (xMin, xMax, yMin, yMax, expected) => {
    const candidates = components.filter(
      (component) =>
        component.x >= png.width * xMin &&
        component.x <= png.width * xMax &&
        component.y >= png.height * yMin &&
        component.y <= png.height * yMax,
    );

    return candidates
      .map((component) => ({
        component,
        score:
          Math.hypot(
            component.x - png.width * expected.x,
            component.y - png.height * expected.y,
          ) -
          component.area * 0.01,
      }))
      .sort((a, b) => a.score - b.score)[0]?.component;
  };

  const topLeft = pick(0, 0.22, 0, 0.12, MARKER_TARGETS.topLeft);
  const topRight = pick(0.78, 1, 0, 0.12, MARKER_TARGETS.topRight);
  const bottomLeft = pick(0, 0.22, 0.88, 1, MARKER_TARGETS.bottomLeft);
  const bottomRight = pick(0.78, 1, 0.88, 1, MARKER_TARGETS.bottomRight);

  if (!topLeft || !topRight || !bottomLeft || !bottomRight) {
    return null;
  }

  return { topLeft, topRight, bottomLeft, bottomRight };
}

function solveHomography(fromPoints, toPoints) {
  const matrix = [];
  const rhs = [];

  for (let i = 0; i < 4; i++) {
    const { x, y } = fromPoints[i];
    const u = toPoints[i].x;
    const v = toPoints[i].y;

    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    rhs.push(u);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    rhs.push(v);
  }

  const solution = solveLinearSystem(matrix, rhs);
  if (!solution) return null;

  return [
    solution[0],
    solution[1],
    solution[2],
    solution[3],
    solution[4],
    solution[5],
    solution[6],
    solution[7],
    1,
  ];
}

function solveLinearSystem(matrix, rhs) {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]]);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }

    if (Math.abs(a[pivot][col]) < 1e-9) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];

    const div = a[col][col];
    for (let j = col; j <= n; j++) a[col][j] /= div;

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let j = col; j <= n; j++) a[row][j] -= factor * a[col][j];
    }
  }

  return a.map((row) => row[n]);
}

function warpPerspective(source, width, height, homography) {
  const out = new PNG({ width, height });

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const denom = homography[6] * x + homography[7] * y + homography[8];
      const sx = (homography[0] * x + homography[1] * y + homography[2]) / denom;
      const sy = (homography[3] * x + homography[4] * y + homography[5]) / denom;
      const targetIndex = (width * y + x) << 2;

      if (
        !Number.isFinite(sx) ||
        !Number.isFinite(sy) ||
        sx < 0 ||
        sx >= source.width - 1 ||
        sy < 0 ||
        sy >= source.height - 1
      ) {
        out.data[targetIndex] = 255;
        out.data[targetIndex + 1] = 255;
        out.data[targetIndex + 2] = 255;
        out.data[targetIndex + 3] = 255;
        continue;
      }

      sampleNearest(source, sx, sy, out.data, targetIndex);
    }
  }

  return out;
}

function sampleNearest(source, sx, sy, targetData, targetIndex) {
  const x = Math.max(0, Math.min(source.width - 1, Math.round(sx)));
  const y = Math.max(0, Math.min(source.height - 1, Math.round(sy)));
  const sourceIndex = (source.width * y + x) << 2;

  targetData[targetIndex] = source.data[sourceIndex];
  targetData[targetIndex + 1] = source.data[sourceIndex + 1];
  targetData[targetIndex + 2] = source.data[sourceIndex + 2];
  targetData[targetIndex + 3] = source.data[sourceIndex + 3];
}

function keepOcrSectionDebugImages(imageFile, debugDir, pageCount) {
  if (!debugDir) return;

  const sections =
    pageCount === 2
      ? [
          {
            name: "section_nivelacion.png",
            x: 0.055,
            y: 0.228,
            width: 0.89,
            height: 0.125,
          },
          {
            name: "section_resumen.png",
            x: 0.05,
            y: 0.695,
            width: 0.90,
            height: 0.145,
          },
        ]
      : [
          {
            name: "section_nivelacion.png",
            x: 0.055,
            y: 0.250,
            width: 0.89,
            height: 0.105,
          },
          {
            name: "section_resumen.png",
            x: 0.05,
            y: 0.770,
            width: 0.90,
            height: 0.115,
          },
        ];

  for (const section of sections) {
    const out = join(debugDir, section.name);
    cropPngPercentToFile(imageFile, section, out);
  }
}

function cropPngPercentToFile(imageFile, region, out) {
  const source = PNG.sync.read(readFileSync(imageFile));
  const crop = {
    x: Math.round(source.width * region.x),
    y: Math.round(source.height * region.y),
    width: Math.round(source.width * region.width),
    height: Math.round(source.height * region.height),
  };
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

  if (field.section) {
    refineSectionRowCrop(source, crop, field, pageCount);
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

function refineSectionRowCrop(source, crop, field, pageCount) {
  try {
    const rowBounds = detectSectionRowBounds(source, field, pageCount);
    if (!rowBounds) {
      crop.height = Math.max(50, Math.round(source.height * 0.012));
      return;
    }

    const paddingY =
      field.section === "resumen"
        ? 1
        : Math.max(2, Math.round(source.height * 0.0008));
    crop.y = rowBounds.yStart + paddingY;
    crop.height = Math.max(34, rowBounds.yEnd - rowBounds.yStart - paddingY * 2);
  } catch (error) {
    console.error(`[OCR Section Rows] ${field.key}:`, error);
    crop.height = Math.max(50, Math.round(source.height * 0.012));
  }
}

function detectSectionRowBounds(source, field, pageCount) {
  const range = sectionSearchRange(field.section, pageCount);
  const lines = detectHorizontalLines(source, range);
  const expectedRows = field.section === "nivelacion" ? 3 : 4;

  if (lines.length < expectedRows + 1) {
    return null;
  }

  const rowLines =
    lines.length > expectedRows + 1
      ? lines.slice(-(expectedRows + 1))
      : lines;

  const targetCenter = Math.round(source.height * field.y + source.height * field.height / 2);
  const candidates = [];

  for (let i = 0; i < rowLines.length - 1; i++) {
    const yStart = rowLines[i];
    const yEnd = rowLines[i + 1];
    const gap = yEnd - yStart;
    if (gap < source.height * 0.008 || gap > source.height * 0.06) continue;

    const center = (yStart + yEnd) / 2;
    candidates.push({
      yStart,
      yEnd,
      center,
      distance: Math.abs(center - targetCenter),
    });
  }

  if (candidates.length >= expectedRows && candidates[field.rowIndex]) {
    return candidates[field.rowIndex];
  }

  return candidates.sort((a, b) => a.distance - b.distance)[0] || null;
}

function sectionSearchRange(section, pageCount) {
  if (section === "nivelacion") {
    return pageCount === 2
      ? { yStart: 0.22, yEnd: 0.36, xStart: 0.06, xEnd: 0.70, strongOnly: true }
      : { yStart: 0.24, yEnd: 0.35, xStart: 0.06, xEnd: 0.70, strongOnly: true };
  }

  return pageCount === 2
    ? { yStart: 0.68, yEnd: 0.84, xStart: 0.06, xEnd: 0.70, strongOnly: true }
    : { yStart: 0.76, yEnd: 0.88, xStart: 0.06, xEnd: 0.70, strongOnly: true };
}

function detectHorizontalLines(source, range) {
  const yStart = Math.round(source.height * range.yStart);
  const yEnd = Math.round(source.height * range.yEnd);
  const xStart = Math.round(source.width * range.xStart);
  const xEnd = Math.round(source.width * range.xEnd);
  const scanWidth = xEnd - xStart;
  const rowSums = Array(source.height).fill(0);

  for (let y = yStart; y < yEnd; y++) {
    for (let x = xStart; x < xEnd; x++) {
      const idx = (source.width * y + x) << 2;
      const gray =
        source.data[idx] * 0.299 +
        source.data[idx + 1] * 0.587 +
        source.data[idx + 2] * 0.114;
      if (gray < 150) rowSums[y]++;
    }
  }

  const threshold = scanWidth * (range.strongOnly ? 0.58 : 0.22);
  const minLineSeparation = Math.max(12, Math.round(source.height * 0.003));
  const lines = [];

  for (let y = yStart + 2; y < yEnd - 2; y++) {
    if (rowSums[y] <= threshold) continue;

    let isMax = true;
    for (let dy = -2; dy <= 2; dy++) {
      if (dy !== 0 && rowSums[y + dy] > rowSums[y]) {
        isMax = false;
        break;
      }
    }

    if (!isMax) continue;
    if (lines.length && y - lines[lines.length - 1] <= minLineSeparation) {
      if (rowSums[y] > rowSums[lines[lines.length - 1]]) {
        lines[lines.length - 1] = y;
      }
      continue;
    }
    lines.push(y);
  }

  return lines;
}

function keepOcrDebugImage(file, debugDir, name) {
  ensureDir(debugDir);
  copyFileSync(file, join(debugDir, name));
}

const onnxSessions = new Map();
let ortPromise = null;

async function loadOnnxRuntime() {
  ortPromise ??= import("onnxruntime-node").then(
    (module) => module.default || module,
  );
  return ortPromise;
}

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
  const merged = mergeDigitFragments(
    connectedComponents(pixels)
      .filter((component) => component.area > 14)
      .filter(
        (component) => {
          const aspect = component.width / component.height;
          const inverseAspect = component.height / component.width;

          return (
            component.minX > 1 &&
            component.maxX < width - 6 &&
            component.minY > 3 &&
            component.maxY < height - 4 &&
            component.width >= 4 &&
            component.height >= 8 &&
            component.width < width * 0.45 &&
            component.height < height * 0.82 &&
            aspect < 2.8 &&
            inverseAspect < 6
          );
        },
      )
      .sort((a, b) => a.minX - b.minX),
  );

  return splitTouchingDigitComponents(pixels, merged).sort(
    (a, b) => a.minX - b.minX,
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
    const hasSmallFragment = Math.min(previous.area, component.area) < 120;

    if (hasSmallFragment && gap <= 8 && yOverlap > 0) {
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

function splitTouchingDigitComponents(pixels, components) {
  const output = [];

  for (const component of components) {
    const split = splitWideComponent(pixels, component);
    output.push(...split);
  }

  return output;
}

function splitWideComponent(pixels, component, depth = 0) {
  if (depth >= 2 || component.width < 16 || component.width < component.height * 1.15) {
    return [component];
  }

  const colSums = [];
  for (let x = component.minX; x <= component.maxX; x++) {
    let sum = 0;
    for (let y = component.minY; y <= component.maxY; y++) {
      if (pixels[y][x]) sum++;
    }
    colSums.push(sum);
  }

  const minPartWidth = Math.max(5, Math.round(component.height * 0.22));
  let bestOffset = -1;
  let bestScore = Infinity;

  for (
    let offset = minPartWidth;
    offset < colSums.length - minPartWidth;
    offset++
  ) {
    const localSum =
      colSums[offset - 1] + colSums[offset] + colSums[offset + 1];
    const centerPenalty = Math.abs(offset - colSums.length / 2) * 0.08;
    const score = localSum + centerPenalty;

    if (score < bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }

  const cutThreshold = Math.max(2, component.height * 0.16);
  if (bestOffset < 0 || bestScore > cutThreshold) {
    return [component];
  }

  const cutX = component.minX + bestOffset;
  const left = componentFromPixels(
    pixels,
    component.minX,
    cutX - 1,
    component.minY,
    component.maxY,
  );
  const right = componentFromPixels(
    pixels,
    cutX + 1,
    component.maxX,
    component.minY,
    component.maxY,
  );

  if (!left || !right || left.area < 8 || right.area < 8) {
    return [component];
  }

  return [
    ...splitWideComponent(pixels, left, depth + 1),
    ...splitWideComponent(pixels, right, depth + 1),
  ];
}

function componentFromPixels(pixels, minX, maxX, minY, maxY) {
  const component = {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    area: 0,
  };

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (!pixels[y]?.[x]) continue;

      component.minX = Math.min(component.minX, x);
      component.maxX = Math.max(component.maxX, x);
      component.minY = Math.min(component.minY, y);
      component.maxY = Math.max(component.maxY, y);
      component.area++;
    }
  }

  if (!component.area) return null;

  component.width = component.maxX - component.minX + 1;
  component.height = component.maxY - component.minY + 1;

  return component;
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

  if (args.ocrModel && existsSync(args.ocrModel)) {
    modelPath = args.ocrModel;
  } else if (args.ocrModel && existsSync(join(args.out || DEFAULT_OUT, args.ocrModel))) {
    modelPath = join(args.out || DEFAULT_OUT, args.ocrModel);
  } else if (resourcesModelPath && existsSync(resourcesModelPath)) {
    modelPath = resourcesModelPath;
  } else if (process.env.E14_OCR_LOCAL_MODEL_PATH) {
    modelPath = join(process.env.E14_OCR_LOCAL_MODEL_PATH, args.ocrModel || "mnist.onnx");
  } else {
    modelPath = join(args.out || DEFAULT_OUT, "models", args.ocrModel || "mnist.onnx");
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
    const ort = await loadOnnxRuntime();
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
  const isLargeStar =
    component.area >= 900 &&
    w >= 48 &&
    h >= 70 &&
    aspect >= 0.55 &&
    aspect <= 0.98 &&
    density >= 0.16 &&
    density <= 0.33 &&
    minProp >= 0.1;

  // Asterisco (*) o cruz (X) usados como cero a la izquierda en E-14.
  return (
    isLargeStar ||
    (minProp >= 0.16 && aspect >= 0.78 && aspect <= 1.35 && density > 0.42)
  );
}

function isCompactZeroMarker(pixels, component, imageWidth, imageHeight) {
  const w = component.maxX - component.minX + 1;
  const h = component.maxY - component.minY + 1;
  if (w < 5 || h < 5) return false;

  let total = 0;
  for (let y = component.minY; y <= component.maxY; y++) {
    for (let x = component.minX; x <= component.maxX; x++) {
      if (pixels[y][x]) total++;
    }
  }

  const aspect = w / h;
  const density = total / (w * h);
  const maxZeroHeight = Math.min(44, imageHeight * 0.42);
  const isCompact =
    w <= imageWidth * 0.18 &&
    h <= maxZeroHeight &&
    aspect >= 0.55 &&
    aspect <= 1.85 &&
    density >= 0.45;

  const isSmallComparedWithField = h <= maxZeroHeight && w <= imageWidth * 0.16;

  return isCompact && isSmallComparedWithField;
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

const digitGateModels = new Map();
let tfPromise = null;

function defaultDigitGateModelPath(args = {}) {
  return join(args.out || DEFAULT_OUT, "models", "digit-gate.json");
}

function digitGateFeatureVectorFromPng(png, grid = 32) {
  const features = new Array(grid * grid).fill(0);
  const counts = new Array(grid * grid).fill(0);

  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      const index = (png.width * y + x) << 2;
      const gray =
        png.data[index] * 0.299 +
        png.data[index + 1] * 0.587 +
        png.data[index + 2] * 0.114;
      const gx = Math.min(grid - 1, Math.floor((x / png.width) * grid));
      const gy = Math.min(grid - 1, Math.floor((y / png.height) * grid));
      const featureIndex = gy * grid + gx;
      features[featureIndex] += gray / 255;
      counts[featureIndex]++;
    }
  }

  return features.map((value, index) =>
    counts[index] ? value / counts[index] : 0,
  );
}

function digitGateFeatureVectorFromComponent(pixels, component, grid = 32) {
  const tmp = new PNG({ width: 64, height: 64 });
  for (let i = 0; i < tmp.data.length; i += 4) {
    tmp.data[i] = 0;
    tmp.data[i + 1] = 0;
    tmp.data[i + 2] = 0;
    tmp.data[i + 3] = 255;
  }

  const padding = 10;
  const scale = Math.min(
    (tmp.width - padding * 2) / component.width,
    (tmp.height - padding * 2) / component.height,
  );
  const targetWidth = Math.max(1, Math.round(component.width * scale));
  const targetHeight = Math.max(1, Math.round(component.height * scale));
  const offsetX = Math.floor((tmp.width - targetWidth) / 2);
  const offsetY = Math.floor((tmp.height - targetHeight) / 2);

  for (let y = component.minY; y <= component.maxY; y++) {
    for (let x = component.minX; x <= component.maxX; x++) {
      if (!pixels[y][x]) continue;
      const tx = Math.min(
        tmp.width - 1,
        Math.max(
          0,
          offsetX +
            Math.floor(((x - component.minX) / component.width) * targetWidth),
        ),
      );
      const ty = Math.min(
        tmp.height - 1,
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
        yy <= Math.min(tmp.height - 1, ty + 1);
        yy++
      ) {
        for (
          let xx = Math.max(0, tx - 1);
          xx <= Math.min(tmp.width - 1, tx + 1);
          xx++
        ) {
          const index = (tmp.width * yy + xx) << 2;
          tmp.data[index] = 255;
          tmp.data[index + 1] = 255;
          tmp.data[index + 2] = 255;
          tmp.data[index + 3] = 255;
        }
      }
    }
  }

  return digitGateFeatureVectorFromPng(tmp, grid);
}

function sigmoid(value) {
  if (value < -40) return 0;
  if (value > 40) return 1;
  return 1 / (1 + Math.exp(-value));
}

function predictDigitGate(model, features) {
  let score = model.bias || 0;
  for (let i = 0; i < model.weights.length; i++) {
    score += model.weights[i] * (features[i] || 0);
  }
  return sigmoid(score);
}

async function loadTensorFlowForDigitGate() {
  if (!tfPromise) {
    tfPromise = import("@tensorflow/tfjs-node")
      .catch(() => import("@tensorflow/tfjs"))
      .then((module) => module.default || module);
  }

  const tf = await tfPromise;
  await tf.ready();
  return tf;
}

function componentToDigitGateTensorData(pixels, component, imageSize = 64) {
  const data = new Float32Array(imageSize * imageSize);
  const padding = 10;
  const scale = Math.min(
    (imageSize - padding * 2) / component.width,
    (imageSize - padding * 2) / component.height,
  );
  const targetWidth = Math.max(1, Math.round(component.width * scale));
  const targetHeight = Math.max(1, Math.round(component.height * scale));
  const offsetX = Math.floor((imageSize - targetWidth) / 2);
  const offsetY = Math.floor((imageSize - targetHeight) / 2);

  for (let y = component.minY; y <= component.maxY; y++) {
    for (let x = component.minX; x <= component.maxX; x++) {
      if (!pixels[y][x]) continue;

      const tx = Math.min(
        imageSize - 1,
        Math.max(
          0,
          offsetX +
            Math.floor(((x - component.minX) / component.width) * targetWidth),
        ),
      );
      const ty = Math.min(
        imageSize - 1,
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
        yy <= Math.min(imageSize - 1, ty + 1);
        yy++
      ) {
        for (
          let xx = Math.max(0, tx - 1);
          xx <= Math.min(imageSize - 1, tx + 1);
          xx++
        ) {
          data[yy * imageSize + xx] = 1;
        }
      }
    }
  }

  return data;
}

async function loadTfjsLayersModelFromDisk(tf, modelDir) {
  const modelJson = JSON.parse(readFileSync(join(modelDir, "model.json"), "utf8"));
  const manifest = modelJson.weightsManifest?.[0];
  if (!manifest) throw new Error(`Modelo TFJS sin weightsManifest: ${modelDir}`);

  const weightData = readFileSync(join(modelDir, manifest.paths[0]));
  return tf.loadLayersModel(
    tf.io.fromMemory({
      modelTopology: modelJson.modelTopology,
      weightSpecs: manifest.weights,
      weightData: weightData.buffer.slice(
        weightData.byteOffset,
        weightData.byteOffset + weightData.byteLength,
      ),
    }),
  );
}

async function getDigitGateModel(args = {}) {
  if (!args.digitGateModel) return null;

  const modelPath = args.digitGateModel;
  if (!existsSync(modelPath)) return null;

  if (!digitGateModels.has(modelPath)) {
    const stat = statSync(modelPath);
    if (stat.isDirectory() && existsSync(join(modelPath, "model.json"))) {
      const tf = await loadTensorFlowForDigitGate();
      const model = await loadTfjsLayersModelFromDisk(tf, modelPath);
      const metadataPath = join(modelPath, "metadata.json");
      const metadata = existsSync(metadataPath)
        ? JSON.parse(readFileSync(metadataPath, "utf8"))
        : {};
      digitGateModels.set(modelPath, {
        type: "tfjs",
        tf,
        model,
        threshold: metadata.threshold ?? 0.5,
        imageSize: metadata.imageSize ?? 64,
      });
    } else {
      digitGateModels.set(modelPath, {
        type: "logreg",
        ...JSON.parse(readFileSync(modelPath, "utf8")),
      });
    }
  }

  return digitGateModels.get(modelPath);
}

async function predictDigitGateProbability(gate, pixels, component) {
  if (!gate) return 1;

  if (gate.type === "tfjs") {
    const data = componentToDigitGateTensorData(
      pixels,
      component,
      gate.imageSize || 64,
    );
    const input = gate.tf.tensor4d(data, [
      1,
      gate.imageSize || 64,
      gate.imageSize || 64,
      1,
    ]);
    const output = gate.model.predict(input);
    const values = await output.data();
    input.dispose();
    output.dispose();
    return values[0];
  }

  return predictDigitGate(
    gate,
    digitGateFeatureVectorFromComponent(
      pixels,
      component,
      gate.featureGrid || 32,
    ),
  );
}

function walkPngFiles(dir, output = []) {
  if (!dir || !existsSync(dir)) return output;

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      walkPngFiles(fullPath, output);
    } else if (entry.endsWith(".png")) {
      output.push(fullPath);
    }
  }

  return output;
}

function digitGateLabelFromFile(file) {
  const name = basename(file);
  if (!/-digit-\d+/.test(name)) return null;
  if (name.includes("-as-zero") || name.includes("-rejected")) return 0;
  return 1;
}

function loadDigitGateTrainingSamples(debugDir) {
  const samples = [];
  const positiveDir = join(debugDir, "positive");
  const negativeDir = join(debugDir, "negative");

  if (existsSync(positiveDir) || existsSync(negativeDir)) {
    for (const [dir, label] of [
      [positiveDir, 1],
      [negativeDir, 0],
    ]) {
      for (const file of walkPngFiles(dir)) {
        const png = PNG.sync.read(readFileSync(file));
        samples.push({
          file,
          label,
          features: digitGateFeatureVectorFromPng(png),
        });
      }
    }

    return samples;
  }

  const files = walkPngFiles(debugDir);
  const negativeBases = new Set(
    files
      .map((file) => relative(debugDir, file))
      .filter((name) => name.includes("-as-zero") || name.includes("-rejected"))
      .map((name) => name.replace(/-(as-zero|rejected)\.png$/, ".png")),
  );

  for (const file of files) {
    const name = relative(debugDir, file);
    const label = digitGateLabelFromFile(file);
    if (label === null) continue;
    if (label === 1 && negativeBases.has(name)) continue;

    const png = PNG.sync.read(readFileSync(file));
    samples.push({
      file,
      label,
      features: digitGateFeatureVectorFromPng(png),
    });
  }

  return samples;
}

function trainDigitGateModel(samples, args = {}) {
  const featureCount = samples[0]?.features?.length || 0;
  const weights = new Array(featureCount).fill(0);
  let bias = 0;
  const epochs = Number(args.epochs || 500);
  const learningRate = Number(args.learningRate || 0.12);
  const l2 = Number(args.l2 || 0.0005);

  for (let epoch = 0; epoch < epochs; epoch++) {
    for (const sample of samples) {
      const prediction = predictDigitGate({ weights, bias }, sample.features);
      const error = prediction - sample.label;

      for (let i = 0; i < weights.length; i++) {
        weights[i] -=
          learningRate * (error * sample.features[i] + l2 * weights[i]);
      }
      bias -= learningRate * error;
    }
  }

  return {
    type: "e14-digit-gate-logreg",
    version: 1,
    featureGrid: 32,
    positiveLabel: "digit",
    negativeLabel: "non-digit-or-zero-marker",
    threshold: Number(args.digitGateThreshold || 0.45),
    weights,
    bias,
    trainedAt: new Date().toISOString(),
    samples: samples.length,
    positives: samples.filter((sample) => sample.label === 1).length,
    negatives: samples.filter((sample) => sample.label === 0).length,
  };
}

function evaluateDigitGateModel(model, samples) {
  let correct = 0;
  let fp = 0;
  let fn = 0;

  for (const sample of samples) {
    const probability = predictDigitGate(model, sample.features);
    const predicted = probability >= model.threshold ? 1 : 0;
    if (predicted === sample.label) correct++;
    else if (predicted === 1) fp++;
    else fn++;
  }

  return {
    accuracy: samples.length ? correct / samples.length : 0,
    correct,
    falsePositive: fp,
    falseNegative: fn,
  };
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
  const digitGate = await getDigitGateModel(args);

  for (let i = 0; i < components.length; i++) {
    const digitFile = join(dir, `${field.key}-digit-${i + 1}.png`);

    if (
      isCompactZeroMarker(pixels, components[i], png.width, png.height) ||
      isAsterisk(pixels, components[i])
    ) {
      writeMnistDigitImage(pixels, components[i], digitFile);
      if (args.keepOcrImages && args.debugDir) {
        keepOcrDebugImage(
          digitFile,
          args.debugDir,
          `${field.key}-digit-${i + 1}-as-zero.png`,
        );
      }
      reads.push({ digit: "0", score: 0.95 });
      continue;
    }

    if (digitGate) {
      const probability = await predictDigitGateProbability(
        digitGate,
        pixels,
        components[i],
      );

      if (
        probability < (args.digitGateThreshold || digitGate.threshold || 0.45)
      ) {
        writeMnistDigitImage(pixels, components[i], digitFile);
        if (args.keepOcrImages && args.debugDir) {
          keepOcrDebugImage(
            digitFile,
            args.debugDir,
            `${field.key}-digit-${i + 1}-rejected.png`,
          );
        }
        continue;
      }
    }

    writeMnistDigitImage(pixels, components[i], digitFile);

    if (args.keepOcrImages && args.debugDir) {
      keepOcrDebugImage(
        digitFile,
        args.debugDir,
        `${field.key}-digit-${i + 1}.png`,
      );
    }

    const floatData = preprocessMnistDigitToTensor(pixels, components[i]);
    const ort = await loadOnnxRuntime();
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
  const provider = normalizeOcrProvider(args.ocrProvider);

  if (provider === "transformers") {
    try {
      const aiResult = await runTransformersDigitOcr(image, dir, field, args);
      return {
        raw: aiResult.raw,
        confidence: aiResult.confidence,
        provider: "transformers",
        ai: aiResult,
      };
    } catch (error) {
      if (!commandExists("tesseract")) {
        throw new Error(
          `OCR ONNX fallo y Tesseract no esta instalado para fallback: ${error.message}`,
        );
      }

      const tesseractResult = runTesseract(image);
      return {
        raw: tesseractResult.raw,
        confidence: Math.min(tesseractResult.confidence, 55),
        provider: "tesseract-fallback",
        error: error.message,
        tesseract: {
          raw: tesseractResult.raw,
          confidence: tesseractResult.confidence,
        },
        ai: {
          raw: "",
          confidence: 0,
          error: error.message,
        },
      };
    }
  }

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
    "total_votantes_e11",
    "total_votos_incinerados",
    "candidato_1",
    "candidato_2",
    "votos_blanco",
    "votos_nulos",
    "votos_no_marcados",
    "total_votos_urna",
    "suma_total_formulario",
    "raw_total_votantes_e11",
    "raw_total_votos_incinerados",
    "raw_candidato_1",
    "raw_candidato_2",
    "raw_votos_blanco",
    "raw_votos_nulos",
    "raw_votos_no_marcados",
    "raw_total_votos_urna",
    "raw_suma_total_formulario",
    "suma_votos",
    "diferencia_total_urna",
    "diferencia_suma_total_formulario",
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
  const trustedSumaTotalFormulario = trusted
    ? (row.ocr?.suma_votos ?? row.ocr?.values?.suma_total_formulario ?? "")
    : "";

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
    total_votantes_e11: trusted
      ? (row.ocr?.values?.total_votantes_e11 ?? "")
      : "",
    total_votos_incinerados: trusted
      ? (row.ocr?.values?.total_votos_incinerados ?? "")
      : "",
    candidato_1: trusted ? (row.ocr?.values?.candidato_1 ?? "") : "",
    candidato_2: trusted ? (row.ocr?.values?.candidato_2 ?? "") : "",
    votos_blanco: trusted ? (row.ocr?.values?.votos_blanco ?? "") : "",
    votos_nulos: trusted ? (row.ocr?.values?.votos_nulos ?? "") : "",
    votos_no_marcados: trusted
      ? (row.ocr?.values?.votos_no_marcados ?? "")
      : "",
    total_votos_urna: trusted ? (row.ocr?.values?.total_votos_urna ?? "") : "",
    suma_total_formulario: trustedSumaTotalFormulario,
    raw_total_votantes_e11: row.ocr?.fields?.total_votantes_e11?.raw ?? "",
    raw_total_votos_incinerados:
      row.ocr?.fields?.total_votos_incinerados?.raw ?? "",
    raw_candidato_1: row.ocr?.fields?.candidato_1?.raw ?? "",
    raw_candidato_2: row.ocr?.fields?.candidato_2?.raw ?? "",
    raw_votos_blanco: row.ocr?.fields?.votos_blanco?.raw ?? "",
    raw_votos_nulos: row.ocr?.fields?.votos_nulos?.raw ?? "",
    raw_votos_no_marcados: row.ocr?.fields?.votos_no_marcados?.raw ?? "",
    raw_total_votos_urna: row.ocr?.fields?.total_votos_urna?.raw ?? "",
    raw_suma_total_formulario:
      row.ocr?.fields?.suma_total_formulario?.raw ?? "",
    suma_votos: row.ocr?.suma_votos ?? "",
    diferencia_total_urna: row.ocr?.diferencia_total_urna ?? "",
    diferencia_suma_total_formulario:
      row.ocr?.diferencia_suma_total_formulario ?? "",
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
  const sumaFormulario = values.suma_total_formulario;
  const diferencia_suma_total_formulario = Number.isFinite(sumaFormulario)
    ? suma_votos - sumaFormulario
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
    diferencia_suma_total_formulario,
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

    const renderedImage = renderPdfPage(file, dir, targetPage);
    const alignment = alignPageForOcr(renderedImage, dir);
    const image = alignment.file;
    const size = imageSize(image);
    const debugDir = args.keepOcrImages ? ocrDebugDir(out, record) : "";

    if (debugDir) {
      keepOcrDebugImage(renderedImage, debugDir, "page.png");
      if (alignment.aligned) {
        keepOcrDebugImage(image, debugDir, "page_aligned.png");
      }
      keepOcrSectionDebugImages(image, debugDir, pageCount);
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
        error: read.error,
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

function runDigitGateTraining(args) {
  const debugDir = args.debugDir || join(args.out || DEFAULT_OUT, "ocr-debug");
  const modelPath = args.digitGateModel || defaultDigitGateModelPath(args);
  const samples = loadDigitGateTrainingSamples(debugDir);
  const positives = samples.filter((sample) => sample.label === 1).length;
  const negatives = samples.length - positives;

  if (!samples.length) {
    throw new Error(
      `No se encontraron PNG de entrenamiento en ${debugDir}. Ejecuta OCR con --keep-ocr-images primero.`,
    );
  }

  if (!positives || !negatives) {
    throw new Error(
      `El dataset necesita positivos y negativos. Encontrados: positivos=${positives}, negativos=${negatives}.`,
    );
  }

  const model = trainDigitGateModel(samples, args);
  const metrics = evaluateDigitGateModel(model, samples);

  ensureDir(dirname(modelPath));
  writeFileSync(modelPath, JSON.stringify({ ...model, metrics }, null, 2));

  console.log(`Digit gate samples: ${samples.length}`);
  console.log(`  positivos: ${positives}`);
  console.log(`  negativos: ${negatives}`);
  console.log(
    `  accuracy entrenamiento: ${(metrics.accuracy * 100).toFixed(2)}%`,
  );
  console.log(`  falsos positivos: ${metrics.falsePositive}`);
  console.log(`  falsos negativos: ${metrics.falseNegative}`);
  console.log(`Digit gate model: ${modelPath}`);
}

function usage() {
  console.log(`Usage:
  node scripts/e14-audit.mjs inventory [filters]
  node scripts/e14-audit.mjs download [filters]
  node scripts/e14-audit.mjs verify [filters]
  node scripts/e14-audit.mjs ocr [filters]
  node scripts/e14-audit.mjs train-digit-gate --debug-dir output/e14/ocr-debug

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
  --digit-gate-model FILE
                         JSON logreg file or TensorFlow.js model folder for
                         filtering non-digit crops before MNIST
  --digit-gate-threshold 0.45
                         Minimum digit probability before running MNIST
  --debug-dir DIR        OCR debug folder used by train-digit-gate. If it has
                         positive/ and negative/ subfolders, those labels are used
  --epochs 500           Training epochs for train-digit-gate
`);
}

async function main() {
  try {
    const args = parseArgs(process.argv);

    if (args.command === "help") return usage();

    if (args.command === "train-digit-gate") {
      runDigitGateTraining(args);
      return;
    }

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
