import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { petInvalidationChannel } from '../lib/realtime';

type Pet = { id: string; name: string; timezone: string };
type Notice = { id: string; pet_id: string; notification_type: string; title: string; body: string; action_path: string; created_at: string; expires_at: string; read_at: string | null; invalidated_at: string | null };
type Preference = { pet_id: string; user_id: string; notification_type: string; in_app_enabled: boolean; push_enabled: boolean; email_enabled: boolean; lead_minutes: number | null; unconfirmed_after_minutes: number | null; repeat_every_minutes: number | null; quiet_start: string | null; quiet_end: string | null; timezone: string };
type PushDevice = { endpoint_hash: string; created_at: string; expiration_time: string | null; last_success_at: string | null };

const types = [
  ['CARE_DUE', '일정 안내'], ['RECORD_UNCONFIRMED', '기록 미확인 안내'], ['CARE_RECORDED', '공동 보호자 기록 변경'],
  ['DUPLICATE_REVIEW', '중복 가능성 확인'], ['ROUTINE_CHANGED', '루틴 변경'],
] as const;
const vapidPublicKey = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
const toHex = (value: Uint8Array) => [...value].map((part) => part.toString(16).padStart(2, '0')).join('');

export function NotificationsPage({ pets, userId, online }: { pets: Pet[]; userId: string; online: boolean }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedPetId, setSelectedPetId] = useState(pets[0]?.id ?? '');
  const [notices, setNotices] = useState<Notice[]>([]);
  const [preferences, setPreferences] = useState<Preference[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [pushStatus, setPushStatus] = useState(() => typeof window !== 'undefined' && (!('serviceWorker' in navigator) || !('PushManager' in window))
    ? '이 브라우저는 Web Push를 지원하지 않습니다.' : '확인되지 않음');
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [currentEndpointHash, setCurrentEndpointHash] = useState<string | null>(null);
  const [pushDevices, setPushDevices] = useState<PushDevice[]>([]);
  const requestedPetId = searchParams.get('pet');
  const activePetId = pets.some((pet) => pet.id === requestedPetId) ? requestedPetId! : pets.some((pet) => pet.id === selectedPetId) ? selectedPetId : (pets[0]?.id ?? '');
  const selectedPet = pets.find((pet) => pet.id === activePetId);
  const visibleNotices = notices.filter((notice) => notice.pet_id === activePetId);

  const refresh = useCallback(async () => {
    if (!supabase || !online || !activePetId) return;
    setMessage('서버 확인 중…');
    const [noticeResult, preferenceResult] = await Promise.all([
      supabase.from('in_app_notifications').select('id,pet_id,notification_type,title,body,action_path,created_at,expires_at,read_at,invalidated_at')
        .eq('pet_id', activePetId).is('invalidated_at', null).lte('available_at', new Date().toISOString()).gte('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(50),
      supabase.from('notification_preferences').select('pet_id,user_id,notification_type,in_app_enabled,push_enabled,email_enabled,lead_minutes,unconfirmed_after_minutes,repeat_every_minutes,quiet_start,quiet_end,timezone')
        .eq('pet_id', activePetId).eq('user_id', userId),
    ]);
    if (noticeResult.error || preferenceResult.error) {
      setNotices([]); setPreferences([]); setMessage('서버에서 알림 상태를 확인하지 못했습니다. 저장된 내용은 최신 상태로 표시하지 않습니다.'); return;
    }
    setNotices((noticeResult.data ?? []) as Notice[]);
    setPreferences((preferenceResult.data ?? []) as Preference[]);
    setMessage('서버에서 현재 권한과 알림 상태를 확인했습니다.');
  }, [online, activePetId, userId]);

  const refreshPushDevices = useCallback(async () => {
    if (!supabase || !online) return;
    const { data, error } = await supabase.functions.invoke('manage-push-subscription', { body: { action: 'list' } });
    if (error) { setPushDevices([]); setPushStatus('서버의 기기별 구독 상태를 확인하지 못했습니다.'); return; }
    setPushDevices((data?.subscriptions ?? []) as PushDevice[]);
  }, [online]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);
  useEffect(() => { const timer = window.setTimeout(() => { void refreshPushDevices(); }, 0); return () => window.clearTimeout(timer); }, [refreshPushDevices]);
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    void navigator.serviceWorker.ready.then(async (registration) => {
      const subscription = await registration.pushManager.getSubscription();
      setPushSubscribed(Boolean(subscription));
      if (subscription) {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subscription.endpoint));
        setCurrentEndpointHash(toHex(new Uint8Array(digest)));
      } else setCurrentEndpointHash(null);
      setPushStatus(subscription ? '이 기기에 Push 구독이 등록되어 있습니다.' : '이 기기는 아직 Push 구독이 없습니다.');
    }).catch(() => setPushStatus('서비스 워커 상태를 확인하지 못했습니다.'));
  }, []);
  useEffect(() => {
    if (!supabase || !online || !activePetId) return;
    const client = supabase;
    const channel = petInvalidationChannel(client, activePetId, () => { void refresh(); });
    channel.subscribe((status) => {
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') setMessage('실시간 연결이 끊겼습니다. 알림은 서버 새로고침 후 확인하세요.');
    });
    return () => { void client.removeChannel(channel); };
  }, [activePetId, online, refresh]);
  useEffect(() => {
    const clearPrivateState = () => { setNotices([]); setPreferences([]); setPushDevices([]); setMessage('UNVERIFIED · 오프라인에서는 최신 알림·권한 상태를 확인할 수 없습니다.'); };
    window.addEventListener('offline', clearPrivateState);
    return () => window.removeEventListener('offline', clearPrivateState);
  }, []);

  function preference(type: string): Preference {
    return preferences.find((item) => item.notification_type === type) ?? {
      pet_id: activePetId, user_id: userId, notification_type: type, in_app_enabled: true, push_enabled: false,
      email_enabled: false, lead_minutes: null, unconfirmed_after_minutes: null, repeat_every_minutes: null, quiet_start: null, quiet_end: null,
      timezone: selectedPet?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }
  function change(type: string, patch: Partial<Preference>) {
    const current = preference(type);
    const next = { ...current, ...patch };
    setPreferences((items) => [...items.filter((item) => item.notification_type !== type), next]);
  }
  async function savePreferences() {
    if (!supabase || !online || !activePetId) return;
    setBusy(true); setMessage('설정을 저장하고 서버 권한을 확인하는 중…');
    const careSettings = preference('CARE_DUE');
    const rows = types.map(([type]) => ({ ...preference(type), timezone: selectedPet?.timezone ?? preference(type).timezone,
      quiet_start: careSettings.quiet_start, quiet_end: careSettings.quiet_end }));
    const { error } = await supabase.from('notification_preferences').upsert(rows, { onConflict: 'pet_id,user_id,notification_type' });
    setBusy(false);
    if (error) { setMessage(error.code === '42501' ? '현재 Pet 설정을 변경할 권한이 없습니다.' : '설정을 서버에 저장하지 못했습니다.'); return; }
    setMessage('알림 설정을 서버에 저장했습니다.'); void refresh();
  }
  async function enablePush() {
    if (!supabase || !online) { setPushStatus('오프라인 · 서버 확인 전에는 구독을 변경할 수 없습니다.'); return; }
    if (!vapidPublicKey) { setPushStatus('Push 서버 키가 설정되지 않아 등록할 수 없습니다.'); return; }
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { setPushStatus('이 브라우저는 Web Push를 지원하지 않습니다.'); return; }
    setBusy(true); setPushStatus('브라우저 권한을 요청하고 있습니다.');
    try {
      const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
      if (permission !== 'granted') { setPushStatus(permission === 'denied' ? '브라우저 알림 권한이 거부되어 있습니다. 브라우저 설정에서 직접 변경해 주세요.' : '알림 권한을 확인하지 못했습니다.'); return; }
      const registration = await navigator.serviceWorker.ready;
      const applicationServerKey = Uint8Array.from(atob(vapidPublicKey.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      const json = subscription.toJSON();
      const endpointHash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(subscription.endpoint));
      const { error } = await supabase.functions.invoke('manage-push-subscription', { body: {
        endpoint: subscription.endpoint, endpoint_hash: toHex(new Uint8Array(endpointHash)), p256dh: json.keys?.p256dh,
        auth: json.keys?.auth, expiration_time: subscription.expirationTime ? new Date(subscription.expirationTime).toISOString() : null,
      } });
      if (error) { await subscription.unsubscribe(); throw new Error('서버에 구독 상태를 등록하지 못했습니다.'); }
      setPushStatus('이 기기의 Push 구독이 서버에 등록되었습니다. 실제 전달은 Worker 설정이 필요합니다.');
      setPushSubscribed(true);
      setCurrentEndpointHash(toHex(new Uint8Array(endpointHash)));
      void refreshPushDevices();
    } catch (error) { setPushStatus(error instanceof Error ? error.message : 'Push 구독을 등록하지 못했습니다.'); }
    finally { setBusy(false); }
  }
  async function revokePushDevice(endpointHash: string) {
    if (!supabase || !online) { setPushStatus('온라인에서 서버 권한을 확인한 뒤 구독을 해제할 수 있습니다.'); return; }
    setBusy(true);
    try {
      const { error } = await supabase.functions.invoke('manage-push-subscription', { body: { action: 'revoke', endpoint_hash: endpointHash } });
      if (error) { setPushStatus('서버 구독을 해제하지 못했습니다. 브라우저 구독은 유지됩니다.'); return; }
      if ('serviceWorker' in navigator && 'PushManager' in window) {
        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (subscription && endpointHash === currentEndpointHash) await subscription.unsubscribe();
      }
      if (endpointHash === currentEndpointHash) { setPushSubscribed(false); setCurrentEndpointHash(null); }
      setPushStatus('선택한 브라우저 구독을 서버에서 해제했습니다.');
      void refreshPushDevices();
    } catch { setPushStatus('구독 해제 상태를 확인하지 못했습니다.'); }
    finally { setBusy(false); }
  }
  async function disablePush() {
    if (!currentEndpointHash) { setPushStatus('현재 브라우저의 서버 등록 구독을 찾지 못했습니다.'); return; }
    await revokePushDevice(currentEndpointHash);
  }
  async function markRead(notice: Notice) {
    if (!supabase || !online) { setMessage('오프라인에서는 알림 확인 상태를 서버에 기록할 수 없습니다.'); return; }
    const { error } = await supabase.rpc('mark_notification_read', { p_notification_id: notice.id });
    if (error) { setMessage('알림 확인 상태를 서버에서 갱신하지 못했습니다.'); return; }
    setNotices((items) => items.map((item) => item.id === notice.id ? { ...item, read_at: item.read_at ?? new Date().toISOString() } : item));
    if (notice.action_path.startsWith('/')) navigate(`/notifications?pet=${encodeURIComponent(notice.pet_id)}`);
  }

  return <main className="page-container">
    <section className="page-heading"><p className="eyebrow">함께 돌봄 알림</p><h1>알림 및 전달 설정</h1><p>알림 열람은 케어 수행이나 수신을 증명하지 않습니다.</p></section>
    {!pets.length ? <section className="panel">접근 가능한 Pet이 없습니다.</section> : <>
      <section className="panel stack">
        <label>Pet 선택<select value={activePetId} onChange={(event) => { setNotices([]); setPreferences([]); setSelectedPetId(event.target.value); setSearchParams({ pet: event.target.value }); }}>{pets.map((pet) => <option key={pet.id} value={pet.id}>{pet.name}</option>)}</select></label>
        <p role="status" className="small-note">{online ? message : 'UNVERIFIED · 오프라인에서는 최신 알림·권한 상태를 확인할 수 없습니다.'}</p>
        <button type="button" className="secondary-action" disabled={!online || busy} onClick={() => void refresh()}>서버에서 새로고침</button>
      </section>
      <section className="panel stack"><div className="section-heading"><div><p className="eyebrow">알림함</p><h2>최근 알림</h2></div></div>
        {!online ? <p className="empty">최신 알림을 확인할 수 없습니다.</p> : visibleNotices.length === 0 ? <p className="empty">표시할 알림이 없습니다. 알림 없음은 케어 미수행을 뜻하지 않습니다.</p> : <ul className="notification-list">{visibleNotices.map((notice) => <li key={notice.id} className={notice.read_at ? 'notification-read' : ''}>
          <div><strong>{notice.title}</strong>{notice.notification_type === 'DUPLICATE_REVIEW' && <small className="notification-risk">중복 가능성 안내 · 의료적 승인/판정이 아닙니다</small>}<p>{notice.body}</p><small>{new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: selectedPet?.timezone }).format(new Date(notice.created_at))} · {notice.read_at ? '알림 확인함' : '알림 확인 전'}</small></div>
          {!notice.read_at && <button className="secondary-action" type="button" onClick={() => void markRead(notice)}>알림 확인</button>}
        </li>)}</ul>}
      </section>
      <section className="panel stack"><div><p className="eyebrow">사용자별 설정</p><h2>알림 종류 및 채널</h2><p className="small-note">타임존: {selectedPet?.timezone ?? '확인 안 됨'}. 이 설정은 전달 선호만 관리하며 임상 판단 기준을 만들지 않습니다.</p></div>
        <div className="preference-grid"><span>알림 종류</span><span>앱</span><span>Push</span><span>이메일</span>{types.map(([type,label]) => { const pref = preference(type); return <div className="preference-row" key={type}>
          <strong>{label}</strong><label><input aria-label={`${label} 인앱 알림`} type="checkbox" checked={pref.in_app_enabled} onChange={(e) => change(type,{in_app_enabled:e.target.checked})}/></label>
          <label><input aria-label={`${label} Push 알림`} type="checkbox" checked={pref.push_enabled} onChange={(e) => change(type,{push_enabled:e.target.checked})}/></label>
          <label><input aria-label={`${label} 이메일 알림`} type="checkbox" checked={pref.email_enabled} onChange={(e) => change(type,{email_enabled:e.target.checked})}/></label>
        </div>; })}</div>
        <div className="form-grid"><label>일정 전 알림(분)<input type="number" min="0" max="10080" value={preference('CARE_DUE').lead_minutes ?? ''} onChange={(e) => change('CARE_DUE',{lead_minutes:e.target.value === '' ? null : Number(e.target.value)})}/></label>
          <label>기록 미확인 안내 지연(분)<input type="number" min="1" max="10080" placeholder="사용 안 함" value={preference('RECORD_UNCONFIRMED').unconfirmed_after_minutes ?? ''} onChange={(e) => change('RECORD_UNCONFIRMED',{unconfirmed_after_minutes:e.target.value === '' ? null : Number(e.target.value)})}/></label>
          <label>방해금지 시작<input type="time" value={preference('CARE_DUE').quiet_start ?? ''} onChange={(e) => change('CARE_DUE',{quiet_start:e.target.value || null})}/></label>
          <label>방해금지 종료<input type="time" value={preference('CARE_DUE').quiet_end ?? ''} onChange={(e) => change('CARE_DUE',{quiet_end:e.target.value || null})}/></label>
          <label>미확인 재안내 간격(분)<input type="number" min="15" max="10080" placeholder="반복 안 함" value={preference('RECORD_UNCONFIRMED').repeat_every_minutes ?? ''} onChange={(e) => change('RECORD_UNCONFIRMED',{repeat_every_minutes:e.target.value === '' ? null : Number(e.target.value)})}/></label></div>
        <button disabled={!online || busy} onClick={() => void savePreferences()}>{busy ? '처리 중…' : '설정 저장'}</button>
      </section>
      <section className="panel stack"><div><p className="eyebrow">이 기기</p><h2>Web Push</h2><p role="status" className="small-note">{pushStatus}</p></div>
        {typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent) && <p className="small-note">iOS/iPadOS에서는 홈 화면에 추가한 웹 앱에서 Push 지원 여부를 확인하세요. 기기와 OS 버전에 따라 지원이 다를 수 있습니다.</p>}
        <button type="button" className="secondary-action" disabled={busy || !online} onClick={() => void enablePush()}>이 기기에서 Push 설정</button>
        {pushSubscribed && <button type="button" className="secondary-action" disabled={busy || !online} onClick={() => void disablePush()}>이 기기 구독 해제</button>}
        <div><h3>등록된 브라우저 및 기기</h3>{!online ? <p className="small-note">서버 상태를 확인할 수 없습니다.</p> : pushDevices.length === 0 ? <p className="small-note">활성 구독이 없습니다.</p> : <ul className="push-device-list">{pushDevices.map((device) => <li key={device.endpoint_hash}>
          <div><strong>{device.endpoint_hash === currentEndpointHash ? '현재 브라우저' : '다른 브라우저 또는 기기'}</strong><small>등록 {new Intl.DateTimeFormat('ko-KR',{dateStyle:'medium',timeStyle:'short',timeZone:selectedPet?.timezone}).format(new Date(device.created_at))}</small>
            <small>마지막 Push 응답 {device.last_success_at ? new Intl.DateTimeFormat('ko-KR',{dateStyle:'medium',timeStyle:'short',timeZone:selectedPet?.timezone}).format(new Date(device.last_success_at)) : '아직 없음'}</small>
            <small>만료 {device.expiration_time ? new Intl.DateTimeFormat('ko-KR',{dateStyle:'medium',timeStyle:'short',timeZone:selectedPet?.timezone}).format(new Date(device.expiration_time)) : '브라우저 제공 없음'}</small></div>
          <button type="button" className="danger-button" disabled={busy || !online} onClick={() => void revokePushDevice(device.endpoint_hash)}>구독 해제</button>
        </li>)}</ul>}</div>
        <p className="small-note">Push는 일반적인 일정 안내만 포함합니다. 브라우저 권한·서버 구독·발송 처리가 확인되기 전에는 성공으로 표시하지 않습니다.</p>
      </section>
      <section className="panel"><p className="small-note">이메일 알림은 서버 제공자 설정이 완료되기 전까지 실제 발송되지 않습니다. 발송 여부와 사용자의 수신·열람 여부는 별도입니다.</p></section>
    </>}
  </main>;
}
