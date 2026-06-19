#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { PDFDocument } from "pdf-lib";
import { ExifTool } from "exiftool-vendored";

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
  "https://divulgacione14presidente.registraduria.gov.co";
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
    baseUrl: DEFAULT_BASE_URL,
  };

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
  if (existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, "utf8"));
  ensureDir(dirname(cacheFile));
  const res = await fetchWithRetry(url, {
    headers: { accept: "application/json" },
  });
  const text = await res.text();
  writeFileSync(cacheFile, text);
  return JSON.parse(text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const corporations = data.corporations.map((c) => ({
    code: pad(c.idCorporationCode, 3),
    name: c.nameCorporation || "",
    acronym: c.acronym || "XXX",
  }));

  return {
    corporations,
    departments: departments
      .map((dep) => ({
        code: pad(dep.idDepartmentCode, 2),
        name: dep.departmentName,
        municipalities: (dep.municipalities ?? []).map((mun) => ({
          code: pad(mun.municipalityCode, 3),
          name: mun.municipalityName,
          zones: (mun.zones ?? []).map((zone) => ({
            code: pad(zone.idZoneCode, 2),
            code3: pad(zone.idZoneCode, 3),
            name: zone.zoneName,
            corporations: zone.corporations ?? [],
            stands: (zone.stands ?? []).map((stand) => ({
              code: pad(stand.standCode, 2),
              name: stand.standName,
              countTable: Number(stand.countTable || 0),
            })),
          })),
        })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

function writeInventory(records, out) {
  ensureDir(out);
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
  writeFileSync(join(out, "inventory.csv"), csv);
  writeFileSync(
    join(out, "inventory.jsonl"),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
}

function localPdfPath(out, record) {
  return join(out, "pdf", record.relativePdfPath);
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
`);
}

async function main() {
  try {
    const args = parseArgs(process.argv);

    if (args.command === "help") return usage();

    if (!["inventory", "download"].includes(args.command))
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

    const { auditFile, failed } = await runDownload(
      records,
      args,
      ({ done, total }) => {
        if (done % 25 === 0 || done === total)
          console.log(`Downloaded/audited ${done}/${total}`);
      },
    );

    console.log(`Audit: ${auditFile}`);
    console.log(`PDF dir: ${join(args.out, "pdf")}`);
    console.log(`Failures/non-PDF: ${failed}`);
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
  runDownload,
  temisUrl,
  writeInventory,
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
