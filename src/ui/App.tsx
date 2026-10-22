import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import {
  retryOrCreateHealthEventCommand,
  eventSubmissionFailure,
  petAccessRefreshLabel,
  safetyResultLabel,
  safetyStatusLabel,
  type EventType,
  type HealthEventCommand,
} from '../lib/event-command';
import { validateEventEntry, type EventEntryFields } from '../lib/event-entry';
import { isSupabaseConfigured, supabase, userFacingError } from '../lib/supabase';
import { petInvalidationChannel, userAccessChannel } from '../lib/realtime';
import { CareRoutinePage } from './CareRoutinePage';
import { InvitationAcceptPage, SharedCarePage } from './SharedCarePage';
import { NotificationsPage } from './NotificationsPage';
import { PwaExperience } from './PwaExperience';

type Pet = { id: string; household_id: string; name: string; timezone: string };
type HealthEvent = {
  id: string;
  pet_id: string;
  actor_id: string;
  performer_id: string | null;
  event_type: EventType;
  occurred_at: string;
  recorded_at: string;
  occurrence_id: string | null;
  plan_version_id: string | null;
  value: Record<string, unknown>;
  unit: string | null;
};
type EventRevision = {
  id: string;
  event_id: string;
  revision_no: number;
  revision_kind: 'CORRECT' | 'VOID';
  patch: Record<string, unknown>;
  reason_code: string;
  actor_id: string;
  recorded_at: string;
};
type RoutineOccurrence = {
  id: string;
  event_type: EventType;
  occurrence_key: string;
  step_key: string;
  scheduled_local_date: string;
  scheduled_local_time: string;
  timezone: string;
  scheduled_at: string | null;
  status: string;
  care_plan_version_id: string;
};
type SafetyResponse = {
  event_id: string;
  evaluation_id: string;
  evaluation_status: 'CURRENT' | 'STALE' | 'UNAVAILABLE' | 'NOT_APPLICABLE';
  result_codes: string[];
  recorded_at: string;
};

const eventOptions: { type: EventType; label: string; icon: string; short: string }[] = [
  { type: 'glucose', label: '혈당', icon: '◉', short: '측정값과 단위' },
  { type: 'meal', label: '식사', icon: '◒', short: '식사와 실제 섭취' },
  { type: 'insulin', label: '인슐린', icon: '↗', short: '이미 발생한 투여 기록' },
  { type: 'water', label: '음수', icon: '⌁', short: '관찰한 음수량' },
  { type: 'elimination', label: '배변·배뇨', icon: '⌖', short: '관찰한 내용' },
  { type: 'exercise', label: '운동', icon: '⌁', short: '실제 활동' },
  { type: 'weight', label: '체중', icon: '◌', short: '측정값과 단위' },
  { type: 'symptom', label: '증상·컨디션', icon: '♡', short: '관찰한 상태' },
];
const eventLabels = Object.fromEntries(eventOptions.map((option) => [option.type, option.label])) as Record<EventType, string>;
const localDateTimeNow = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const todayForTimezone = (timezone: string) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};
const localDateKey = (instant: string, timezone: string) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(instant));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};
const dateInTimezone = (instant: string, timezone: string) => new Intl.DateTimeFormat('ko-KR', {
  timeZone: timezone, year: 'numeric', month: 'long', day: 'numeric',
}).format(new Date(instant));
const dateTimeInTimezone = (instant: string, timezone: string) => new Intl.DateTimeFormat('ko-KR', {
  timeZone: timezone, dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(instant));
const timeInTimezone = (instant: string, timezone: string) => new Intl.DateTimeFormat('ko-KR', {
  timeZone: timezone, hour: '2-digit', minute: '2-digit',
}).format(new Date(instant));
const actorLabel = (actorId: string, currentUserId: string) => actorId === currentUserId
  ? '내가 기록'
  : `공동 보호자 · ${actorId.slice(0, 8)}`;
const latestRevision = (revisions: EventRevision[] = []) => [...revisions].sort((a, b) => b.revision_no - a.revision_no)[0];

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined;
}

export function App() {
  const location = useLocation();
  const [session, setSession] = useState<Session | null>(null);
  const [sessionReady, setSessionReady] = useState(!isSupabaseConfigured);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);

  useEffect(() => {
    if (!supabase) return;
    const client = supabase;
    void client.auth.getSession().then(({ data, error }) => {
      if (!error) {
        setSession(data.session);
        if (data.session?.access_token) void client.realtime.setAuth(data.session.access_token);
      }
      setSessionReady(true);
    });
    const { data } = client.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (next?.access_token) void client.realtime.setAuth(next.access_token);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  if (!sessionReady) return <main className="center-card" aria-live="polite">세션을 확인하고 있습니다…</main>;

  const requestedInvitePath = (location.state as { from?: unknown } | null)?.from;
  const postLoginPath = typeof requestedInvitePath === 'string' && requestedInvitePath.startsWith('/invite') ? requestedInvitePath : '/';

  return (
    <div className="app-shell">
      <header className="topbar">
        <Link to="/" className="brand"><img src={`${import.meta.env.BASE_URL}paw.svg`} alt="" /> HaniLog</Link>
        <span className={`connection ${online ? 'online' : 'offline'}`} role="status">
          {online ? '연결됨 · 서버 최신 상태는 새로고침으로 확인' : '오프라인 · 최신 상태 확인 불가'}
        </span>
        {session && <button className="quiet-button" onClick={() => void supabase?.auth.signOut()}>로그아웃</button>}
      </header>
      <PwaExperience />
      {!online && <div role="alert" className="offline-banner">서버 최신 상태를 확인할 수 없습니다. 기록은 서버 응답 전까지 확정되지 않습니다.</div>}
      <Routes>
        <Route path="/login" element={session ? <Navigate to={postLoginPath} replace /> : <Login />} />
        <Route path="/*" element={session ? <Workspace userId={session.user.id} online={online} /> : <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />} />
      </Routes>
      <footer>HaniLog는 실제 돌봄을 기록합니다. 치료·투여의 적정성을 승인하거나 처방을 바꾸지 않습니다.</footer>
    </div>
  );
}

function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [creatingAccount, setCreatingAccount] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    setBusy(true);
    setMessage('');
    const result = creatingAccount
      ? await supabase.auth.signUp({ email, password })
      : await supabase.auth.signInWithPassword({ email, password });
    if (result.error) setMessage(userFacingError(result.error));
    else if (creatingAccount) setMessage('계정 요청을 처리했습니다. 이메일 확인이 설정된 경우 받은 편지함을 확인하세요.');
    setBusy(false);
  }

  if (!isSupabaseConfigured) return (
    <main className="center-card">
      <p className="eyebrow">환경 설정 필요</p><h1>Supabase 연결 정보가 없습니다</h1>
      <p>로컬 <code>.env</code>에 Supabase URL과 publishable key를 설정하면 로그인할 수 있습니다. 비밀키는 넣지 마세요.</p>
    </main>
  );

  return (
    <main className="center-card login-card">
      <p className="eyebrow">함께 돌보는 건강 기록</p><h1>반려동물의 하루를 기록해요</h1>
      <p>이메일과 비밀번호로 로그인하세요.</p>
      <form className="stack" onSubmit={(event) => void submit(event)}>
        <label>이메일<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>비밀번호<input type="password" autoComplete={creatingAccount ? 'new-password' : 'current-password'} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <button disabled={busy}>{busy ? '확인 중…' : creatingAccount ? '계정 만들기' : '로그인'}</button>
        <button type="button" className="secondary-action" onClick={() => { setCreatingAccount((current) => !current); setMessage(''); }}>
          {creatingAccount ? '이미 계정이 있어요' : '새 계정 만들기'}
        </button>
        {message && <p role="alert" className="error-text">{message}</p>}
      </form>
      <p className="small-note">공동 데이터 접근권한은 서버에서 별도로 확인합니다.</p>
    </main>
  );
}

