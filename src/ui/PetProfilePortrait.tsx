import { useEffect, useState } from 'react';
import { PET_AVATARS, isPetAvatarId } from '../lib/pet-profile';
import { downloadPetProfilePhoto } from '../lib/pet-profile-persistence';
import { supabase } from '../lib/supabase';

type PortraitPet = { id: string; name: string; profile_avatar_id?: string | null; profile_photo_object_path?: string | null };

export function PetProfilePortrait({ pet, className = 'pet-heading-portrait' }: { pet: PortraitPet; className?: string }) {
  const [photo, setPhoto] = useState<{ key: string; url: string } | null>(null);
  const key = `${pet.id}:${pet.profile_photo_object_path ?? ''}`;
  useEffect(() => {
    if (!supabase || !pet.profile_photo_object_path) return;
    let active = true;
    let url = '';
    void downloadPetProfilePhoto(supabase, pet.profile_photo_object_path).then((blob) => {
      if (active) { url = URL.createObjectURL(blob); setPhoto({ key, url }); }
    }).catch(() => undefined);
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [key, pet.profile_photo_object_path]);
  const avatar = PET_AVATARS.find((item) => item.id === (isPetAvatarId(pet.profile_avatar_id) ? pet.profile_avatar_id : 'dog-1')) ?? PET_AVATARS[0];
  return <img className={className} src={photo?.key === key ? photo.url : avatar.src} alt={`${pet.name} 프로필`} />;
}
