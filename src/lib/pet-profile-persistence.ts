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
  input: { petId: string; avatarId: PetAvatarId; revision: number; photoPath?: string | null; photo?: Blob | null; removePhoto?: boolean },
  onProgress?: (stage: 'preparing' | 'uploading' | 'processing' | 'confirming') => void,
): Promise<PersistedPetProfile> {
  if (!isPetAvatarId(input.avatarId)) throw new Error('아바타 선택을 다시 확인해 주세요.');
  if (input.photo) {
    if (input.photo.type !== 'image/jpeg' || input.photo.size > 1024 * 1024) {
      throw new Error('사진은 서버 저장용 JPG 1MB 이하로 준비해 주세요.');
    }
    onProgress?.('preparing');
    const prepared = await client.rpc('begin_pet_photo_upload', {
      p_pet_id: input.petId, p_avatar_id: input.avatarId, p_revision: input.revision,
    });
    if (prepared.error) throw prepared.error;
    const intent = prepared.data;
    if (!intent?.id || typeof intent.object_path !== 'string' || typeof intent.output_path !== 'string') {
      throw new Error('사진 저장 준비를 완료하지 못했어요. 다시 시도해 주세요.');
    }
    onProgress?.('uploading');
    const uploaded = await client.storage.from('pet-photo-incoming').upload(intent.object_path, input.photo, {
      contentType: 'image/jpeg', cacheControl: '0', upsert: false,
    }).catch(() => ({ error: true }));
    // A lost upload response may still have stored the object. Finalize checks the
    // server intent/object before processing, so do not overwrite or upload twice.
    onProgress?.('processing');
    const finalized = await client.functions.invoke('pet-photo-finalize', { body: { uploadId: intent.id } })
      .catch(() => ({ data: null, error: true }));
    let data = finalized.data;
    if (finalized.error || data?.ok !== true) {
      onProgress?.('confirming');
      const status = await client.from('pet_photo_uploads').select('state,result').eq('id', intent.id).maybeSingle();
      if (!status.error && status.data?.state === 'completed' && status.data.result) {
        data = { ok: true, profile: status.data.result, cleanupPending: true };
      } else {
        throw new Error(uploaded.error
          ? '사진 전송 결과를 확인하지 못했어요. 기존 사진은 유지되며, 연결 후 최신 프로필을 확인해 주세요.'
          : '사진 저장 결과를 확인하지 못했어요. 새로고침으로 최신 프로필을 확인한 뒤 다시 시도해 주세요.');
      }
    }
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
    p_profile_photo_object_path: input.removePhoto ? null : input.photoPath ?? null,
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