function Workspace({ userId, online }: { userId: string; online: boolean }) {
  const [pets, setPets] = useState<Pet[]>([]);
  const [households, setHouseholds] = useState<{ id: string; name: string }[]>([]);
  const [selectedPetId, setSelectedPetId] = useState('');
  const [loadedPetId, setLoadedPetId] = useState('');
  const [events, setEvents] = useState<HealthEvent[]>([]);
  const [revisions, setRevisions] = useState<EventRevision[]>([]);
  const [occurrences, setOccurrences] = useState<RoutineOccurrence[]>([]);
  const [planApproval, setPlanApproval] = useState<Record<string, string>>({});
  const [syncAt, setSyncAt] = useState<string | null>(null);
  const [loadingPets, setLoadingPets] = useState(true);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [accessMessage, setAccessMessage] = useState('');
  const [dataMessage, setDataMessage] = useState('');
  const [recordNotice, setRecordNotice] = useState<{ kind: 'success' | 'error' | 'unverified'; text: string } | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [householdName, setHouseholdName] = useState('');
  const [petName, setPetName] = useState('');
  const [petTimezone, setPetTimezone] = useState('');
  const [creating, setCreating] = useState(false);
  const [dateSelection, setDateSelection] = useState({ petId: '', value: '' });
  const pendingCommand = useRef<HealthEventCommand | null>(null);
  const selectedPetIdRef = useRef('');
  const selectedPet = pets.find((pet) => pet.id === selectedPetId) ?? null;
  const dateFilter = selectedPet
    ? dateSelection.petId === selectedPet.id ? dateSelection.value : todayForTimezone(selectedPet.timezone)
    : '';
  const setDateFilter = (value: string) => {
    if (selectedPet) setDateSelection({ petId: selectedPet.id, value });
  };
  const dataReady = Boolean(selectedPetId && loadedPetId === selectedPetId && !loadingEvents);
  const location = useLocation();

  useEffect(() => { selectedPetIdRef.current = selectedPetId; }, [selectedPetId]);

  useEffect(() => {
    const handleOffline = () => {
      pendingCommand.current = null;
      setEvents([]); setRevisions([]); setOccurrences([]); setPlanApproval({});
      setLoadedPetId(''); setSyncAt(null);
      setDataMessage('UNVERIFIED · 오프라인 상태에서는 최신 서버 기록을 표시할 수 없습니다.');
    };
    window.addEventListener('offline', handleOffline);
    return () => window.removeEventListener('offline', handleOffline);
  }, []);

  const refreshPets = useCallback(async () => {
    if (!supabase) return false;
    setLoadingPets(true);
    const [petResult, householdResult] = await Promise.all([
      supabase.from('pets').select('id,household_id,name,timezone').order('created_at', { ascending: true }),
      supabase.from('households').select('id,name').order('created_at', { ascending: true }),
    ]);
    if (petResult.error || householdResult.error) {
      const error = petResult.error ?? householdResult.error;
      setAccessMessage(errorCode(error) === '42501'
        ? '현재 계정의 접근권한을 확인할 수 없습니다.'
        : 'Pet 목록을 서버에서 확인하지 못했습니다. 연결 후 다시 시도해 주세요.');
      setLoadingPets(false);
      return false;
    }
    const nextPets = (petResult.data ?? []) as Pet[];
    setPets(nextPets);
    setHouseholds(householdResult.data ?? []);
    setAccessMessage('');
    const previousPetId = selectedPetIdRef.current;
    if (previousPetId && !nextPets.some((pet) => pet.id === previousPetId)) {
      pendingCommand.current = null;
      setEvents([]);
      setRevisions([]);
      setOccurrences([]);
      setPlanApproval({});
      setLoadedPetId('');
      setRecordNotice(null);
      setDataMessage('');
      setAccessMessage(petAccessRefreshLabel());
    }
    const nextSelectedPetId = nextPets.some((pet) => pet.id === previousPetId) ? previousPetId : nextPets[0]?.id ?? '';
    selectedPetIdRef.current = nextSelectedPetId;
    setSelectedPetId(nextSelectedPetId);
    setLoadingPets(false);
    return true;
  }, []);

  const refreshPetData = useCallback(async (petId: string) => {
    if (!supabase || !petId) return false;
    setLoadingEvents(true);
    const [eventResult, occurrenceResult] = await Promise.all([
      supabase.from('health_events')
        .select('id,pet_id,actor_id,performer_id,event_type,occurred_at,recorded_at,occurrence_id,plan_version_id,value,unit')
        .eq('pet_id', petId).order('occurred_at', { ascending: false }).limit(120),
      supabase.from('routine_occurrences')
        .select('id,event_type,occurrence_key,step_key,scheduled_local_date,scheduled_local_time,timezone,scheduled_at,status,care_plan_version_id')
        .eq('pet_id', petId).in('status', ['SCHEDULED','SCHEDULE_TIME_UNRESOLVED'])
        .order('scheduled_at', { ascending: false, nullsFirst: false }).limit(80),
    ]);
    if (eventResult.error || occurrenceResult.error) {
      const error = eventResult.error ?? occurrenceResult.error;
      setEvents([]);
      setRevisions([]);
      setOccurrences([]);
      setLoadedPetId(petId);
      setDataMessage(errorCode(error) === '42501'
        ? '접근권한이 변경됐습니다. Pet 목록을 새로 확인해 주세요.'
        : '서버 기록을 불러오지 못했습니다. 최신 상태는 확인되지 않았습니다.');
      setLoadingEvents(false);
      return false;
    }
    const nextEvents = (eventResult.data ?? []) as HealthEvent[];
    const nextOccurrences = (occurrenceResult.data ?? []) as RoutineOccurrence[];
    setEvents(nextEvents);
    setOccurrences(nextOccurrences);
    const eventIds = nextEvents.map((item) => item.id);
    const planIds = [...new Set(nextOccurrences.map((item) => item.care_plan_version_id))];
    const [revisionResult, planResult] = await Promise.all([
      eventIds.length
        ? supabase.from('health_event_revisions')
          .select('id,event_id,revision_no,revision_kind,patch,reason_code,actor_id,recorded_at')
          .in('event_id', eventIds)
        : Promise.resolve({ data: [], error: null }),
      planIds.length
        ? supabase.from('care_plan_versions').select('id,approval_status').in('id', planIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    setRevisions((revisionResult.data ?? []) as EventRevision[]);
    const approvalMap: Record<string, string> = {};
    for (const row of planResult.data ?? []) approvalMap[row.id] = row.approval_status;
    setPlanApproval(approvalMap);
    setLoadedPetId(petId);
    setDataMessage(revisionResult.error || planResult.error
      ? '기록은 불러왔지만 일부 이력 또는 계획 상태를 확인하지 못했습니다.'
      : '');
    setSyncAt(new Date().toISOString());
    setLoadingEvents(false);
    return true;
  }, []);

  const refreshAll = useCallback(async () => {
    const petRefreshSucceeded = await refreshPets();
    if (petRefreshSucceeded && selectedPetId) await refreshPetData(selectedPetId);
  }, [refreshPets, refreshPetData, selectedPetId]);

  useEffect(() => {
    if (!supabase) return;
    const client = supabase;
    const clearPrivateState = () => {
      pendingCommand.current = null;
      selectedPetIdRef.current = '';
      setSelectedPetId('');
      setEvents([]); setRevisions([]); setOccurrences([]); setPlanApproval({});
      setLoadedPetId(''); setSyncAt(null); setRecordNotice(null);
      setDataMessage('접근권한 변경 알림을 받았습니다. 서버 권한을 다시 확인하는 동안 기록을 숨깁니다.');
      window.dispatchEvent(new Event('hanilog:access-changed'));
    };
    const channel = userAccessChannel(supabase, userId, () => {
      clearPrivateState();
      void client.auth.refreshSession().then(async ({ data, error }) => {
        if (!error && data.session?.access_token) await client.realtime.setAuth(data.session.access_token);
        await refreshPets();
      });
    }).subscribe((status) => {
      if (status === 'SUBSCRIBED') void refreshPets();
    });
    return () => { void client.removeChannel(channel); };
  }, [userId, refreshPets]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refreshPets(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshPets]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (selectedPetId) void refreshPetData(selectedPetId);
      else setLoadingEvents(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [selectedPetId, refreshPetData]);

  useEffect(() => {
    if (!supabase || !selectedPetId) return;
    let refreshTimer = 0;
    const refreshHint = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => { void refreshPetData(selectedPetId); }, 120);
    };
    const channel = petInvalidationChannel(supabase, selectedPetId, refreshHint)
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          setRealtimeStatus('connected');
          // Re-query on initial connection and reconnect; channel messages are hints only.
          refreshHint();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setRealtimeStatus('disconnected');
        }
      });
    return () => { window.clearTimeout(refreshTimer); void supabase?.removeChannel(channel); };
  }, [selectedPetId, refreshPetData]);

  useEffect(() => {
    const checkCurrentAccess = () => {
      void refreshPets();
      if (selectedPetId) void refreshPetData(selectedPetId);
    };
    window.addEventListener('focus', checkCurrentAccess);
    const timer = window.setInterval(checkCurrentAccess, 60_000);
    return () => {
      window.removeEventListener('focus', checkCurrentAccess);
      window.clearInterval(timer);
    };
  }, [refreshPets, refreshPetData, selectedPetId]);

  async function createHousehold(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !householdName.trim()) return;
    setCreating(true);
    const { error } = await supabase.rpc('create_household', { p_name: householdName.trim() });
    if (error) setDataMessage(errorCode(error) === '42501' ? '가정을 만들 권한이 없습니다.' : userFacingError(error));
    else {
      setHouseholdName('');
      setDataMessage('공동 돌봄 가정을 만들었습니다.');
      await refreshPets();
    }
    setCreating(false);
  }

  async function createPet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !households[0] || !petName.trim() || !petTimezone.trim()) return;
    setCreating(true);
    const { data, error } = await supabase.rpc('create_pet', {
      p_household_id: households[0].id,
      p_name: petName.trim(),
      p_timezone: petTimezone.trim(),
    });
    if (error) setDataMessage(errorCode(error) === '42501'
      ? '현재 Household에서 Pet을 만들 권한이 없습니다.'
      : 'Pet을 등록하지 못했습니다. 이름과 IANA 시간대를 확인해 주세요.');
    else {
      setPetName('');
      setPetTimezone('');
      setDataMessage('Pet을 등록했습니다. 서버에서 접근권한을 다시 확인하고 있습니다.');
      await refreshPets();
      if (typeof data === 'string') setSelectedPetId(data);
    }
    setCreating(false);
  }

  async function submitHealthEvent(fields: EventEntryFields, occurrenceId: string | null, confirmedPerformed: boolean): Promise<boolean> {
    if (!supabase || !selectedPet) return false;
    const validation = validateEventEntry(fields);
    if (validation.error || !validation.value) {
      setRecordNotice({ kind: 'error', text: validation.error ?? '입력 내용을 확인해 주세요.' });
      return false;
    }
    const clientTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const command = retryOrCreateHealthEventCommand({
      petId: selectedPet.id,
      eventType: fields.eventType,
      occurredAt: validation.value.occurredAt,
      occurrenceId,
      value: validation.value.value,
      unit: validation.value.unit,
      clientTimezone,
      performerId: confirmedPerformed ? userId : null,
    }, pendingCommand.current);
    pendingCommand.current = command;
    setRecordNotice(null);

    if (!online) {
      setRecordNotice({ kind: 'unverified', text: 'UNVERIFIED · 오프라인이라 서버에 제출하지 않았습니다. 현재 입력은 미확정이며, 연결 후 같은 내용으로 다시 시도할 수 있습니다.' });
      return false;
    }

    const { data, error } = await supabase.rpc('record_health_event', {
      p_pet_id: command.petId,
      p_event_type: command.eventType,
      p_occurred_at: command.occurredAt,
      p_occurrence_id: command.occurrenceId,
      p_value: command.value,
      p_unit: command.unit,
      p_idempotency_key: command.idempotencyKey,
      p_client_timezone: command.clientTimezone,
      p_performer_id: command.performerId,
    });
    if (error) {
      const code = errorCode(error);
      const failure = eventSubmissionFailure(code);
      if (failure.kind === 'error') pendingCommand.current = null;
      setRecordNotice(failure);
      return false;
    }

    const response = data as Partial<SafetyResponse> | null;
    if (!response?.event_id || !response.evaluation_id || !response.evaluation_status || !Array.isArray(response.result_codes)) {
      setRecordNotice({ kind: 'unverified', text: 'UNVERIFIED · 응답에서 저장 확정을 확인할 수 없습니다. 같은 내용으로 다시 확인해 주세요.' });
      return false;
    }

    pendingCommand.current = null;
    const warnings = response.result_codes.map(safetyResultLabel).join(' ');
    const evaluationStatus = safetyStatusLabel(response.evaluation_status);
    setRecordNotice({
      kind: 'success',
      text: warnings
        ? `서버 기록 확인 완료 · ${warnings}`
        : `서버 기록 확인 완료 · ${evaluationStatus}`,
    });
    await refreshPetData(selectedPet.id);
    return true;
  }

  const todayEvents = useMemo(() => selectedPet && dataReady
    ? events.filter((item) => localDateKey(item.occurred_at, selectedPet.timezone) === todayForTimezone(selectedPet.timezone))
    : [], [events, selectedPet, dataReady]);

  return (
    <>
      <div className="workspace-bar">
        <div className="pet-switcher">
          <label htmlFor="pet-switch">현재 반려동물</label>
          <select id="pet-switch" aria-label="반려동물 선택" value={selectedPetId} disabled={!pets.length} onChange={(event) => {
            pendingCommand.current = null;
            setRecordNotice(null);
            setSelectedPetId(event.target.value);
          }}>
            {!pets.length && <option value="">접근 가능한 Pet 없음</option>}
            {pets.map((pet) => <option value={pet.id} key={pet.id}>{pet.name}</option>)}
          </select>
        </div>
        <button className="refresh-button" type="button" disabled={!online || loadingPets || loadingEvents} onClick={() => void refreshAll()}>
          {loadingPets || loadingEvents ? '확인 중…' : '새로고침'}
        </button>
      </div>
      {accessMessage && <div role="alert" className="notice notice-warning">{accessMessage}</div>}
      {dataMessage && <div role="status" className="notice notice-warning">{dataMessage}</div>}
      {recordNotice && <div role={recordNotice.kind === 'error' || recordNotice.kind === 'unverified' ? 'alert' : 'status'}
        className={`notice ${recordNotice.kind === 'success' ? 'notice-success' : 'notice-warning'}`}>{recordNotice.text}</div>}
      {!online && recordNotice?.kind !== 'unverified' && <div role="status" className="notice notice-warning">
        서버 최신 상태 확인 불가 · 과거 기록이 현재 상태를 보증하지 않습니다.
      </div>}
      {selectedPet && <p className="sync-caption" aria-live="polite">
        {syncAt ? `마지막 서버 확인 · ${dateTimeInTimezone(syncAt, selectedPet.timezone)}` : '서버 확인 시각 없음'}
        {' · '}Pet 시간대 {selectedPet.timezone}
        {' · '}실시간 {realtimeStatus === 'connected' ? '연결됨' : realtimeStatus === 'connecting' ? '연결 확인 중' : '연결 끊김 · 서버 재조회 필요'}
      </p>}
      <Routes>
        <Route path="/invite" element={<InvitationAcceptPage />} />
        <Route path="/" element={<DashboardPage
          pet={selectedPet} petsCount={pets.length} households={households}
          events={todayEvents} allEvents={dataReady ? events : []} revisions={dataReady ? revisions : []}
          occurrences={dataReady ? occurrences : []} planApproval={dataReady ? planApproval : {}} userId={userId}
          loading={loadingPets || loadingEvents} dataMessage={dataMessage}
          onCreateHousehold={createHousehold} onCreatePet={createPet}
          householdName={householdName} setHouseholdName={setHouseholdName}
          petName={petName} setPetName={setPetName} petTimezone={petTimezone} setPetTimezone={setPetTimezone}
          creating={creating}
        />} />
        <Route path="/timeline" element={!selectedPet
          ? <SetupPrompt loading={loadingPets} />
          : <TimelinePage pet={selectedPet} events={dataReady ? events : []} revisions={dataReady ? revisions : []} userId={userId}
            dateFilter={dateFilter} setDateFilter={setDateFilter} loading={loadingEvents} />} />
        <Route path="/care" element={!selectedPet ? <SetupPrompt loading={loadingPets} /> : <CareRoutinePage key={selectedPet.id} pet={selectedPet} online={online} userId={userId} />} />
        <Route path="/shared" element={<SharedCarePage key={households.map((item) => item.id).join(':')} households={households} pets={pets} userId={userId} />} />
        <Route path="/notifications" element={<NotificationsPage key={`${userId}:${selectedPetId}:${pets.map((pet) => pet.id).join(':')}`} pets={pets} userId={userId} online={online} />} />
        <Route path="/record" element={!selectedPet
          ? <SetupPrompt loading={loadingPets} />
          : <QuickRecordPage key={`${selectedPet.id}:${location.search}`} pet={selectedPet} userId={userId} occurrences={dataReady ? occurrences : []}
            planApproval={dataReady ? planApproval : {}} online={online}
            presetEventType={new URLSearchParams(location.search).get('event') ?? undefined}
            presetOccurrenceId={new URLSearchParams(location.search).get('occurrence') ?? undefined}
            onSubmit={submitHealthEvent} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      {sessionNav(location.pathname)}
    </>
  );
}

