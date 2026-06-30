#!/usr/bin/env node
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import {
  IMAGE_SIZE,
  datasetSamples,
  ensureDir,
  loadTensorFlow,
  parseArgs,
  saveLayersModelToDisk,
  splitSamples,
  tensorsFromSamples,
} from "./lib/common.mjs";

function usage() {
  console.log(`Usage:
  node digit-gate/train.mjs \\
    --dataset digit-gate/dataset-digit-gate \\
    --model-out ~/Documents/audit-e14/models/digit-gate-tfjs

Options:
  --dataset DIR          Folder with positive/ and negative/
  --model-out DIR        TensorFlow.js model output folder
  --epochs 25            Training epochs
  --batch-size 32        Batch size
  --validation-ratio 0.15
  --learning-rate 0.001
  --architecture mlp    mlp or cnn
`);
}

function createModel(tf, learningRate, architecture = "mlp") {
  const model = tf.sequential();

  if (architecture === "mlp") {
    model.add(tf.layers.flatten({ inputShape: [IMAGE_SIZE, IMAGE_SIZE, 1] }));
    model.add(tf.layers.dense({ units: 48, activation: "relu" }));
    model.add(tf.layers.dropout({ rate: 0.2 }));
    model.add(tf.layers.dense({ units: 16, activation: "relu" }));
    model.add(tf.layers.dense({ units: 1, activation: "sigmoid" }));

    model.compile({
      optimizer: tf.train.adam(learningRate),
      loss: "binaryCrossentropy",
      metrics: ["accuracy"],
    });

    return model;
  }

  model.add(
    tf.layers.conv2d({
      inputShape: [IMAGE_SIZE, IMAGE_SIZE, 1],
      filters: 12,
      kernelSize: 3,
      activation: "relu",
      padding: "same",
    }),
  );
  model.add(tf.layers.maxPooling2d({ poolSize: 2, strides: 2 }));
  model.add(
    tf.layers.conv2d({
      filters: 24,
      kernelSize: 3,
      activation: "relu",
      padding: "same",
    }),
  );
  model.add(tf.layers.maxPooling2d({ poolSize: 2, strides: 2 }));
  model.add(tf.layers.flatten());
  model.add(tf.layers.dropout({ rate: 0.25 }));
  model.add(tf.layers.dense({ units: 32, activation: "relu" }));
  model.add(tf.layers.dense({ units: 1, activation: "sigmoid" }));

  model.compile({
    optimizer: tf.train.adam(learningRate),
    loss: "binaryCrossentropy",
    metrics: ["accuracy"],
  });

  return model;
}

const args = parseArgs(process.argv);
if (args.help || args.h) {
  usage();
  process.exit(0);
}

const dataset = args.dataset || "digit-gate/dataset-digit-gate";
const modelOut =
  args.modelOut || "~/Documents/audit-e14/models/digit-gate-tfjs";
const epochs = Number(args.epochs || 25);
const batchSize = Number(args.batchSize || 32);
const validationRatio = Number(args.validationRatio || 0.15);
const learningRate = Number(args.learningRate || 0.001);
const architecture = args.architecture || "mlp";

const samples = datasetSamples(dataset);
const positives = samples.filter((sample) => sample.label === 1).length;
const negatives = samples.length - positives;

if (!positives || !negatives) {
  throw new Error(
    `Dataset incompleto. positive=${positives}, negative=${negatives}.`,
  );
}

const { tf, backend } = await loadTensorFlow();
await tf.ready();

const shuffled = samples.slice();
tf.util.shuffle(shuffled);
const { train, validation } = splitSamples(shuffled, validationRatio);
const trainTensors = tensorsFromSamples(tf, train);
const validationTensors = tensorsFromSamples(tf, validation);
const model = createModel(tf, learningRate, architecture);

console.log(`TensorFlow backend: ${backend}/${tf.getBackend()}`);
console.log(`Dataset: ${dataset}`);
console.log(`  samples: ${samples.length}`);
console.log(`  positive: ${positives}`);
console.log(`  negative: ${negatives}`);
console.log(`  train: ${train.length}`);
console.log(`  validation: ${validation.length}`);

const history = await model.fit(trainTensors.xs, trainTensors.ys, {
  epochs,
  batchSize,
  validationData: [validationTensors.xs, validationTensors.ys],
  shuffle: true,
  callbacks: {
    onEpochEnd(epoch, logs) {
      const acc = logs.acc ?? logs.accuracy;
      const valAcc = logs.val_acc ?? logs.val_accuracy;
      console.log(
        `epoch ${epoch + 1}/${epochs} loss=${logs.loss.toFixed(4)} acc=${acc?.toFixed(4)} val_loss=${logs.val_loss?.toFixed(4)} val_acc=${valAcc?.toFixed(4)}`,
      );
    },
  },
});

ensureDir(modelOut);
await saveLayersModelToDisk(tf, model, modelOut);

writeFileSync(
  join(modelOut, "metadata.json"),
  JSON.stringify(
    {
      type: "e14-digit-gate-tfjs",
      imageSize: IMAGE_SIZE,
      threshold: 0.5,
      trainedAt: new Date().toISOString(),
      backend,
      samples: samples.length,
      positives,
      negatives,
      train: train.length,
      validation: validation.length,
      epochs,
      batchSize,
      learningRate,
      architecture,
      history: history.history,
    },
    null,
    2,
  ),
);

trainTensors.xs.dispose();
trainTensors.ys.dispose();
validationTensors.xs.dispose();
validationTensors.ys.dispose();
model.dispose();

console.log(`Model exported: ${modelOut}`);
