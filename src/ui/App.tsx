import { weightSamples } from '../lib/weight-trends';
import { loadWeightTarget } from '../lib/weight-history';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
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
import { formatGlucoseValue, GLUCOSE_MEASUREMENT_CONDITIONS, GLUCOSE_UNIT, validateEventEntry, type EventEntryFields } from '../lib/event-entry';
import { isSupabaseConfigured, supabase, supabaseConfigurationError, userFacingError } from '../lib/supabase';
import { petInvalidationChannel, userAccessChannel } from '../lib/realtime';
import { InvitationAcceptPage, SharedCarePage } from './SharedCarePage';
import { NotificationsPage } from './NotificationsPage';
import { PwaExperience } from './PwaExperience';
import { HealthTrendsPage } from './HealthTrendsPage';
import { GlucoseSharePage } from './GlucoseSharePage';
import { effectiveGlucoseValue } from '../lib/health-trends';
import { authCallbackPurpose, authFailureMessage, authLinkErrorMessage, authRedirectTo, type AuthCallbackPurpose } from '../lib/auth-redirect';
import { detectBrowserTimezone, formatTimezoneLabel, timezoneOptionsFor } from '../lib/timezone';
import { RecordChoices } from './RecordControls';
import { PetProfileEditor } from './PetProfileEditor';
import { PetProfilePortrait } from './PetProfilePortrait';
import { persistPetProfile } from '../lib/pet-profile-persistence';
import { isPetAvatarId, type PetAvatarId } from '../lib/pet-profile';

type Pet = {
  id: string; household_id: string; name: string; timezone: string;
  profile_avatar_id?: string | null; profile_photo_object_path?: string | null; profile_revision?: number | null;
  default_insulin_product?: string | null;
  profileCanEdit?: boolean;
};
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
type SafetyResponse = {
  event_id: string;
  evaluation_id: string;
  evaluation_status: 'CURRENT' | 'STALE' | 'UNAVAILABLE' | 'NOT_APPLICABLE';
  result_codes: string[];
  recorded_at: string;
};

const eventOptions: { type: EventType; label: string; icon: string; short: string }[] = [
  { type: 'glucose', label: '혈당', icon: '◉', short: '측정값과 단위' },
  { type: 'insulin', label: '인슐린', icon: '↗', short: '이미 발생한 투여 기록' },
  { type: 'elimination', label: '배변·배뇨', icon: '⌖', short: '관찰한 내용' },
  { type: 'meal', label: '식사', icon: '◒', short: '식사와 실제 섭취' },
  { type: 'water', label: '음수', icon: '⌁', short: '관찰한 음수량' },
  { type: 'exercise', label: '운동 및 산책', icon: '⌁', short: '실제 활동' },
  { type: 'weight', label: '체중', icon: '◌', short: '측정값과 단위' },
  { type: 'symptom', label: '증상·컨디션', icon: '♡', short: '관찰한 상태' },
];
const primaryRecordTypes: EventType[] = ['glucose', 'insulin', 'elimination', 'meal'];
const coreTimelineTypes: EventType[] = primaryRecordTypes;
const rememberedLoginEmailKey = 'hanilog:remembered-login-email';
const commonInsulinProductLabels = ['캐니슐린', '프로진크', 'NPH', '글라진', '디터미르'];
const eventLabels = Object.fromEntries(eventOptions.map((option) => [option.type, option.label])) as Record<EventType, string>;
function RecordTypeIllustration({ type, className = '' }: { type: EventType; className?: string }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return <span className={`record-illustration record-illustration--${type} ${className}`} aria-hidden="true"><svg viewBox="0 0 32 32" focusable="false">
    {type === 'glucose' && <><path d="M16 3.5C12.4 8.7 7.3 14 7.3 20a8.7 8.7 0 1 0 17.4 0c0-6-5.1-11.3-8.7-16.5Z" fill="currentColor"/><path d="M12 20.5a4.2 4.2 0 0 0 4.2 4.2" fill="none" stroke="white" strokeWidth="1.7" strokeLinecap="round"/></>}
    {type === 'insulin' && <g transform="rotate(42 16 16)"><rect x="12" y="8" width="8" height="15" rx="1.5" {...common}/><path {...common} d="M11 8h10M16 3v5M13 4h6M16 23v5M14 28h4M12 12h3M12 15h3M12 18h3"/></g>}
    {type === 'meal' && <g transform="rotate(-38 16 16)" fill="currentColor"><rect x="14" y="7" width="4" height="18" rx="2"/><circle cx="11.5" cy="9.5" r="4.5"/><circle cx="20.5" cy="9.5" r="4.5"/><circle cx="11.5" cy="22.5" r="4.5"/><circle cx="20.5" cy="22.5" r="4.5"/></g>}
    {type === 'elimination' && <><path d="M7 25c-2.4 0-4-1.7-4-4.1 0-2.6 1.8-4.5 4.6-4.8-.6-1.1-.6-2.5.1-3.8.8-1.5 2.4-2.4 4.2-2.3-.2-2.1 1.1-4.1 3.2-4.8 2.8-.9 5.3.9 5.3 3.7 0 1.5-.8 2.8-2 3.7 3.1-.8 6 .1 7.6 2.2 2.6.1 4.3 2.1 4.3 4.7S28.5 25 26 25H7Z" fill="currentColor"/><path d="M12 18h.1M21 18h.1M14 21c1.2 1 3 1 4.2 0" fill="none" stroke="white" strokeWidth="1.7" strokeLinecap="round"/></>}
    {type === 'water' && <><path {...common} d="M12 5c-2.6 3.5-5 6.2-5 9a5 5 0 0 0 10 0c0-2.8-2.4-5.5-5-9Z"/><path {...common} d="M23 15c-1.8 2.4-3 4-3 6a4 4 0 0 0 8 0c0-2-1.2-3.6-3-6Z"/></>}
    {type === 'exercise' && <g fill="currentColor">
      <ellipse cx="7.6" cy="10.6" rx="2.7" ry="3.5" transform="rotate(-24 7.6 10.6)"/>
      <ellipse cx="13.2" cy="7.3" rx="2.8" ry="3.7" transform="rotate(-9 13.2 7.3)"/>
      <ellipse cx="19.1" cy="7.3" rx="2.8" ry="3.7" transform="rotate(9 19.1 7.3)"/>
      <ellipse cx="24.7" cy="10.6" rx="2.7" ry="3.5" transform="rotate(24 24.7 10.6)"/>
      <path d="M16 15c-3.8 0-6.9 3.6-7.8 7.1-.9 3.4 1.6 5.9 4.5 5.4 1.2-.2 2.1-.7 3.3-.7s2.1.5 3.3.7c2.9.5 5.4-2 4.5-5.4C22.9 18.6 19.8 15 16 15Z"/>
    </g>}
    {type === 'weight' && <><rect {...common} x="6" y="5" width="20" height="23" rx="4"/><path {...common} d="M12 12a4 4 0 0 1 8 0l-4 3-4-3Z"/></>}
    {type === 'symptom' && <path {...common} d="M16 27 5.5 17A7 7 0 0 1 16 7.7 7 7 0 0 1 26.5 17L16 27ZM7 16h5l2-4 4 9 2-5h5"/>}
  </svg></span>;
}
const localDateTimeNow = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const localDateTimeNowPrecise = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
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
  const demoMode = import.meta.env.VITE_DEMO_MODE === 'true';
  const stagingMode = import.meta.env.MODE === 'staging';
  const [session, setSession] = useState<Session | null>(null);
  const [sessionReady, setSessionReady] = useState(demoMode || !isSupabaseConfigured);
  const [authCallback, setAuthCallback] = useState<AuthCallbackPurpose | null>(() => authCallbackPurpose(window.location.search));
  const [authLinkMessage] = useState(() => {
    try {
      const storedMessage = window.sessionStorage.getItem('hanilog.auth-link-message');
      window.sessionStorage.removeItem('hanilog.auth-link-message');
      return storedMessage || authLinkErrorMessage(window.location.href);
    } catch {
      return authLinkErrorMessage(window.location.href);
    }
  });
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);

  useEffect(() => {
    if (demoMode || !supabase) return;
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
  }, [demoMode]);

  useEffect(() => {
    if (!sessionReady || (!authCallback && !authLinkMessage)) return;
    const callbackUrl = new URL(window.location.href);
    for (const key of ['auth_callback', 'code', 'error', 'error_code', 'error_description']) callbackUrl.searchParams.delete(key);
    if (callbackUrl.hash.startsWith('#/')) {
      const routePath = callbackUrl.hash.slice(1).split('?')[0];
      callbackUrl.hash = routePath;
    } else {
      callbackUrl.hash = '';
    }
    window.history.replaceState({}, document.title, `${callbackUrl.pathname}${callbackUrl.search}${callbackUrl.hash}`);
  }, [sessionReady, authCallback, authLinkMessage]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  const publicShareRoute = location.pathname.startsWith('/glucose-share/');
  if (!sessionReady && !publicShareRoute) return <DataLoadingPage title="로그인 상태를 확인하고 있어요" />;

  const requestedInvitePath = (location.state as { from?: unknown } | null)?.from;
  const postLoginPath = typeof requestedInvitePath === 'string' && requestedInvitePath.startsWith('/invite') ? requestedInvitePath : '/';

  return (
    <div className={publicShareRoute ? 'app-shell public-share-shell' : 'app-shell'}>
      <header className="topbar">
        <Link to="/" className="brand"><img src={`${import.meta.env.BASE_URL}paw.svg`} alt="" /> HaniLog</Link>
        {location.pathname.startsWith('/glucose-share/') && <span className="environment-badge">읽기 전용</span>}
        {stagingMode && <span className="environment-badge">STAGING · 합성 전용</span>}
        {demoMode && <span className="environment-badge">DEMO · 저장되지 않음</span>}
        {session && <button className="quiet-button" onClick={() => void supabase?.auth.signOut()}>로그아웃</button>}
      </header>
      <PwaExperience updatesOnly={location.pathname.startsWith('/glucose-share/')} />
      {!online && <div role="alert" className="offline-banner">서버 최신 상태를 확인할 수 없습니다. 기록은 서버 응답 전까지 확정되지 않습니다.</div>}
      <Routes>
        <Route path="/glucose-share/:token" element={<GlucoseSharePage />} />
        {demoMode && <Route path="/*" element={<DemoWorkspace />} />}
        <Route path="/login" element={session ? <Navigate to={postLoginPath} replace /> : <Login initialMessage={authLinkMessage ?? ''} />} />
        <Route path="/*" element={authCallback === 'recovery'
          ? session
            ? <PasswordRecovery onComplete={() => setAuthCallback(null)} />
            : <Login initialMessage={authLinkMessage ?? '비밀번호 재설정 세션을 확인하지 못했습니다. 새 재설정 메일을 요청해 주세요.'} />
          : authCallback === 'confirm' && !session
            ? <Login initialMessage={authLinkMessage ?? '이메일 인증 링크 처리를 마쳤습니다. 승인된 Staging 계정으로 로그인해 주세요.'} />
            : session
              ? <Workspace userId={session.user.id} online={online} />
              : <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />} />
      </Routes>
      <footer>HaniLog는 실제 돌봄을 기록합니다.</footer>
    </div>
  );
}

const demoPetList: Pet[] = [
  { id: 'demo-pet-a', household_id: 'demo-household', name: '예시 반려견 A', timezone: 'Asia/Seoul', profile_avatar_id: 'dog-1', profileCanEdit: true },
  { id: 'demo-pet-momo', household_id: 'demo-household', name: '모모 (합성 예시)', timezone: 'Asia/Seoul', profile_avatar_id: 'dog-5', profileCanEdit: true },
];
const demoUserId = 'demo-caregiver-a';
const demoHouseholds = [{ id: 'demo-household', name: '데모 공동 돌봄 가정', role: 'PRIMARY_CAREGIVER' }];

type OnboardingDraft = { householdName: string; petName: string; petTimezone: string };
function readOnboardingDraft(userId: string): OnboardingDraft {
  try {
    const value = sessionStorage.getItem(`hanilog:onboarding-draft:${userId}`);
    if (value) {
      const parsed = JSON.parse(value) as Partial<OnboardingDraft>;
      return {
        householdName: typeof parsed.householdName === 'string' ? parsed.householdName : '',
        petName: typeof parsed.petName === 'string' ? parsed.petName : '',
        petTimezone: typeof parsed.petTimezone === 'string' ? parsed.petTimezone : detectBrowserTimezone(),
      };
    }
  } catch {
    // Storage may be unavailable in private browsing; in-memory onboarding still works.
  }
  return { householdName: '', petName: '', petTimezone: detectBrowserTimezone() };
}