function sessionNav(pathname: string) {
  const navItems = [
    { to: '/', label: '오늘', icon: '⌂' },
    { to: '/record', label: '빠른 기록', icon: '+' },
    { to: '/timeline', label: '기록 모아보기', icon: '◷' },
    { to: '/care', label: '돌봄 루틴', icon: '✓' },
    { to: '/shared', label: '함께 돌봄', icon: '♡' },
    { to: '/notifications', label: '알림', icon: '♧' },
  ];
  return <nav className="bottom-nav" aria-label="주요 메뉴">
    {navItems.map((item) => {
      const active = item.to === '/' ? pathname === '/' : pathname.startsWith(item.to);
      return <NavLink key={item.to} to={item.to} className={active ? 'nav-item active' : 'nav-item'} aria-current={active ? 'page' : undefined}>
        <span className="nav-icon" aria-hidden="true">{item.icon}</span><span>{item.label}</span>
      </NavLink>;
    })}
  </nav>;
}

function SetupPrompt({ loading }: { loading: boolean }) {
  return <main className="page-container">
    <section className="panel empty-panel"><span className="empty-illustration" aria-hidden="true">🐾</span>
      <h1>{loading ? '반려동물 정보를 확인하고 있어요' : '먼저 반려동물을 등록해 주세요'}</h1>
      <p>기록 화면을 열기 전에 서버에서 확인 가능한 Pet을 선택해야 합니다.</p>
      <Link className="button-link" to="/">Pet 등록으로 이동</Link>
    </section>
  </main>;
}

