import { describe, expect, it } from 'vitest';
import { jpegDimensions, stripJpegMetadataSegments, validateProfileImageInput } from './pet-profile-image';

describe('profile photo server input contract', () => {
  it('requires bounded JPEG bytes and a 512 square image', () => {
    const image = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    expect(validateProfileImageInput({ contentType: 'image/jpeg', bytes: image, width: 512, height: 512 })).toBeNull();
    expect(validateProfileImageInput({ contentType: 'image/png', bytes: image, width: 512, height: 512 })).toBe('PROFILE_IMAGE_TYPE_INVALID');
    expect(validateProfileImageInput({ contentType: 'image/jpeg', bytes: image, width: 513, height: 512 })).toBe('PROFILE_IMAGE_DIMENSIONS_INVALID');
  });

  it('removes EXIF/application and comment segments but preserves image scan bytes', () => {
    const jpeg = new Uint8Array([
      0xff, 0xd8,
      0xff, 0xe1, 0x00, 0x06, 0x45, 0x58, 0x49, 0x46,
      0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46,
      0xff, 0xdb, 0x00, 0x04, 0x00, 0x01,
      0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9,
    ]);
    const stripped = stripJpegMetadataSegments(jpeg);
    expect(stripped).not.toBeNull();
    expect(Array.from(stripped!)).toEqual([
      0xff, 0xd8, 0xff, 0xdb, 0x00, 0x04, 0x00, 0x01,
      0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9,
    ]);
  });

  it('rejects malformed JPEG segment lengths', () => {
    expect(stripJpegMetadataSegments(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]))).toBeNull();
  });

  it('reads dimensions from JPEG headers before image decoding', () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08, 0x02, 0x00, 0x02, 0x00, 0xff, 0xda]);
    expect(jpegDimensions(bytes)).toEqual({ width: 512, height: 512 });
    expect(jpegDimensions(new Uint8Array([0xff, 0xd8, 0xff, 0xda]))).toBeNull();
  });

  it('rejects oversized pixel dimensions before invoking the decoder', () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08, 0x02, 0x01, 0x02, 0x00, 0xff, 0xda]);
    expect(jpegDimensions(bytes)).toEqual({ width: 512, height: 513 });
    expect(validateProfileImageInput({ contentType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 512, height: 513 }))
      .toBe('PROFILE_IMAGE_DIMENSIONS_INVALID');
  });

  it('enforces the exact JPEG byte limit and rejects MIME spoofing', () => {
    const tooLarge = new Uint8Array(1024 * 1024 + 1);
    expect(validateProfileImageInput({ contentType: 'image/jpeg', bytes: tooLarge, width: 512, height: 512 }))
      .toBe('PROFILE_IMAGE_SIZE_INVALID');
    expect(validateProfileImageInput({ contentType: 'image/png', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 512, height: 512 }))
      .toBe('PROFILE_IMAGE_TYPE_INVALID');
    expect(validateProfileImageInput({ contentType: 'image/jpeg', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), width: 512, height: 512 }))
      .toBe('PROFILE_IMAGE_FORMAT_INVALID');
  });
});
