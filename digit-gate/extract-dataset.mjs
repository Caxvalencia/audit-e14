#!/usr/bin/env node
import { join, relative } from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  cleanDir,
  copySample,
  deterministicBucket,
  duplicateNegativeBases,
  ensureDir,
  labelFromDebugDigit,
  parseArgs,
  walkPngFiles,
} from "./lib/common.mjs";

function usage() {
  console.log(`Usage:
  node digit-gate/extract-dataset.mjs \\
    --source ~/Documents/audit-e14/ocr-debug \\
    --dataset digit-gate/dataset-digit-gate

Options:
  --source DIR        OCR debug folder generated with --keep-ocr-images
                      Default: ~/Documents/audit-e14/ocr-debug
  --dataset DIR       Destination dataset with positive/ and negative/
                      Default: digit-gate/dataset-digit-gate
  --test-dataset DIR  Optional destination dataset for test split
                      Default: digit-gate/dataset-digit-gate-test
  --test-ratio 0.2    Optional deterministic test split ratio. Use 0 to disable
  --clean             Remove destination folders before copying
`);
}

const args = parseArgs(process.argv);
if (args.help || args.h) {
  usage();
  process.exit(0);
}

const defaultSource = join(homedir(), "Documents", "audit-e14", "ocr-debug");
const source = args.source || defaultSource;
const dataset = args.dataset || "digit-gate/dataset-digit-gate";
const testRatio = Number(args.testRatio ?? 0.2);
const testDataset =
  testRatio > 0 ? args.testDataset || "digit-gate/dataset-digit-gate-test" : "";

if (!existsSync(source)) {
  usage();
  throw new Error(`No existe --source: ${source}`);
}

for (const dir of [dataset, testDataset].filter(Boolean)) {
  if (args.clean) cleanDir(dir);
  ensureDir(join(dir, "positive"));
  ensureDir(join(dir, "negative"));
}

const files = walkPngFiles(source);
const negativeBases = duplicateNegativeBases(source, files);
const rows = [];
const counts = {
  positive: 0,
  negative: 0,
  skipped: 0,
  testPositive: 0,
  testNegative: 0,
};

for (const file of files) {
  const relativePath = relative(source, file);
  const label = labelFromDebugDigit(file);

  if (!label) {
    counts.skipped++;
    continue;
  }

  if (label === "positive" && negativeBases.has(relativePath)) {
    counts.skipped++;
    continue;
  }

  const goesToTest =
    testDataset &&
    testRatio > 0 &&
    deterministicBucket(relativePath) < testRatio;
  const targetDataset = goesToTest ? testDataset : dataset;
  const dest = copySample(source, file, targetDataset, label);

  if (goesToTest && label === "positive") counts.testPositive++;
  else if (goesToTest && label === "negative") counts.testNegative++;
  else counts[label]++;

  rows.push({
    source: file,
    destination: dest,
    split: goesToTest ? "test" : "train",
    label,
  });
}

const manifestPath = join(dataset, "manifest.csv");
writeFileSync(
  manifestPath,
  [
    "split,label,source,destination",
    ...rows.map((row) =>
      [row.split, row.label, row.source, row.destination]
        .map((value) => `"${String(value).replaceAll('"', '""')}"`)
        .join(","),
    ),
  ].join("\n") + "\n",
);

console.log(`Dataset: ${dataset}`);
console.log(`  positive: ${counts.positive}`);
console.log(`  negative: ${counts.negative}`);
if (testDataset) {
  console.log(`Test dataset: ${testDataset}`);
  console.log(`  positive: ${counts.testPositive}`);
  console.log(`  negative: ${counts.testNegative}`);
}
console.log(`Skipped: ${counts.skipped}`);
console.log(`Manifest: ${manifestPath}`);
