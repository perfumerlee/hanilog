import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PET_AVATARS } from '../lib/pet-profile';
import type { PersistedPetProfile } from '../lib/pet-profile-persistence';

const mocks = vi.hoisted(() => ({
  persistPetProfile: vi.fn(),
  downloadPetProfilePhoto: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({ supabase: {} }));
vi.mock('../lib/pet-profile-persistence', () => ({
  persistPetProfile: mocks.persistPetProfile,
  downloadPetProfilePhoto: mocks.downloadPetProfilePhoto,
}));

import { PetProfileEditor } from './PetProfileEditor';

describe('PetProfileEditor persistence UX', () => {
  afterEach(() => cleanup());
  beforeEach(() => {
    mocks.persistPetProfile.mockReset();
    mocks.downloadPetProfilePhoto.mockReset();
    mocks.persistPetProfile.mockResolvedValue({ avatarId: 'dog-2', photoPath: null, revision: 1 } satisfies PersistedPetProfile);
  });

  it('labels preview before saving and only confirms after the server response', async () => {
    const saved = vi.fn();
    render(<MemoryRouter><PetProfileEditor name="Synthetic pet" petId="pet-1" avatarId="dog-1" revision={0} onProfileSaved={saved} /></MemoryRouter>);
    fireEvent.click(screen.getByText('사진·아바타 바꾸기'));
    fireEvent.click(screen.getByRole('button', { name: PET_AVATARS[1].label }));
    expect(screen.getByRole('status').textContent).toContain('저장 버튼');
    fireEvent.click(screen.getByRole('button', { name: '프로필 저장' }));
    await waitFor(() => expect(mocks.persistPetProfile).toHaveBeenCalledWith(expect.anything(), {
      petId: 'pet-1', avatarId: 'dog-2', revision: 0, photoPath: null, photo: null,
    }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('서버에서 확인'));
    expect(saved).toHaveBeenCalledWith({ avatarId: 'dog-2', photoPath: null, revision: 1 });
  });

  it('keeps Demo explicitly preview-only with no persistence action', () => {
    render(<MemoryRouter><PetProfileEditor name="Synthetic demo pet" /></MemoryRouter>);
    fireEvent.click(screen.getByText('사진·아바타 바꾸기'));
    expect(screen.getByText(/DEMO 미리보기/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: '프로필 저장' })).toBeNull();
  });

  it('reports pending old-photo cleanup without claiming the profile failed to save', async () => {
    mocks.persistPetProfile.mockResolvedValue({ avatarId: 'dog-2', photoPath: 'pet-1/photo.jpg', revision: 1, cleanupPending: true });
    render(<MemoryRouter><PetProfileEditor name="Synthetic pet" petId="pet-1" avatarId="dog-1" revision={0} /></MemoryRouter>);
    fireEvent.click(screen.getByText('사진·아바타 바꾸기'));
    fireEvent.click(screen.getByRole('button', { name: PET_AVATARS[1].label }));
    fireEvent.click(screen.getByRole('button', { name: '프로필 저장' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('이전 사진 정리'));
  });
});
