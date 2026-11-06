import { describe, expect, it, vi } from 'vitest';
import { PET_AVATARS } from './pet-profile';
import { persistPetProfile, toPersistedPetProfile } from './pet-profile-persistence';

describe('persisted Pet profile mapping', () => {
  it('keeps a known avatar and private object path', () => {
    expect(toPersistedPetProfile({ profile_avatar_id: 'dog-32', profile_photo_object_path: 'pet/path.jpg', profile_revision: 4 }))
      .toEqual({ avatarId: 'dog-32', photoPath: 'pet/path.jpg', revision: 4 });
  });

  it('uses the safe default for unknown IDs and invalid revisions', () => {
    expect(toPersistedPetProfile({ profile_avatar_id: 'unknown', profile_photo_object_path: null, profile_revision: -1 }))
      .toEqual({ avatarId: 'dog-1', photoPath: null, revision: 0 });
    expect(PET_AVATARS.some((avatar) => avatar.id === 'dog-1')).toBe(true);
  });
});

describe('private staged photo upload', () => {
  const profile = { profile_avatar_id: 'dog-2', profile_photo_object_path: 'pet/final.jpg', profile_revision: 2 };
  function fixture(completed = true) {
    const upload = vi.fn().mockResolvedValue({ error: null });
    const invoke = vi.fn().mockResolvedValue({ data: { ok: true, profile }, error: null });
    const maybeSingle = vi.fn().mockResolvedValue({ data: { state: completed ? 'completed' : 'processing', result: completed ? profile : null }, error: null });
    const client = {
      rpc: vi.fn().mockResolvedValue({ data: { id: 'intent', object_path: 'pet/input.jpg', output_path: 'pet/final.jpg' }, error: null }),
      storage: { from: vi.fn().mockReturnValue({ upload }) },
      functions: { invoke },
      from: vi.fn().mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle }) }) }),
    };
    return { client, upload, invoke, maybeSingle };
  }
  const input = { petId: 'pet', avatarId: 'dog-2' as const, revision: 1, photo: new Blob(['synthetic'], { type: 'image/jpeg' }) };
  it('uploads only to the private incoming bucket and sends only the intent ID to the function', async () => {
    const f = fixture(); const progress = vi.fn();
    await persistPetProfile(f.client as never, input, progress);
    expect(f.client.storage.from).toHaveBeenCalledWith('pet-photo-incoming');
    expect(f.upload).toHaveBeenCalledWith('pet/input.jpg', input.photo, expect.objectContaining({ upsert: false }));
    expect(f.invoke).toHaveBeenCalledWith('pet-photo-finalize', { body: { uploadId: 'intent' } });
    expect(progress.mock.calls.flat()).toEqual(['preparing', 'uploading', 'processing']);
  });
  it('recovers a lost final response from the committed upload intent without reuploading', async () => {
    const f = fixture(); f.invoke.mockResolvedValue({ error: new Error('response lost') });
    await expect(persistPetProfile(f.client as never, input)).resolves.toMatchObject({ photoPath: 'pet/final.jpg', revision: 2 });
    expect(f.upload).toHaveBeenCalledTimes(1);
    expect(f.maybeSingle).toHaveBeenCalledTimes(1);
  });
  it('does not claim success when the server commit is unverified', async () => {
    const f = fixture(false); f.invoke.mockResolvedValue({ error: new Error('unavailable') });
    await expect(persistPetProfile(f.client as never, input)).rejects.toThrow('저장 결과를 확인하지 못했어요');
  });
  it('rejects an oversized photo before creating an upload intent', async () => {
    const f = fixture();
    await expect(persistPetProfile(f.client as never, { ...input, photo: new Blob([new Uint8Array(1048577)], { type: 'image/jpeg' }) })).rejects.toThrow('1MB');
    expect(f.client.rpc).not.toHaveBeenCalled();
  });
  it('removes the photo only when explicitly requested', async () => {
    const f = fixture(); f.client.rpc.mockResolvedValue({ data: [{ ...profile, profile_photo_object_path: null }], error: null });
    await persistPetProfile(f.client as never, { ...input, photo: null, photoPath: 'pet/old.jpg', removePhoto: true });
    expect(f.client.rpc).toHaveBeenCalledWith('update_pet_profile', expect.objectContaining({ p_profile_photo_object_path: null }));
  });
});

describe('avatar-only profile persistence', () => {
  it('uses the permission-checked RPC and preserves the existing private photo path', async () => {
    const rpc = async (_name: string, args: Record<string, unknown>) => ({
      data: [{
        profile_avatar_id: args.p_profile_avatar_id,
        profile_photo_object_path: args.p_profile_photo_object_path,
        profile_revision: Number(args.p_expected_revision) + 1,
      }],
      error: null,
    });
    const invoke = async () => { throw new Error('photo function must not be used for avatar-only edits'); };
    const client = { rpc, functions: { invoke } } as never;

    await expect(persistPetProfile(client, {
      petId: '00000000-0000-4000-8000-000000000001',
      avatarId: 'dog-2',
      revision: 7,
      photoPath: '00000000-0000-4000-8000-000000000001/0123456789abcdef0123456789abcdef.jpg',
    })).resolves.toEqual({
      avatarId: 'dog-2',
      photoPath: '00000000-0000-4000-8000-000000000001/0123456789abcdef0123456789abcdef.jpg',
      revision: 8,
    });
  });
});
