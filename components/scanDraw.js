// Frame drawing for the camera scanners — a video frame (or any drawable
// with videoWidth/videoHeight) onto a canvas, turned and cropped. Kept apart
// from the components so the exact same code runs in offline tests.

// The whole frame is decoded: a barcode held sideways or diagonally runs
// well outside the on-screen guide box (a 62%-high middle band cut every
// vertical barcode off — caught in testing). Turned frames are only scaled
// down if their long side would pass MAX_SIDE, and 1920 keeps a normal 1080p
// frame at full resolution: shrinking it blurred thin, faint bars.
const CROP = { w: 1, h: 1 };
const MAX_SIDE = 1920;

export function drawTurnedCrop(video, canvas, ctx, angleDeg) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const sw = vw * CROP.w;
  const sh = vh * CROP.h;
  const a = (angleDeg * Math.PI) / 180;
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  let W = sw * c + sh * s;
  let H = sw * s + sh * c;
  const k = Math.min(1, MAX_SIDE / Math.max(W, H));
  W = Math.round(W * k);
  H = Math.round(H * k);
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.translate(W / 2, H / 2);
  ctx.rotate(-a);
  ctx.scale(k, k);
  ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, -sw / 2, -sh / 2, sw, sh);
  ctx.restore();
  return ctx.getImageData(0, 0, W, H);
}

const BAND = { w: 0.9, h: 0.3 };
// The guide-box band of the current frame, turned by `turnDeg` (clockwise,
// about the frame centre = band centre) and scaled by `scale`.
export function drawBand(video, canvas, ctx, turnDeg, scale) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const W = Math.round(vw * BAND.w * scale);
  const H = Math.round(vh * BAND.h * scale);
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  ctx.save();
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.translate(W / 2, H / 2);
  ctx.rotate((turnDeg * Math.PI) / 180);
  ctx.scale(scale, scale);
  ctx.drawImage(video, -vw / 2, -vh / 2, vw, vh);
  ctx.restore();
  return ctx.getImageData(0, 0, W, H);
}
