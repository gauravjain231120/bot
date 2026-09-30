function stretchGray(data, width, height) {
  const n = width * height;
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const g = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
    data[p] = g;
    hist[g]++;
  }
  const loT = n * 0.01;
  const hiT = n * 0.99;
  let lo = 0;
  let hi = 255;
  for (let v = 0, acc = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= loT) { lo = v; break; }
  }
  for (let v = 0, acc = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= hiT) { hi = v; break; }
  }
  const range = hi - lo;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = range < 8 ? v : ((v - lo) * 255) / range;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const g = lut[data[p]];
    data[p] = g;
    data[p + 1] = g;
    data[p + 2] = g;
    data[p + 3] = 255;
  }
}
