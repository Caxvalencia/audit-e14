import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { PNG } from "pngjs";

export const IMAGE_SIZE = 64;

export function parseArgs(argv) {
  const args = {};

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      args._ ??= [];
      args._.push(arg);
      continue;
    }

    const key = arg
      .slice(2)
      .replace(/-([a-z])/g, (_, chr) => chr.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }

  return args;
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

export function cleanDir(dir) {
  rmSync(dir, { recursive: true, force: true });
  ensureDir(dir);
}

export function walkPngFiles(dir, output = []) {
  if (!dir || !existsSync(dir)) return output;

  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) walkPngFiles(fullPath, output);
    else if (entry.toLowerCase().endsWith(".png")) output.push(fullPath);
  }

  return output;
}

export function sha1(value) {
  return createHash("sha1").update(value).digest("hex");
}

export function copySample(sourceRoot, file, datasetDir, label) {
  const relativePath = relative(sourceRoot, file);
  const safeRelative = relativePath.replace(/[^a-zA-Z0-9_.-]+/g, "__");
  const hash = sha1(relativePath).slice(0, 10);
  const dest = join(datasetDir, label, `${hash}__${safeRelative}`);

  ensureDir(dirname(dest));
  copyFileSync(file, dest);
  return dest;
}

export function labelFromDebugDigit(file) {
  const name = basename(file);

  if (!/-digit-\d+/.test(name)) return null;

  if (name.includes("-as-zero") || name.includes("-rejected"))
    return "negative";

  return "positive";
}

export function duplicateNegativeBases(sourceRoot, files) {
  return new Set(
    files
      .map((file) => relative(sourceRoot, file))
      .filter((name) => name.includes("-as-zero") || name.includes("-rejected"))
      .map((name) => name.replace(/-(as-zero|rejected)\.png$/, ".png")),
  );
}

export function deterministicBucket(value) {
  const hex = sha1(value).slice(0, 8);
  return Number.parseInt(hex, 16) / 0xffffffff;
}

export function readPngAsImageVector(file, imageSize = IMAGE_SIZE) {
  const png = PNG.sync.read(readFileSync(file));
  const values = new Float32Array(imageSize * imageSize);

  for (let y = 0; y < imageSize; y++) {
    for (let x = 0; x < imageSize; x++) {
      const sx = Math.min(
        png.width - 1,
        Math.floor((x / imageSize) * png.width),
      );
      const sy = Math.min(
        png.height - 1,
        Math.floor((y / imageSize) * png.height),
      );
      const index = (png.width * sy + sx) << 2;
      const gray =
        png.data[index] * 0.299 +
        png.data[index + 1] * 0.587 +
        png.data[index + 2] * 0.114;

      values[y * imageSize + x] = gray / 255;
    }
  }

  return values;
}

export function datasetSamples(datasetDir) {
  const rows = [];

  for (const [folder, label] of [
    ["negative", 0],
    ["positive", 1],
  ]) {
    for (const file of walkPngFiles(join(datasetDir, folder))) {
      rows.push({ file, label });
    }
  }

  return rows;
}

export function splitSamples(samples, validationRatio = 0.15) {
  const train = [];
  const validation = [];

  for (const sample of samples) {
    const bucket = deterministicBucket(sample.file);
    if (bucket < validationRatio) validation.push(sample);
    else train.push(sample);
  }

  return { train, validation };
}

export async function loadTensorFlow() {
  try {
    const tf = await import("@tensorflow/tfjs-node");
    return { tf: tf.default || tf, backend: "tfjs-node" };
  } catch {
    const tf = await import("@tensorflow/tfjs");
    return { tf: tf.default || tf, backend: "tfjs" };
  }
}

export function tensorsFromSamples(tf, samples, imageSize = IMAGE_SIZE) {
  const imageValues = new Float32Array(samples.length * imageSize * imageSize);
  const labelValues = new Float32Array(samples.length);

  samples.forEach((sample, sampleIndex) => {
    imageValues.set(
      readPngAsImageVector(sample.file, imageSize),
      sampleIndex * imageSize * imageSize,
    );
    labelValues[sampleIndex] = sample.label;
  });

  return {
    xs: tf.tensor4d(imageValues, [samples.length, imageSize, imageSize, 1]),
    ys: tf.tensor2d(labelValues, [samples.length, 1]),
  };
}

export async function saveLayersModelToDisk(tf, model, outDir) {
  ensureDir(outDir);

  await model.save(
    tf.io.withSaveHandler(async (artifacts) => {
      const weightPath = "weights.bin";
      writeFileSync(
        join(outDir, weightPath),
        Buffer.from(artifacts.weightData),
      );
      writeFileSync(
        join(outDir, "model.json"),
        JSON.stringify(
          {
            format: "layers-model",
            generatedBy: "audit-e14 digit-gate",
            convertedBy: null,
            modelTopology: artifacts.modelTopology,
            weightsManifest: [
              {
                paths: [weightPath],
                weights: artifacts.weightSpecs,
              },
            ],
          },
          null,
          2,
        ),
      );

      return {
        modelArtifactsInfo: {
          dateSaved: new Date(),
          modelTopologyType: "JSON",
          modelTopologyBytes: JSON.stringify(artifacts.modelTopology).length,
          weightSpecsBytes: JSON.stringify(artifacts.weightSpecs).length,
          weightDataBytes: artifacts.weightData.byteLength,
        },
      };
    }),
  );
}

export async function loadLayersModelFromDisk(tf, modelDir) {
  const modelJson = JSON.parse(
    readFileSync(join(modelDir, "model.json"), "utf8"),
  );
  const manifest = modelJson.weightsManifest?.[0];
  if (!manifest) throw new Error(`Modelo sin weightsManifest: ${modelDir}`);

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
