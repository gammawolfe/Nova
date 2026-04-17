function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h;
}

export function slugColor(slug) {
  const hue = fnv1a(slug) % 360;
  const [r, g, b] = hslToRgb(hue, 0.85, 0.65);
  return {
    light: `hsl(${hue}, 85%, 65%)`,
    dark:  `hsl(${hue}, 70%, 25%)`,
    glow:  `rgba(${r}, ${g}, ${b}, 0.4)`,
  };
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r, g, b;
  if      (h < 60)  [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else              [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export function humanizeTtl(seconds) {
  if (seconds > 86400 && seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds >= 3600  && seconds % 3600 === 0)  return `${seconds / 3600}h`;
  if (seconds >= 60    && seconds % 60 === 0)    return `${seconds / 60}m`;
  return `${seconds}s`;
}
