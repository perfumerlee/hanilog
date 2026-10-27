export type PetAvatarId = `dog-${number}`;

export const PET_AVATARS = Array.from({ length: 32 }, (_, index) => {
  const coat = ['크림', '갈색', '검정', '하양'][index % 4];
  const ears = ['선 귀', '처진 귀', '짝귀', '둥근 귀'][Math.floor(index / 4) % 4];
  const shape = index >= 16 ? '둥근 체형' : '날씬한 체형';
  const family = ['스피츠형', '리트리버형', '믹스견', '푸들형'][Math.floor(index / 4) % 4];
  return { id: `dog-${index + 1}` as PetAvatarId, coat, ears, shape, family, label: `${coat} · ${ears} · ${shape}`,
    src: `${import.meta.env.BASE_URL}avatars/dog-${index + 1}.svg` };
});

const PET_AVATAR_IDS: ReadonlySet<string> = new Set(PET_AVATARS.map((avatar) => avatar.id));

export function isPetAvatarId(value: unknown): value is PetAvatarId {
  return typeof value === 'string' && PET_AVATAR_IDS.has(value);
}

export function photoFileError(file: Pick<File, 'type' | 'size'>): string | null {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return 'JPG, PNG, WebP 사진을 선택해 주세요. HEIC 사진은 JPG로 내보낸 뒤 선택할 수 있어요.';
  if (file.size > 10 * 1024 * 1024) return '10MB 이하의 사진을 선택해 주세요.';
  if (!file.size) return '빈 파일은 사진으로 사용할 수 없어요.';
  return null;
}

export function cropRectangle(width: number, height: number, zoom: number, x: number, y: number) {
  const size = Math.min(width, height) / Math.max(1, Math.min(3, zoom));
  return { x: (width - size) * Math.max(0, Math.min(1, x)), y: (height - size) * Math.max(0, Math.min(1, y)), size };
}
