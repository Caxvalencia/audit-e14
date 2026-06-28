const state = {
  catalog: null,
  records: [],
  audits: new Map(),
  ocr: new Map(),
  ocrProcess: {
    active: false,
    total: 0,
    done: 0,
    consistent: 0,
    needsReview: 0,
    skipped: 0,
    failed: 0,
  },
  selected: null,
  downloading: false,
  downloadController: null,
  currentPage: 1,
  pageSize: 50,
  defaultBaseUrl: "",
};

const desktop = window.e14Desktop || null;
const BASE_URL_STORAGE_KEY = "e14.baseUrl";
const $ = (id) => document.getElementById(id);

const els = {
  department: $("department"),
  municipality: $("municipality"),
  zone: $("zone"),
  stand: $("stand"),
  corporation: $("corporation"),
  limit: $("limit"),
  concurrency: $("concurrency"),
  out: $("out"),
  chooseOutBtn: $("chooseOutBtn"),
  skipExisting: $("skipExisting"),
  metadata: $("metadata"),
  keepOcrImages: $("keepOcrImages"),
  ocrProvider: $("ocrProvider"),
  ocrModel: $("ocrModel"),
  ocrLocalOnly: $("ocrLocalOnly"),
  inventoryBtn: $("inventoryBtn"),
  downloadBtn: $("downloadBtn"),
  ocrBtn: $("ocrBtn"),
  configBtn: $("configBtn"),
  cancelBtn: $("cancelBtn"),
  configDialog: $("configDialog"),
  configForm: $("configForm"),
  configError: $("configError"),
  closeConfigBtn: $("closeConfigBtn"),
  baseUrl: $("baseUrl"),
  resetBaseUrlBtn: $("resetBaseUrlBtn"),
  saveConfigBtn: $("saveConfigBtn"),
  status: $("status"),
  rows: $("rows"),
  search: $("search"),
  outputHint: $("outputHint"),
  detailSubtitle: $("detailSubtitle"),
  detailList: $("detailList"),
  openPdf: $("openPdf"),
  openLocal: $("openLocal"),
  showLocal: $("showLocal"),
  progressLabel: $("progressLabel"),
  progressCount: $("progressCount"),
  progressBar: $("progressBar"),
  processDialog: $("processDialog"),
  processTitle: $("processTitle"),
  processSubtitle: $("processSubtitle"),
  processLabel: $("processLabel"),
  processCount: $("processCount"),
  processBar: $("processBar"),
  ocrDone: $("ocrDone"),
  ocrOk: $("ocrOk"),
  ocrReview: $("ocrReview"),
  ocrSkipped: $("ocrSkipped"),
  closeProcessBtn: $("closeProcessBtn"),
  cancelProcessBtn: $("cancelProcessBtn"),
  openOcrDetailBtn: $("openOcrDetailBtn"),
  openOcrSummaryBtn: $("openOcrSummaryBtn"),
  ocrDetailDialog: $("ocrDetailDialog"),
  closeOcrDetailBtn: $("closeOcrDetailBtn"),
  ocrDetailSubtitle: $("ocrDetailSubtitle"),
  ocrDetailRows: $("ocrDetailRows"),
  ocrSummaryDialog: $("ocrSummaryDialog"),
  closeOcrSummaryBtn: $("closeOcrSummaryBtn"),
  ocrSummarySubtitle: $("ocrSummarySubtitle"),
  ocrSummaryRows: $("ocrSummaryRows"),
  metricTotal: $("metricTotal"),
  metricPublished: $("metricPublished"),
  metricPending: $("metricPending"),
  metricStands: $("metricStands"),

  // pagination
  pageInfo: $("pageInfo"),
  pageSize: $("pageSize"),
  firstPage: $("firstPage"),
  prevPage: $("prevPage"),
  pageNumber: $("pageNumber"),
  nextPage: $("nextPage"),
  lastPage: $("lastPage"),
};

function setStatus(text, kind = "") {
  els.status.textContent = text;
  els.status.className = `status ${kind}`.trim();
}

function option(value, label) {
  const opt = document.createElement("option");
  opt.value = value;
  opt.textContent = label;
  return opt;
}

function fillSelect(select, items, placeholder) {
  select.replaceChildren(
    option("", placeholder),
    ...items.map((item) => option(item.code, `${item.code} - ${item.name}`)),
  );
}

function selectedDepartment() {
  return state.catalog?.departments.find(
    (d) => d.code === els.department.value,
  );
}

function selectedMunicipality() {
  return selectedDepartment()?.municipalities.find(
    (m) => m.code === els.municipality.value,
  );
}

function selectedZone() {
  return selectedMunicipality()?.zones.find((z) => z.code === els.zone.value);
}

function refreshDependentFilters(level) {
  if (level === "department") {
    const dep = selectedDepartment();

    fillSelect(
      els.municipality,
      dep?.municipalities ?? [],
      "Todos los municipios",
    );
    fillSelect(els.zone, [], "Todas las zonas");
    fillSelect(els.stand, [], "Todos los puestos");
  }

  if (level === "department" || level === "municipality") {
    const mun = selectedMunicipality();

    fillSelect(els.zone, mun?.zones ?? [], "Todas las zonas");
    fillSelect(els.stand, [], "Todos los puestos");
  }

  if (level === "department" || level === "municipality" || level === "zone") {
    const zone = selectedZone();

    fillSelect(els.stand, zone?.stands ?? [], "Todos los puestos");
  }
}

function params() {
  return {
    baseUrl: currentBaseUrl(),
    department: els.department.value,
    municipality: els.municipality.value,
    zone: els.zone.value,
    stand: els.stand.value,
    corporation: els.corporation.value || "001",
    limit: Number(els.limit.value || 0),
    concurrency: Number(els.concurrency.value || 4),
    out: els.out.value || "output/e14",
    skipExisting: els.skipExisting.checked,
    metadata: els.metadata.checked,
    keepOcrImages: els.keepOcrImages.checked,
    ocrProvider: els.ocrProvider.value || "transformers",
    ocrModel: els.ocrModel.value || "mnist.onnx",
    ocrLocalOnly: els.ocrLocalOnly.checked,
  };
}