function DemoWorkspace() {
  const location = useLocation();
  const [selectedPetId, setSelectedPetId] = useState(demoPetList[0].id);
  const [events, setEvents] = useState<HealthEvent[]>(() => createDemoEvents());
  const [demoRevisions, setDemoRevisions] = useState<EventRevision[]>([]);
  const [timelineSelection, setTimelineSelection] = useState({ petId: demoPetList[0].id, date: todayForTimezone('Asia/Seoul') });
  const pet = demoPetList.find((item) => item.id === selectedPetId) ?? demoPetList[0];
  const petEvents = events.filter((event) => event.pet_id === pet.id);
  const date = todayForTimezone(pet.timezone);
  const timelineDate = timelineSelection.petId === pet.id ? timelineSelection.date : date;

  async function addDemoEvent(fields: EventEntryFields, occurrenceId: string | null) {
    const validated = validateEventEntry(fields);
    if (!validated.value) return false;
    const event: HealthEvent = {
      id: crypto.randomUUID(), pet_id: pet.id, actor_id: demoUserId,
      performer_id: null, event_type: fields.eventType,
      occurred_at: validated.value.occurredAt, recorded_at: new Date().toISOString(),
      occurrence_id: occurrenceId, plan_version_id: null,
      value: validated.value.value, unit: validated.value.unit,
    };
    setEvents((current) => [event, ...current]);
    return true;
  }

  async function saveDemoExerciseEnd(eventId: string, endedAt: string, expectedRevision: number, durationSeconds: number) {
    const event = events.find((item) => item.id === eventId);
    if (!event || Date.parse(endedAt) <= Date.parse(event.occurred_at)) return false;
    const revisionNo = expectedRevision + 1;
    setEvents((current) => current.map((item) => item.id === eventId
      ? { ...item, value: { ...item.value, activity_ended_at: endedAt, activity_state: 'COMPLETED',
        activity_duration_seconds: durationSeconds, observed_value: Math.round(durationSeconds / 60 * 100) / 100 }, unit: '분' } : item));
    setDemoRevisions((current) => [...current, {
      id: crypto.randomUUID(), event_id: eventId, revision_no: revisionNo, revision_kind: 'CORRECT',
      patch: { value: { activity_ended_at: endedAt, activity_state: 'COMPLETED',
        activity_duration_seconds: durationSeconds, observed_value: Math.round(durationSeconds / 60 * 100) / 100 } }, reason_code: 'EXERCISE_END_TIME_CORRECTED',
      actor_id: demoUserId, recorded_at: new Date().toISOString(),
    }]);
    return true;
  }

  const noOpForm = (event: FormEvent<HTMLFormElement>) => event.preventDefault();
  return <>
    <div className="workspace-layout">
      <SessionNavigation key={`${location.pathname}${location.search}`} pathname={location.pathname} search={location.search}
        petSelector={<div className="pet-switcher"><label htmlFor="demo-nav-pet-switch">예시 반려동물</label>
          <select id="demo-nav-pet-switch" value={pet.id} onChange={(event) => setSelectedPetId(event.target.value)}>
            {demoPetList.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></div>} />
      <div className="workspace-content">
        <div className="notice notice-warning demo-banner" role="status">
          <strong>DEMO 모드 · 합성 정보만 사용</strong>
          <span>화면 흐름 확인용입니다. 기록 변경은 이 탭의 메모리에만 남고 새로고침하면 사라집니다. 서버·이메일·Push 전송은 연결되지 않습니다.</span>
        </div>
        <div className="workspace-bar">
          <div className="pet-switcher"><label htmlFor="demo-pet-switch">예시 반려동물</label>
            <select id="demo-pet-switch" value={pet.id} onChange={(event) => setSelectedPetId(event.target.value)}>
              {demoPetList.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
          <span className="small-note">인증·접근권한 검증은 수행하지 않음</span>
        </div>
        <Routes>
          <Route path="/login" element={<DemoLogin />} />
          <Route path="/" element={location.search !== '?profile=1' ? <Navigate to="/record" replace /> : <DashboardPage profileOnly pet={pet} petsCount={demoPetList.length} households={demoHouseholds}
            selectedHouseholdId={demoHouseholds[0].id} setSelectedHouseholdId={() => undefined}
            events={petEvents.filter((event) => localDateKey(event.occurred_at, pet.timezone) === date)} allEvents={petEvents}
            revisions={demoRevisions} userId={demoUserId}
            loading={false} dataMessage="DEMO 데이터 · 서버 조회 결과가 아닙니다." onCreateHousehold={noOpForm} onCreatePet={noOpForm}
            onRenameHousehold={async () => false}
            householdName="" setHouseholdName={() => undefined} petName="" setPetName={() => undefined}
            petTimezone={pet.timezone} setPetTimezone={() => undefined} creating={false} />} />
          <Route path="/record" element={<QuickRecordPage key={`${pet.id}:${location.search}`} pet={pet} presetEventType={new URLSearchParams(location.search).get('event') ?? undefined}
            events={petEvents} revisions={demoRevisions} online demoOnly onSubmit={addDemoEvent}
            onSaveExerciseEnd={saveDemoExerciseEnd} />} />
          <Route path="/timeline" element={<TimelinePage pet={pet} events={petEvents} revisions={demoRevisions} userId={demoUserId}
            dateFilter={timelineDate} setDateFilter={(value) => setTimelineSelection({ petId: pet.id, date: value })} loading={false}
            onSaveExerciseEnd={saveDemoExerciseEnd} />} />
          <Route path="/trends" element={<HealthTrendsPage pet={pet} userId={demoUserId} online demoEvents={petEvents} />} />
          <Route path="/care" element={<Navigate to="/timeline" replace />} />
          <Route path="/shared" element={<DemoSharedCarePage />} />
          <Route path="/notifications" element={<DemoNotificationsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  </>;
}

function DemoLogin() {
  return <main className="center-card login-card">
    <p className="eyebrow">로컬 화면 미리보기</p><h1>HaniLog Demo</h1>
    <p>계정 인증 없이 합성 데이터로 화면을 둘러봅니다. 로그인, 서버 권한 및 저장 기능은 작동하지 않습니다.</p>
    <Link className="button-link" to="/">데모 화면 열기</Link>
  </main>;
}

function createDemoEvents(): HealthEvent[] {
  const now = Date.now();
  return demoPetList.flatMap((pet, index) => {
    const offset = index * 11;
    const entries: { id: string; type: EventType; minutes: number; value: Record<string, unknown>; unit: string | null; occurrence?: string }[] = [
      { id: `demo-glucose-${index}`, type: 'glucose', minutes: 90 + offset, value: { observed_value: 164 }, unit: 'mg/dL' },
      { id: `demo-meal-${index}`, type: 'meal', minutes: 125 + offset, value: { meal_status: 'ATE' }, unit: null, occurrence: `demo-${pet.id}-am-meal` },
      { id: `demo-insulin-${index}`, type: 'insulin', minutes: 118 + offset, value: {}, unit: null, occurrence: `demo-${pet.id}-am-insulin` },
      { id: `demo-elimination-${index}`, type: 'elimination', minutes: 210 + offset, value: { observation_type: 'URINATION' }, unit: null },
    ];
    const history: { id: string; type: EventType; minutes: number; value: Record<string, unknown>; unit: string | null; occurrence?: string }[] = Array.from({ length: 90 }, (_, day) => ({
      id: `demo-glucose-history-${index}-${day}`, type: 'glucose' as EventType,
      minutes: (89 - day) * 1440 + 9 * 60 + offset,
      value: { observed_value: 130 + ((day * 7 + index * 11) % 55),
        measurement_source: '합성 예시 계측기', measurement_condition: day % 2 ? '식사 전 · 합성 설명용' : '미기록' },
      unit: 'mg/dL',
    }));
    return [...entries, ...history].map((item) => {
      const timestamp = new Date(now - item.minutes * 60_000).toISOString();
      return { id: item.id, pet_id: pet.id, actor_id: index ? 'demo-caregiver-b' : demoUserId,
        performer_id: index ? 'demo-caregiver-b' : demoUserId, event_type: item.type, occurred_at: timestamp,
        recorded_at: timestamp, occurrence_id: item.occurrence ?? null,
        plan_version_id: null, value: item.value, unit: item.unit };
    });
  });
}

function DemoSharedCarePage() {
  return <main className="page-container"><section className="page-heading"><p className="eyebrow">DEMO · 합성 정보</p><h1>가족 공간과 보호자</h1>
    <p>초대나 실제 권한 변경은 실행되지 않습니다.</p></section><section className="panel"><h2>데모 공동 돌봄 가정</h2>
      <ul className="household-pet-list">{demoPetList.map((pet) => <li key={pet.id}><PetProfilePortrait pet={pet} className="household-pet-portrait" /><strong>{pet.name}</strong></li>)}</ul>
      <ul className="member-list"><li><div className="member-heading"><strong>보호자 A · 주 보호자</strong><span>예시 사용자</span></div></li>
        <li><div className="member-heading"><strong>보호자 B · 공동 보호자</strong><span>예시 사용자</span></div></li></ul>
      <button type="button" disabled>초대 링크 발급 (데모 비활성)</button><p className="small-note">실제 Household 접근은 서버에서 검증되어야 합니다.</p></section></main>;
}

function DemoNotificationsPage() {
  const [enabled, setEnabled] = useState(false);
  return <main className="page-container"><section className="page-heading"><p className="eyebrow">DEMO · 전달 미연결</p><h1>알림 및 전달 설정</h1>
    <p>외부 Push와 이메일은 발송되지 않습니다.</p></section><section className="panel stack"><div className="notice notice-warning" role="status">공급자 연결 없음 · 알림 확인은 실제 수행을 뜻하지 않습니다.</div>
      <label className="check-row"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />화면 예시 설정 {enabled ? 'ON' : 'OFF'} (저장되지 않음)</label>
      <ul className="glance-list"><li className="glance-row"><div><strong>일정 안내</strong><small>일반 케어 안내 문구 예시</small></div></li>
        <li className="glance-row"><div><strong>기록 미확인 안내</strong><small>기록 없음은 실제 미수행을 뜻하지 않습니다.</small></div></li></ul></section></main>;
}

function Login({ initialMessage = '' }: { initialMessage?: string }) {
  const stagingMode = import.meta.env.MODE === 'staging';
  const [email, setEmail] = useState(() => {
    try { return window.localStorage.getItem(rememberedLoginEmailKey) ?? ''; } catch { return ''; }
  });
  const [rememberEmail, setRememberEmail] = useState(() => {
    try { return window.localStorage.getItem(rememberedLoginEmailKey) !== null; } catch { return false; }
  });
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState(initialMessage);
  const [busy, setBusy] = useState(false);
  const [creatingAccount, setCreatingAccount] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    if (!creatingAccount) {
      try {
        if (rememberEmail && email.trim()) window.localStorage.setItem(rememberedLoginEmailKey, email.trim());
        else window.localStorage.removeItem(rememberedLoginEmailKey);
      } catch { /* Storage may be unavailable; authentication should still proceed. */ }
    }
    setBusy(true);
    setMessage('');
    try {
      const result = creatingAccount
        ? await supabase.auth.signUp({ email, password, options: { emailRedirectTo: authRedirectTo('confirm') } })
        : await supabase.auth.signInWithPassword({ email, password });
      if (result.error) setMessage(authFailureMessage(result.error));
      else if (creatingAccount) setMessage('가입 요청을 처리했습니다. 이메일 인증이 필요한 경우 받은 편지함에서 최신 링크를 여세요.');
    } catch {
      setMessage(authFailureMessage(null));
    } finally {
      setBusy(false);
    }
  }

  async function resendConfirmation() {
    if (!supabase || !email.trim()) {
      setMessage('먼저 계정 이메일을 입력해 주세요.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email: email.trim(),
        options: { emailRedirectTo: authRedirectTo('confirm') },
      });
      setMessage(error ? authFailureMessage(error) : '재발송 요청을 처리했습니다. 미인증 계정이라면 새 메일을 확인해 주세요.');
    } catch {
      setMessage(authFailureMessage(null));
    } finally {
      setBusy(false);
    }
  }

  async function requestPasswordReset() {
    if (!supabase || !email.trim()) {
      setMessage('먼저 계정 이메일을 입력해 주세요.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: authRedirectTo('recovery'),
      });
      setMessage(error ? authFailureMessage(error) : '해당 이메일로 등록된 계정이 있다면 비밀번호 재설정 안내를 보냈습니다.');
    } catch {
      setMessage(authFailureMessage(null));
    } finally {
      setBusy(false);
    }
  }

  if (!isSupabaseConfigured) return (
    <main className="center-card">
      <p className="eyebrow">{stagingMode ? 'STAGING 연결 설정 필요' : '환경 설정 필요'}</p><h1>Supabase 연결 정보가 없습니다</h1>
      <p>{supabaseConfigurationError || <>로컬 <code>.env</code>에 Supabase URL과 Publishable Key를 설정하면 로그인할 수 있습니다.</>} 비밀키는 브라우저에 넣지 마세요.</p>
    </main>
  );

  return (
    <main className="center-card login-card">
      <p className="eyebrow">함께 돌보는 건강 기록</p><h1>반려동물의 하루를 기록해요</h1>
      <p>이메일과 비밀번호로 로그인하세요.</p>
      <form className="stack" onSubmit={(event) => void submit(event)}>
        <label>이메일<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label className="remember-email-control"><input type="checkbox" checked={rememberEmail} onChange={(event) => {
          const checked = event.target.checked;
          setRememberEmail(checked);
          try {
            if (checked && email.trim()) window.localStorage.setItem(rememberedLoginEmailKey, email.trim());
            else if (!checked) window.localStorage.removeItem(rememberedLoginEmailKey);
          } catch { /* Optional convenience only. */ }
        }} /> <span>이메일 기억하기 <small>이 기기에만 저장돼요. 비밀번호는 저장하지 않습니다.</small></span></label>
        <label>비밀번호<input type="password" autoComplete={creatingAccount ? 'new-password' : 'current-password'} required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <button disabled={busy}>{busy ? '확인 중…' : creatingAccount ? '계정 만들기' : '로그인'}</button>
        {!stagingMode && import.meta.env.MODE !== 'production' && <button type="button" className="secondary-action" onClick={() => { setCreatingAccount((current) => !current); setMessage(''); }}>
          {creatingAccount ? '이미 계정이 있어요' : '새 계정 만들기'}
        </button>}
        {message && <p role="alert" className="error-text">{message}</p>}
      </form>
      <div className="auth-help-actions">
        <button type="button" className="quiet-button" disabled={busy || !email.trim()} onClick={() => void requestPasswordReset()}>비밀번호 재설정 메일</button>
        <button type="button" className="quiet-button" disabled={busy || !email.trim()} onClick={() => void resendConfirmation()}>인증 메일 다시 보내기</button>
      </div>
      {stagingMode && <p className="small-note">Staging 테스트 계정은 Supabase Auth에서 승인된 사용자만 관리하세요. 이 화면은 계정 생성 기능을 제공하지 않습니다.</p>}
      <p className="small-note">공동 데이터 접근권한은 서버에서 별도로 확인합니다.</p>
    </main>
  );
}

