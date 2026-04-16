export function drawGlow(ctx, x, y, radius, color, alpha = 0.3) {
  const grad = ctx.createRadialGradient(x, y, 0, x, y, radius);
  grad.addColorStop(0, colorWithAlpha(color, alpha));
  grad.addColorStop(1, colorWithAlpha(color, 0));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();
}

export function drawBloom(ctx, x, y, radius, color) {
  const prev = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'lighter';
  drawGlow(ctx, x, y, radius, color, 0.15);
  ctx.globalCompositeOperation = prev;
}

// Scratch canvas for color parsing — supports hex, hsl, rgb, named colors
const _colorCtx = typeof document !== 'undefined'
  ? (() => { const c = document.createElement('canvas'); c.width = 1; c.height = 1; return c.getContext('2d', { willReadFrequently: true }); })()
  : null;
const _colorCache = new Map();

export function colorWithAlpha(color, alpha) {
  // Fast path: hex
  if (color[0] === '#' && (color.length === 7 || color.length === 4)) {
    let r, g, b;
    if (color.length === 7) {
      r = parseInt(color.slice(1, 3), 16);
      g = parseInt(color.slice(3, 5), 16);
      b = parseInt(color.slice(5, 7), 16);
    } else {
      r = parseInt(color[1] + color[1], 16);
      g = parseInt(color[2] + color[2], 16);
      b = parseInt(color[3] + color[3], 16);
    }
    return `rgba(${r},${g},${b},${alpha})`;
  }

  // Slow path: parse any CSS color via canvas
  let rgb = _colorCache.get(color);
  if (!rgb && _colorCtx) {
    const ctx = _colorCtx;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    rgb = { r, g, b };
    _colorCache.set(color, rgb);
  }
  if (rgb) return `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
  return color; // fallback
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}
