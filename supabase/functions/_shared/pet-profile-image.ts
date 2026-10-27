export const PROFILE_IMAGE_MAX_BYTES = 1024 * 1024;
export const PROFILE_IMAGE_SIDE = 512;

export function validateProfileImageInput(input: {
  contentType: string;
  bytes: Uint8Array;
  width: number;
  height: number;
}): string | null {
  if (input.contentType.toLowerCase() !== 'image/jpeg') return 'PROFILE_IMAGE_TYPE_INVALID';
  if (input.bytes.byteLength < 4 || input.bytes.byteLength > PROFILE_IMAGE_MAX_BYTES) return 'PROFILE_IMAGE_SIZE_INVALID';
  if (input.bytes[0] !== 0xff || input.bytes[1] !== 0xd8 || input.bytes.at(-2) !== 0xff || input.bytes.at(-1) !== 0xd9) {
    return 'PROFILE_IMAGE_FORMAT_INVALID';
  }
  if (input.width !== PROFILE_IMAGE_SIDE || input.height !== PROFILE_IMAGE_SIDE) return 'PROFILE_IMAGE_DIMENSIONS_INVALID';
  return null;
}

export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) return null;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (offset + 2 > bytes.length) return null;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return null;
    if (sofMarkers.has(marker)) {
      if (length < 7) return null;
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += length;
  }
  return null;
}

/** Remove JPEG application/comment segments after re-encoding decoded pixels. */
export function stripJpegMetadataSegments(jpeg: Uint8Array): Uint8Array | null {
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  const parts: Uint8Array[] = [jpeg.subarray(0, 2)];
  let offset = 2;
  while (offset < jpeg.length) {
    if (jpeg[offset] !== 0xff) return null;
    const markerStart = offset;
    while (offset < jpeg.length && jpeg[offset] === 0xff) offset++;
    if (offset >= jpeg.length) return null;
    const marker = jpeg[offset++];
    if (marker === 0xda) {
      parts.push(jpeg.subarray(markerStart));
      const total = parts.reduce((sum, part) => sum + part.length, 0);
      const output = new Uint8Array(total);
      let writeOffset = 0;
      for (const part of parts) { output.set(part, writeOffset); writeOffset += part.length; }
      return output;
    }
    const standalone = marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01;
    if (standalone) {
      parts.push(jpeg.subarray(markerStart, offset));
      if (marker === 0xd9) return null;
      continue;
    }
    if (offset + 2 > jpeg.length) return null;
    const length = (jpeg[offset] << 8) | jpeg[offset + 1];
    if (length < 2 || offset + length > jpeg.length) return null;
    const end = offset + length;
    const metadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!metadata) parts.push(jpeg.subarray(markerStart, end));
    offset = end;
  }
  return null;
}
