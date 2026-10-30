import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { cropRectangle, PET_AVATARS, photoFileError, type PetAvatarId } from '../lib/pet-profile';
import { downloadPetProfilePhoto, persistPetProfile, type PersistedPetProfile } from '../lib/pet-profile-persistence';
import { supabase } from '../lib/supabase';

type DraftChange = (draft: { avatarId: PetAvatarId; photo: Blob | null }) => void;

export function PetProfileEditor({
  name,
  petId,
  onboarding = false,
  avatarId: savedAvatarId = 'dog-1',
  photoPath = null,
  revision = 0,
  canEdit = true,
  onDraftChange,
  onProfileSaved,
}: {
  name: string;
  petId?: string;
  onboarding?: boolean;
  avatarId?: PetAvatarId;
  photoPath?: string | null;
  revision?: number;
  canEdit?: boolean;
  onDraftChange?: DraftChange;
  onProfileSaved?: (profile: PersistedPetProfile) => void | Promise<void>;
}) {
  const [avatar, setAvatar] = useState(() => PET_AVATARS.find((item) => item.id === savedAvatarId) ?? PET_AVATARS[0]);
  const [photo, setPhoto] = useState('');
  const [pendingPhoto, setPendingPhoto] = useState<Blob | null>(null);
  const [source, setSource] = useState<HTMLImageElement | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('전체');
  const [zoom, setZoom] = useState(1);
  const [x, setX] = useState(.5);
  const [y, setY] = useState(.5);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const request = useRef(0);
  const gallery = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const photoUrl = useRef('');
  const [baseRevision, setBaseRevision] = useState(revision);

  function setPhotoUrl(next: string) {
    if (photoUrl.current.startsWith('blob:')) URL.revokeObjectURL(photoUrl.current);
    photoUrl.current = next.startsWith('blob:') ? next : '';
    setPhoto(next);
  }

  useEffect(() => () => {
    request.current++;
    if (photoUrl.current) URL.revokeObjectURL(photoUrl.current);
  }, []);

  const remoteChanged = dirty && revision !== baseRevision;
  const displayedAvatar = dirty ? avatar : PET_AVATARS.find((item) => item.id === savedAvatarId) ?? PET_AVATARS[0];

  useEffect(() => {
    let active = true;
    if (photoUrl.current && !dirty) {
      URL.revokeObjectURL(photoUrl.current);
      photoUrl.current = '';
    }
    if (!photoPath || dirty || !supabase) return () => { active = false; };
    void downloadPetProfilePhoto(supabase, photoPath).then((blob) => {
      if (!active) return;
      setPhotoUrl(URL.createObjectURL(blob));
    }).catch(() => {
      if (active) setMessage('저장된 사진을 서버에서 불러오지 못했어요. 연결과 접근권한을 확인해 주세요.');
    });
    return () => { active = false; };
  }, [dirty, petId, photoPath]);

  useEffect(() => {
    const inputs = [gallery.current, camera.current];
    const cancelled = () => setMessage('사진 선택이 취소되었거나 기기에서 허용되지 않았어요. 기존 프로필은 유지됩니다.');
    inputs.forEach((input) => input?.addEventListener('cancel', cancelled));
    return () => inputs.forEach((input) => input?.removeEventListener('cancel', cancelled));
  }, []);

  useEffect(() => {
    if (!source || !canvas.current) return;
    const ctx = canvas.current.getContext('2d');
    if (!ctx) return;
    const rect = cropRectangle(source.naturalWidth, source.naturalHeight, zoom, x, y);
    ctx.fillStyle = '#faf8f1'; ctx.fillRect(0, 0, 512, 512);
    ctx.drawImage(source, rect.x, rect.y, rect.size, rect.size, 0, 0, 512, 512);
  }, [source, zoom, x, y]);

  function notifyDraft(nextAvatar: PetAvatarId, nextPhoto: Blob | null) {
    onDraftChange?.({ avatarId: nextAvatar, photo: nextPhoto });
  }

  async function choose(file?: File) {
    if (import.meta.env.MODE === 'production' || (import.meta.env.MODE !== 'demo' && import.meta.env.VITE_PET_PROFILE_PHOTO_UPLOAD_ENABLED !== 'true')) {
      setMessage('사진 업로드는 현재 점검 중이라 잠시 중지했어요. 기본 아바타를 사용해 주세요.');
      return;
    }
    if (!file) { setMessage('사진 선택을 취소했어요. 기존 프로필은 유지됩니다.'); return; }
    const error = photoFileError(file);
    if (error) { setMessage(error); return; }
    const version = ++request.current;
    setBusy(true); setMessage('');
    const url = URL.createObjectURL(file);
    try {
      const image = new Image(); image.src = url;
      await image.decode();
      if (image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error('oversize');
      if (request.current !== version) return;
      setZoom(1); setX(.5); setY(.5); setSource(image);
    } catch {
      if (request.current === version) setMessage('사진을 읽지 못했어요. 해상도를 줄이거나 다른 JPG·PNG 사진을 선택해 주세요.');
    } finally { URL.revokeObjectURL(url); if (request.current === version) setBusy(false); }
  }

  async function saveProfile() {
    if (remoteChanged) {
      setMessage('다른 보호자의 변경 사항을 먼저 새로고침해 주세요.');
      return;
    }
    if (!supabase || !petId || !canEdit || !navigator.onLine) {
      setMessage(!navigator.onLine ? '오프라인에서는 프로필을 저장할 수 없어요. 연결 후 다시 시도해 주세요.' : '현재 계정에는 프로필 변경 권한이 없어요.');
      return;
    }
    setBusy(true); setMessage('서버에서 권한을 확인하고 프로필을 저장하고 있어요…');
    try {
      const saved = await persistPetProfile(supabase, { petId, avatarId: avatar.id, revision, photoPath, photo: pendingPhoto });
      await onProfileSaved?.(saved);
      setBaseRevision(saved.revision);
      setPendingPhoto(null); setDirty(false);
      setMessage(saved.cleanupPending
        ? '프로필은 저장됐어요. 이전 사진 정리는 연결 상태를 확인한 뒤 다시 처리됩니다.'
        : '프로필 저장을 서버에서 확인했어요.');
    } catch (error) {
      setMessage(error instanceof Error && error.message.includes('409')
        ? '다른 보호자가 먼저 바꿨어요. 최신 프로필을 불러온 뒤 다시 저장해 주세요.'
        : error instanceof Error ? error.message : '프로필을 저장하지 못했어요. 기존 사진은 유지됩니다.');
    } finally { setBusy(false); }
  }

  const visible = PET_AVATARS.filter((item) => (filter === '전체' || `${item.family} ${item.label}`.includes(filter))
    && `${item.family} ${item.label} 강아지 믹스견`.includes(query.trim()));
  const persistent = Boolean(petId && supabase);
  const photoUploadEnabled = import.meta.env.MODE === 'demo'
    || (import.meta.env.MODE !== 'production' && import.meta.env.VITE_PET_PROFILE_PHOTO_UPLOAD_ENABLED === 'true');
  return <section className="pet-journal-profile" aria-label="반려동물 프로필">
    <div className="profile-heading">
      <img className="profile-portrait" src={(dirty ? photo : photoPath ? photo : '') || displayedAvatar.src} alt={`${name || '반려동물'} 프로필`} />
      <div><p className="eyebrow">우리의 건강수첩</p><h1>{name || '새로운 가족'}</h1><p className="small-note">하루의 작은 변화를 함께 기록해요.</p></div>
      {!onboarding && <Link className="button-link" to="/record">기록 추가</Link>}
    </div>
    <details className="profile-editor">
      <summary>사진·아바타 바꾸기</summary>
      <p className="profile-preview-notice" role="note">{onboarding
        ? '선택한 프로필은 반려동물 등록을 마치면 서버에 저장됩니다.'
        : persistent ? '저장 버튼을 누르기 전에는 미리보기입니다. 서버 저장 상태는 완료 안내로 확인해 주세요.'
          : 'DEMO 미리보기 · 서버에 저장되지 않으며 화면을 나가면 초기화됩니다.'}</p>
      <div className="profile-upload" onDragOver={photoUploadEnabled ? (event) => event.preventDefault() : undefined} onDrop={photoUploadEnabled ? (event) => {
        event.preventDefault(); void choose(event.dataTransfer.files[0]);
      } : undefined}>
        {photoUploadEnabled ? <div className="profile-actions">
          <button type="button" disabled={busy || !canEdit} onClick={() => camera.current?.click()}>카메라 촬영</button>
          <button type="button" className="secondary-action" disabled={busy || !canEdit} onClick={() => gallery.current?.click()}>사진·파일 선택</button>
          <button type="button" className="secondary-action" disabled={busy || !canEdit} onClick={() => {
            request.current++;
            const nextAvatar = PET_AVATARS[0];
            setPhotoUrl(''); setPendingPhoto(null); setSource(null); setAvatar(nextAvatar); setDirty(true);
            notifyDraft(nextAvatar.id, null); setMessage(persistent ? '기본 아바타 미리보기예요. 저장을 완료해야 서버에 반영됩니다.' : '기본 아바타 미리보기로 돌아왔어요.');
          }}>기본 아바타로 복귀</button>
        </div> : <p role="note">사진 업로드는 현재 점검 중이라 잠시 중지했어요. 기본 아바타 선택과 저장은 계속 사용할 수 있어요.</p>}
        {photoUploadEnabled && <>
        <input ref={gallery} type="file" hidden accept="image/jpeg,image/png,image/webp" aria-label="사진 파일 선택" onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ''; }} />
        <input ref={camera} type="file" hidden accept="image/*" capture="environment" aria-label="카메라 사진 선택" onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = ''; }} />
        <p className="small-note">사진을 여기에 끌어 놓아도 돼요. JPG·PNG·WebP, 입력 최대 10MB. 서버에는 512×512 JPG로 저장합니다.</p>
        </>}
      </div>
      {busy && <p role="status">{persistent ? '프로필을 처리하고 있어요…' : '사진을 준비하고 있어요…'}</p>}
      {remoteChanged && <p role="status">다른 보호자가 프로필을 바꿨어요. 저장 전에 최신 상태를 확인해 주세요.</p>}
      {message && <p role="status">{message}</p>}
      {source && <div className="profile-crop">
        <h2>사진 위치 맞추기</h2><p className="small-note">정사각형으로 자른 후 프로필에서 원형으로 보여요.</p>
        <canvas ref={canvas} width={512} height={512} aria-label="정사각형 사진 자르기 미리보기" />
        <label>확대<input type="range" min="1" max="3" step=".05" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /></label>
        <label>좌우 위치<input type="range" min="0" max="1" step=".01" value={x} onChange={(event) => setX(Number(event.target.value))} /></label>
        <label>상하 위치<input type="range" min="0" max="1" step=".01" value={y} onChange={(event) => setY(Number(event.target.value))} /></label>
        <div className="profile-actions"><button type="button" onClick={() => {
          if (!canvas.current?.toBlob) { setMessage('이 브라우저에서 사진을 자를 수 없어요. 아바타를 선택해 주세요.'); return; }
          canvas.current.toBlob((blob) => {
            if (!blob) { setMessage('사진을 준비하지 못했어요. 다시 시도해 주세요.'); return; }
            const nextUrl = URL.createObjectURL(blob);
            setPhotoUrl(nextUrl); setPendingPhoto(blob); setSource(null); setDirty(true);
            notifyDraft(avatar.id, blob);
            setMessage(persistent ? '사진 미리보기에 적용했어요. 저장 버튼을 눌러야 서버에 올라갑니다.' : '이 화면의 미리보기에 적용했어요. 서버에는 저장되지 않아요.');
          }, 'image/jpeg', .85);
        }}>미리보기에 적용</button><button type="button" className="secondary-action" onClick={() => setSource(null)}>자르기 취소</button></div>
      </div>}
      <h2>닮은 얼굴을 골라 주세요</h2><p className="small-note">32가지 얼굴 · 품종을 몰라도 괜찮아요. 믹스견도 털색과 귀 모양으로 찾아보세요.</p>
      <label>아바타 검색<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="예: 갈색, 처진 귀, 믹스견" /></label>
      <label>특징으로 찾기<select value={filter} onChange={(event) => setFilter(event.target.value)}>{['전체', '스피츠형', '리트리버형', '믹스견', '푸들형', '크림', '갈색', '검정', '하양', '선 귀', '처진 귀', '짝귀', '둥근 귀', '둥근 체형', '날씬한 체형'].map((item) => <option key={item}>{item}</option>)}</select></label>
      <div className="avatar-grid" aria-label="아바타 선택">{visible.map((item) => <button type="button" key={item.id} disabled={busy || !canEdit} aria-label={item.label} aria-pressed={!photo && displayedAvatar.id === item.id} onClick={() => {
        setPhotoUrl(''); setPendingPhoto(null); setSource(null); setAvatar(item); setDirty(true);
        notifyDraft(item.id, null);
        setMessage(persistent ? `${item.label} 미리보기예요. 저장 버튼을 눌러 서버에 반영해 주세요.` : `${item.label} 아바타를 미리보기에 적용했어요.`);
      }}><img src={item.src} alt="" loading="lazy" /><span>{item.coat}<br />{item.ears}<br />{item.shape}</span></button>)}</div>
      {!visible.length && <p role="status">맞는 아바타가 없어요. 다른 특징으로 찾아보세요.</p>}
      {persistent && dirty && <button type="button" disabled={busy || !canEdit || remoteChanged} onClick={() => void saveProfile()}>{busy ? '저장 중…' : '프로필 저장'}</button>}
      {persistent && !canEdit && <p role="note">현재 계정은 프로필을 볼 수 있지만 수정할 권한이 없어요.</p>}
    </details>
  </section>;
}

