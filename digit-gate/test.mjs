#!/usr/bin/env node
import {
  datasetSamples,
  loadLayersModelFromDisk,
  loadTensorFlow,
  parseArgs,
  tensorsFromSamples,
} from "./lib/common.mjs";

function usage() {
  console.log(`Usage:
  node digit-gate/test.mjs \\
    --dataset digit-gate/dataset-digit-gate-test \\
    --model ~/Documents/audit-e14/models/digit-gate-tfjs

Options:
  --threshold 0.5       Probability threshold for valid digit
`);
}

const args = parseArgs(process.argv);
if (args.help || args.h) {
  usage();
  process.exit(0);
}

const dataset = args.dataset || "digit-gate/dataset-digit-gate-test";
const modelDir =
  args.model || "~/Documents/audit-e14/models/digit-gate-tfjs";
const threshold = Number(args.threshold || 0.5);

const samples = datasetSamples(dataset);
if (!samples.length) throw new Error(`Dataset vacio: ${dataset}`);

const { tf, backend } = await loadTensorFlow();
await tf.ready();

const model = await loadLayersModelFromDisk(tf, modelDir);
const tensors = tensorsFromSamples(tf, samples);
const predictions = await model.predict(tensors.xs).data();

let tp = 0;
let tn = 0;
let fp = 0;
let fn = 0;
const misses = [];

for (let i = 0; i < samples.length; i++) {
  const actual = samples[i].label;
  const probability = predictions[i];
  const predicted = probability >= threshold ? 1 : 0;

  if (predicted === 1 && actual === 1) tp++;
  else if (predicted === 0 && actual === 0) tn++;
  else if (predicted === 1 && actual === 0) {
    fp++;
    misses.push({ kind: "FP", probability, file: samples[i].file });
  } else {
    fn++;
    misses.push({ kind: "FN", probability, file: samples[i].file });
  }
}

const accuracy = (tp + tn) / samples.length;
const precision = tp + fp ? tp / (tp + fp) : 0;
const recall = tp + fn ? tp / (tp + fn) : 0;
const specificity = tn + fp ? tn / (tn + fp) : 0;

console.log(`TensorFlow backend: ${backend}/${tf.getBackend()}`);
console.log(`Dataset: ${dataset}`);
console.log(`Model: ${modelDir}`);
console.log(`Threshold: ${threshold}`);
console.log(`Samples: ${samples.length}`);
console.log(`TP=${tp} TN=${tn} FP=${fp} FN=${fn}`);
console.log(`accuracy=${accuracy.toFixed(4)}`);
console.log(`precision=${precision.toFixed(4)}`);
console.log(`recall=${recall.toFixed(4)}`);
console.log(`specificity=${specificity.toFixed(4)}`);

if (misses.length) {
  console.log("Misses:");
  for (const miss of misses.slice(0, 40)) {
    console.log(
      `  ${miss.kind} p=${miss.probability.toFixed(4)} ${miss.file}`,
    );
  }
  if (misses.length > 40) console.log(`  ... ${misses.length - 40} mas`);
}

tensors.xs.dispose();
tensors.ys.dispose();
model.dispose();
