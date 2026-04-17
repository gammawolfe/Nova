import { describe, it, expect } from 'vitest';
import { slugColor, humanizeTtl } from '../../public/js/utils.js';

describe('slugColor', () => {
  it('returns the same colors for the same slug', () => {
    expect(slugColor('acme-corp')).toEqual(slugColor('acme-corp'));
  });

  it('returns different colors for different slugs', () => {
    expect(slugColor('acme-corp')).not.toEqual(slugColor('helios'));
  });

  it('returns light, dark, and glow CSS strings', () => {
    const c = slugColor('demo');
    expect(c.light).toMatch(/^hsl\(/);
    expect(c.dark).toMatch(/^hsl\(/);
    expect(c.glow).toMatch(/^rgba\(/);
  });
});

describe('humanizeTtl', () => {
  it('formats common presets', () => {
    expect(humanizeTtl(3600)).toBe('1h');
    expect(humanizeTtl(86400)).toBe('24h');
    expect(humanizeTtl(7 * 86400)).toBe('7d');
  });

  it('formats custom values', () => {
    expect(humanizeTtl(90)).toBe('90s');
    expect(humanizeTtl(600)).toBe('10m');
    expect(humanizeTtl(2 * 86400)).toBe('2d');
  });
});
