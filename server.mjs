#!/usr/bin/env node
import { createReadStream, existsSync, statSync, readFileSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { createServer } from "node:http";
import { URL } from "node:url";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BASE_URL,
  DEFAULT_OUT,
  buildCatalog,
  loadData,
  normalizeBaseUrl,
  pad,
  recordsFromData,
  runDownload,
  writeInventory,
} from "./scripts/e14-audit.mjs";

const DEFAULT_ROOT = process.cwd();
const DEFAULT_PUBLIC = resolve(DEFAULT_ROOT, "public");
const DEFAULT_PORT = Number(process.env.PORT || 4173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);

  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function notFound(res) {
  json(res, 404, { error: "Not found" });
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolveBody(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function argsFromQuery(params, context) {
  return {
    out: params.get("out") || (context && context.defaultOut) || DEFAULT_OUT,
    baseUrl: normalizeBaseUrl(params.get("baseUrl") || DEFAULT_BASE_URL),
    department: params.get("department")
      ? pad(params.get("department"), 2)
      : null,
    municipality: params.get("municipality")
      ? pad(params.get("municipality"), 3)
      : null,
    zone: params.get("zone") ? pad(params.get("zone"), 2) : null,
    stand: params.get("stand") ? pad(params.get("stand"), 2) : null,
    table: params.get("table") ? pad(params.get("table"), 3) : null,
    corporation: params.get("corporation")
      ? pad(params.get("corporation"), 3)
      : "001",
    limit: Number(params.get("limit") || 0),
    concurrency: Number(params.get("concurrency") || 4),
    skipExisting: params.get("skipExisting") !== "false",
    metadata: params.get("metadata") !== "false",
  };
}

function argsFromBody(body, context) {
  return {
    out: body.out || (context && context.defaultOut) || DEFAULT_OUT,
    baseUrl: normalizeBaseUrl(body.baseUrl || DEFAULT_BASE_URL),
    department: body.department ? pad(body.department, 2) : null,
    municipality: body.municipality ? pad(body.municipality, 3) : null,
    zone: body.zone ? pad(body.zone, 2) : null,
    stand: body.stand ? pad(body.stand, 2) : null,
    table: body.table ? pad(body.table, 3) : null,
    corporation: body.corporation ? pad(body.corporation, 3) : "001",
    limit: Number(body.limit || 0),
    concurrency: Number(body.concurrency || 4),
    skipExisting: body.skipExisting !== false,
    metadata: body.metadata !== false,
  };
}

function summarize(records) {
  const published = records.filter((r) => Number(r.status) === 11).length;
  const pending = records.length - published;
  const departments = new Set(records.map((r) => r.department)).size;
  const municipalities = new Set(
    records.map((r) => `${r.department}:${r.municipality}`),
  ).size;

  const stands = new Set(
    records.map(
      (r) => `${r.department}:${r.municipality}:${r.zone}:${r.stand}`,
    ),
  ).size;

  return {
    total: records.length,
    published,
    pending,
    departments,
    municipalities,
    stands,
  };
}

function resolveInside(base, path) {
  const resolvedBase = resolve(base);
  const file = resolve(resolvedBase, path);
  const rel = relative(resolvedBase, file);

  if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return file;
  }

  return null;
}

function isInsideAny(file, directories) {
  const resolvedFile = resolve(file);

  return directories.some((directory) => {
    const resolvedDirectory = resolve(directory);
    const rel = relative(resolvedDirectory, resolvedFile);

    return !rel || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

function loadExistingAudits(out, records) {
  const auditFile = join(out, "audit.jsonl");
  const audits = {};

  if (!existsSync(auditFile)) {
    return audits;
  }

  const recordKeys = new Set(
    records.map((r) =>
      [
        r.department,
        r.municipality,
        r.zone,
        r.stand,
        r.table,
        r.corporation,
      ].join("|"),
    ),
  );

  try {
    const content = readFileSync(auditFile, "utf8");
    const lines = content.split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;

      const row = JSON.parse(line);
      const key = [
        row.department,
        row.municipality,
        row.zone,
        row.stand,
        row.table,
        row.corporation,
      ].join("|");

      if (recordKeys.has(key) && row.localPath && existsSync(row.localPath)) {
        audits[key] = row;
      }
    }
  } catch (error) {
    console.error("Error reading audit.jsonl:", error);
  }

  return audits;
}

async function handleApi(req, res, url, context) {
  if (req.method === "GET" && url.pathname === "/api/config") {
    json(res, 200, {
      defaultBaseUrl: DEFAULT_BASE_URL,
      defaultOut: context.defaultOut,
    });

    return;
  }

  if (req.method === "GET" && url.pathname === "/api/catalog") {
    const args = argsFromQuery(url.searchParams, context);
    const data = await loadData(args.out, args.baseUrl);

    json(res, 200, buildCatalog(data));

    return;
  }

  if (req.method === "GET" && url.pathname === "/api/inventory") {
    const args = argsFromQuery(url.searchParams, context);
    const data = await loadData(args.out, args.baseUrl);
    const records = recordsFromData(data, args);

    writeInventory(records, args.out);
    const pageSize = Number(url.searchParams.get("pageSize") || 0);
    const audits = loadExistingAudits(args.out, records);

    json(res, 200, {
      summary: summarize(records),
      records: pageSize > 0 ? records.slice(0, pageSize) : records,
      audits,
      output: {
        inventoryCsv: join(args.out, "inventory.csv"),
        inventoryJsonl: join(args.out, "inventory.jsonl"),
      },
    });

    return;
  }

  if (req.method === "POST" && url.pathname === "/api/download") {
    const body = await readBody(req);
    const args = argsFromBody(body, context);
    const controller = new AbortController();

    req.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    args.signal = controller.signal;
    const data = await loadData(args.out, args.baseUrl);
    const records = recordsFromData(data, args);

    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    });

    res.write(
      JSON.stringify({
        type: "start",
        summary: summarize(records),
        total: records.length,
      }) + "\n",
    );

    const result = await runDownload(records, args, (event) => {
      if (!res.destroyed && !res.writableEnded)
        res.write(JSON.stringify(event) + "\n");
    });

    if (!res.destroyed && !res.writableEnded) {
      res.write(
        JSON.stringify({
          type: result.canceled ? "canceled" : "complete",
          ...result,
        }) + "\n",
      );
      res.end();
    }

    return;
  }

  if (req.method === "GET" && url.pathname === "/api/file") {
    const requested = url.searchParams.get("path");

    if (!requested) {
      return notFound(res);
    }

    const file = resolve(context.root, requested);
    const out =
      url.searchParams.get("out") || context.defaultOut || DEFAULT_OUT;
    const allowedDirectories = [context.root, resolve(context.root, out)];

    if (
      !isInsideAny(file, allowedDirectories) ||
      !existsSync(file) ||
      !statSync(file).isFile()
    ) {
      return notFound(res);
    }

    res.writeHead(200, {
      "content-type": MIME[extname(file)] || "application/octet-stream",
    });

    createReadStream(file).pipe(res);

    return;
  }

  notFound(res);
}

function serveStatic(req, res, url, context) {
  const pathname = decodeURIComponent(
    url.pathname === "/" ? "/index.html" : url.pathname,
  );

  const file = resolveInside(context.publicDir, `.${pathname}`);

  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    return notFound(res);
  }

  res.writeHead(200, {
    "content-type": MIME[extname(file)] || "application/octet-stream",
  });

  createReadStream(file).pipe(res);
}

function startServer({
  root = DEFAULT_ROOT,
  publicDir = DEFAULT_PUBLIC,
  port = DEFAULT_PORT,
  host,
  defaultOut,
} = {}) {
  const context = {
    root: resolve(root),
    publicDir: resolve(publicDir),
    defaultOut: defaultOut || resolve(root, "output/e14"),
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url, context);
      } else {
        serveStatic(req, res, url, context);
      }
    } catch (error) {
      json(res, 500, { error: error.message });
    }
  });

  return new Promise((resolveStart, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address();
      const actualPort = typeof address === "object" ? address.port : port;
      const actualHost = host || "localhost";

      resolveStart({
        server,
        port: actualPort,
        url: `http://${actualHost}:${actualPort}`,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((error) =>
              error ? rejectClose(error) : resolveClose(),
            );
          }),
      });
    });
  });
}

export { startServer };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer().then(({ url }) => {
    console.log(`E14 auditor UI: ${url}`);
  });
}