function PasswordRecovery({ onComplete }: { onComplete: () => void }) {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function updatePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;
    if (password !== confirmation) {
      setMessage('비밀번호가 서로 일치하지 않습니다.');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) {
        setMessage(authFailureMessage(error));
        return;
      }
      onComplete();
      navigate('/', { replace: true });
    } catch {
      setMessage(authFailureMessage(null));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="center-card login-card">
      <p className="eyebrow">계정 보안</p><h1>새 비밀번호 설정</h1>
      <p>이메일 재설정 링크로 확인된 세션에서만 비밀번호를 변경할 수 있습니다.</p>
      <form className="stack" onSubmit={(event) => void updatePassword(event)}>
        <label>새 비밀번호<input type="password" autoComplete="new-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <label>새 비밀번호 확인<input type="password" autoComplete="new-password" required value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></label>
        <button disabled={busy}>{busy ? '저장 중…' : '비밀번호 변경'}</button>
        {message && <p role="alert" className="error-text">{message}</p>}
      </form>
      <p className="small-note">만료되었거나 이미 사용한 링크라면 로그인 화면에서 새 재설정 메일을 요청하세요.</p>
    </main>
  );
}

function Workspace({ userId, online }: { userId: string; online: boolean }) {
  const location = useLocation();
  const [pets, setPets] = useState<Pet[]>([]);
  const [households, setHouseholds] = useState<{ id: string; name: string; role: string }[]>([]);
  const [selectedHouseholdId, setSelectedHouseholdId] = useState('');
  const [selectedPetId, setSelectedPetId] = useState('');
  const [loadedPetId, setLoadedPetId] = useState('');
  const [events, setEvents] = useState<HealthEvent[]>([]);
  const [revisions, setRevisions] = useState<EventRevision[]>([]);
  const [, setSyncAt] = useState<string | null>(null);
  const [healthRefreshVersion, setHealthRefreshVersion] = useState(0);
  const [loadingPets, setLoadingPets] = useState(true);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [accessMessage, setAccessMessage] = useState('');
  const [dataMessage, setDataMessage] = useState('');
  const [recordNotice, setRecordNotice] = useState<{ kind: 'success' | 'error' | 'unverified'; text: string } | null>(null);
  const [, setRealtimeStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [householdName, setHouseholdName] = useState(() => readOnboardingDraft(userId).householdName);
  const [petName, setPetName] = useState(() => readOnboardingDraft(userId).petName);
  const [petTimezone, setPetTimezone] = useState(() => readOnboardingDraft(userId).petTimezone);
  const [petProfileDraft, setPetProfileDraft] = useState<{ avatarId: PetAvatarId; photo: Blob | null }>({ avatarId: 'dog-1', photo: null });
  const [creating, setCreating] = useState(false);
  const [dateSelection, setDateSelection] = useState({ petId: '', value: '' });
  const pendingCommand = useRef<HealthEventCommand | null>(null);
  const selectedPetIdRef = useRef('');
  const selectedPet = pets.find((pet) => pet.id === selectedPetId) ?? null;
  const requestedTimelineDate = new URLSearchParams(location.search).get('date');
  const dateFilter = selectedPet
    ? dateSelection.petId === selectedPet.id ? dateSelection.value
      : location.pathname === '/timeline' && requestedTimelineDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedTimelineDate)
        ? requestedTimelineDate : todayForTimezone(selectedPet.timezone)
    : '';
  const setDateFilter = (value: string) => {
    if (selectedPet) setDateSelection({ petId: selectedPet.id, value });
  };
  const dataReady = Boolean(selectedPetId && loadedPetId === selectedPetId);

  useEffect(() => {
    try {
      sessionStorage.setItem(`hanilog:onboarding-draft:${userId}`, JSON.stringify({ householdName, petName, petTimezone }));
    } catch {
      // Draft persistence is best-effort and never treated as a server-confirmed record.
    }
  }, [userId, householdName, petName, petTimezone]);

  useEffect(() => { selectedPetIdRef.current = selectedPetId; }, [selectedPetId]);

  useEffect(() => {
    const handleOffline = () => {
      pendingCommand.current = null;
      setEvents([]); setRevisions([]);
      setLoadedPetId(''); setSyncAt(null);
      setDataMessage('UNVERIFIED · 오프라인 상태에서는 최신 서버 기록을 표시할 수 없습니다.');
    };
    window.addEventListener('offline', handleOffline);
    return () => window.removeEventListener('offline', handleOffline);
  }, []);

  const refreshPets = useCallback(async () => {
    if (!supabase) return false;
    setLoadingPets(true);
    const [petResult, householdResult, membershipResult, grantResult] = await Promise.all([
      supabase.from('pets').select('id,household_id,name,timezone,profile_avatar_id,profile_photo_object_path,profile_revision,default_insulin_product').order('created_at', { ascending: true }),
      supabase.from('households').select('id,name').order('created_at', { ascending: true }),
      supabase.from('household_memberships').select('household_id,role').eq('user_id', userId).eq('status', 'ACTIVE'),
      supabase.from('pet_access_grants').select('pet_id,access_role').eq('user_id', userId).eq('status', 'ACTIVE'),
    ]);
    if (petResult.error || householdResult.error || membershipResult.error || grantResult.error) {
      const error = petResult.error ?? householdResult.error ?? membershipResult.error ?? grantResult.error;
      setAccessMessage(errorCode(error) === '42501'
        ? '현재 계정의 접근권한을 확인할 수 없습니다.'
        : 'Pet 목록을 서버에서 확인하지 못했습니다. 연결 후 다시 시도해 주세요.');
      setLoadingPets(false);
      return false;
    }
    const roleByHousehold = new Map((membershipResult.data ?? []).map((membership) => [membership.household_id, membership.role]));
    const grantsByPet = new Map((grantResult.data ?? []).map((grant) => [grant.pet_id, grant.access_role]));
    const nextPets = (petResult.data ?? []).map((pet) => ({
      ...pet,
      profileCanEdit: ['PRIMARY_CAREGIVER', 'CAREGIVER'].includes(roleByHousehold.get(pet.household_id) ?? '')
        && grantsByPet.get(pet.id) === 'CAREGIVER',
    })) as Pet[];
    setPets(nextPets);
    const nextHouseholds = (householdResult.data ?? []).map((household) => ({
      ...household,
      role: roleByHousehold.get(household.id) ?? 'READ_ONLY',
    }));
    setHouseholds(nextHouseholds);
    setSelectedHouseholdId((current) => nextHouseholds.some((household) => household.id === current)
      ? current : nextHouseholds[0]?.id ?? '');
    setAccessMessage('');
    const previousPetId = selectedPetIdRef.current;
    if (previousPetId && !nextPets.some((pet) => pet.id === previousPetId)) {
      pendingCommand.current = null;
      setEvents([]);
      setRevisions([]);
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
  }, [userId]);

  const refreshPetData = useCallback(async (petId: string) => {
    if (!supabase || !petId) return false;
    setLoadingEvents(true);
    const eventResult = await supabase.from('health_events')
        .select('id,pet_id,actor_id,performer_id,event_type,occurred_at,recorded_at,occurrence_id,plan_version_id,value,unit')
        .eq('pet_id', petId).order('occurred_at', { ascending: false }).limit(120);
    if (eventResult.error) {
      const error = eventResult.error;
      setEvents([]);
      setRevisions([]);
      setLoadedPetId(petId);
      setDataMessage(errorCode(error) === '42501'
        ? '접근권한이 변경됐습니다. Pet 목록을 새로 확인해 주세요.'
        : '서버 기록을 불러오지 못했습니다. 최신 상태는 확인되지 않았습니다.');
      setLoadingEvents(false);
      return false;
    }
    const nextEvents = (eventResult.data ?? []) as HealthEvent[];
    setEvents(nextEvents);
    const eventIds = nextEvents.map((item) => item.id);
    const revisionResult = eventIds.length
        ? await supabase.from('health_event_revisions')
          .select('id,event_id,revision_no,revision_kind,patch,reason_code,actor_id,recorded_at')
          .in('event_id', eventIds)
        : { data: [], error: null };
    setRevisions((revisionResult.data ?? []) as EventRevision[]);
    setLoadedPetId(petId);
    setDataMessage(revisionResult.error
      ? '기록은 불러왔지만 일부 정정 이력을 확인하지 못했습니다.'
      : '');
    setSyncAt(new Date().toISOString());
    setHealthRefreshVersion((version) => version + 1);
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
      setEvents([]); setRevisions([]);
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
      refreshTimer = window.setTimeout(() => {
        void refreshPetData(selectedPetId);
        void refreshPets();
      }, 120);
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
  }, [selectedPetId, refreshPetData, refreshPets]);

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
    if (error) {
      setDataMessage(errorCode(error) === '42501' ? '가족 공간을 만들 권한이 없습니다.' : userFacingError(error));
      // A timed-out response may still have committed server-side; re-read before allowing another create.
      await refreshPets();
    }
    else {
      setHouseholdName('');
      setDataMessage('함께 돌보는 가족 공간을 만들었습니다.');
      await refreshPets();
    }
    setCreating(false);
  }

  async function renameHousehold(householdId: string, name: string): Promise<boolean> {
    if (!supabase || !householdId || !name.trim()) return false;
    setCreating(true);
    const { error } = await supabase.rpc('rename_household', {
      p_household_id: householdId,
      p_name: name.trim(),
    });
    if (error) {
      setDataMessage(errorCode(error) === '42501'
        ? '가족 공간 이름을 바꿀 권한이 없습니다. 주 보호자에게 요청해 주세요.'
        : '가족 공간 이름을 저장하지 못했습니다. 다시 확인해 주세요.');
      setCreating(false);
      return false;
    }
    setDataMessage('가족 공간 이름을 변경했습니다.');
    const refreshed = await refreshPets();
    setCreating(false);
    return refreshed;
  }

  async function createPet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selectedHousehold = households.find((household) => household.id === selectedHouseholdId);
    if (!supabase || !selectedHousehold || !petName.trim() || !petTimezone.trim()) return;
    setCreating(true);
    const { data, error } = await supabase.rpc('create_pet', {
      p_household_id: selectedHousehold.id,
      p_name: petName.trim(),
      p_timezone: petTimezone.trim(),
    });
    if (error) setDataMessage(errorCode(error) === '42501'
      ? '현재 가족 공간에 반려동물을 등록할 권한이 없습니다.'
      : 'Pet을 등록하지 못했습니다. 이름과 IANA 시간대를 확인해 주세요.');
    else {
      let profileSaved = true;
      if (typeof data === 'string' && (petProfileDraft.avatarId !== 'dog-1' || petProfileDraft.photo)) {
        try {
          await persistPetProfile(supabase, {
            petId: data, avatarId: petProfileDraft.avatarId, revision: 0, photo: petProfileDraft.photo,
          });
        } catch {
          profileSaved = false;
        }
      }
      setPetName('');
      setPetTimezone(detectBrowserTimezone());
      setPetProfileDraft({ avatarId: 'dog-1', photo: null });
      try { sessionStorage.removeItem(`hanilog:onboarding-draft:${userId}`); } catch { /* Draft storage is optional. */ }
      setDataMessage(profileSaved
        ? '반려동물을 등록하고 선택한 프로필을 서버에서 확인했습니다.'
        : '반려동물은 등록됐지만 프로필 저장은 확인되지 않았어요. Dashboard에서 다시 저장할 수 있습니다.');
      await refreshPets();
      if (typeof data === 'string') setSelectedPetId(data);
    }
    setCreating(false);
  }

  async function submitHealthEvent(fields: EventEntryFields, occurrenceId: string | null): Promise<boolean> {
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
      performerId: null,
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

  async function savePetInsulinProduct(product: string): Promise<boolean> {
    if (!supabase || !selectedPet || !selectedPet.profileCanEdit || !online) return false;
    const { error } = await supabase.rpc('update_pet_default_insulin_product', {
      p_pet_id: selectedPet.id,
      p_product: product.trim(),
    });
    if (error) {
      setRecordNotice({ kind: 'error', text: userFacingError(error) });
      return false;
    }
    setRecordNotice({ kind: 'success', text: '반려동물의 기본 인슐린 제품을 서버에서 확인했습니다.' });
    await refreshPets();
    return true;
  }

  async function saveExerciseEnd(eventId: string, endedAt: string, expectedRevision: number, durationSeconds: number): Promise<boolean> {
    if (!supabase || !online) return false;
    const { error } = await supabase.rpc('revise_health_event', {
      p_event_id: eventId,
      p_expected_revision: expectedRevision,
      p_revision_kind: 'CORRECT',
      p_patch: { value: { activity_ended_at: endedAt, activity_state: 'COMPLETED',
        activity_duration_seconds: durationSeconds, observed_value: Math.round(durationSeconds / 60 * 100) / 100 } },
      p_reason_code: 'EXERCISE_END_TIME_CORRECTED',
      p_idempotency_key: crypto.randomUUID(),
    });
    if (error) {
      setRecordNotice({ kind: 'error', text: error.code === '40001' ? '다른 보호자가 기록을 먼저 수정했습니다. 최신 기록을 다시 확인해 주세요.' : userFacingError(error) });
      return false;
    }
    if (selectedPet) await refreshPetData(selectedPet.id);
    return true;
  }

  async function reviseTimelineEvent(eventId: string, expectedRevision: number, kind: 'CORRECT' | 'VOID', patch: Record<string, unknown>): Promise<boolean> {
    if (!supabase || !online || !selectedPet) return false;
    const { error } = await supabase.rpc('revise_health_event', {
      p_event_id: eventId, p_expected_revision: expectedRevision, p_revision_kind: kind,
      p_patch: patch, p_reason_code: kind === 'VOID' ? 'USER_ENTRY_VOIDED' : 'USER_ENTRY_CORRECTED',
      p_idempotency_key: crypto.randomUUID(),
    });
    if (error) {
      setRecordNotice({ kind: 'error', text: error.code === '40001' ? '다른 보호자가 먼저 수정했습니다. 새로 조회한 뒤 다시 시도해 주세요.' : userFacingError(error) });
      return false;
    }
    await refreshPetData(selectedPet.id);
    setRecordNotice({ kind: 'success', text: kind === 'VOID' ? '기록을 무효화했습니다. 감사 이력은 보존됩니다.' : '정정 내용을 서버에 저장했습니다.' });
    return true;
  }

  async function correctTimelineTime(eventId: string, expectedRevision: number, occurredAt: string): Promise<boolean> {
    if (!supabase || !online || !selectedPet) return false;
    const { error } = await supabase.rpc('correct_health_event_time', {
      p_event_id: eventId, p_expected_revision: expectedRevision, p_occurred_at: occurredAt,
      p_idempotency_key: crypto.randomUUID(),
    });
    if (error) {
      setRecordNotice({ kind: 'error', text: error.code === '40001' ? '다른 보호자가 먼저 수정했습니다. 최신 기록을 확인해 주세요.' : userFacingError(error) });
      return false;
    }
    await refreshPetData(selectedPet.id);
    setRecordNotice({ kind: 'success', text: '실제 발생 시각을 정정했습니다. 이전 시각은 감사 이력에 보존됩니다.' });
    return true;
  }

  const todayEvents = useMemo(() => selectedPet && dataReady
    ? events.filter((item) => localDateKey(item.occurred_at, selectedPet.timezone) === todayForTimezone(selectedPet.timezone))
    : [], [events, selectedPet, dataReady]);

  if (online && ((loadingPets && pets.length === 0) || (selectedPet && loadedPetId !== selectedPet.id))) {
    return <DataLoadingPage title="반려동물 기록을 불러오고 있어요" />;
  }

  return (
    <div className="workspace-layout">
      <SessionNavigation key={`${location.pathname}${location.search}`} pathname={location.pathname} search={location.search}
        petSelector={pets.length > 0 ? <div className="pet-switcher"><label htmlFor="nav-pet-switch">현재 반려동물</label>
          <select id="nav-pet-switch" value={selectedPetId} onChange={(event) => {
            pendingCommand.current = null; setRecordNotice(null); setSelectedPetId(event.target.value);
          }}>{pets.map((pet) => <option value={pet.id} key={pet.id}>{pet.name}</option>)}</select>
          {selectedPet && <PetProfilePortrait pet={selectedPet} className="nav-pet-portrait" />}
        </div> : undefined} />
      <div className="workspace-content">
      <div className="workspace-bar">
        {pets.length > 0 ? <div className="pet-switcher">
          <label htmlFor="pet-switch">현재 반려동물</label>
          <select id="pet-switch" aria-label="반려동물 선택" value={selectedPetId} onChange={(event) => {
            pendingCommand.current = null;
            setRecordNotice(null);
            setSelectedPetId(event.target.value);
          }}>
            {pets.map((pet) => <option value={pet.id} key={pet.id}>{pet.name}</option>)}
          </select>
        </div> : <p className="workspace-empty-status" role="status">
          {loadingPets ? '반려동물 목록을 확인하고 있어요' : accessMessage ? '반려동물 접근 상태를 확인해 주세요' : '반려동물 등록을 시작해 주세요'}
        </p>}
        <button className="refresh-button" type="button" disabled={!online || loadingPets || loadingEvents} onClick={() => void refreshAll()}>
          {loadingPets || loadingEvents ? '확인 중…' : pets.length ? '새로고침' : '다시 확인'}
        </button>
      </div>
      {accessMessage && <div role="alert" className="notice notice-warning">{accessMessage}</div>}
      {dataMessage && !loadingPets && !loadingEvents && <div role="status" className="notice notice-warning">{dataMessage}</div>}
      {recordNotice && <div role={recordNotice.kind === 'error' || recordNotice.kind === 'unverified' ? 'alert' : 'status'}
        className={`notice ${recordNotice.kind === 'success' ? 'notice-success' : 'notice-warning'}`}>{recordNotice.text}</div>}
      {!online && recordNotice?.kind !== 'unverified' && <div role="status" className="notice notice-warning">
        서버 최신 상태 확인 불가 · 과거 기록이 현재 상태를 보증하지 않습니다.
      </div>}

      <Routes>
        <Route path="/invite" element={<InvitationAcceptPage />} />
        <Route path="/" element={selectedPet && !loadingPets && location.search !== '?profile=1' ? <Navigate to="/record" replace /> : <DashboardPage profileOnly={location.search === '?profile=1'}
          pet={selectedPet} petsCount={pets.length} households={households} selectedHouseholdId={selectedHouseholdId} setSelectedHouseholdId={setSelectedHouseholdId}
          onRenameHousehold={renameHousehold}
          events={todayEvents} allEvents={dataReady ? events : []} revisions={dataReady ? revisions : []}
          userId={userId}
          loading={loadingPets || loadingEvents} dataMessage={dataMessage} accessMessage={accessMessage}
          onCreateHousehold={createHousehold} onCreatePet={createPet}
          petProfileDraft={petProfileDraft} onPetProfileDraftChange={setPetProfileDraft}
          onPetProfileSaved={async () => { await refreshPets(); }}
          householdName={householdName} setHouseholdName={setHouseholdName}
          petName={petName} setPetName={setPetName} petTimezone={petTimezone} setPetTimezone={setPetTimezone}
          creating={creating}
        />} />
        <Route path="/timeline" element={!selectedPet
          ? <SetupPrompt loading={loadingPets} accessMessage={accessMessage} />
          : <TimelinePage pet={selectedPet} events={dataReady ? events : []} revisions={dataReady ? revisions : []} userId={userId}
            dateFilter={dateFilter} setDateFilter={setDateFilter} loading={loadingEvents} onSaveExerciseEnd={saveExerciseEnd} onReviseEvent={reviseTimelineEvent} onCorrectTime={correctTimelineTime} />} />
        <Route path="/trends" element={!selectedPet ? <SetupPrompt loading={loadingPets} accessMessage={accessMessage} />
          : online && !dataReady ? <DataLoadingPage title="혈당 기록을 불러오고 있어요" /> : <HealthTrendsPage key={selectedPet.id} pet={selectedPet} userId={userId} online={online && dataReady} refreshVersion={healthRefreshVersion} onSaveWeightTarget={(eventId, expectedRevision, value) => reviseTimelineEvent(eventId, expectedRevision, 'CORRECT', { value })} onReviseWeight={reviseTimelineEvent} />} />
        <Route path="/care" element={<Navigate to="/timeline" replace />} />
        <Route path="/shared" element={<SharedCarePage key={households.map((item) => item.id).join(':')} households={households} pets={pets} userId={userId} onRenameHousehold={renameHousehold} />} />
        <Route path="/notifications" element={<NotificationsPage key={`${userId}:${selectedPetId}:${pets.map((pet) => pet.id).join(':')}`} pets={pets} userId={userId} online={online} />} />
        <Route path="/record" element={!selectedPet
          ? <SetupPrompt loading={loadingPets} accessMessage={accessMessage} />
          : <QuickRecordPage key={`${selectedPet.id}:${location.search}`} pet={selectedPet}
            events={dataReady ? events : []} revisions={dataReady ? revisions : []}
            online={online}
            presetEventType={new URLSearchParams(location.search).get('event') ?? undefined}
            onSubmit={submitHealthEvent} onSaveExerciseEnd={saveExerciseEnd}
            onSaveInsulinDefault={selectedPet.profileCanEdit ? savePetInsulinProduct : undefined} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      </div>
    </div>
  );
}

function DataLoadingPage({ title }: { title: string }) {
  return <main className="page-container trends-loading-page" role="status" aria-live="polite" aria-busy="true">
    <div className="loading-spinner" aria-hidden="true" /><h1>{title}</h1>
    <p>서버에서 최신 정보를 확인하고 있습니다.</p>
  </main>;
}

function SessionNavigation({ pathname, search, petSelector }: { pathname: string; search: string; petSelector?: ReactNode }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const desktopItems = [
    { to: '/trends', label: '혈당 기록', icon: 'glucose' },
    { to: '/timeline', label: '하루 타임라인', icon: '◷' },
    { to: '/record', label: '빠른 기록', icon: '+' },
    { to: '/?profile=1', label: '반려동물 설정', icon: '🐾' },
    { to: '/shared', label: '가족 공간과 보호자', icon: '♡' },
    { to: '/notifications', label: '알림 및 전달 설정', icon: '♧' },
  ];
  const secondaryItems = [
    { to: '/?profile=1', label: '반려동물 설정', icon: '🐾' },
    { to: '/timeline', label: '하루 타임라인', icon: '◷' },
    { to: '/shared', label: '가족 공간과 보호자', icon: '♡' },
    { to: '/notifications', label: '알림 및 전달 설정', icon: '♧' },
  ];
  const primaryItems = [
    { to: '/trends', label: '혈당 기록', icon: 'glucose' },
    { to: '/record', label: '빠른 기록', icon: '+' },
  ];
  useEffect(() => {
    const resetAtDesktop = () => {
      if (window.matchMedia('(min-width: 900px)').matches) setMoreOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false);
    };
    window.addEventListener('resize', resetAtDesktop);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('resize', resetAtDesktop);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [pathname]);
  const linkFor = (item: { to: string; label: string; icon: string }) => {
      const active = item.to.startsWith('/?') ? pathname === '/' && search === item.to.slice(1)
        : item.to === '/' ? pathname === '/' : pathname.startsWith(item.to);
      return <NavLink key={item.to} to={item.to} onClick={() => {
        setMoreOpen(false);
        if (item.to === '/record') window.scrollTo({ top: 0, behavior: 'smooth' });
      }} className={`${active ? 'nav-item active' : 'nav-item'}${item.to === '/record' ? ' nav-record' : ''}`} aria-current={active ? 'page' : undefined}>
        {item.icon === 'glucose' ? <RecordTypeIllustration type="glucose" className="nav-glucose-icon" /> : <span className="nav-icon" aria-hidden="true">{item.icon}</span>}<span>{item.label}</span>
      </NavLink>;
  };
  const activeSecondary = secondaryItems.some((item) => item.to.startsWith('/?')
    ? pathname === '/' && search === item.to.slice(1) : pathname.startsWith(item.to));
  return <>
    {moreOpen && <button type="button" className="nav-menu-backdrop" aria-label="메뉴 닫기" onClick={() => setMoreOpen(false)} />}
    <nav className={`app-nav${moreOpen ? ' is-open' : ''}`} aria-label="주요 메뉴">
      {petSelector && <div className="nav-pet-selector">{petSelector}</div>}
      <div className="nav-desktop-list">{desktopItems.map(linkFor)}</div>
      <div className="nav-primary">{primaryItems.map(linkFor)}
        <button type="button" className={`nav-more-toggle${activeSecondary ? ' active' : ''}`} aria-expanded={moreOpen}
          aria-controls="nav-secondary-links" onClick={() => setMoreOpen((value) => !value)}>
          <span className="nav-icon" aria-hidden="true">⋯</span><span>더 보기</span>
        </button>
      </div>
      <div id="nav-secondary-links" className="nav-secondary" aria-label="추가 메뉴">{secondaryItems.map(linkFor)}</div>
    </nav>
  </>;
}

function SetupPrompt({ loading, accessMessage = '' }: { loading: boolean; accessMessage?: string }) {
  const title = loading ? '반려동물 정보를 확인하고 있어요'
    : accessMessage ? '반려동물 정보를 확인할 수 없어요' : '먼저 반려동물을 등록해 주세요';
  const detail = loading ? '서버에서 현재 접근 상태를 확인하고 있습니다.'
    : accessMessage ? `${accessMessage} 대시보드에서 다시 확인하거나 계정 관리자에게 문의해 주세요.`
      : '기록 화면을 열기 전에 등록된 반려동물을 선택해야 합니다.';
  return <main className="page-container">
    <section className="panel empty-panel"><span className="empty-illustration" aria-hidden="true">🐾</span>
      <h1>{title}</h1>
      <p>{detail}</p>
      <Link className="button-link" to="/">{accessMessage ? '대시보드에서 다시 확인' : '반려동물 등록으로 이동'}</Link>
    </section>
  </main>;
}

function DashboardPage(props: {
  profileOnly?: boolean;
  pet: Pet | null; petsCount: number; households: { id: string; name: string; role: string }[];
  selectedHouseholdId: string; setSelectedHouseholdId: (id: string) => void;
  onRenameHousehold: (householdId: string, name: string) => Promise<boolean>;
  events: HealthEvent[]; allEvents: HealthEvent[]; revisions: EventRevision[];
  userId: string;
  loading: boolean; dataMessage: string; accessMessage?: string;
  onCreateHousehold: (event: FormEvent<HTMLFormElement>) => void;
  onCreatePet: (event: FormEvent<HTMLFormElement>) => void;
  petProfileDraft?: { avatarId: PetAvatarId; photo: Blob | null };
  onPetProfileDraftChange?: (draft: { avatarId: PetAvatarId; photo: Blob | null }) => void;
  onPetProfileSaved?: () => Promise<void>;
  householdName: string; setHouseholdName: (value: string) => void;
  petName: string; setPetName: (value: string) => void;
  petTimezone: string; setPetTimezone: (value: string) => void; creating: boolean;
}) {
  const [reviewHousehold, setReviewHousehold] = useState(false);
  const {
    pet, petsCount, households, selectedHouseholdId, setSelectedHouseholdId, onRenameHousehold, events, allEvents, revisions, userId,
    loading, accessMessage = '', onCreateHousehold, onCreatePet, householdName, setHouseholdName,
    petName, setPetName, petTimezone, setPetTimezone, creating,
    petProfileDraft = { avatarId: 'dog-1', photo: null }, onPetProfileDraftChange, onPetProfileSaved,
  } = props;
  if (!pet && petsCount === 0 && !loading && accessMessage) return <SetupPrompt loading={false} accessMessage={accessMessage} />;
  if (!pet && petsCount === 0 && !loading) return <main className="page-container">
    <section className="hero-card setup-hero">
      <p className="eyebrow">처음 시작하기 · {households.length ? '2/2단계' : '1/2단계'}</p>
      <h1>우리 가족의 돌봄 기록을 시작해요</h1>
      <p>반려동물을 등록하면 가족과 기록을 함께 확인할 수 있어요. 권한과 저장은 서버에서 확인합니다.</p>
    </section>
    <ol className="onboarding-progress" aria-label="처음 설정 진행 단계">
      <li className={households.length ? 'complete' : 'current'} aria-current={households.length ? undefined : 'step'}>
        <span>1</span><span>가족 공간</span>{households.length > 0 && <small>완료</small>}
      </li>
      <li className={households.length ? 'current' : ''} aria-current={households.length ? 'step' : undefined}>
        <span>2</span><span>반려동물 등록</span>
      </li>
    </ol>
    <section className="panel setup-grid">
      {households.length === 0 && <form className="stack" onSubmit={onCreateHousehold}>
        <div className="step-title"><div className="step-number">01</div><h2>함께 돌보는 가족 공간 만들기</h2></div>
        <p className="small-note">가족 공간은 반려동물 기록을 함께 관리할 사람들을 묶어 줍니다.</p>
        <label>가족 공간 이름<input required maxLength={120} value={householdName} onChange={(event) => setHouseholdName(event.target.value)} placeholder="예: 우리 가족" /></label>
        <button type="submit" disabled={creating || !householdName.trim()}>{creating ? '저장 중…' : '다음'}</button>
      </form>}
      {households.length > 0 && (reviewHousehold ? <form className="stack onboarding-household-review" aria-labelledby="household-review-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (selectedHouseholdId) void onRenameHousehold(selectedHouseholdId, householdName).then((success) => {
            if (success) setReviewHousehold(false);
          });
        }}>
        <div className="step-title"><div className="step-number">01</div><h2 id="household-review-title">가족 공간 수정</h2></div>
        <p>이름을 바꾸면 이 가족 공간을 함께 사용하는 보호자에게도 변경 내용이 반영됩니다.</p>
        {households.length > 1 && <label>수정할 가족 공간
          <select value={selectedHouseholdId} onChange={(event) => {
            setSelectedHouseholdId(event.target.value);
            setHouseholdName(households.find((household) => household.id === event.target.value)?.name ?? '');
          }}>
            {households.map((household) => <option value={household.id} key={household.id}>{household.name}</option>)}
          </select>
        </label>}
        {households.find((household) => household.id === selectedHouseholdId)?.role === 'PRIMARY_CAREGIVER' ? <>
          <label>가족 공간 이름<input required maxLength={120} value={householdName} onChange={(event) => setHouseholdName(event.target.value)} /></label>
          <div className="onboarding-actions">
            <button type="button" className="secondary-action" onClick={() => setReviewHousehold(false)}>취소</button>
            <button type="submit" disabled={creating || !householdName.trim()}>{creating ? '저장 중…' : '이름 저장'}</button>
          </div>
        </> : <>
          <dl><div><dt>가족 공간 이름</dt><dd>{households.find((household) => household.id === selectedHouseholdId)?.name}</dd></div></dl>
          <p className="small-note">가족 공간 이름은 주 보호자만 바꿀 수 있어요.</p>
          <button type="button" onClick={() => setReviewHousehold(false)}>다음 · 반려동물 등록</button>
        </>}
      </form> : <form className="stack" onSubmit={onCreatePet}>
        <div className="step-title"><div className="step-number">02</div><h2>반려동물 등록</h2></div>
        {households.length > 1 && <label>어느 가족 공간에 등록할까요?
          <select value={selectedHouseholdId} onChange={(event) => setSelectedHouseholdId(event.target.value)} required>
            {households.map((household) => <option value={household.id} key={household.id}>{household.name}</option>)}
          </select>
        </label>}
        <p className="small-note">{households.length === 1
          ? `‘${households[0].name}’에서 함께 돌볼 반려동물을 등록합니다.`
          : `선택한 가족 공간 ‘${households.find((household) => household.id === selectedHouseholdId)?.name ?? ''}’에 등록합니다.`}</p>
        <label>반려동물 이름<input required maxLength={120} value={petName} onChange={(event) => setPetName(event.target.value)} /></label>
        <PetProfileEditor name={petName} onboarding avatarId={petProfileDraft.avatarId} onDraftChange={onPetProfileDraftChange} />
        <label>생활 지역 시간대
          <select required value={petTimezone} onChange={(event) => setPetTimezone(event.target.value)}>
            <option value="">시간대 선택</option>
            {timezoneOptionsFor(detectBrowserTimezone()).map((option) => <option value={option.value} key={option.value}>{option.label} · {option.value}</option>)}
          </select>
        </label>
        <p className="small-note">{petTimezone
          ? `${formatTimezoneLabel(petTimezone)}를 기준으로 날짜와 반복 일정을 표시합니다. ${petTimezone === detectBrowserTimezone() ? '기기 설정에서 자동으로 선택했으며' : '선택한'} 필요하면 변경할 수 있어요.`
          : '기기의 시간대를 확인하지 못했어요. 생활 지역을 직접 선택해 주세요.'}</p>
        <div className="onboarding-actions">
          <button type="button" className="secondary-action" onClick={() => {
            const currentHousehold = households.find((household) => household.id === selectedHouseholdId) ?? households[0];
            setSelectedHouseholdId(currentHousehold.id);
            setHouseholdName(currentHousehold.name);
            setReviewHousehold(true);
          }}>이전</button>
          <button type="submit" disabled={creating || !selectedHouseholdId || !petName.trim() || !petTimezone.trim()}>{creating ? '등록 중…' : '반려동물 등록'}</button>
        </div>
      </form>)}
    </section>
  </main>;
  if (!pet) return <SetupPrompt loading={loading} />;

  if (props.profileOnly) return <main className="page-container profile-page">
    <section className="page-heading"><p className="eyebrow">반려동물 설정</p><h1>{pet.name}의 프로필</h1></section>
    <PetProfileEditor key={pet.id} name={pet.name} petId={onPetProfileSaved ? pet.id : undefined}
      avatarId={isPetAvatarId(pet.profile_avatar_id) ? pet.profile_avatar_id : 'dog-1'}
      photoPath={onPetProfileSaved ? pet.profile_photo_object_path ?? null : null} revision={pet.profile_revision ?? 0}
      canEdit={pet.profileCanEdit ?? false} onProfileSaved={onPetProfileSaved} />
  </main>;

  const localToday = todayForTimezone(pet.timezone);
  const daily = events.filter((event) => localDateKey(event.occurred_at, pet.timezone) === localToday
    && latestRevision(revisions.filter((revision) => revision.event_id === event.id))?.revision_kind !== 'VOID');
  const recentGlucoseSeries = allEvents.filter((event) => event.event_type === 'glucose' && event.unit === GLUCOSE_UNIT
    && latestRevision(revisions.filter((revision) => revision.event_id === event.id))?.revision_kind !== 'VOID')
    .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
  const recentGlucose = recentGlucoseSeries.at(-1);
  const recentMeal = allEvents.find((event) => event.event_type === 'meal');
  const recentInsulin = allEvents.find((event) => event.event_type === 'insulin');

  const recentGlucoseRevision = recentGlucose ? latestRevision(revisions.filter((item) => item.event_id === recentGlucose.id)) : undefined;
  const recentGlucoseObserved = recentGlucose ? effectiveGlucoseValue(recentGlucose.value, recentGlucoseRevision?.patch) : null;
  const recentGlucoseValue = recentGlucose && (typeof recentGlucoseObserved === 'number' || typeof recentGlucoseObserved === 'string')
    ? formatGlucoseValue(recentGlucoseObserved, typeof recentGlucoseRevision?.patch.unit === 'string' ? recentGlucoseRevision.patch.unit : recentGlucose.unit) : null;

  return <main className="page-container dashboard-page">
    <PetProfileEditor key={pet.id} name={pet.name} petId={onPetProfileSaved ? pet.id : undefined}
      avatarId={isPetAvatarId(pet.profile_avatar_id) ? pet.profile_avatar_id : 'dog-1'}
      photoPath={onPetProfileSaved ? pet.profile_photo_object_path ?? null : null} revision={pet.profile_revision ?? 0}
      canEdit={pet.profileCanEdit ?? false} onProfileSaved={onPetProfileSaved} />
    <p className="journal-date">{dateInTimezone(new Date().toISOString(), pet.timezone)} · 오늘의 건강수첩</p>

    <div className="dashboard-grid">
      <div className="dashboard-primary">
        <section className="panel glucose-highlight" aria-label="최근 혈당 기록">
          <div className="section-heading"><div><p className="eyebrow">최근 혈당 기록</p><h2>측정 결과</h2></div><span className="unit-tag">mg/dL</span></div>
          {recentGlucose && recentGlucoseValue ? <><strong className="glucose-value">{recentGlucoseValue}</strong>
            <p className="glucose-meta">{dateTimeInTimezone(recentGlucose.occurred_at, pet.timezone)} · {actorLabel(recentGlucose.actor_id, userId)}</p>
          </> : <p className="empty glucose-empty">mg/dL로 확인 가능한 최근 혈당 기록이 없습니다.</p>}
          {recentGlucoseSeries.length > 1 && <MiniGlucoseTrend events={recentGlucoseSeries.slice(-8)} revisions={revisions} />}
          <div className="dashboard-glucose-links">
            <Link className="button-link" to="/trends?view=day">오늘 혈당 그래프</Link>
            <Link className="text-link" to="/trends">기간별 추세</Link>
          </div>
        </section>

        <section className="summary-grid" aria-label="오늘 건강 기록 요약">
          <SummaryCard title="오늘 등록된 기록" value={String(daily.length)} detail={daily.length ? '화면에 표시된 기록 수' : '기록 없음은 미실시가 아니에요'} icon="◷" />
        </section>

      </div>

      <div className="dashboard-secondary">
        <section className="panel quick-glance">
          <div className="section-heading"><div><p className="eyebrow">최근 건강 기록</p><h2>식사·인슐린 등</h2></div><Link to="/timeline">모두 보기</Link></div>
          <div className="glance-list">
            <GlanceRow title="최근 식사" event={recentMeal} pet={pet} revisions={revisions} userId={userId} />
            <GlanceRow title="최근 인슐린" event={recentInsulin} pet={pet} revisions={revisions} userId={userId} />
          </div>
          {loading && <p className="small-note" role="status">서버 기록을 확인하고 있습니다…</p>}
        </section>
      <p className="medical-note">Safety Guard는 서버에서 확인된 데이터 상태만 보여줍니다. 인슐린 투여를 승인하지 않습니다.</p>
      </div>
    </div>
  </main>;
}