function DashboardPage(props: {
  pet: Pet | null; petsCount: number; households: { id: string; name: string }[];
  events: HealthEvent[]; allEvents: HealthEvent[]; revisions: EventRevision[];
  occurrences: RoutineOccurrence[]; planApproval: Record<string, string>; userId: string;
  loading: boolean; dataMessage: string;
  onCreateHousehold: (event: FormEvent<HTMLFormElement>) => void;
  onCreatePet: (event: FormEvent<HTMLFormElement>) => void;
  householdName: string; setHouseholdName: (value: string) => void;
  petName: string; setPetName: (value: string) => void;
  petTimezone: string; setPetTimezone: (value: string) => void; creating: boolean;
}) {
  const {
    pet, petsCount, households, events, allEvents, revisions, occurrences, planApproval, userId,
    loading, onCreateHousehold, onCreatePet, householdName, setHouseholdName,
    petName, setPetName, petTimezone, setPetTimezone, creating,
  } = props;
  if (!pet && petsCount === 0 && !loading) return <main className="page-container">
    <section className="hero-card setup-hero">
      <p className="eyebrow">첫 설정</p><h1>공동 돌봄 기록을 시작해요</h1>
      <p>Pet을 만든 뒤 서버가 부여한 접근권한으로 기록을 확인할 수 있습니다.</p>
    </section>
    <section className="panel setup-grid">
      {households.length === 0 && <form className="stack" onSubmit={onCreateHousehold}>
        <div className="step-number">01</div><h2>공동 돌봄 가정</h2>
        <label>가정 이름<input required maxLength={120} value={householdName} onChange={(event) => setHouseholdName(event.target.value)} /></label>
        <button disabled={creating || !householdName.trim()}>{creating ? '저장 중…' : '가정 만들기'}</button>
      </form>}
      {households.length > 0 && <form className="stack" onSubmit={onCreatePet}>
        <div className="step-number">02</div><h2>반려동물 등록</h2>
        <p className="small-note">접근 가능한 첫 Household에 등록합니다.</p>
        <label>이름<input required maxLength={120} value={petName} onChange={(event) => setPetName(event.target.value)} /></label>
        <label>Pet 시간대<input required value={petTimezone} onChange={(event) => setPetTimezone(event.target.value)} placeholder="IANA 시간대" /></label>
        <button disabled={creating || !petName.trim() || !petTimezone.trim()}>{creating ? '등록 중…' : 'Pet 등록'}</button>
      </form>}
    </section>
  </main>;
  if (!pet) return <SetupPrompt loading={loading} />;

  const localToday = todayForTimezone(pet.timezone);
  const daily = events.filter((event) => localDateKey(event.occurred_at, pet.timezone) === localToday
    && latestRevision(revisions.filter((revision) => revision.event_id === event.id))?.revision_kind !== 'VOID');
  const todayOccurrences = occurrences.filter((occurrence) => occurrence.scheduled_local_date === localToday);
  const recentGlucose = allEvents.find((event) => event.event_type === 'glucose');
  const recentMeal = allEvents.find((event) => event.event_type === 'meal');
  const recentInsulin = allEvents.find((event) => event.event_type === 'insulin');
  const currentOccurrenceEventIds = new Set(daily.map((event) => event.occurrence_id).filter(Boolean));

  return <main className="page-container">
    <section className="hero-card pet-profile">
      <div className="pet-avatar" aria-hidden="true">🐕</div>
      <div className="pet-intro"><p className="eyebrow">오늘의 돌봄</p><h1>{pet.name}</h1>
        <p>{dateInTimezone(new Date().toISOString(), pet.timezone)} · 기록을 함께 확인해요</p></div>
      <Link to="/record" className="hero-add" aria-label="빠른 기록 추가">+</Link>
    </section>

    <section className="summary-grid" aria-label="오늘 건강 기록 요약">
      <SummaryCard title="오늘 기록" value={String(daily.length)} detail={daily.length ? '서버에 저장된 기록' : '기록 없음은 미실시가 아니에요'} icon="◷" />
      <SummaryCard title="루틴 확인" value={todayOccurrences.length ? `${todayOccurrences.filter((item) => currentOccurrenceEventIds.has(item.id)).length}/${todayOccurrences.length}` : '일정 없음'}
        detail={todayOccurrences.length ? '기록 미확인 상태를 포함해요' : '등록된 일정이 없습니다'} icon="✓" />
    </section>

    <section className="panel routine-panel">
      <div className="section-heading"><div><p className="eyebrow">관리 루틴</p><h2>예정 일정 확인</h2></div><span className="section-date">{localToday}</span></div>
      {!todayOccurrences.length ? <p className="empty">오늘 등록된 routine occurrence가 없습니다. 일정이 없다는 사실을 실제 돌봄 미실시로 판단하지 않습니다.</p> :
        <ul className="routine-list">{todayOccurrences.map((occurrence) => {
          const matched = daily.some((event) => event.occurrence_id === occurrence.id
            && latestRevision(revisions.filter((revision) => revision.event_id === event.id))?.revision_kind !== 'VOID');
          const approval = planApproval[occurrence.care_plan_version_id];
          return <li key={occurrence.id}>
            <span className="routine-time">{occurrence.scheduled_local_time.slice(0, 5)}</span>
            <span className="routine-label"><strong>{eventLabels[occurrence.event_type] ?? occurrence.event_type}</strong>
              <small>{approval === 'CLINICIAN_CONFIRMED' ? '계획 상태 확인됨' : '계획 승인 확인 안 됨'}</small></span>
            <span className={matched ? 'routine-state recorded' : 'routine-state unknown'}>{matched ? '기록 확인' : '기록 미확인'}</span>
          </li>;
        })}</ul>}
      <p className="small-note">일정 기록이 없으면 미확인으로 표시합니다. 실제 미실시로 자동 판단하지 않습니다.</p>
    </section>

    <section className="panel quick-glance">
      <div className="section-heading"><div><p className="eyebrow">최근 기록</p><h2>혈당·식사·인슐린</h2></div><Link to="/timeline">모두 보기</Link></div>
      <div className="glance-list">
        <GlanceRow title="최근 혈당" event={recentGlucose} pet={pet} revisions={revisions} userId={userId} />
        <GlanceRow title="최근 식사" event={recentMeal} pet={pet} revisions={revisions} userId={userId} />
        <GlanceRow title="최근 인슐린" event={recentInsulin} pet={pet} revisions={revisions} userId={userId} />
      </div>
      {loading && <p className="small-note" role="status">서버 기록을 확인하고 있습니다…</p>}
    </section>
    <p className="medical-note">Safety Guard는 일정·기록 간 데이터 상태만 표시합니다. 인슐린 투여를 승인하지 않습니다.</p>
  </main>;
}