function currentBaseUrl() {
  return normalizeBaseUrl(els.baseUrl.value || state.defaultBaseUrl);
}

function normalizeBaseUrl(value) {
  const url = new URL(String(value || state.defaultBaseUrl).trim());
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (url.pathname === "/home") url.pathname = "/";
  url.search = "";
  url.hash = "";

  return url.toString().replace(/\/+$/, "");
}

function fileUrl(path, title = "") {
  const q = new URLSearchParams({
    path,
    out: els.out.value || "output/e14",
  });

  if (title) {
    q.set("title", title);
  }

  return `/api/file?${q.toString()}`;
}

function remoteFileUrl(url, title = "") {
  const q = new URLSearchParams({ url });

  if (title) {
    q.set("title", title);
  }

  return `/api/remote-file?${q.toString()}`;
}

function outputFileLink(path, label) {
  return `<a href="${fileUrl(path)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
}

function recordTitle(record) {
  return `${record.departmentName} / ${record.municipalityName} / Mesa ${record.table}`;
}

function queryFromParams(extra = {}) {
  const data = { ...params(), ...extra };
  const q = new URLSearchParams();

  Object.entries(data).forEach(([key, value]) => {
    if (value !== "" && value !== null && value !== undefined) {
      q.set(key, value);
    }
  });

  return q.toString();
}

async function loadCatalog() {
  setStatus("Cargando", "busy");

  const savedDepartment = els.department.value || localStorage.getItem("e14.department") || "";
  const savedMunicipality = els.municipality.value || localStorage.getItem("e14.municipality") || "";
  const savedZone = els.zone.value || localStorage.getItem("e14.zone") || "";
  const savedStand = els.stand.value || localStorage.getItem("e14.stand") || "";
  const savedCorporation = els.corporation.value || localStorage.getItem("e14.corporation") || "";

  const q = new URLSearchParams({
    out: els.out.value || "output/e14",
    baseUrl: currentBaseUrl(),
  });
  const res = await fetch(`/api/catalog?${q.toString()}`);

  if (!res.ok) {
    throw new Error((await res.json()).error || "No se pudo cargar catalogo");
  }

  state.catalog = await res.json();

  fillSelect(
    els.department,
    state.catalog.departments,
    "Todos los departamentos",
  );

  let dep = null;
  if (
    savedDepartment &&
    state.catalog.departments.some((d) => d.code === savedDepartment)
  ) {
    els.department.value = savedDepartment;
    dep = state.catalog.departments.find((d) => d.code === savedDepartment);
  }

  const municipalities = dep?.municipalities ?? [];
  fillSelect(els.municipality, municipalities, "Todos los municipios");

  let mun = null;
  if (
    savedMunicipality &&
    municipalities.some((m) => m.code === savedMunicipality)
  ) {
    els.municipality.value = savedMunicipality;
    mun = dep.municipalities.find((m) => m.code === savedMunicipality);
  }

  const zones = mun?.zones ?? [];
  fillSelect(els.zone, zones, "Todas las zonas");

  let zone = null;
  if (savedZone && zones.some((z) => z.code === savedZone)) {
    els.zone.value = savedZone;
    zone = mun.zones.find((z) => z.code === savedZone);
  }

  const stands = zone?.stands ?? [];
  fillSelect(els.stand, stands, "Todos los puestos");

  if (savedStand && stands.some((s) => s.code === savedStand)) {
    els.stand.value = savedStand;
  }

  fillSelect(
    els.corporation,
    state.catalog.corporations.map((c) => ({ code: c.code, name: c.name })),
    "Corporacion",
  );

  if (
    savedCorporation &&
    state.catalog.corporations.some((c) => c.code === savedCorporation)
  ) {
    els.corporation.value = savedCorporation;
  } else {
    els.corporation.value = "001";
  }

  setStatus("Listo", "ok");
}

function collectConfig() {
  return {
    defaultBaseUrl: currentBaseUrl(),
    defaultOut: els.out.value || "output/e14",
    limit: Number(els.limit.value || 0),
    concurrency: Number(els.concurrency.value || 4),
    skipExisting: els.skipExisting.checked,
    metadata: els.metadata.checked,
    keepOcrImages: els.keepOcrImages.checked,
    department: els.department.value || "",
    municipality: els.municipality.value || "",
    zone: els.zone.value || "",
    stand: els.stand.value || "",
    corporation: els.corporation.value || "001",
  };
}

async function persistConfig(config) {
  const saveRes = await fetch("/api/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!saveRes.ok) {
    const errJson = await saveRes.json().catch(() => ({}));
    throw new Error(errJson.error || "No se pudo guardar la configuración en el servidor");
  }
}

async function loadConfig() {
  // Don't send HTML default "output/e14" — let the server use its own
  // context.defaultOut which was read from the root config.json at startup.
  const savedOut = localStorage.getItem("out_folder") || "";
  const q = new URLSearchParams(savedOut ? { out: savedOut } : {});
  const res = await fetch(`/api/config?${q.toString()}`);

  if (!res.ok) {
    throw new Error(
      (await res.json()).error || "No se pudo cargar configuracion",
    );
  }

  const config = await res.json();
  state.defaultBaseUrl = normalizeBaseUrl(config.defaultBaseUrl);
  els.baseUrl.value = config.defaultBaseUrl
    ? normalizeBaseUrl(config.defaultBaseUrl)
    : state.defaultBaseUrl;

  if (config.defaultOut) {
    els.out.value = config.defaultOut;
    localStorage.setItem("out_folder", config.defaultOut);
  }

  // Restore all persisted form fields
  if (config.limit !== undefined) els.limit.value = config.limit;
  if (config.concurrency !== undefined) els.concurrency.value = config.concurrency;
  if (config.skipExisting !== undefined) els.skipExisting.checked = config.skipExisting;
  if (config.metadata !== undefined) els.metadata.checked = config.metadata;
  if (config.keepOcrImages !== undefined) els.keepOcrImages.checked = config.keepOcrImages;

  // Save filter selections to restore after catalog loads
  if (config.department) localStorage.setItem("e14.department", config.department);
  if (config.municipality) localStorage.setItem("e14.municipality", config.municipality);
  if (config.zone) localStorage.setItem("e14.zone", config.zone);
  if (config.stand) localStorage.setItem("e14.stand", config.stand);
  if (config.corporation) localStorage.setItem("e14.corporation", config.corporation);
}

function openConfig() {
  clearConfigError();
  els.baseUrl.value = currentBaseUrl();
  els.configDialog.showModal();
}

function closeConfig() {
  clearConfigError();
  els.configDialog.close();
}

async function saveConfig(event) {
  event.preventDefault();
  clearConfigError();

  try {
    const baseUrl = currentBaseUrl();
    els.baseUrl.value = baseUrl;

    await persistConfig(collectConfig());

    closeConfig();
    await loadCatalog();
  } catch (error) {
    showConfigError(error.message);
  }
}

async function resetBaseUrl() {
  clearConfigError();
  els.baseUrl.value = state.defaultBaseUrl;

  try {
    await persistConfig(collectConfig());

    closeConfig();
    await loadCatalog();
  } catch (error) {
    showConfigError(error.message);
  }
}

async function chooseOutputFolder() {
  if (!desktop) {
    return;
  }

  const folder = await desktop.selectOutputFolder();

  if (!folder) {
    return;
  }

  els.out.value = folder;
  localStorage.setItem("out_folder", folder);

  try {
    await persistConfig(collectConfig());
  } catch (e) {
    console.error(
      "Error al guardar la nueva ruta de salida en el servidor:",
      e,
    );
  }

  await loadCatalog();
}

function renderMetrics(summary = {}) {
  els.metricTotal.textContent = formatNumber(summary.total || 0);
  els.metricPublished.textContent = formatNumber(summary.published || 0);
  els.metricPending.textContent = formatNumber(summary.pending || 0);
  els.metricStands.textContent = formatNumber(summary.stands || 0);
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("es-CO");
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

async function generateInventory() {
  setBusy(true, "Inventariando");
  try {
    const res = await fetch(`/api/inventory?${queryFromParams()}`);

    if (!res.ok) {
      throw new Error(
        (await res.json()).error ||
          "No se pudo cargar la base de datos de la registraduria",
      );
    }

    const payload = await res.json();
    state.records = payload.records;
    state.audits.clear();
    state.ocr.clear();

    if (payload.audits) {
      Object.entries(payload.audits).forEach(([key, val]) => {
        state.audits.set(key, val);
      });
    }

    state.currentPage = 1;
    renderMetrics(payload.summary);
    renderRows();
    els.outputHint.textContent = `${payload.output.inventoryCsv} · ${formatNumber(payload.summary.total)} registros`;
    setProgress("Sin descarga activa", 0, 0);
    setStatus("Inventario listo", "ok");
  } catch (error) {
    setStatus("Error", "error");
    showError(error);
  } finally {
    setBusy(false);
  }
}

function setBusy(disabled, label = "Procesando") {
  state.downloading = disabled;
  els.inventoryBtn.disabled = disabled;
  els.downloadBtn.disabled = disabled;
  els.ocrBtn.disabled = disabled;
  els.cancelBtn.classList.toggle("hidden", !disabled);
  els.cancelBtn.disabled = !disabled;

  if (disabled) {
    setStatus(label, "busy");
  }
}

function filteredRecords() {
  const terms = searchTokens(els.search.value);
  const sorted = [...state.records].sort((a, b) =>
    recordKey(a).localeCompare(recordKey(b)),
  );

  if (!terms.length) {
    return sorted;
  }

  return sorted.filter((r) => {
    const key = recordKey(r);
    const audit = state.audits.get(key);
    const ocr = state.ocr.get(key);
    const text = buildSearchText(r, audit, ocr);

    return terms.every((term) => text.includes(term));
  });
}

function renderRows() {
  const rows = filteredRecords();
  const totalPages = Math.max(1, Math.ceil(rows.length / state.pageSize));
  state.currentPage = Math.min(Math.max(1, state.currentPage), totalPages);
  const start = (state.currentPage - 1) * state.pageSize;
  const pageRows = rows.slice(start, start + state.pageSize);
  const fragment = document.createDocumentFragment();

  pageRows.forEach((record, pageIndex) => {
    const key = recordKey(record);
    const audit = state.audits.get(key);
    const ocr = state.ocr.get(key);
    const tr = document.createElement("tr");
    tr.dataset.key = key;

    if (state.selected && recordKey(state.selected) === key) {
      tr.classList.add("active");
    }

    tr.innerHTML = `
      <td class="row-index">${formatNumber(start + pageIndex + 1)}</td>
      
      <td title="${record.department}-${record.municipality}-${record.zone}-${record.stand}">
        <strong>${escapeHtml(record.departmentName)} / ${escapeHtml(record.municipalityName)}</strong>
        <br>
        <span class="mono">${escapeHtml(record.standName)}</span>
      </td>
      
      <td>
        <strong>Mesa ${record.table}</strong>
      </td>
      
      <td>${statusPill(record.status)}</td>
      
      <td>${auditPill(audit)}${ocr ? `<br>${ocrPill(ocr)}` : ""}</td>

      <td>
        <div class="row-actions">
          <button class="row-action load-action" type="button">Cargar</button>
          <button class="row-action verify-action" type="button" ${audit?.localPath ? "" : "disabled"}>Validar</button>
        </div>
      </td>
    `;

    tr.querySelector(".load-action").addEventListener("click", (event) => {
      event.stopPropagation();
      loadSingleRow(record, event.currentTarget);
    });

    tr.querySelector(".verify-action").addEventListener("click", (event) => {
      event.stopPropagation();
      verifySingleRow(record, event.currentTarget);
    });

    tr.addEventListener("click", () => selectRecord(record));
    fragment.appendChild(tr);
  });

  els.rows.replaceChildren(fragment);
  renderPagination(rows.length, start, pageRows.length, totalPages);
}

function renderPagination(totalRows, start, pageRows, totalPages) {
  const from = totalRows ? start + 1 : 0;
  const to = totalRows ? start + pageRows : 0;

  els.pageInfo.textContent = `${formatNumber(from)}-${formatNumber(to)} de ${formatNumber(totalRows)} registros`;
  els.pageNumber.textContent = `${formatNumber(state.currentPage)} / ${formatNumber(totalPages)}`;
  els.firstPage.disabled = state.currentPage <= 1;
  els.prevPage.disabled = state.currentPage <= 1;
  els.nextPage.disabled = state.currentPage >= totalPages;
  els.lastPage.disabled = state.currentPage >= totalPages;
}

function buildSearchText(record, audit, ocr) {
  const values = [
    ...deepValues(record),
    audit ? deepValues(audit) : [],
    ocr ? deepValues(ocr) : [],
    Number(record.status) === 11 ? "publicado" : "pendiente",
    audit ? (audit.ok ? "auditado valido ok" : "error fallido") : "sin auditar",
    ocr
      ? ocr.ocr?.consistente
        ? "ocr consistente validado"
        : "ocr revision inconsistente"
      : "sin ocr",
    `mesa ${record.table}`,
    `${record.department}-${record.municipality}-${record.zone}-${record.stand}`,
    `${record.departmentName} ${record.municipalityName} ${record.zoneName} ${record.standName}`,
  ];

  return normalizeSearch(values.flat().join(" "));
}

function deepValues(value) {
  if (value === null || value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap(deepValues);
  }

  if (typeof value === "object") {
    return Object.values(value).flatMap(deepValues);
  }

  return [String(value)];
}

function normalizeSearch(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .toLowerCase()
    .trim();
}

function searchTokens(value) {
  return normalizeSearch(value).split(/\s+/).filter(Boolean);
}

function statusPill(status) {
  return Number(status) === 11
    ? `<span class="pill ok">Publicado</span>`
    : `<span class="pill warn">Pendiente</span>`;
}

function auditPill(audit) {
  if (!audit) return `<span class="pill warn">Sin auditar</span>`;

  if (audit.verification) {
    if (audit.ok) {
      return `<span class="pill ok">Validado</span>`;
    }

    if (audit.verification.checksumOk === false) {
      return `<span class="pill error">Hash distinto</span>`;
    }

    if (audit.verification.metadataOk === false) {
      return `<span class="pill error">Metadata distinta</span>`;
    }
  }

  if (audit.ok) {
    return `<span class="pill ok">${formatBytes(audit.bytes)}</span>`;
  }

  return `<span class="pill error">Error</span>`;
}

function ocrPill(row) {
  if (row.ocr?.consistente) {
    return `<span class="pill ok">OCR OK</span>`;
  }

  if (row.error) {
    return `<span class="pill error">OCR error</span>`;
  }

  return `<span class="pill warn">OCR revision</span>`;
}

function trustedOcrValue(row, key) {
  return row?.ocr?.consistente ? (row.ocr?.values?.[key] ?? "") : "";
}

function rawOcrValue(row, key) {
  return row?.ocr?.fields?.[key]?.raw || "";
}

function selectRecord(record) {
  state.selected = record;
  renderRows();
  renderDetail(record);
}

function renderDetail(record) {
  const audit = state.audits.get(recordKey(record));
  const ocr = state.ocr.get(recordKey(record));
  const title = recordTitle(record);
  els.detailSubtitle.textContent = title;
  const meta = audit?.metadata || {};
  const verification = audit?.verification;
  const entries = [
    ["Departamento", `${record.department} - ${record.departmentName}`],
    ["Municipio", `${record.municipality} - ${record.municipalityName}`],
    ["Zona", `${record.zone} - ${record.zoneName}`],
    ["Puesto", `${record.stand} - ${record.standName}`],
    ["Mesa", record.table],
    ["Estado", Number(record.status) === 11 ? "Publicado" : "Pendiente"],
    ["Archivo", record.expectedName],
    ["SHA-256", audit?.sha256 || ""],
    ["SHA-256 remoto", verification?.remoteSha256 || ""],
    [
      "Checksum",
      verification
        ? verification.checksumOk
          ? "Coincide"
          : "No coincide"
        : "",
    ],
    [
      "Metadata",
      verification
        ? verification.metadataOk
          ? "Coincide"
          : "No coincide"
        : "",
    ],
    ["Validado", verification?.verifiedAt || ""],
    ["Bytes", audit?.bytes ? formatBytes(audit.bytes) : ""],
    [
      "Bytes remoto",
      verification?.remoteBytes ? formatBytes(verification.remoteBytes) : "",
    ],
    ["Error", audit?.error || ""],
    ["Paginas", meta.PageCount || ""],
    ["Version PDF", meta.PDFVersion || ""],
  ];

  if (ocr) {
    entries.push(
      ["OCR", ocr.ocr?.consistente ? "Consistente" : "Requiere revision"],
      ["OCR proveedor", ocr.ocr?.proveedor ?? ""],
      ["OCR confianza", ocr.ocr?.confianza_promedio ?? ""],
      ["OCR total urna", trustedOcrValue(ocr, "total_votos_urna")],
      ["OCR candidato 1", trustedOcrValue(ocr, "candidato_1")],
      ["OCR candidato 2", trustedOcrValue(ocr, "candidato_2")],
      ["OCR blanco", trustedOcrValue(ocr, "votos_blanco")],
      ["OCR nulos", trustedOcrValue(ocr, "votos_nulos")],
      ["OCR no marcados", trustedOcrValue(ocr, "votos_no_marcados")],
      ["OCR raw total", rawOcrValue(ocr, "total_votos_urna")],
      ["OCR raw C1", rawOcrValue(ocr, "candidato_1")],
      ["OCR raw C2", rawOcrValue(ocr, "candidato_2")],
      ["OCR raw blanco", rawOcrValue(ocr, "votos_blanco")],
      ["OCR raw nulos", rawOcrValue(ocr, "votos_nulos")],
      ["OCR raw no marc.", rawOcrValue(ocr, "votos_no_marcados")],
      ["OCR suma", ocr.ocr?.suma_votos ?? ""],
      ["OCR diferencia", ocr.ocr?.diferencia_total_urna ?? ""],
      ["OCR error", ocr.error || ""],
    );
  }

  const nodes = entries.flatMap(([label, value]) => detailPair(label, value));
  const metaEntries = Object.entries(meta).sort(([a], [b]) =>
    a.localeCompare(b),
  );

  if (metaEntries.length) {
    const heading = document.createElement("dt");
    heading.className = "metadata-heading";
    heading.textContent = "Metadata completa";
    const spacer = document.createElement("dd");
    spacer.className = "metadata-heading";
    spacer.textContent = `${metaEntries.length} campos`;

    nodes.push(heading, spacer);

    for (const [key, value] of metaEntries) {
      nodes.push(...detailPair(key, formatMetaValue(value), true));
    }
  }

  if (verification?.metadataDiff?.length) {
    const heading = document.createElement("dt");
    heading.className = "metadata-heading";
    heading.textContent = "Diferencias metadata";

    const spacer = document.createElement("dd");
    spacer.className = "metadata-heading";
    spacer.textContent = `${verification.metadataDiff.length} campos`;
    nodes.push(heading, spacer);

    for (const diff of verification.metadataDiff) {
      nodes.push(
        ...detailPair(
          diff.key,
          `Local: ${formatMetaValue(diff.local)} | Registraduria: ${formatMetaValue(diff.remote)}`,
          true,
        ),
      );
    }
  }

  els.detailList.replaceChildren(...nodes);
  els.openPdf.href = remoteFileUrl(record.pdfUrl, title);
  els.openPdf.dataset.path = "";
  els.openPdf.classList.remove("disabled");

  if (audit?.localPath) {
    els.openLocal.href = fileUrl(audit.localPath, title);
    els.openLocal.dataset.path = audit.localPath;
    els.openLocal.classList.remove("disabled");
    els.showLocal.dataset.path = audit.localPath;
    els.showLocal.disabled = !desktop;
    els.showLocal.classList.toggle("disabled", !desktop);
  } else {
    els.openLocal.href = "#";
    els.openLocal.dataset.path = "";
    els.openLocal.classList.add("disabled");
    els.showLocal.dataset.path = "";
    els.showLocal.disabled = true;
    els.showLocal.classList.add("disabled");
  }
}

function detailPair(label, value, metadata = false) {
  const dt = document.createElement("dt");
  dt.textContent = label;

  if (metadata) {
    dt.classList.add("metadata-key");
  }

  const dd = document.createElement("dd");
  dd.textContent = value || "—";
  dd.classList.add("mono");

  if (["Checksum", "Metadata"].includes(label) || metadata) {
    if (value.includes("No coincide") || value.includes("Error")) {
      dd.classList.add("pill", "error");
    } else if (value.includes("Coincide") || value.includes("Coincide")) {
      dd.classList.add("pill", "ok");
    }
  }

  return [dt, dd];
}

function formatMetaValue(value) {
  if (value === null || value === undefined || value === "") {
    return "—";
  }

  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : "—";
  }

  if (typeof value === "object") {
    // Check if it's an ExifDateTime or has all date/time fields
    if (
      value._ctor === "ExifDateTime" ||
      (value.year !== undefined &&
        value.month !== undefined &&
        value.day !== undefined &&
        value.hour !== undefined)
    ) {
      const dateStr = `${value.year}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
      const timeStr = `${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}:${String(value.second).padStart(2, "0")}`;
      const tz = value.zoneName
        ? ` ${value.zoneName}`
        : value.tzoffsetMinutes !== undefined
          ? value.tzoffsetMinutes === 0
            ? " UTC"
            : ` UTC${value.tzoffsetMinutes > 0 ? "+" : ""}${value.tzoffsetMinutes / 60}`
          : "";

      return `${dateStr} ${timeStr}${tz}`;
    }

    // Check if it's an ExifDate
    if (
      value._ctor === "ExifDate" ||
      (value.year !== undefined &&
        value.month !== undefined &&
        value.day !== undefined)
    ) {
      return `${value.year}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
    }

    // Check if it's an ExifTime
    if (
      value._ctor === "ExifTime" ||
      (value.hour !== undefined && value.minute !== undefined)
    ) {
      return `${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}:${String(value.second).padStart(2, "0")}`;
    }

    // Fallback to rawValue if present
    if (value.rawValue) {
      return String(value.rawValue);
    }

    return JSON.stringify(value);
  }

  return String(value);
}

function formatBytes(bytes) {
  if (!bytes) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }

  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function setProgress(label, done, total) {
  els.progressLabel.textContent = label;
  els.progressCount.textContent = `${formatNumber(done)} / ${formatNumber(total)}`;

  const pct = total ? Math.round((done / total) * 100) : 0;
  els.progressBar.style.width = `${pct}%`;
}

function openProcessModal(title, subtitle) {
  els.processTitle.textContent = title;
  els.processSubtitle.textContent = subtitle;
  els.openOcrDetailBtn.disabled = state.ocr.size === 0;
  els.openOcrSummaryBtn.disabled = state.ocr.size === 0;

  if (!els.processDialog.open) {
    els.processDialog.showModal();
  }
}

function updateProcessModal(label, stats = {}) {
  state.ocrProcess = {
    ...state.ocrProcess,
    ...stats,
  };
  const total = state.ocrProcess.total || 0;
  const done = state.ocrProcess.done || 0;
  const pct = total ? Math.round((done / total) * 100) : 0;

  els.processLabel.textContent = label;
  els.processCount.textContent = `${formatNumber(done)} / ${formatNumber(total)}`;
  els.processBar.style.width = `${pct}%`;
  els.ocrDone.textContent = formatNumber(done);
  els.ocrOk.textContent = formatNumber(state.ocrProcess.consistent || 0);
  els.ocrReview.textContent = formatNumber(state.ocrProcess.needsReview || 0);
  els.ocrSkipped.textContent = formatNumber(state.ocrProcess.skipped || 0);
  els.openOcrDetailBtn.disabled = state.ocr.size === 0;
  els.openOcrSummaryBtn.disabled = state.ocr.size === 0;
}

function ocrRows() {
  return [...state.ocr.values()].sort((a, b) =>
    recordKey(a).localeCompare(recordKey(b)),
  );
}

function openOcrDetailModal() {
  const rows = ocrRows();
  els.ocrDetailSubtitle.textContent = `${formatNumber(rows.length)} mesas procesadas`;
  els.ocrDetailRows.replaceChildren(
    ...rows.slice(0, 1000).map((row) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(row.departmentName)} / ${escapeHtml(row.municipalityName)}<br><span class="mono">${escapeHtml(row.zoneName)} / ${escapeHtml(row.standName)}</span></td>
        <td>${escapeHtml(row.table)}</td>
        <td>${escapeHtml(trustedOcrValue(row, "total_votos_urna"))}</td>
        <td>${escapeHtml(trustedOcrValue(row, "candidato_1"))}</td>
        <td>${escapeHtml(trustedOcrValue(row, "candidato_2"))}</td>
        <td>${escapeHtml(trustedOcrValue(row, "votos_blanco"))}</td>
        <td>${escapeHtml(trustedOcrValue(row, "votos_nulos"))}</td>
        <td>${escapeHtml(trustedOcrValue(row, "votos_no_marcados"))}</td>
        <td>${escapeHtml(row.ocr?.diferencia_total_urna ?? "")}</td>
        <td>${escapeHtml(row.ocr?.proveedor ?? "")}</td>
        <td>${row.ocr?.consistente ? "Consistente" : row.error ? "Error" : "Revision"}</td>
      `;

      return tr;
    }),
  );

  if (!els.ocrDetailDialog.open) {
    els.ocrDetailDialog.showModal();
  }
}

