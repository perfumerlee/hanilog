import { describe, expect, it } from 'vitest';
import { cropRectangle, PET_AVATARS, photoFileError } from './pet-profile';

describe('pet profile preview boundaries', () => {
  it('provides 32 unique local portraits with searchable attributes', () => {
    expect(new Set(PET_AVATARS.map((item) => item.id)).size).toBe(32);
    expect(PET_AVATARS.every((item) => item.src.includes('/avatars/') && item.ears && item.coat && item.shape)).toBe(true);
  });
  it('rejects active formats, HEIC, empty files and oversized images', () => {
    for (const type of ['image/svg+xml', 'text/html', 'image/heic']) expect(photoFileError({ type, size: 200 })).not.toBeNull();
    expect(photoFileError({ type: 'image/png', size: 11 * 1024 * 1024 })).not.toBeNull();
    expect(photoFileError({ type: 'image/png', size: 0 })).not.toBeNull();
    expect(photoFileError({ type: 'image/jpeg', size: 1024 })).toBeNull();
  });
  it('keeps crop coordinates inside portrait and landscape images at every edge', () => {
    for (const [width, height] of [[300, 800], [800, 300]]) {
      for (const position of [-1, 0, .5, 1, 2]) {
        const rect = cropRectangle(width, height, 2, position, position);
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.size).toBeLessThanOrEqual(width);
        expect(rect.y + rect.size).toBeLessThanOrEqual(height);
      }
    }
    expect(cropRectangle(800, 400, 1, .5, .5)).toEqual({ x: 200, y: 0, size: 400 });
  });
});
