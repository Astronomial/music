# Discogs-EffNet attribution

`discogs-effnet-bsdynamic-1` is a frozen music-style and audio-embedding model by
Pablo Alonso-Jiménez and the Music Technology Group, Universitat Pompeu Fabra,
distributed by the Essentia project. Citation: Alonso-Jiménez, Serra, Bogdanov,
*Music Representation Learning Based on Editorial Metadata from Discogs*, ISMIR 2022.

Original model documentation: https://essentia.upf.edu/models/
Redistribution terms for these model weights: **CC BY-NC-SA 4.0**.
License text: https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode
These weights are not MIT-licensed. Use of this component is non-commercial;
model-derived exported datasets must retain applicable NC-SA terms. The frozen
weights have not been trained or modified by Forma.

The ONNX weights and companion manifest were obtained from this public mirror:
https://github.com/IrosTheBeggar/mStream/releases/tag/discovery-models-1

- ONNX SHA-256: `a280825b334797cf677939db8cd5762c0392aedd0ca6415dbc1cd083f045e43c`
- Manifest SHA-256: `a2e85b2e7372d5f8e0f35bdd6aeae1139f101087d183d0b2fb60b0ea0f01a0ff`

Downloaded bytes were checked against the mirror's GitHub asset digests. An
independently published checksum of the original UPF binary was not located;
mirror integrity is not claimed as independent original-binary verification.

ONNX Runtime is a separate dependency by Microsoft under the MIT License:
https://github.com/microsoft/onnxruntime/blob/main/LICENSE

The model predicts 400 international styles; it does not contain dedicated
Russian-chanson or Caucasian-estrada classes. Those exclusions also rely on
explicit recording metadata and listener rules. A model prediction is not an
infallible genre label.

## ONNX Runtime license

MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