function SummaryCard({ title, value, detail, icon }: { title: string; value: string; detail: string; icon: string }) {
  return <article className="summary-card"><span className="summary-icon" aria-hidden="true">{icon}</span>
    <span className="summary-title">{title}</span><strong>{value}</strong><small>{detail}</small>
  </article>;
}

function GlanceRow({ title, event, pet, revisions, userId }: {
  title: string; event: HealthEvent | undefined; pet: Pet; revisions: EventRevision[]; userId: string;
}) {
  if (!event) return <div className="glance-row"><span className="glance-symbol" aria-hidden="true">·</span><div><strong>{title}</strong><small>기록 미확인 · 실제 미실시 여부는 알 수 없습니다</small></div></div>;
  const revision = latestRevision(revisions.filter((item) => item.event_id === event.id));
  const value = typeof event.value.observed_value === 'number' || typeof event.value.observed_value === 'string'
    ? `${event.value.observed_value}${event.unit ? ` ${event.unit}` : ''}`
    : typeof event.value.meal_status === 'string' ? mealStatusLabel(event.value.meal_status) : '상세 기록 보기';
  return <div className="glance-row"><span className="glance-symbol" aria-hidden="true">{eventOptions.find((item) => item.type === event.event_type)?.icon}</span>
    <div><strong>{title} · {value}</strong><small>{dateTimeInTimezone(event.occurred_at, pet.timezone)} · {actorLabel(event.actor_id, userId)}
      {revision?.revision_kind === 'VOID' ? ' · 무효 처리' : revision ? ' · 정정 이력 있음' : ''}</small></div></div>;
}