function MiniGlucoseTrend({ events, revisions }: { events: HealthEvent[]; revisions: EventRevision[] }) {
  const valueFor = (event: HealthEvent) => Number(effectiveGlucoseValue(event.value,
    latestRevision(revisions.filter((revision) => revision.event_id === event.id))?.patch));
  const values = events.map(valueFor).filter(Number.isFinite);
  const times = events.map((event) => Date.parse(event.occurred_at));
  if (values.length < 2 || times.some((time) => !Number.isFinite(time))) return null;
  const min = Math.min(...values); const max = Math.max(...values);
  const firstTime = Math.min(...times); const lastTime = Math.max(...times);
  const y = (value: number) => max === min ? 25 : 42 - ((value - min) / (max - min)) * 34;
  const x = (time: number) => lastTime === firstTime ? 50 : 4 + ((time - firstTime) / (lastTime - firstTime)) * 92;
  return <div className="mini-trend" role="img" aria-label={`최근 ${events.length}개의 mg/dL 혈당 측정 점 미리보기. 점은 실제 측정값이며 선형 예측은 없습니다.`}>
    <svg viewBox="0 0 100 50" aria-hidden="true">{events.map((event) => <circle key={event.id}
      cx={x(Date.parse(event.occurred_at))} cy={y(valueFor(event))} r="2.5" />)}</svg>
    <span>최근 {events.length}회 실제 기록 · 미리보기</span>
  </div>;
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
    ? event.event_type === 'glucose' ? formatGlucoseValue(event.value.observed_value, event.unit) : `${event.value.observed_value}${event.unit ? ` ${event.unit}` : ''}`
    : typeof event.value.meal_status === 'string' ? mealStatusLabel(event.value.meal_status) : '상세 기록 보기';
  return <div className="glance-row"><RecordTypeIllustration type={event.event_type} className="glance-symbol" />
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
  pet: Pet; presetEventType?: string;
  events: HealthEvent[]; revisions: EventRevision[]; online: boolean; demoOnly?: boolean;
  onSubmit: (fields: EventEntryFields, occurrenceId: string | null) => Promise<boolean>;
  onSaveExerciseEnd?: (eventId: string, endedAt: string, expectedRevision: number, durationSeconds: number) => Promise<boolean>;
  onSaveInsulinDefault?: (product: string) => Promise<boolean>;
}) {
  const { pet, online, onSubmit } = props;
  const initialEventType = eventOptions.find((option) => option.type === props.presetEventType)?.type ?? 'glucose';
  const [eventType, setEventType] = useState<EventType>(initialEventType);
  const [occurredLocal, setOccurredLocal] = useState(localDateTimeNow());
  const manuallyChosenTime = useRef(false);
  const [currentLocal, setCurrentLocal] = useState(localDateTimeNow());
  useEffect(() => {
    const timer = window.setInterval(() => { const current = localDateTimeNow(); setCurrentLocal(current); if (!manuallyChosenTime.current) setOccurredLocal(current); }, 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const [numericValue, setNumericValue] = useState('');
  const [targetOverride, setTargetWeight] = useState<string | null>(null);
  const [savedWeightTarget, setSavedWeightTarget] = useState<{ petId: string; target: number | null; error?: boolean } | null>(null);
  const demoTarget = weightSamples(props.events, props.revisions).target;
  const previousWeightTarget = props.demoOnly ? demoTarget : savedWeightTarget?.petId === pet.id ? savedWeightTarget.target : null;
  const targetWeight = targetOverride ?? (previousWeightTarget === null ? '' : String(previousWeightTarget));
  useEffect(() => {
    if (props.demoOnly || !supabase || !online || eventType !== 'weight') return;
    let active = true;
    void loadWeightTarget(supabase, pet.id).then(target => {
      if (active) setSavedWeightTarget({ petId: pet.id, target });
    }).catch(() => { if (active) setSavedWeightTarget({ petId: pet.id, target: null, error: true }); });
    return () => { active = false; };
  }, [pet.id, online, props.demoOnly, props.events, props.revisions, eventType]);
  const [unit, setUnit] = useState(initialEventType === 'meal' ? 'g' : '');
  const [note, setNote] = useState('');
  const [mealStatus, setMealStatus] = useState('');
  const [eliminationType, setEliminationType] = useState('');
  const [description, setDescription] = useState('');
  const [measurementSource, setMeasurementSource] = useState('');
  const [measurementCondition, setMeasurementCondition] = useState('');
  const [doseAmount, setDoseAmount] = useState('');
  const [insulinProductLabel, setInsulinProductLabel] = useState(() => pet.default_insulin_product?.trim() ?? '');
  const insulinProductDefaultRef = useRef({ petId: pet.id, value: pet.default_insulin_product?.trim() ?? '' });
  const [savingInsulinDefault, setSavingInsulinDefault] = useState(false);
  const [insulinDefaultMessage, setInsulinDefaultMessage] = useState('');
  const [showAllRecordTypes, setShowAllRecordTypes] = useState(!primaryRecordTypes.includes(initialEventType));
  const visibleEventOptions = showAllRecordTypes
    ? eventOptions
    : eventOptions.filter((option) => primaryRecordTypes.includes(option.type) || option.type === eventType);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [activityMessage, setActivityMessage] = useState('');
  type Draft = { numericValue: string; unit: string; note: string; mealStatus: string; eliminationType: string;
    description: string; measurementSource: string; measurementCondition: string; doseAmount: string;
    insulinProductLabel: string };
  const drafts = useRef<Partial<Record<EventType, Draft>>>({});
  function selectRecordType(next: EventType) {
    if (next === eventType || saving) return;
    drafts.current[eventType] = { numericValue, unit, note, mealStatus, eliminationType, description,
      measurementSource, measurementCondition, doseAmount, insulinProductLabel };
    const draft = drafts.current[next];
    setNumericValue(draft?.numericValue ?? ''); setUnit(draft?.unit ?? (next === 'meal' ? 'g' : '')); setNote(draft?.note ?? '');
    setMealStatus(draft?.mealStatus ?? ''); setEliminationType(draft?.eliminationType ?? '');
    setDescription(draft?.description ?? ''); setMeasurementSource(draft?.measurementSource ?? '');
    setMeasurementCondition(draft?.measurementCondition ?? ''); setDoseAmount(draft?.doseAmount ?? '');
    setInsulinProductLabel(draft?.insulinProductLabel ?? '');
    setFormError('');
    setShowAllRecordTypes(!primaryRecordTypes.includes(next));
    setEventType(next);
  }

  const activeExercise = useMemo(() => props.events
    .filter((item) => item.event_type === 'exercise')
    .map((item) => {
      const itemRevisions = props.revisions.filter((revision) => revision.event_id === item.id)
        .sort((a, b) => a.revision_no - b.revision_no);
      return { event: item, value: effectiveEventValue(item.value, itemRevisions), revision: itemRevisions.at(-1) };
    })
    .filter((item) => item.value.activity_state === 'STARTED' && item.revision?.revision_kind !== 'VOID')
    .sort((a, b) => Date.parse(b.event.recorded_at) - Date.parse(a.event.recorded_at))[0],
  [props.events, props.revisions]);
  const savedInsulinProduct = pet.default_insulin_product?.trim() ?? '';
  const insulinProductSelection = !insulinProductLabel ? ''
    : commonInsulinProductLabels.includes(insulinProductLabel) ? insulinProductLabel : '__custom__';

  useEffect(() => {
    const previous = insulinProductDefaultRef.current;
    if (previous.petId !== pet.id || !insulinProductLabel.trim() || insulinProductLabel === previous.value) {
      setInsulinProductLabel(savedInsulinProduct);
    }
    insulinProductDefaultRef.current = { petId: pet.id, value: savedInsulinProduct };
  }, [pet.id, savedInsulinProduct, insulinProductLabel]);

  async function saveInsulinDefault() {
    const product = insulinProductLabel.trim();
    if (!product || !props.onSaveInsulinDefault || savingInsulinDefault) return;
    setSavingInsulinDefault(true);
    setInsulinDefaultMessage('');
    const saved = await props.onSaveInsulinDefault(product);
    setSavingInsulinDefault(false);
    setInsulinDefaultMessage(saved ? '이 반려동물의 기본 제품으로 저장했습니다.' : '기본 제품을 저장하지 못했습니다. 연결과 권한을 확인해 주세요.');
  }

  async function finishExerciseSession() {
    if (!activeExercise || !props.onSaveExerciseEnd || saving) return;
    if (!online) {
      setFormError('오프라인에서는 종료 시각을 서버에 저장할 수 없습니다. 연결을 복구한 뒤 종료를 기록해 주세요.');
      return;
    }
    const endedAt = new Date();
    const startedAt = new Date(activeExercise.event.occurred_at);
    const durationSeconds = Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000));
    setSaving(true); setFormError('');
    const saved = await props.onSaveExerciseEnd(activeExercise.event.id, endedAt.toISOString(), activeExercise.revision?.revision_no ?? 0, durationSeconds);
    setSaving(false);
    if (saved) setActivityMessage('종료 시각과 경과 시간을 저장했습니다.');
    else setFormError('종료 기록을 저장하지 못했습니다. 진행 시간은 서버 확인 전까지 미확정입니다.');
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError('');
    if (eventType === 'exercise') {
      if (activeExercise) {
        await finishExerciseSession();
        return;
      }
      const startedLocal = localDateTimeNowPrecise();
      const startFields: EventEntryFields = {
        eventType: 'exercise', occurredLocal: startedLocal, activityStartedLocal: startedLocal,
        activityState: 'STARTED', note, numericValue: '', unit: '분', mealStatus: '', eliminationType: '',
        description,
      };
      const startValidation = validateEventEntry(startFields);
      if (startValidation.error) { setFormError(startValidation.error); return; }
      setSaving(true);
      const saved = await onSubmit(startFields, null);
      setSaving(false);
      if (!saved) return;
      setActivityMessage('시작 시각을 저장하고 타이머를 시작했습니다.');
      setNote(''); setDescription('');
      return;
    }
    const fields: EventEntryFields = {
      eventType, occurredLocal, note, numericValue, targetWeight, unit: eventType === 'meal' ? 'g' : unit, mealStatus, eliminationType, description,
      measurementSource, measurementCondition, doseAmount, doseUnit: eventType === 'insulin' ? 'U' : '', insulinProductLabel,
    };
    const validation = validateEventEntry(fields);
    if (validation.error) {
      setFormError(validation.error);
      return;
    }
    setSaving(true);
    const saved = await onSubmit(fields, null);
    setSaving(false);
    if (saved) {
      setNumericValue('');
      setUnit(eventType === 'meal' ? 'g' : '');
      setNote('');
      setDescription('');
      setMeasurementSource('');
      setMeasurementCondition('');
      setDoseAmount('');
      setInsulinProductLabel(pet.default_insulin_product?.trim() ?? '');
      setMealStatus('');
      setEliminationType('');
    }
  }

  return <main className="page-container record-page">
    <section className="page-heading"><p className="eyebrow">빠른 기록</p><h1>{pet.name}의 하루를 남겨요</h1>
      <p>관찰한 일을 골라 기록하세요. 선택만으로 저장되지는 않아요.</p></section>
    {props.demoOnly && <div className="notice notice-warning" role="status">DEMO · 제출한 내용은 이 탭의 메모리에만 표시되며 서버에 저장되지 않습니다.</div>}
    {activityMessage && <p className="activity-message" role="status">{activityMessage}</p>}
    {activeExercise && <section className="activity-session-bar" aria-label="진행 중인 운동 및 산책 기록">
      <div><strong>운동 및 산책 기록 진행 중</strong><small>시작 {dateTimeInTimezone(activeExercise.event.occurred_at, pet.timezone)} · 다른 기록을 추가해도 타이머는 계속됩니다.</small></div>
      <ActivityElapsedTimer startedAt={activeExercise.event.occurred_at} />
      <button type="button" className="activity-stop-button" disabled={saving || !online}
        onClick={() => void finishExerciseSession()}>{saving ? '저장 중…' : '산책 종료 · 저장'}</button>
      {!online && <p role="status">UNVERIFIED · 오프라인이라 종료 시각을 저장할 수 없습니다.</p>}
    </section>}
    <form className="record-form" onSubmit={(event) => void handleSubmit(event)} noValidate>
      <fieldset className="event-type-fieldset">
        <legend>무엇을 기록할까요?</legend>
        <div className="event-type-grid">{visibleEventOptions.map((option) =>
          <label className={eventType === option.type ? 'type-choice selected' : 'type-choice'} key={option.type}>
            <input type="radio" name="event-type" value={option.type} checked={eventType === option.type}
              disabled={saving} onChange={() => selectRecordType(option.type)} />
            <RecordTypeIllustration type={option.type} className="type-icon" />
            <span className="type-label">{option.label}</span>
          </label>)}</div>
        <button type="button" className="record-more-types" aria-expanded={showAllRecordTypes}
          onClick={() => setShowAllRecordTypes((current) => !current)}>{showAllRecordTypes ? '다른 기록 종류 접기' : '다른 기록 종류 보기'}</button>
      </fieldset>
      {eventType !== 'exercise' && <div className="actual-occurrence-field">
        <label className="field-label">실제 발생 시각
          <input aria-label="실제 발생 시각" type="datetime-local" required value={occurredLocal}
            onChange={(event) => { manuallyChosenTime.current = true; setOccurredLocal(event.target.value); }} />
          <small>기기 현재 시각 {currentLocal.replace('T', ' ')} · 기기 시간대 기준</small>
        </label>
        <button type="button" className="text-button actual-time-action" onClick={() => {
          manuallyChosenTime.current = false;
          setOccurredLocal(localDateTimeNow());
        }}>현재 시각 적용</button>
      </div>}

      <section className={eventType === 'insulin' ? 'insulin-record-section' : 'event-fields'}>
        {eventType === 'insulin' && <div className="insulin-header">
          <p className="eyebrow">투여 후 기록</p><h2>실제 투여 내용을 기록해요</h2>
          <p>기억하는 투여량과 제품을 그대로 남겨요. 앱은 용량을 계산하거나 투여를 판단하지 않습니다.</p>
        </div>}
        <div className="form-grid">
          {eventType === 'exercise' && <p className="activity-start-hint">시작 버튼을 누르면 현재 시각을 서버에 저장하고 타이머를 시작합니다.</p>}
          {eventType === 'glucose' && <>
            <label className="field-label">측정값<input type="number" inputMode="decimal" step="any" value={numericValue} onChange={(event) => setNumericValue(event.target.value)} required /></label>
            <div className="field-label glucose-unit-field"><span>측정 단위</span><span className="unit-fixed">{GLUCOSE_UNIT}</span><small>신규 혈당 기록은 mg/dL로 저장됩니다.</small></div>
            <RecordChoices label="측정 조건 (선택)" value={measurementCondition}
              options={[{ value: '', label: '미기록' }, ...GLUCOSE_MEASUREMENT_CONDITIONS]} onChange={setMeasurementCondition} />
          </>}
          {eventType === 'weight' && <>
            <label className="field-label">측정값<input type="number" inputMode="decimal" step="any" value={numericValue} onChange={(event) => setNumericValue(event.target.value)} required /></label>
            <div className="field-label glucose-unit-field" role="group" aria-label="측정 단위"><span>측정 단위</span><output className="unit-fixed">kg</output></div>
            <label className="field-label">목표 체중 (선택 · kg)<input type="number" min="0.01" step="any" inputMode="decimal" value={targetWeight} onChange={(event) => setTargetWeight(event.target.value)} /><small>이전 목표를 불러와 이번 측정값과 함께 저장합니다. 변경하면 이번 기록부터 새 목표가 적용됩니다.</small></label>
          </>}
          {eventType === 'weight' && savedWeightTarget?.error && <p role="status">이전 목표를 불러오지 못했습니다. 연결을 확인하거나 목표를 직접 입력해 주세요.</p>}
          {eventType === 'meal' && <>
            <RecordChoices label="관찰한 식사 상태" value={mealStatus} onChange={setMealStatus}
              options={[{ value: 'ATE', label: '섭취 확인' }, { value: 'PARTIAL', label: '일부 섭취' }, { value: 'REFUSED', label: '식사 거부' }]} />
            <label className="field-label">실제 섭취량 (선택)<input type="number" inputMode="decimal" step="any" value={numericValue} onChange={(event) => setNumericValue(event.target.value)} /></label>
            <div className="field-label glucose-unit-field" role="group" aria-label="섭취량 단위"><span>섭취량 단위</span><output className="unit-fixed">g</output></div>
            <label className="field-label full-field">섭취 내용 (선택)<textarea rows={3} maxLength={1000} value={note}
              onChange={(event) => setNote(event.target.value)} placeholder="먹은 음식이나 평소와 다른 점을 적어 주세요" />
              <small>{note.length}/1000</small></label>
          </>}
          {eventType === 'water' && <>
            <label className="field-label">관찰한 음수량 (선택)<input type="number" inputMode="decimal" step="any" value={numericValue} onChange={(event) => setNumericValue(event.target.value)} /></label>
            <label className="field-label">단위 (선택)<input value={unit} onChange={(event) => setUnit(event.target.value)} /></label>
          </>}
          {eventType === 'elimination' && <RecordChoices label="관찰한 유형" value={eliminationType} onChange={setEliminationType}
            options={[{ value: 'URINATION', label: '배뇨' }, { value: 'BOWEL_MOVEMENT', label: '배변' }, { value: 'BOTH', label: '배변·배뇨 둘 다' }]} />}
          {eventType === 'exercise' && <>
            {!activeExercise && <p className="small-note">중간에 배변·배뇨 등 다른 일을 별도로 기록해도 시작한 타이머는 유지됩니다.</p>}
            <label className="field-label">활동 내용 (선택)<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="예: 산책" /></label>
          </>}
          {eventType === 'insulin' && <>
            <div className="field-label insulin-product-field">인슐린 제품
              <select aria-label="인슐린 제품" value={insulinProductSelection} required
                onChange={(event) => { if (event.target.value !== '__custom__') setInsulinProductLabel(event.target.value); setInsulinDefaultMessage(''); }}>
                <option value="">제품 선택</option>
                <option value="캐니슐린">캐니슐린</option>
                <option value="프로진크">프로진크</option>
                <option value="NPH">NPH</option>
                <option value="글라진">글라진</option>
                <option value="디터미르">디터미르</option>
                <option value="__custom__">다른 제품 직접 입력</option>
              </select>
              {insulinProductSelection === '__custom__' && <input aria-label="직접 입력한 인슐린 제품" maxLength={120} value={insulinProductLabel}
                onChange={(event) => { setInsulinProductLabel(event.target.value); setInsulinDefaultMessage(''); }}
                placeholder="처방 제품명을 입력" required />}
              <small>목록은 제품명을 기록하기 위한 선택지이며, 처방·추천 목록이 아닙니다. 수의사가 처방한 제품을 고르세요.</small>
              {props.onSaveInsulinDefault && insulinProductLabel.trim() !== (pet.default_insulin_product ?? '').trim() &&
                <button type="button" className="insulin-default-save" disabled={!online || savingInsulinDefault || !insulinProductLabel.trim()}
                  onClick={() => void saveInsulinDefault()}>{savingInsulinDefault ? '저장 중…' : '이 반려동물의 기본 제품으로 저장'}</button>}
              {insulinDefaultMessage && <small role="status">{insulinDefaultMessage}</small>}
              {!pet.default_insulin_product && <small>자주 사용하는 제품을 선택한 뒤 기본 제품으로 저장할 수 있습니다.</small>}
              {props.demoOnly && <small>DEMO에서는 기본 제품 변경이 서버에 저장되지 않습니다.</small>}
            </div>
            <div className="insulin-dose-row">
              <label className="field-label">실제 투여량<input type="number" inputMode="decimal" min="0" step="any" value={doseAmount}
                onChange={(event) => setDoseAmount(event.target.value)} placeholder="예: 2" required /></label>
              <div className="field-label glucose-unit-field"><span>단위</span><span className="unit-fixed">U</span></div>
            </div>
            <p className="insulin-dose-note">수의사가 정한 값을 실제 기록에서 확인해 입력하세요. mL로 환산하지 않습니다.</p>
            <details className="record-details insulin-extra-details">
              <summary>추가 정보 · 도움말</summary>
            <details className="insulin-help">
              <summary>처음 인슐린을 준비하는 보호자 도움말</summary>
              <div className="insulin-help-content">
                <p><strong>이 도움말은 개별 투여 지시나 실습을 대신하지 않습니다.</strong> 제품과 주사기 종류에 따라 준비 방법이 다르므로, 담당 수의사에게 실제 제품으로 시범과 확인을 요청하고 제품 설명서를 우선하세요.</p>
                <ul>
                  <li>제품명·농도와 수의사가 안내한 주사기 또는 기기가 일치하는지 확인하세요. U와 mL는 서로 다른 단위이므로 직접 환산하지 마세요.</li>
                  <li>흔들기·굴리기, 보관 온도와 사용 기간은 제품마다 다릅니다. 라벨과 수의사 안내를 따르고, 얼거나 과열·직사광선에 노출된 제품은 사용 여부를 병원에 확인하세요.</li>
                  <li>기포가 보이거나 눈금의 실제 양을 확신할 수 없다면 임의로 보정하지 마세요. 기포 확인·제거 방법도 해당 제품과 기기의 설명 및 수의사 시범을 따르세요.</li>
                  <li>주사 준비·투여 방법은 진료팀에게 직접 배우세요. 매회 새 주사기와 바늘을 사용하고, 사용한 바늘은 바로 안전한 손상성 폐기 용기에 넣으세요.</li>
                  <li>투여했는지, 전량 들어갔는지 확실하지 않거나 누락·추가 투여가 의심되면 임의로 보충하거나 다음 행동을 정하지 말고 담당 병원에 즉시 문의하세요. 급박한 이상이 있으면 응급 동물병원에 연락하세요.</li>
                  <li>폐기 방법은 지역 규정에 따라 다를 수 있습니다. 병원이나 관할 지자체에 가정용 주사침 폐기 방법을 확인하세요.</li>
                </ul>
                <p className="small-note">기포가 있으면 항상 같은 조치를 해야 한다는 뜻은 아닙니다. 제품별 지침을 확인하세요.</p>
                <nav aria-label="인슐린 안전 참고 자료" className="insulin-help-links">
                  <a href="https://healthtopics.vetmed.ucdavis.edu/health-topics/canine/diabetes-mellitus-dogs-owner-instructions" target="_blank" rel="noreferrer">UC Davis 수의대 보호자 안내</a>
                  <a href="https://vcahospitals.com/know-your-pet/diabetes-mellitus-insulin-treatment-in-dogs" target="_blank" rel="noreferrer">VCA 반려견 인슐린 치료 안내</a>
                  <a href="https://vetmed.illinois.edu/2025/07/09/pharmacists-corner-storage-and-handling-of-insulins/" target="_blank" rel="noreferrer">일리노이 수의대: 인슐린 보관·취급</a>
                  <a href="https://www.cdc.gov/infection-control/hcp/environmental-control/summary-recommendations.html" target="_blank" rel="noreferrer">CDC: 손상성 폐기물 안전</a>
                </nav>
              </div>
            </details>
            </details>
          </>}
          {eventType === 'symptom' && <p className="field-hint">증상이나 컨디션을 관찰한 표현 그대로 적어 주세요. 앱은 진단하거나 분류하지 않습니다.</p>}
          {eventType === 'symptom' && <>          <label className="field-label full-field">메모 (선택)
            <textarea rows={3} maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)}
              placeholder="관찰한 증상이나 컨디션을 적어 주세요" />
            <small>{note.length}/1000</small>
          </label></>}
          <details className="record-details full-field" key={eventType}>
            <summary>상세 입력 · 시각과 메모</summary><div className="form-grid">
            {eventType === 'glucose' && <>            <label className="field-label">측정 출처 (선택)<input maxLength={120} value={measurementSource} onChange={(event) => setMeasurementSource(event.target.value)} placeholder="예: 혈당계, 병원 검사" /></label>
</>}
            {eventType !== 'symptom' && eventType !== 'meal' && <>          <label className="field-label full-field">메모 (선택)
            <textarea rows={3} maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)}
              placeholder={eventType === 'insulin' ? '필요한 경우 실제 발생 상황을 적어 주세요' : '관찰하거나 수행한 내용을 기록하세요'} />
            <small>{note.length}/1000</small>
          </label></>}
            </div>
          </details>
        </div>
        {formError && <p role="alert" className="inline-error">{formError}</p>}
        <div className="record-save-bar"><p className="small-note">{props.demoOnly ? '데모 미리보기 · 서버 저장 안 됨' : '서버 확인 후 저장 결과를 알려드려요'}</p>
        <button className={eventType === 'insulin' ? 'submit-button insulin-submit' : 'submit-button'}
          type="submit" disabled={saving || !online || (eventType === 'exercise' && !!activeExercise)}>
          {saving ? (props.demoOnly ? '데모 화면 반영 중…' : '서버 확인 중…') : eventType === 'exercise' ? '운동 및 산책 시작 · 저장' : props.demoOnly ? '데모 화면에만 추가 (저장 안 됨)' : '기록 저장'}
        </button>
        </div>
        {!online && <p className="small-note">오프라인에서는 서버 저장을 시도하지 않습니다. 입력은 확정 기록이 아닙니다.</p>}
      </section>
    </form>
  </main>;
}