function ocrSummaryRows() {
  const grouped = new Map();

  for (const row of state.ocr.values()) {
    if (!row.ocr?.consistente) continue;

    const key = [
      row.department,
      row.municipality,
      row.zone,
      row.stand,
      row.corporation,
    ].join("|");

    if (!grouped.has(key)) {
      grouped.set(key, {
        label: `${escapeHtml(row.departmentName)} / ${escapeHtml(row.municipalityName)}<br><span class="mono">${escapeHtml(row.zoneName)} / ${escapeHtml(row.standName)}</span>`,
        mesas: 0,
        total: 0,
        candidato_1: 0,
        candidato_2: 0,
        votos_blanco: 0,
        votos_nulos: 0,
        votos_no_marcados: 0,
      });
    }

    const summary = grouped.get(key);
    const values = row.ocr.values || {};
    summary.mesas++;
    summary.total += Number(values.total_votos_urna || 0);
    summary.candidato_1 += Number(values.candidato_1 || 0);
    summary.candidato_2 += Number(values.candidato_2 || 0);
    summary.votos_blanco += Number(values.votos_blanco || 0);
    summary.votos_nulos += Number(values.votos_nulos || 0);
    summary.votos_no_marcados += Number(values.votos_no_marcados || 0);
  }

  return [...grouped.values()];
}