function mealStatusLabel(status: string) {
  switch (status) {
    case 'ATE': return '섭취 확인';
    case 'PARTIAL': return '일부 섭취';
    case 'REFUSED': return '식사 거부 보고';
    default: return status;
  }
}

export function QuickRecordPage(props: {
  pet: Pet; userId: string; occurrences: RoutineOccurrence[]; presetEventType?: string; presetOccurrenceId?: string;
  planApproval: Record<string, string>; online: boolean;
  onSubmit: (fields: EventEntryFields, occurrenceId: string | null, confirmedPerformed: boolean) => Promise<boolean>;
}) {
  const { pet, userId, occurrences, planApproval, online, onSubmit } = props;
  const initialEventType = eventOptions.find((option) => option.type === props.presetEventType)?.type ?? 'glucose';
  const [eventType, setEventType] = useState<EventType>(initialEventType);
  const [occurredLocal, setOccurredLocal] = useState(localDateTimeNow());
  const [numericValue, setNumericValue] = useState('');
  const [unit, setUnit] = useState('');
  const [note, setNote] = useState('');
  const [mealStatus, setMealStatus] = useState('');
  const [eliminationType, setEliminationType] = useState('');
  const [description, setDescription] = useState('');
  const [occurrenceId, setOccurrenceId] = useState(props.presetOccurrenceId ?? '');
  const [confirmedAlreadyOccurred, setConfirmedAlreadyOccurred] = useState(false);
  const [performedByMe, setPerformedByMe] = useState(false);
  const [preflight, setPreflight] = useState<'idle' | 'checking' | 'verified' | 'unverified'>('idle');
  const [priorEvents, setPriorEvents] = useState<HealthEvent[]>([]);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const selectedOccurrence = occurrences.find((item) => item.id === occurrenceId);
  const selectedApproval = selectedOccurrence ? planApproval[selectedOccurrence.care_plan_version_id] : null;

  useEffect(() => {
    if (eventType !== 'insulin' || !occurrenceId) {
      return;
    }
    let cancelled = false;
    let timer = 0;
    async function checkOccurrence() {
      setPreflight('checking');
      if (!online || !supabase) {
        setPreflight('unverified');
        return;
      }
      const { data, error } = await supabase.from('health_events')
        .select('id,pet_id,actor_id,performer_id,event_type,occurred_at,recorded_at,occurrence_id,plan_version_id,value,unit')
        .eq('pet_id', pet.id).eq('occurrence_id', occurrenceId).eq('event_type', 'insulin')
        .order('recorded_at', { ascending: true });
      if (error) {
        if (!cancelled) {
          setPriorEvents([]);
          setPreflight('unverified');
        }
        return;
      }
      const rows = (data ?? []) as HealthEvent[];
      let activeRows = rows;
      if (rows.length) {
        const result = await supabase.from('health_event_revisions')
          .select('event_id,revision_no,revision_kind')
          .in('event_id', rows.map((row) => row.id));
        if (result.error) {
          if (!cancelled) {
            setPriorEvents(rows);
            setPreflight('unverified');
          }
          return;
        }
        const revisionRows = result.data ?? [];
        activeRows = rows.filter((row) => {
          const latest = revisionRows.filter((item) => item.event_id === row.id)
            .sort((a, b) => b.revision_no - a.revision_no)[0];
          return latest?.revision_kind !== 'VOID';
        });
      }
      if (!cancelled) {
        setPriorEvents(activeRows);
        setPreflight('verified');
      }
    }
    timer = window.setTimeout(() => { void checkOccurrence(); }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [eventType, occurrenceId, online, pet.id]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError('');
    const fields: EventEntryFields = {
      eventType, occurredLocal, note, numericValue, unit, mealStatus, eliminationType, description, confirmedAlreadyOccurred,
    };
    const validation = validateEventEntry(fields);
    if (validation.error) {
      setFormError(validation.error);
      return;
    }
    setSaving(true);
    const saved = await onSubmit(fields, occurrenceId || null, performedByMe || confirmedAlreadyOccurred);
    setSaving(false);
    if (saved) {
      setNumericValue('');
      setUnit('');
      setNote('');
      setDescription('');
      setMealStatus('');
      setEliminationType('');
      setConfirmedAlreadyOccurred(false);
      setPerformedByMe(false);
      setOccurrenceId('');
    }
  }

  return <main className="page-container record-page">
    <section className="page-heading"><p className="eyebrow">빠른 기록</p><h1>{pet.name}의 실제 돌봄을 기록해요</h1>
      <p>발생한 사실을 기록합니다. 기록 입력은 투여 지시나 임상적 승인으로 사용되지 않습니다.</p></section>
    <form className="record-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
      <fieldset className="event-type-fieldset">
        <legend>무엇을 기록할까요?</legend>
        <div className="event-type-grid">{eventOptions.map((option) =>
          <label className={eventType === option.type ? 'type-choice selected' : 'type-choice'} key={option.type}>
            <input type="radio" name="event-type" value={option.type} checked={eventType === option.type}
              onChange={() => {
                setEventType(option.type);
                setNumericValue('');
                setUnit('');
                setMealStatus('');
                setEliminationType('');
                setDescription('');
                setConfirmedAlreadyOccurred(false);
                setFormError('');
              }} />
            <span className="type-icon" aria-hidden="true">{option.icon}</span>
            <span className="type-label">{option.label}</span>
          </label>)}</div>
      </fieldset>

      <section className={eventType === 'insulin' ? 'insulin-record-section' : 'event-fields'}>
        {eventType === 'insulin' && <div className="insulin-header">
          <p className="eyebrow">사후 기록 전용</p><h2>이미 발생한 투여 사실</h2>
          <p>이 화면은 신규 투여를 안내하지 않습니다. 용량이나 투여 가능 여부를 판단하지 않습니다.</p>
        </div>}
        <div className="form-grid">
          <label className="field-label">실제 발생 시각
            <input type="datetime-local" required value={occurredLocal} onChange={(event) => setOccurredLocal(event.target.value)} />
            <small>기기 시간대 기준 입력 · 서버에는 UTC로 저장</small>
          </label>
          {eventType !== 'insulin' && <label className="field-label">연결할 돌봄 일정 (선택)
            <select value={occurrenceId} onChange={(event) => setOccurrenceId(event.target.value)}>
              <option value="">일정 연결 안 함</option>
              {occurrences.filter((occurrence) => occurrence.event_type === eventType).map((occurrence) => <option key={occurrence.id} value={occurrence.id}>
                {occurrence.scheduled_local_date} · {occurrence.scheduled_local_time.slice(0, 5)} · {occurrence.status === 'SCHEDULE_TIME_UNRESOLVED' ? '시각 확인 필요' : occurrence.occurrence_key}
              </option>)}
            </select><small>일정 연결은 기록 분류용이며 돌봄 수행 여부나 의료적 적정성을 승인하지 않습니다.</small>
          </label>}
          {eventType === 'glucose' && <>
            <label className="field-label">측정값<input type="number" inputMode="decimal" step="any" value={numericValue} onChange={(event) => setNumericValue(event.target.value)} required /></label>
            <label className="field-label">측정 단위<input value={unit} onChange={(event) => setUnit(event.target.value)} placeholder="측정기 표시 단위" required /></label>
          </>}
          {eventType === 'weight' && <>
            <label className="field-label">측정값<input type="number" inputMode="decimal" step="any" value={numericValue} onChange={(event) => setNumericValue(event.target.value)} required /></label>
            <label className="field-label">측정 단위<input value={unit} onChange={(event) => setUnit(event.target.value)} placeholder="예: kg" required /></label>
          </>}
          {eventType === 'meal' && <>
            <label className="field-label">관찰한 식사 상태
              <select value={mealStatus} onChange={(event) => setMealStatus(event.target.value)} required>
                <option value="">선택하세요</option><option value="ATE">섭취 확인</option>
                <option value="PARTIAL">일부 섭취 보고</option><option value="REFUSED">식사 거부 보고</option>
              </select>
              <small>수량 기준이나 임상 판단을 적용하지 않습니다.</small>
            </label>
            <label className="field-label">실제 섭취량 (선택)<input type="number" inputMode="decimal" step="any" value={numericValue} onChange={(event) => setNumericValue(event.target.value)} /></label>
            <label className="field-label">섭취량 단위 (선택)<input value={unit} onChange={(event) => setUnit(event.target.value)} placeholder="보호자가 확인한 단위" /></label>
          </>}
          {eventType === 'water' && <>
            <label className="field-label">관찰한 음수량 (선택)<input type="number" inputMode="decimal" step="any" value={numericValue} onChange={(event) => setNumericValue(event.target.value)} /></label>
            <label className="field-label">단위 (선택)<input value={unit} onChange={(event) => setUnit(event.target.value)} /></label>
          </>}
          {eventType === 'elimination' && <label className="field-label">관찰한 유형
            <select value={eliminationType} onChange={(event) => setEliminationType(event.target.value)} required>
              <option value="">선택하세요</option><option value="URINATION">배뇨</option>
              <option value="BOWEL_MOVEMENT">배변</option><option value="BOTH">배변·배뇨 모두</option>
            </select>
          </label>}
          {eventType === 'exercise' && <>
            <label className="field-label">실제 활동 시간 (선택)<input type="number" inputMode="decimal" min="0" step="any" value={numericValue} onChange={(event) => setNumericValue(event.target.value)} /><small>운동 강도나 적정성은 판단하지 않습니다.</small></label>
            <label className="field-label">활동 내용 (선택)<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="예: 산책" /></label>
          </>}
          {eventType === 'insulin' && <>
            <label className="field-label">연결할 예정 일정 (선택)
              <select value={occurrenceId} onChange={(event) => setOccurrenceId(event.target.value)}>
                <option value="">일정 연결 안 함</option>
                {occurrences.filter((occurrence) => occurrence.event_type === eventType).map((occurrence) => <option key={occurrence.id} value={occurrence.id}>
                  {occurrence.scheduled_local_date} · {occurrence.scheduled_local_time.slice(0, 5)} · {occurrence.status === 'SCHEDULE_TIME_UNRESOLVED' ? '시각 확인 필요' : occurrence.occurrence_key}
                </option>)}
              </select>
              <small>시각이 가까운 일정에 자동 연결하지 않습니다.</small>
            </label>
            <div className="safety-check" role="status">
              {!occurrenceId && <><strong>일정 연결 없음</strong><p>중복 일정 조회를 할 수 없습니다. 이미 발생한 행위 기록은 제출할 수 있습니다.</p></>}
              {occurrenceId && preflight === 'checking' && <><strong>서버 일정 상태 확인 중</strong><p>확인 완료 전에는 투여 상태를 확정하지 않습니다.</p></>}
              {occurrenceId && preflight === 'unverified' && <><strong>UNVERIFIED · 서버 확인 실패</strong><p>최신 일정 상태를 확인하지 못했습니다. 실제 발생 사실만 기록할 수 있습니다.</p></>}
              {occurrenceId && preflight === 'verified' && <>
                <strong>{priorEvents.length ? '같은 일정에 투여 기록이 있습니다' : '현재 서버에서 연결 기록을 찾지 못했습니다'}</strong>
                <p>{priorEvents.length ? `${priorEvents.length}건의 기록을 확인했습니다. 중복 가능성을 표시하며 기록을 차단하지 않습니다.` : '기록이 없다는 뜻이며 실제 미실시를 의미하지 않습니다.'}</p>
                {priorEvents.map((item) => <small key={item.id}>{dateTimeInTimezone(item.occurred_at, pet.timezone)} · {actorLabel(item.actor_id, userId)}</small>)}
              </>}
              {occurrenceId && <p className="plan-status">계획 상태: {selectedApproval === 'CLINICIAN_CONFIRMED' ? '의료진 확인 상태로 표시됨' : selectedApproval ? '의료진 확인 상태가 아님' : '확인할 수 없음'} · 투여 적정성 승인이 아닙니다.</p>}
            </div>
            <label className="check-row"><input type="checkbox" checked={confirmedAlreadyOccurred}
              onChange={(event) => setConfirmedAlreadyOccurred(event.target.checked)} required />
              이미 실제로 발생한 투여 사실을 기록합니다.</label>
          </>}
          {eventType === 'symptom' && <p className="field-hint">증상이나 컨디션을 관찰한 표현 그대로 적어 주세요. 앱은 진단하거나 분류하지 않습니다.</p>}
          <label className="field-label full-field">메모 (선택)
            <textarea rows={3} maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)}
              placeholder={eventType === 'insulin' ? '실제 발생 시각 등 사실을 적어 주세요. 용량 입력은 없습니다.' : '관찰하거나 수행한 내용을 기록하세요'} />
            <small>{note.length}/1000</small>
          </label>
          {eventType !== 'insulin' && <label className="check-row"><input type="checkbox" checked={performedByMe} onChange={(event) => setPerformedByMe(event.target.checked)} />내가 직접 수행하거나 측정함</label>}
        </div>
        {formError && <p role="alert" className="inline-error">{formError}</p>}
        <button className={eventType === 'insulin' ? 'submit-button insulin-submit' : 'submit-button'}
          type="submit" disabled={saving || !online}>
          {saving ? '서버 확인 중…' : eventType === 'insulin' ? '이미 발생한 투여 사실 저장' : '기록 저장'}
        </button>
        {!online && <p className="small-note">오프라인에서는 서버 저장을 시도하지 않습니다. 입력은 확정 기록이 아닙니다.</p>}
      </section>
    </form>
  </main>;
}