export function TimelinePage(props: {
  pet: Pet; events: HealthEvent[]; revisions: EventRevision[]; userId: string;
  dateFilter: string; setDateFilter: (value: string) => void; loading: boolean;
  onSaveExerciseEnd?: (eventId: string, endedAt: string, expectedRevision: number, durationSeconds: number) => Promise<boolean>;
  onReviseEvent?: (eventId: string, expectedRevision: number, kind: 'CORRECT' | 'VOID', patch: Record<string, unknown>) => Promise<boolean>;
  onCorrectTime?: (eventId: string, expectedRevision: number, occurredAt: string) => Promise<boolean>;
}) {
  const { pet, events, revisions, userId, dateFilter, setDateFilter, loading, onSaveExerciseEnd, onReviseEvent, onCorrectTime } = props;
  const [searchParams, setSearchParams] = useSearchParams();
  const visibleTypes = useMemo(() => {
    const serialized = searchParams.get('types');
    if (serialized === null) return new Set(coreTimelineTypes);
    const allowed = new Set(eventOptions.map((item) => item.type));
    return new Set(serialized.split(',').filter((type): type is EventType => allowed.has(type as EventType)));
  }, [searchParams]);
  const dailyEvents = useMemo(() => events
    .filter((event) => localDateKey(event.occurred_at, pet.timezone) === dateFilter)
    .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at)), [events, pet.timezone, dateFilter]);
  const filteredEvents = dailyEvents.filter((event) => visibleTypes.has(event.event_type));

  return <main className="page-container timeline-page">
    <section className="page-heading pet-photo-heading"><PetProfilePortrait pet={pet} /><div><p className="eyebrow">건강 기록</p><h1>하루 타임라인</h1>
      <p>{pet.name}의 기록 · {dateFilter}</p></div></section>
    <div className="timeline-filter"><label htmlFor="timeline-date">날짜 선택</label>
      <input id="timeline-date" type="date" value={dateFilter} onChange={(event) => {
        const date = event.target.value;
        setDateFilter(date);
        setSearchParams((current) => { const next = new URLSearchParams(current); next.set('date', date); return next; });
      }} /></div>
    <section className="timeline-type-filter" aria-label="표시할 기록 종류">
      <div className="timeline-filter-heading"><strong>보고 싶은 기록</strong>
        <div className="timeline-filter-actions">
          <button type="button" className="text-button" onClick={() => setSearchParams((current) => { const next = new URLSearchParams(current); next.set('types', coreTimelineTypes.join(',')); return next; })}>주요 기록</button>
          {visibleTypes.size !== eventOptions.length && <button type="button" className="text-button" onClick={() => setSearchParams((current) => { const next = new URLSearchParams(current); next.set('types', eventOptions.map((item) => item.type).join(',')); return next; })}>전체 보기</button>}
        </div></div>
      <div className="timeline-filter-chips" role="group" aria-label="기록 종류 필터">
        {eventOptions.map((option) => <button type="button" key={option.type}
          className={visibleTypes.has(option.type) ? 'timeline-filter-chip selected' : 'timeline-filter-chip'}
          aria-pressed={visibleTypes.has(option.type)}
          onClick={() => setSearchParams((current) => {
            const currentTypes = new Set(visibleTypes);
            const next = new URLSearchParams(current);
            if (currentTypes.has(option.type)) currentTypes.delete(option.type); else currentTypes.add(option.type);
            next.set('types', eventOptions.filter((item) => currentTypes.has(item.type)).map((item) => item.type).join(','));
            return next;
          })}><RecordTypeIllustration type={option.type} className="timeline-chip-icon" /> {option.label}</button>)}
      </div>
      <small>{filteredEvents.length} / {dailyEvents.length}개 기록 표시</small>
    </section>
    {loading && <p role="status" className="load-state">서버에서 기록을 확인하고 있습니다…</p>}
    {!loading && dailyEvents.length === 0 && <section className="panel empty-panel">
      <span className="empty-illustration" aria-hidden="true">◷</span><h2>이 날짜에 서버 기록이 없습니다</h2>
      <p>기록이 없다는 사실은 실제 미실시를 뜻하지 않습니다.</p>
      <Link to="/record" className="button-link">실제 발생한 일 기록하기</Link>
    </section>}
    {!loading && dailyEvents.length > 0 && filteredEvents.length === 0 && <section className="panel empty-panel"><h2>선택한 종류의 기록이 없습니다</h2><p>필터를 바꾸면 다른 기록을 볼 수 있어요.</p></section>}
    {filteredEvents.length > 0 && <ol className="timeline-list">{filteredEvents.map((event) => {
      const itemRevisions = revisions.filter((revision) => revision.event_id === event.id).sort((a, b) => a.revision_no - b.revision_no);
      const latest = itemRevisions[itemRevisions.length - 1];
      const effectiveValue = effectiveEventValue(event.value, itemRevisions);
      return <li className="timeline-item" key={event.id}>
        <time className="timeline-time" dateTime={event.occurred_at}>{timeInTimezone(event.occurred_at, pet.timezone)}</time>
        <RecordTypeIllustration type={event.event_type} className="event-icon" />
        <article className="timeline-card">
          <div className="timeline-card-heading"><h2>{eventLabels[event.event_type] ?? event.event_type}</h2>
            {latest && <span className={latest.revision_kind === 'VOID' ? 'event-status void' : 'event-status corrected'}>
              {latest.revision_kind === 'VOID' ? '무효 처리' : '정정 이력 있음'}
            </span>}</div>
          <p className="event-value">{formatEventValue(event, effectiveValue)}</p>
          {event.event_type === 'weight' && onReviseEvent && latest?.revision_kind !== 'VOID' &&
            <TimelineCorrectionEditor event={event} value={effectiveValue} revision={latest?.revision_no ?? 0}
              onSave={onReviseEvent} onCorrectTime={onCorrectTime} direct />}
          <details><summary>상세 정보·수정</summary>
            <p className="event-timestamp">실제 발생 {dateTimeInTimezone(event.occurred_at, pet.timezone)}</p>
            {event.event_type === 'exercise' && typeof effectiveValue.activity_ended_at === 'string' &&
              <p className="event-timestamp">종료 {dateTimeInTimezone(effectiveValue.activity_ended_at, pet.timezone)}</p>}
            {event.event_type === 'exercise' && onSaveExerciseEnd && latest?.revision_kind !== 'VOID' &&
              <ExerciseEndEditor event={event} value={effectiveValue} revision={latest?.revision_no ?? 0}
                onSave={onSaveExerciseEnd} />}
            {event.event_type !== 'weight' && onReviseEvent && latest?.revision_kind !== 'VOID' && <TimelineCorrectionEditor event={event} value={effectiveValue}
              revision={latest?.revision_no ?? 0} onSave={onReviseEvent} onCorrectTime={onCorrectTime} />}
            <p className="event-timestamp">기록자 {actorLabel(event.actor_id, userId)} · 서버 입력 {dateTimeInTimezone(event.recorded_at, pet.timezone)}</p>
            <dl className="detail-list"><div><dt>기록 ID</dt><dd>{event.id}</dd></div>
              <div><dt>기록자 ID</dt><dd>{event.actor_id}</dd></div>
              <div><dt>실제 수행자</dt><dd>{event.performer_id ? actorLabel(event.performer_id, userId) : '지정되지 않음'}</dd></div>
              <div><dt>단위</dt><dd>{event.event_type === 'glucose'
                ? event.unit === GLUCOSE_UNIT ? GLUCOSE_UNIT : event.unit ? `${event.unit} · 기존 단위 보존, mg/dL로 변환하지 않음` : '기존 기록 · 저장 단위 확인 필요'
                : event.unit ?? '없음'}</dd></div>
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

  </main>;
}

function TimelineCorrectionEditor({ event, value, revision, onSave, onCorrectTime, direct = false }: {
  event: HealthEvent; value: Record<string, unknown>; revision: number;
  onSave: (eventId: string, revision: number, kind: 'CORRECT' | 'VOID', patch: Record<string, unknown>) => Promise<boolean>;
  onCorrectTime?: (eventId: string, revision: number, occurredAt: string) => Promise<boolean>;
  direct?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(String(value.observed_value ?? value.administered_dose_value ?? ''));
  const [targetWeight, setTargetWeight] = useState(String(value.target_weight_kg ?? ''));
  const [note, setNote] = useState(String(value.note ?? ''));
  const [condition, setCondition] = useState(String(value.measurement_condition ?? ''));
  const [source, setSource] = useState(String(value.measurement_source ?? ''));
  const [insulinProduct, setInsulinProduct] = useState(String(value.insulin_product_label ?? ''));
  const [meal, setMeal] = useState(String(value.meal_status ?? ''));
  const [elimination, setElimination] = useState(String(value.observation_type ?? ''));
  const [occurredLocal, setOccurredLocal] = useState(() => {
    const date = new Date(event.occurred_at);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const numeric = event.event_type === 'glucose' || event.event_type === 'insulin' || event.event_type === 'weight' || event.event_type === 'water';
  async function save() {
    const parsed = Number(amount);
    if (numeric && (!Number.isFinite(parsed) || parsed <= 0)) { setError('기록값은 0보다 큰 숫자로 입력해 주세요.'); return; }
    if (event.event_type === 'insulin' && !insulinProduct.trim()) { setError('인슐린 제품명을 입력해 주세요.'); return; }
    if (event.event_type === 'weight' && targetWeight.trim() && (!Number.isFinite(Number(targetWeight)) || Number(targetWeight) <= 0)) { setError('목표 체중은 0보다 큰 kg 값으로 입력해 주세요.'); return; }
    setBusy(true); setError('');
    const patchValue: Record<string, unknown> = { ...value, note: note.trim(), ...(numeric ? event.event_type === 'insulin'
      ? { administered_dose_value: parsed, insulin_product_label: insulinProduct.trim() } : { observed_value: parsed } : {}),
      ...(event.event_type === 'glucose' ? { measurement_condition: condition, measurement_source: source.trim() } : {}),
      ...(event.event_type === 'meal' ? { meal_status: meal } : {}),
      ...(event.event_type === 'elimination' ? { observation_type: elimination } : {}) };
    if (event.event_type === 'weight') {
      if (targetWeight.trim()) patchValue.target_weight_kg = Number(targetWeight);
      else patchValue.target_weight_kg = null;
    }
    const success = await onSave(event.id, revision, 'CORRECT', { value: patchValue });
    setBusy(false); if (success) setOpen(false); else setError('정정을 저장하지 못했습니다. 최신 기록을 확인해 주세요.');
  }
  async function voidEvent() {
    if (!window.confirm('이 기록을 무효화할까요? 원본과 감사 이력은 보존됩니다.')) return;
    setBusy(true); setError('');
    const success = await onSave(event.id, revision, 'VOID', {});
    setBusy(false); if (!success) setError('기록을 무효화하지 못했습니다. 최신 기록을 확인해 주세요.');
  }
  async function saveTime() {
    const parsed = new Date(occurredLocal);
    if (!Number.isFinite(parsed.getTime())) { setError('발생 시각을 확인해 주세요.'); return; }
    if (!onCorrectTime) return;
    setBusy(true); setError('');
    const success = await onCorrectTime(event.id, revision, parsed.toISOString());
    setBusy(false); if (success) setOpen(false); else setError('시각을 수정하지 못했습니다. 서버 적용 상태와 최신 기록을 확인해 주세요.');
  }
  return <div className="timeline-correction">
    <div className="timeline-correction-actions">
      <button type="button" className="text-button" aria-expanded={open} onClick={() => setOpen(!open)}>{direct ? '수정' : '수정·삭제'}</button>
      {direct && <button type="button" className="text-button" disabled={busy} onClick={() => void voidEvent()}>삭제</button>}
    </div>
    {open && <div className="timeline-correction-fields">
      {numeric && <label className="field-label">기록값<input type="number" inputMode="decimal" step="any" value={amount} onChange={(input) => setAmount(input.target.value)} /></label>}
      {event.event_type === 'weight' && <label className="field-label">목표 체중 (kg)<input type="number" inputMode="decimal" min="0.01" step="any" value={targetWeight} onChange={(input) => setTargetWeight(input.target.value)} /></label>}
      {event.event_type === 'glucose' && <><label className="field-label">측정 조건<select value={condition} onChange={(input) => setCondition(input.target.value)}>
        <option value="">미기록</option>{GLUCOSE_MEASUREMENT_CONDITIONS.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}</select></label>
        <label className="field-label">측정 출처<input maxLength={120} value={source} onChange={(input) => setSource(input.target.value)} /></label></>}
      {event.event_type === 'insulin' && <label className="field-label">인슐린 제품<input maxLength={120} value={insulinProduct} onChange={(input) => setInsulinProduct(input.target.value)} /></label>}
      {event.event_type === 'meal' && <label className="field-label">식사 상태<select value={meal} onChange={(input) => setMeal(input.target.value)}><option value="ATE">섭취 확인</option><option value="PARTIAL">일부 섭취</option><option value="REFUSED">식사 거부</option></select></label>}
      {event.event_type === 'elimination' && <label className="field-label">배변·배뇨 유형<select value={elimination} onChange={(input) => setElimination(input.target.value)}><option value="URINATION">배뇨</option><option value="BOWEL_MOVEMENT">배변</option><option value="BOTH">배변·배뇨 둘 다</option></select></label>}
      <label className="field-label">메모<input maxLength={1000} value={note} onChange={(input) => setNote(input.target.value)} /></label>
      {onCorrectTime && <label className="field-label">실제 발생 시각 · 이 기기의 시간대<input type="datetime-local" value={occurredLocal} onChange={(input) => setOccurredLocal(input.target.value)} /></label>}
      <p className="small-note">시각·기록값·메모는 각각 정정됩니다. 한 항목을 저장한 뒤 다른 항목을 바꾸려면 최신 기록을 다시 확인해 주세요. 원본과 감사 이력은 남습니다.</p>
      {error && <p role="alert" className="inline-error">{error}</p>}
      <div className="timeline-correction-actions"><button type="button" className="button-secondary" disabled={busy} onClick={() => void save()}>값·메모 저장</button>
        {onCorrectTime && <button type="button" className="button-secondary" disabled={busy} onClick={() => void saveTime()}>시각 저장</button>}
        {!direct && <button type="button" className="text-button" disabled={busy} onClick={() => void voidEvent()}>기록 무효화</button>}</div>
    </div>}
  </div>;
}

function effectiveEventValue(value: Record<string, unknown>, revisions: EventRevision[]) {
  const effective = { ...value };
  for (const revision of revisions) {
    if (revision.revision_kind !== 'CORRECT') continue;
    const patchValue = revision.patch.value;
    if (patchValue && typeof patchValue === 'object' && !Array.isArray(patchValue)) {
      Object.assign(effective, patchValue);
    }
  }
  return effective;
}

function formatEventValue(event: HealthEvent, value = event.value ?? {}) {
  const pieces: string[] = [];
  if (typeof value.observed_value === 'number' || typeof value.observed_value === 'string') pieces.push(
    event.event_type === 'glucose' ? formatGlucoseValue(value.observed_value, event.unit) : `${value.observed_value}${event.unit ? ` ${event.unit}` : ''}`,
  );
  if (typeof value.meal_status === 'string') pieces.push(mealStatusLabel(value.meal_status));
  if (typeof value.observed_value === 'number' && value.meal_status) pieces.push(`섭취량 ${value.observed_value}${event.unit ? ` ${event.unit}` : ''}`);
  if (typeof value.observation_type === 'string') pieces.push(({ URINATION: '배뇨', BOWEL_MOVEMENT: '배변', BOTH: '배변·배뇨 둘 다' } as Record<string, string>)[value.observation_type] ?? value.observation_type);
  if (event.event_type === 'insulin' && typeof value.administered_dose_value === 'number'
    && (value.administered_dose_unit === 'U' || value.administered_dose_unit === 'mL')) {
    pieces.push(`기록된 실제 투여량 ${value.administered_dose_value} ${value.administered_dose_unit}`);
  }
  if (event.event_type === 'insulin' && typeof value.insulin_product_label === 'string') {
    pieces.push(`제품 표기 ${value.insulin_product_label}`);
  }
  if (typeof value.observed_value === 'number' && event.event_type === 'exercise') pieces.push(`활동 ${value.observed_value}${event.unit ?? ''}`);
  if (event.event_type === 'exercise' && value.activity_state === 'STARTED') pieces.push('진행 중 · 종료 기록 전');
  else if (event.event_type === 'exercise' && typeof value.activity_ended_at !== 'string') pieces.push('종료 시각 미기록');
  if (typeof value.activity_description === 'string') pieces.push(value.activity_description);
  if (typeof value.note === 'string') pieces.push(value.note);
  return pieces.length ? pieces.join(' · ') : event.event_type === 'insulin' ? '실제 투여 사실 기록' : '추가 입력 없음';
}

function ExerciseEndEditor({ event, value, revision, onSave }: {
  event: HealthEvent; value: Record<string, unknown>; revision: number;
  onSave: (eventId: string, endedAt: string, expectedRevision: number, durationSeconds: number) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [endedLocal, setEndedLocal] = useState(typeof value.activity_ended_at === 'string'
    ? localInputFromInstant(value.activity_ended_at) : '');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  async function submit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    const ended = new Date(endedLocal);
    const started = new Date(typeof value.activity_started_at === 'string' ? value.activity_started_at : event.occurred_at);
    if (!endedLocal || Number.isNaN(ended.getTime()) || ended.getTime() <= started.getTime()) {
      setMessage('종료 시각은 시작 시각보다 늦게 입력해 주세요.');
      return;
    }
    setSaving(true); setMessage('');
    const durationSeconds = Math.max(0, Math.floor((ended.getTime() - started.getTime()) / 1000));
    const saved = await onSave(event.id, ended.toISOString(), revision, durationSeconds);
    setSaving(false);
    setMessage(saved ? '종료 시각을 정정 이력과 함께 저장했습니다.' : '저장하지 못했습니다. 최신 기록을 확인한 뒤 다시 시도해 주세요.');
  }
  return <section className="exercise-end-editor">
    <button type="button" className="text-button" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
      {typeof value.activity_ended_at === 'string' ? '종료 시각 수정' : '늦게 종료 시각 기록'}
    </button>
    {open && <form onSubmit={(formEvent) => void submit(formEvent)}>
      <label className="field-label">실제 종료 시각
        <input type="datetime-local" value={endedLocal} onChange={(event) => setEndedLocal(event.target.value)} required />
      </label>
      <button type="submit" className="button-secondary" disabled={saving}>{saving ? '서버 확인 중…' : '정정 이력으로 저장'}</button>
      {message && <p role="status">{message}</p>}
    </form>}
  </section>;
}

function localInputFromInstant(instant: string) {
  const date = new Date(instant);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function ActivityElapsedTimer({ startedAt }: { startedAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const hours = Math.floor(elapsed / 3600);
  const minutes = Math.floor((elapsed % 3600) / 60);
  const seconds = elapsed % 60;
  return <output className="activity-elapsed" aria-live="off" aria-label={`경과 시간 ${hours}시간 ${minutes}분 ${seconds}초`}>
    {`${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`}
  </output>;
}

