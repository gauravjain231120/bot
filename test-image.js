function stretchGray(img) {
  const { data, width, height } = img;
  const n = width * height;
  const hist = new Uint32Array(256);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const g = (data[p] * 77 + data[p + 1] * 150 + data[p + 2] * 29) >> 8;
    data[p] = g;
    hist[g]++;
  }
  const loT = n * 0.01;
  const hiT = n * 0.99;
  let lo = 0, hi = 255;
  for (let v = 0, acc = 0; v < 256; v++) { acc += hist[v]; if (acc >= loT) { lo = v; break; } }
  for (let v = 0, acc = 0; v < 256; v++) { acc += hist[v]; if (acc >= hiT) { hi = v; break; } }
  const range = Math.max(1, hi - lo);
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = range < 8 ? v : ((v - lo) * 255) / range;
  
  // Apply LUT and also store in a temporary buffer for erosion
  const temp = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const g = lut[data[p]];
    temp[i] = g;
  }
  
  // Erosion: dark pixels expand to close gaps in thermal/dot-matrix prints
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = y * width + x;
      let min = temp[idx];
      if (temp[idx - 1] < min) min = temp[idx - 1]; // left
      if (temp[idx + 1] < min) min = temp[idx + 1]; // right
      if (temp[idx - width] < min) min = temp[idx - width]; // top
      if (temp[idx + width] < min) min = temp[idx + width]; // bottom
      
      const p = idx * 4;
      data[p] = min;
      data[p + 1] = min;
      data[p + 2] = min;
      data[p + 3] = 255;
    }
  }
  return img;
}