function TimelinePage(props: {
  pet: Pet; events: HealthEvent[]; revisions: EventRevision[]; userId: string;
  dateFilter: string; setDateFilter: (value: string) => void; loading: boolean;
}) {
  const { pet, events, revisions, userId, dateFilter, setDateFilter, loading } = props;
  const dailyEvents = useMemo(() => events
    .filter((event) => localDateKey(event.occurred_at, pet.timezone) === dateFilter)
    .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at)), [events, pet.timezone, dateFilter]);

  return <main className="page-container timeline-page">
    <section className="page-heading"><p className="eyebrow">건강 기록</p><h1>하루 타임라인</h1>
      <p>{pet.name}의 실제 발생 시각을 {pet.timezone} 시간대로 보여줍니다.</p></section>
    <div className="timeline-filter"><label htmlFor="timeline-date">날짜 선택</label>
      <input id="timeline-date" type="date" value={dateFilter} onChange={(event) => setDateFilter(event.target.value)} /></div>
    {loading && <p role="status" className="load-state">서버에서 기록을 확인하고 있습니다…</p>}
    {!loading && dailyEvents.length === 0 && <section className="panel empty-panel">
      <span className="empty-illustration" aria-hidden="true">◷</span><h2>이 날짜에 서버 기록이 없습니다</h2>
      <p>기록이 없다는 사실은 실제 미실시를 뜻하지 않습니다.</p>
      <Link to="/record" className="button-link">실제 발생한 일 기록하기</Link>
    </section>}
    {dailyEvents.length > 0 && <ol className="timeline-list">{dailyEvents.map((event) => {
      const itemRevisions = revisions.filter((revision) => revision.event_id === event.id).sort((a, b) => a.revision_no - b.revision_no);
      const latest = itemRevisions[itemRevisions.length - 1];
      const icon = eventOptions.find((option) => option.type === event.event_type)?.icon ?? '•';
      return <li className="timeline-item" key={event.id}>
        <time className="timeline-time" dateTime={event.occurred_at}>{timeInTimezone(event.occurred_at, pet.timezone)}</time>
        <span className="event-icon" aria-hidden="true">{icon}</span>
        <article className="timeline-card">
          <div className="timeline-card-heading"><div><h2>{eventLabels[event.event_type] ?? event.event_type}</h2>
              <span className="actor-name">{actorLabel(event.actor_id, userId)}</span></div>
            <span className={latest?.revision_kind === 'VOID' ? 'event-status void' : latest ? 'event-status corrected' : 'event-status confirmed'}>
              {latest?.revision_kind === 'VOID' ? '무효 처리' : latest ? '정정 이력 있음' : '서버 확정'}
            </span></div>
          <p className="event-value">{formatEventValue(event)}</p>
          <p className="event-timestamp">실제 발생 {dateTimeInTimezone(event.occurred_at, pet.timezone)}</p>
          <p className="event-timestamp">서버 입력 {dateTimeInTimezone(event.recorded_at, pet.timezone)}</p>
          <details><summary>기록 상세와 이력</summary>
            <dl className="detail-list"><div><dt>기록 ID</dt><dd>{event.id}</dd></div>
              <div><dt>기록자 ID</dt><dd>{event.actor_id}</dd></div>
              <div><dt>실제 수행자</dt><dd>{event.performer_id ? actorLabel(event.performer_id, userId) : '지정되지 않음'}</dd></div>
              <div><dt>Occurrence</dt><dd>{event.occurrence_id ?? '연결 없음'}</dd></div>
              <div><dt>단위</dt><dd>{event.unit ?? '없음'}</dd></div>
            </dl>
            {itemRevisions.length > 0 ? <div className="revision-list"><h3>정정·무효화 이력</h3>
              {itemRevisions.map((revision) => <div className="revision-row" key={revision.id}>
                <strong>{revision.revision_no}. {revision.revision_kind === 'VOID' ? '무효화' : '정정'}</strong>
                <span>{revision.reason_code} · {dateTimeInTimezone(revision.recorded_at, pet.timezone)}</span>
                <code>{JSON.stringify(revision.patch)}</code>
              </div>)}</div> : <p className="small-note">정정 이력 없음</p>}
          </details>
        </article>
      </li>;
    })}</ol>}
    <p className="timeline-footnote">이 화면에는 서버 조회로 확인된 기록만 표시됩니다. 제출 중 입력이나 오프라인 초안은 서버 확정 기록으로 보이지 않습니다.</p>
  </main>;
}

function formatEventValue(event: HealthEvent) {
  const value = event.value ?? {};
  const pieces: string[] = [];
  if (typeof value.observed_value === 'number' || typeof value.observed_value === 'string') pieces.push(`${value.observed_value}${event.unit ? ` ${event.unit}` : ''}`);
  if (typeof value.meal_status === 'string') pieces.push(mealStatusLabel(value.meal_status));
  if (typeof value.observed_value === 'number' && value.meal_status) pieces.push(`섭취량 ${value.observed_value}${event.unit ? ` ${event.unit}` : ''}`);
  if (typeof value.observation_type === 'string') pieces.push(value.observation_type);
  if (typeof value.observed_value === 'number' && event.event_type === 'exercise') pieces.push(`활동 ${value.observed_value}${event.unit ?? ''}`);
  if (typeof value.activity_description === 'string') pieces.push(value.activity_description);
  if (typeof value.note === 'string') pieces.push(value.note);
  return pieces.length ? pieces.join(' · ') : event.event_type === 'insulin' ? '실제 투여 사실 기록' : '추가 입력 없음';
}
