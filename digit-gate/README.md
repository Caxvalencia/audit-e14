# Digit Gate

Mini proyecto local para entrenar un clasificador binario:

- `positive/`: crops que si contienen un digito manuscrito valido.
- `negative/`: manchas, asteriscos, muescas, fragmentos o marcas que no deben pasar a MNIST.

El modelo exportado es TensorFlow.js:

```text
model.json
weights.bin
metadata.json
```

## 1. Extraer dataset inicial

Primero genera crops con el OCR principal:

```bash
node scripts/e14-audit.mjs ocr \
  --out ~/Documents/audit-e14 \
  --department 01 --municipality 001 --zone 01 --stand 01 \
  --limit 36 \
  --no-skip-existing \
  --keep-ocr-images \
  --ocr-provider transformers \
  --ocr-model mnist.onnx
```

Luego extrae candidatos:

```bash
pnpm digit-gate:extract -- --clean
```

Por defecto lee `~/Documents/audit-e14/ocr-debug`, escribe `digit-gate/dataset-digit-gate`,
y crea un split de test en `digit-gate/dataset-digit-gate-test` con `--test-ratio 0.2`.
Para desactivar el split de test usa `--test-ratio 0`.

El extractor clasifica automáticamente:

- `*-digit-N.png` como `positive/`.
- `*-digit-N-as-zero.png` y `*-digit-N-rejected.png` como `negative/`.

Después revisa manualmente las carpetas y mueve lo que esté mal.
Una vez curado, la carpeta manda: `train.mjs` y `test.mjs` ignoran el nombre del
archivo y usan solo `positive/` o `negative/` como etiqueta. Si moviste un
`*-as-zero.png` a `positive/`, se entrena como positivo.

Si usas `extract-dataset.mjs` con una fuente que ya tiene `positive/` y
`negative/`, tambien respeta esas carpetas e ignora los sufijos del nombre.

## 2. Entrenar

```bash
node digit-gate/train.mjs \
  --dataset digit-gate/dataset-digit-gate \
  --model-out ~/Documents/audit-e14/models/digit-gate-tfjs \
  --epochs 25 \
  --batch-size 32 \
  --threshold 0.01 \
  --architecture mlp
```

Si `@tensorflow/tfjs-node` está disponible, se usa ese backend. Si no, cae a `@tensorflow/tfjs` en CPU JS.
`mlp` es el default porque entrena rápido en CPU; `--architecture cnn` queda disponible cuando el backend nativo esté funcionando.
El `--threshold` queda guardado en `metadata.json` y el OCR principal lo usa como default si no pasas `--digit-gate-threshold`.

## 3. Evaluar con dataset de test

```bash
node digit-gate/test.mjs \
  --dataset digit-gate/dataset-digit-gate-test \
  --model ~/Documents/audit-e14/models/digit-gate-tfjs \
  --threshold 0.5
```

Para este filtro conviene priorizar `recall` alto: un falso negativo bota un digito real antes de MNIST.

## 4. Usar en la aplicacion

Cuando el modelo este validado, el OCR principal puede cargar el modelo exportado. La integracion final debe leer:

```text
~/Documents/audit-e14/models/digit-gate-tfjs/model.json
~/Documents/audit-e14/models/digit-gate-tfjs/weights.bin
```

El gate debe ejecutarse despues de las reglas explicitas de cero (`*` y marcas compactas) y antes de MNIST.