function openOcrSummaryModal() {
  const rows = ocrSummaryRows();
  els.ocrSummarySubtitle.textContent = `${formatNumber(rows.length)} grupos con mesas consistentes`;
  els.ocrSummaryRows.replaceChildren(
    ...rows.map((row) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${row.label}</td>
        <td>${formatNumber(row.mesas)}</td>
        <td>${formatNumber(row.total)}</td>
        <td>${formatNumber(row.candidato_1)}</td>
        <td>${formatNumber(row.candidato_2)}</td>
        <td>${formatNumber(row.votos_blanco)}</td>
        <td>${formatNumber(row.votos_nulos)}</td>
        <td>${formatNumber(row.votos_no_marcados)}</td>
      `;

      return tr;
    }),
  );

  if (!els.ocrSummaryDialog.open) {
    els.ocrSummaryDialog.showModal();
  }
}

function getFilteredTablesCount() {
  if (!state.catalog) return 0;

  const depCode = els.department.value;
  const munCode = els.municipality.value;
  const zoneCode = els.zone.value;
  const standCode = els.stand.value;

  let total = 0;

  for (const dep of state.catalog.departments) {
    if (depCode && dep.code !== depCode) continue;
    for (const mun of dep.municipalities) {
      if (munCode && mun.code !== munCode) continue;
      for (const zone of mun.zones) {
        if (zoneCode && zone.code !== zoneCode) continue;
        for (const stand of zone.stands) {
          if (standCode && stand.code !== standCode) continue;
          total += stand.countTable || 0;
        }
      }
    }
  }

  return total;
}

async function downloadAudit() {
  const count = getFilteredTablesCount();
  const limit = Number(els.limit.value || 0);
  const actualCount = limit > 0 ? Math.min(count, limit) : count;

  if (actualCount > 2000) {
    const confirmDownload = confirm(
      `¡Atención! Estás a punto de descargar y auditar ${formatNumber(actualCount)} formularios E14.\n\nEsta operación puede tardar bastante tiempo y consumir una cantidad significativa de ancho de banda y almacenamiento.\n\n¿Estás seguro de que deseas continuar?`,
    );
    if (!confirmDownload) {
      return;
    }
  }

  setBusy(true, "Descargando");
  state.downloadController = new AbortController();
  state.audits.clear();
  setProgress("Preparando descarga", 0, 0);
  renderRows();

  try {
    const res = await fetch("/api/download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params()),
      signal: state.downloadController.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error("No se pudo iniciar la descarga");
    }

    await readNdjson(res.body);

    if (!state.downloadController.signal.aborted) {
      setStatus("Auditoria lista", "ok");
    }
  } catch (error) {
    if (error.name === "AbortError") {
      setStatus("Cancelado", "error");
      setProgress(
        "Descarga cancelada",
        state.audits.size,
        state.records.length,
      );
    } else {
      setStatus("Error", "error");
      showError(error);
    }
  } finally {
    state.downloadController = null;
    setBusy(false);
  }
}

async function extractOcr() {
  const count = getFilteredTablesCount();
  const limit = Number(els.limit.value || 0);
  const actualCount = limit > 0 ? Math.min(count, limit) : count;

  if (actualCount > 500) {
    const confirmOcr = confirm(
      `Vas a procesar OCR sobre ${formatNumber(actualCount)} formularios locales.\n\nEl OCR puede tardar bastante y solo consolida como validas las mesas que cuadren matematicamente.\n\n¿Deseas continuar?`,
    );
    if (!confirmOcr) {
      return;
    }
  }

  setBusy(true, "OCR");
  state.downloadController = new AbortController();
  state.ocr.clear();
  state.ocrProcess = {
    active: true,
    total: actualCount,
    done: 0,
    consistent: 0,
    needsReview: 0,
    skipped: 0,
    failed: 0,
  };
  setProgress("Preparando OCR", 0, 0);
  openProcessModal(
    "Extrayendo votos OCR",
    "Leyendo PDFs locales y conservando resultados ya procesados",
  );
  updateProcessModal("Preparando OCR", state.ocrProcess);
  renderRows();

  try {
    const res = await fetch("/api/ocr", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params()),
      signal: state.downloadController.signal,
    });

    if (!res.ok || !res.body) {
      throw new Error("No se pudo iniciar OCR");
    }

    await readNdjson(res.body, handleOcrEvent);

    if (!state.downloadController.signal.aborted) {
      setStatus("OCR listo", "ok");
    }
  } catch (error) {
    if (error.name === "AbortError") {
      setStatus("Cancelado", "error");
      setProgress("OCR cancelado", state.ocr.size, state.records.length);
    } else {
      setStatus("Error", "error");
      showError(error);
    }
  } finally {
    state.downloadController = null;
    state.ocrProcess.active = false;
    setBusy(false);
  }
}

async function loadSingleRow(record, button) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Cargando";
  selectRecord(record);
  setStatus("Cargando fila", "busy");

  try {
    const res = await fetch("/api/download", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...params(),
        department: record.department,
        municipality: record.municipality,
        zone: record.zone,
        stand: record.stand,
        table: record.table,
        corporation: record.corporation,
        limit: 0,
        concurrency: 1,
        skipExisting: true,
      }),
    });

    if (!res.ok || !res.body) {
      throw new Error("No se pudo cargar la fila");
    }

    const result = await readSingleRowNdjson(res.body);

    if (result) {
      const key = recordKey(result);
      state.audits.set(key, result);
      const index = state.records.findIndex((item) => recordKey(item) === key);

      if (index >= 0) {
        state.records[index] = { ...state.records[index], ...result };
      }

      state.selected = state.records[index] || result;
      renderRows();
      renderDetail(state.selected);
      setStatus("Fila cargada", "ok");
    } else {
      setStatus("Sin resultado", "error");
    }
  } catch (error) {
    setStatus("Error", "error");
    showError(error);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function verifySingleRow(record, button) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Validando";

  selectRecord(record);
  setStatus("Validando fila", "busy");

  try {
    const res = await fetch("/api/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...params(),
        department: record.department,
        municipality: record.municipality,
        zone: record.zone,
        stand: record.stand,
        table: record.table,
        corporation: record.corporation,
        limit: 0,
        concurrency: 1,
      }),
    });

    if (!res.ok || !res.body) {
      throw new Error("No se pudo validar la fila");
    }

    const result = await readSingleRowNdjson(res.body);

    if (result) {
      const key = recordKey(result);
      state.audits.set(key, result);

      const index = state.records.findIndex((item) => recordKey(item) === key);

      if (index >= 0) {
        state.records[index] = { ...state.records[index], ...result };
      }

      state.selected = state.records[index] || result;
      renderRows();
      renderDetail(state.selected);

      setStatus(
        result.ok ? "Validacion correcta" : "Validacion con diferencias",
        result.ok ? "ok" : "error",
      );
    } else {
      setStatus("Sin resultado", "error");
    }
  } catch (error) {
    setStatus("Error", "error");
    showError(error);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function readSingleRowNdjson(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let loadedRow = null;

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === "row") loadedRow = event.row;
    }
  }

  if (buffer.trim()) {
    const event = JSON.parse(buffer);
    if (event.type === "row") loadedRow = event.row;
  }

  return loadedRow;
}

async function readNdjson(stream, handler = handleDownloadEvent) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.trim()) {
        handler(JSON.parse(line));
      }
    }
  }

  if (buffer.trim()) {
    handler(JSON.parse(buffer));
  }
}

function handleDownloadEvent(event) {
  if (event.type === "start") {
    renderMetrics(event.summary);
    state.records = [];
    state.currentPage = 1;
    setProgress("Descargando PDFs", 0, event.total);

    return;
  }

  if (event.type === "row") {
    const row = event.row;
    const key = recordKey(row);

    if (!state.records.some((record) => recordKey(record) === key)) {
      state.records.push(row);
    }

    state.audits.set(key, row);

    setProgress("Descargando PDFs", event.done, event.total);

    if (state.selected && recordKey(state.selected) === key) {
      renderDetail(row);
    }

    if (event.done % 10 === 0 || event.done === event.total) {
      renderRows();
    }

    return;
  }

  if (event.type === "complete") {
    setProgress(
      `Completado · fallos ${event.failed}`,
      event.total,
      event.total,
    );
    renderRows();
    els.outputHint.textContent = `${event.auditFile} · ${formatNumber(event.total)} registros`;
  }

  if (event.type === "canceled") {
    setProgress(
      `Cancelado · ${formatNumber(event.done)} auditados`,
      event.done,
      event.total,
    );
    renderRows();
    els.outputHint.textContent = `${event.auditFile} · descarga cancelada`;
  }
}

function handleOcrEvent(event) {
  if (event.type === "start") {
    renderMetrics(event.summary);
    state.currentPage = 1;
    setProgress("Extrayendo votos OCR", 0, event.total);
    updateProcessModal("Extrayendo votos OCR", {
      total: event.total,
      done: 0,
      consistent: 0,
      needsReview: 0,
      skipped: 0,
      failed: 0,
    });

    return;
  }

  if (event.type === "row") {
    const row = event.row;
    const key = recordKey(row);

    state.ocr.set(key, row);

    if (!state.records.some((record) => recordKey(record) === key)) {
      state.records.push(row);
    }

    setProgress(
      `OCR · consistentes ${formatNumber(event.consistent || 0)} · revision ${formatNumber(event.needsReview || 0)} · omitidas ${formatNumber(event.skipped || 0)}`,
      event.done,
      event.total,
    );
    updateProcessModal("Procesando OCR", {
      total: event.total,
      done: event.done,
      consistent: event.consistent || 0,
      needsReview: event.needsReview || 0,
      skipped: event.skipped || 0,
      failed: event.failed || 0,
    });

    if (state.selected && recordKey(state.selected) === key) {
      renderDetail(row);
    }

    if (event.done % 10 === 0 || event.done === event.total) {
      renderRows();
    }

    return;
  }

  if (event.type === "complete") {
    setProgress(
      `OCR completo · consistentes ${formatNumber(event.consistent || 0)} · revision ${formatNumber(event.needsReview || 0)} · omitidas ${formatNumber(event.skipped || 0)}`,
      event.total,
      event.total,
    );
    updateProcessModal("OCR completo", {
      total: event.total,
      done: event.total,
      consistent: event.consistent || 0,
      needsReview: event.needsReview || 0,
      skipped: event.skipped || 0,
      failed: event.failed || 0,
    });
    renderRows();
    els.outputHint.innerHTML = `${outputFileLink(event.resultsCsv, "Detalle OCR CSV")} · ${outputFileLink(event.summaryCsv, "Resumen por zona CSV")}`;
  }

  if (event.type === "canceled") {
    setProgress(
      `OCR cancelado · ${formatNumber(event.done)} procesados`,
      event.done,
      event.total,
    );
    updateProcessModal("OCR cancelado", {
      total: event.total,
      done: event.done,
      consistent: event.consistent || 0,
      needsReview: event.needsReview || 0,
      skipped: event.skipped || 0,
      failed: event.failed || 0,
    });
    renderRows();
    els.outputHint.innerHTML = `${outputFileLink(event.resultsCsv, "Detalle OCR CSV")} · OCR cancelado`;
  }
}

function showError(error) {
  els.detailSubtitle.textContent = "Error";
  els.detailList.replaceChildren();
  const dt = document.createElement("dt");
  dt.textContent = "Mensaje";
  const dd = document.createElement("dd");
  dd.textContent = error.message;
  els.detailList.append(dt, dd);
}

function showConfigError(msg) {
  if (els.configError) {
    els.configError.textContent = msg;
    els.configError.classList.remove("hidden");
  } else {
    alert(msg);
  }
}

function clearConfigError() {
  if (els.configError) {
    els.configError.textContent = "";
    els.configError.classList.add("hidden");
  }
}

async function showLocalInFolder(event) {
  const path = event.currentTarget.dataset.path;

  if (!desktop || !path) {
    return;
  }

  const result = await desktop.showItemInFolder(path);

  if (!result.ok) {
    showError(new Error(result.error || "No se pudo mostrar el archivo"));
  }
}

if (desktop) {
  els.chooseOutBtn.classList.remove("hidden");
}

els.department.addEventListener("change", () =>
  refreshDependentFilters("department"),
);
els.municipality.addEventListener("change", () =>
  refreshDependentFilters("municipality"),
);

els.zone.addEventListener("change", () => refreshDependentFilters("zone"));
els.inventoryBtn.addEventListener("click", generateInventory);
els.downloadBtn.addEventListener("click", downloadAudit);
els.ocrBtn.addEventListener("click", extractOcr);
els.configBtn.addEventListener("click", openConfig);
els.closeConfigBtn.addEventListener("click", closeConfig);
els.configDialog.addEventListener("close", () => {
  els.baseUrl.value = state.defaultBaseUrl;
});
els.configDialog.addEventListener("cancel", () => {
  els.baseUrl.value = state.defaultBaseUrl;
});
els.configForm.addEventListener("submit", saveConfig);
els.resetBaseUrlBtn.addEventListener("click", resetBaseUrl);
els.chooseOutBtn.addEventListener("click", chooseOutputFolder);
els.showLocal.addEventListener("click", showLocalInFolder);
els.closeProcessBtn.addEventListener("click", () => els.processDialog.close());
els.cancelProcessBtn.addEventListener("click", () => {
  state.downloadController?.abort();
});
els.openOcrDetailBtn.addEventListener("click", openOcrDetailModal);
els.openOcrSummaryBtn.addEventListener("click", openOcrSummaryModal);
els.closeOcrDetailBtn.addEventListener("click", () =>
  els.ocrDetailDialog.close(),
);
els.closeOcrSummaryBtn.addEventListener("click", () =>
  els.ocrSummaryDialog.close(),
);
els.cancelBtn.addEventListener("click", () => {
  state.downloadController?.abort();
});

els.search.addEventListener("input", () => {
  state.currentPage = 1;
  renderRows();
});

els.pageSize.addEventListener("change", () => {
  state.pageSize = Number(els.pageSize.value || 50);
  state.currentPage = 1;
  renderRows();
});

els.firstPage.addEventListener("click", () => {
  state.currentPage = 1;
  renderRows();
});

els.prevPage.addEventListener("click", () => {
  state.currentPage -= 1;
  renderRows();
});

els.nextPage.addEventListener("click", () => {
  state.currentPage += 1;
  renderRows();
});

els.lastPage.addEventListener("click", () => {
  state.currentPage = Number.MAX_SAFE_INTEGER;
  renderRows();
});

els.out.addEventListener("change", loadCatalog);

loadConfig()
  .then(loadCatalog)
  .catch((error) => {
    setStatus("Error", "error");
    showError(error);
  });
