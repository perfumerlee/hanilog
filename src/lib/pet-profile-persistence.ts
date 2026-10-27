import type { SupabaseClient } from '@supabase/supabase-js';
import { isPetAvatarId, type PetAvatarId } from './pet-profile';

export const PET_PROFILE_BUCKET = 'pet-profile-images';

export type PersistedPetProfile = {
  avatarId: PetAvatarId;
  photoPath: string | null;
  revision: number;
  cleanupPending?: boolean;
};

type ProfileRow = {
  profile_avatar_id: string | null;
  profile_photo_object_path: string | null;
  profile_revision: number | null;
};

export function toPersistedPetProfile(row: ProfileRow): PersistedPetProfile {
  return {
    avatarId: isPetAvatarId(row.profile_avatar_id) ? row.profile_avatar_id : 'dog-1',
    photoPath: typeof row.profile_photo_object_path === 'string' ? row.profile_photo_object_path : null,
    revision: Number.isSafeInteger(row.profile_revision) && (row.profile_revision ?? -1) >= 0 ? row.profile_revision! : 0,
  };
}

export async function fetchPetProfile(client: SupabaseClient, petId: string): Promise<PersistedPetProfile> {
  const { data, error } = await client.from('pets')
    .select('profile_avatar_id,profile_photo_object_path,profile_revision')
    .eq('id', petId).single();
  if (error) throw error;
  return toPersistedPetProfile(data as ProfileRow);
}

export async function persistPetProfile(
  client: SupabaseClient,
  input: { petId: string; avatarId: PetAvatarId; revision: number; photoPath?: string | null; photo?: Blob | null },
): Promise<PersistedPetProfile> {
  if (!isPetAvatarId(input.avatarId)) throw new Error('아바타 선택을 다시 확인해 주세요.');
  if (input.photo) {
    if (input.photo.type !== 'image/jpeg' || input.photo.size > 1024 * 1024) {
      throw new Error('사진은 서버 저장용 JPG 1MB 이하로 준비해 주세요.');
    }
    const body = new FormData();
    body.set('action', 'save');
    body.set('petId', input.petId);
    body.set('avatarId', input.avatarId);
    body.set('revision', String(input.revision));
    body.set('file', input.photo, 'profile.jpg');
    const { data, error } = await client.functions.invoke('pet-profile-media', { body });
    if (error) throw error;
    if (!data || data.ok !== true || !isPetAvatarId(data.profile?.profile_avatar_id)
        || !Number.isSafeInteger(data.profile?.profile_revision)) {
      throw new Error('서버에서 프로필 저장 결과를 확인하지 못했습니다. 화면을 새로고침해 다시 확인해 주세요.');
    }
    return {
      ...toPersistedPetProfile(data.profile as ProfileRow),
      cleanupPending: data.cleanupPending === true,
    };
  }

  // Avatar-only edits use the narrowly scoped, revision-checked RPC. Passing the
  // existing path prevents an avatar change from implicitly deleting a saved photo.
  const { data, error } = await client.rpc('update_pet_profile', {
    p_pet_id: input.petId,
    p_profile_avatar_id: input.avatarId,
    p_profile_photo_object_path: input.photoPath ?? null,
    p_expected_revision: input.revision,
  });
  if (error) throw error;
  const profile = Array.isArray(data) ? data[0] : data;
  if (!profile || !isPetAvatarId(profile.profile_avatar_id)
      || !Number.isSafeInteger(profile.profile_revision)) {
    throw new Error('서버에서 프로필 저장 결과를 확인하지 못했습니다. 화면을 새로고침해 다시 확인해 주세요.');
  }
  return toPersistedPetProfile(profile as ProfileRow);
}

export async function downloadPetProfilePhoto(client: SupabaseClient, path: string): Promise<Blob> {
  const { data, error } = await client.storage.from(PET_PROFILE_BUCKET).download(path);
  if (error) throw error;
  if (data.type !== 'image/jpeg' || data.size > 1024 * 1024) throw new Error('프로필 사진 응답을 확인할 수 없습니다.');
  return data;
}
