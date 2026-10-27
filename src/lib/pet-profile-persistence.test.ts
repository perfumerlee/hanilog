import { describe, expect, it } from 'vitest';
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
