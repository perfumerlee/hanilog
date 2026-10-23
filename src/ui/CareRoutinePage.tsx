import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { safetyResultLabel, safetyStatusLabel, type EventType } from '../lib/event-command';
import { routineDisplayStatus } from '../lib/routine-status';
import { supabase } from '../lib/supabase';
import { petInvalidationChannel } from '../lib/realtime';

type Pet = { id: string; household_id: string; name: string; timezone: string };
type Step = { key: string; event_type: string; predecessor_step_keys: string[] };
type Routine = { id: string; name: string; timezone: string; care_plan_id: string };
type Version = { id: string; routine_id: string; care_plan_version_id: string; version_no: number; recurrence: { days?: number[]; times?: string[] }; steps: Step[] };
type Occurrence = { id: string; routine_version_id: string; occurrence_key: string; step_key: string; event_type: string; scheduled_local_date: string; scheduled_local_time: string; timezone: string; scheduled_at: string | null; status: string; care_plan_version_id: string };
type EventRow = { id: string; occurrence_id: string | null; event_type: string; actor_id: string; performer_id: string | null; occurred_at: string; recorded_at: string; value: Record<string, unknown> };
type Evaluation = { id: string; occurrence_id: string | null; evaluation_status: string; result_codes: string[]; evaluated_at: string };
type Revision = { event_id: string; revision_no: number; revision_kind: string };

const eventLabels: Record<string, string> = { meal: '식사', insulin: '인슐린', glucose: '혈당', elimination: '배변·배뇨', exercise: '운동', water: '음수', weight: '체중', symptom: '증상', medication: '약물' };
const dayLabels = ['일', '월', '화', '수', '목', '금', '토'];
const defaultSteps: Step[] = [];
const localDateFor = (timezone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dateTimeFor = (instant: string, timezone: string) => new Intl.DateTimeFormat('ko-KR', { timeZone: timezone, dateStyle: 'short', timeStyle: 'short' }).format(new Date(instant));

function errorMessage(code?: string) {
  if (code === '42501' || code === 'PGRST301') return 'Pet 접근권한을 서버에서 확인하지 못했습니다. Pet을 다시 선택해 주세요.';
  if (code === '22023') return '루틴 날짜, 시간, 단계 또는 시간대 값을 확인해 주세요.';
  return '서버에서 요청을 확정하지 못했습니다. 연결 상태를 확인한 뒤 다시 조회해 주세요.';
}

export function CareRoutinePage({ pet, online, userId }: { pet: Pet; online: boolean; userId: string }) {
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [occurrences, setOccurrences] = useState<Occurrence[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [currentTime, setCurrentTime] = useState(() => Date.now());
  const [realtimeState, setRealtimeState] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [canWrite, setCanWrite] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(pet.timezone);
  const [days, setDays] = useState<number[]>([]);
  const [times, setTimes] = useState('');
  const [steps, setSteps] = useState<Step[]>(defaultSteps);

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const today = useMemo(() => localDateFor(pet.timezone), [pet.timezone]);
  const refresh = useCallback(async () => {
    if (!supabase) { setLoading(false); return; }
    const client = supabase;
    setLoading(true); setNotice('');
    const ensure = await client.rpc('ensure_routine_occurrences', { p_pet_id: pet.id, p_local_date: today });
    if (ensure.error) setNotice(errorMessage(ensure.error.code));
    const [routineResult, occurrenceResult, eventResult, membershipResult, grantResult] = await Promise.all([
      client.from('care_routines').select('id,name,timezone,care_plan_id').eq('pet_id', pet.id).order('created_at'),
      client.from('routine_occurrences').select('id,routine_version_id,occurrence_key,step_key,event_type,scheduled_local_date,scheduled_local_time,timezone,scheduled_at,status,care_plan_version_id').eq('pet_id', pet.id).eq('scheduled_local_date', today).order('scheduled_local_time').order('step_key'),
      client.from('health_events').select('id,occurrence_id,event_type,actor_id,performer_id,occurred_at,recorded_at,value').eq('pet_id', pet.id).not('occurrence_id', 'is', null).order('recorded_at', { ascending: false }).limit(200),
      client.from('household_memberships').select('role').eq('household_id', pet.household_id).eq('user_id', userId).eq('status', 'ACTIVE').maybeSingle(),
      client.from('pet_access_grants').select('access_role').eq('pet_id', pet.id).eq('user_id', userId).eq('status', 'ACTIVE').maybeSingle(),
    ]);
    const routineRows = (routineResult.data ?? []) as Routine[];
    const occurrenceRows = (occurrenceResult.data ?? []) as Occurrence[];
    const writeAllowed = ['PRIMARY_CAREGIVER','CAREGIVER'].includes(membershipResult.data?.role ?? '') && grantResult.data?.access_role === 'CAREGIVER';
    setCanWrite(writeAllowed);
    if (online && writeAllowed) {
      // Each evaluation is calculated and persisted by PostgreSQL from current server records.
      await Promise.all(occurrenceRows.map((occurrence) => client.rpc('evaluate_routine_occurrence', { p_occurrence_id: occurrence.id })));
    }
    const evaluationResult = await client.from('safety_evaluations').select('id,occurrence_id,evaluation_status,result_codes,evaluated_at').eq('pet_id', pet.id).order('evaluated_at', { ascending: false }).limit(100);
    const routineIds = routineRows.map((item) => item.id);
    const versionResult = routineIds.length ? await client.from('care_routine_versions').select('id,routine_id,care_plan_version_id,version_no,recurrence,steps').in('routine_id', routineIds).order('version_no', { ascending: false }) : { data: [], error: null };
    const eventRows = (eventResult.data ?? []) as EventRow[];
    const eventIds = eventRows.map((item) => item.id);
    const revisionResult = eventIds.length ? await client.from('health_event_revisions').select('event_id,revision_no,revision_kind').in('event_id', eventIds) : { data: [], error: null };
    const evaluationRows = (evaluationResult.data ?? []) as Evaluation[];
    const evaluationIds = evaluationRows.map((item) => item.id);
    const ackResult = evaluationIds.length ? await client.from('safety_acknowledgements').select('evaluation_id').in('evaluation_id', evaluationIds) : { data: [], error: null };
    setRoutines(routineRows); setOccurrences(occurrenceRows); setEvents(eventRows); setEvaluations(evaluationRows);
    setVersions((versionResult.data ?? []) as Version[]); setRevisions((revisionResult.data ?? []) as Revision[]);
    setAcknowledged((ackResult.data ?? []).map((item) => item.evaluation_id));
    const firstError = routineResult.error ?? occurrenceResult.error ?? eventResult.error ?? membershipResult.error ?? grantResult.error ?? evaluationResult.error ?? versionResult.error ?? revisionResult.error ?? ackResult.error;
    if (firstError) setNotice(errorMessage(firstError.code));
    setLoading(false);
  }, [pet.id, pet.household_id, today, online, userId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [pet.id, refresh]);

  useEffect(() => {
    if (!supabase) return;
    let timer = 0;
    const refreshHint = () => { window.clearTimeout(timer); timer = window.setTimeout(() => { void refresh(); }, 150); };
    const channel = petInvalidationChannel(supabase, pet.id, refreshHint)
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') { setRealtimeState('connected'); refreshHint(); }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') setRealtimeState('disconnected');
      });
    return () => { window.clearTimeout(timer); void supabase?.removeChannel(channel); };
  }, [pet.id, refresh]);

  useEffect(() => {
    const clearOnRevocation = () => {
      setRoutines([]); setOccurrences([]); setEvents([]); setEvaluations([]); setVersions([]); setRevisions([]); setAcknowledged([]);
      setNotice('접근권한이 변경되어 현재 화면의 기록을 숨겼습니다. 서버 권한을 다시 확인해 주세요.');
    };
    window.addEventListener('hanilog:access-changed', clearOnRevocation);
    return () => window.removeEventListener('hanilog:access-changed', clearOnRevocation);
  }, []);

  useEffect(() => {
    const clearOfflineData = () => {
      setRoutines([]); setOccurrences([]); setEvents([]); setEvaluations([]); setVersions([]); setRevisions([]); setAcknowledged([]);
      setNotice('UNVERIFIED · 오프라인 상태에서는 최신 일정 및 기록을 확인할 수 없습니다.');
    };
    window.addEventListener('offline', clearOfflineData);
    return () => window.removeEventListener('offline', clearOfflineData);
  }, []);

  const activeEventsByOccurrence = useMemo(() => {
    const result = new Map<string, EventRow[]>();
    for (const event of events) {
      if (!event.occurrence_id) continue;
      const latestRevision = revisions.filter((revision) => revision.event_id === event.id).sort((a, b) => b.revision_no - a.revision_no)[0];
      if (latestRevision?.revision_kind === 'VOID') continue;
      result.set(event.occurrence_id, [...(result.get(event.occurrence_id) ?? []), event]);
    }
    return result;
  }, [events, revisions]);

  const latestEvaluationByOccurrence = useMemo(() => {
    const result = new Map<string, Evaluation>();
    for (const evaluation of evaluations) if (evaluation.occurrence_id && !result.has(evaluation.occurrence_id)) result.set(evaluation.occurrence_id, evaluation);
    return result;
  }, [evaluations]);

  function beginEdit(routine: Routine) {
    const version = versions.filter((item) => item.routine_id === routine.id).sort((a, b) => b.version_no - a.version_no)[0];
    setEditingId(routine.id); setFormOpen(true); setName(routine.name); setTimezone(routine.timezone);
    setDays(version?.recurrence.days ?? []); setTimes((version?.recurrence.times ?? []).join(', '));
    setSteps(version?.steps ?? []); setNotice('기존 일정의 새 버전을 만들며 과거 일정과 실제 기록은 보존됩니다.');
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !online || !canWrite) { setNotice(!online ? 'UNVERIFIED · 연결 상태를 확인할 수 없어 루틴을 저장하지 않았습니다.' : '현재 Pet 기록 권한이 확인되지 않아 저장하지 않았습니다.'); return; }
    const parsedTimes = [...new Set(times.split(',').map((item) => item.trim()).filter(Boolean))];
    if (!name.trim() || !days.length || !parsedTimes.length || !steps.length) { setNotice('이름, 반복 요일, 시간, 한 단계 이상을 입력해 주세요.'); return; }
    setSaving(true); setNotice('');
    const { error } = await supabase.rpc('save_care_routine', {
      p_pet_id: pet.id, p_routine_id: editingId, p_name: name.trim(), p_timezone: timezone,
      p_days: days, p_times: parsedTimes,
      p_steps: steps.map((step, index) => ({ ...step, sequence: index + 1 })), p_care_plan_version_id: null,
    });
    if (error) setNotice(errorMessage(error.code));
    else {
      setNotice('루틴 버전을 서버에 저장했습니다. 개인 관리 일정이며 의료적 승인이나 투여 판단을 뜻하지 않습니다.');
      setEditingId(null); setFormOpen(false); setName(''); setDays([]); setTimes(''); setSteps([]);
      await refresh();
    }
    setSaving(false);
  }

  function addStep() {
    setSteps((current) => [...current, { key: `step-${crypto.randomUUID().slice(0, 8)}`, event_type: 'meal', predecessor_step_keys: current.length ? [current[current.length - 1].key] : [] }]);
  }

  function updateStep(index: number, patch: Partial<Step>) {
    setSteps((current) => current.map((step, stepIndex) => stepIndex === index ? { ...step, ...patch } : step));
  }

  async function acknowledge(evaluation: Evaluation) {
    if (!supabase || !canWrite || !evaluation.result_codes.length) return;
    const { error } = await supabase.rpc('acknowledge_safety_evaluation', { p_evaluation_id: evaluation.id, p_acknowledged_codes: evaluation.result_codes });
    if (error) setNotice(errorMessage(error.code)); else { setNotice('경고 확인 시각을 기록했습니다. 확인은 의학적 승인이나 위험 해소를 뜻하지 않습니다.'); await refresh(); }
  }

  const routineById = new Map(routines.map((item) => [item.id, item]));

  return <main className="page-container">
    <section className="page-heading"><p className="eyebrow">Care Routine · Safety Guard</p><h1>{pet.name}의 돌봄 일정</h1>
      <p>반복 일정은 개인 관리 안내입니다. 수의사가 확인하지 않은 순서로 임상적 선행 조건이나 투여 가능성을 판단하지 않습니다.</p></section>
    {!online && <div role="alert" className="notice notice-warning">UNVERIFIED · 인터넷 연결이 끊겨 최신 투여 상태를 확인할 수 없습니다. 이전 표시값은 현재 상태를 보증하지 않습니다.</div>}
    {notice && <div role="status" className="notice notice-warning">{notice}</div>}
    <section className="panel"><div className="section-heading"><h2>오늘 일정</h2><button type="button" className="secondary-action" onClick={() => void refresh()} disabled={loading || !online}>서버에서 다시 확인</button></div>
      <p className="small-note">데이터 상태와 안전 판단은 다릅니다. <strong>CURRENT</strong>는 조회 시점에 서버 기록을 확인했다는 뜻이며 투여 안전성 판정이 아닙니다.</p>
      <p className="small-note" role="status">실시간 {realtimeState === 'connected' ? '연결됨' : realtimeState === 'connecting' ? '연결 중' : '연결 끊김 · 서버를 다시 조회해야 합니다'}</p>
      {loading ? <p role="status">일정과 서버 기록을 확인하고 있습니다…</p> : occurrences.length ? <ol className="care-occurrence-list">{occurrences.map((occurrence) => {
        const eventRows = activeEventsByOccurrence.get(occurrence.id) ?? [];
        const evaluation = latestEvaluationByOccurrence.get(occurrence.id);
        const version = versions.find((item) => item.id === occurrence.routine_version_id);
        const exception = eventRows.some((row) => ['PARTIAL','REFUSED'].includes(String(row.value.meal_status ?? '')));
        const record = eventRows[0];
        const displayStatus = routineDisplayStatus({ hasRecord: Boolean(record), exceptionReported: exception,
          occurrenceStatus: occurrence.status, scheduledAt: occurrence.scheduled_at, now: currentTime });
        const isUpcoming = displayStatus === 'scheduled';
        const isDue = displayStatus === 'unconfirmed';
        const routine = routineById.get(version?.routine_id ?? '');
        const canAcknowledge = canWrite && evaluation?.result_codes.length && !acknowledged.includes(evaluation.id);
        return <li key={occurrence.id} className={`care-occurrence${isDue ? ' routine-current' : isUpcoming ? ' routine-upcoming' : ''}`}>
          <div className="care-occurrence-head"><strong>{eventLabels[occurrence.event_type] ?? occurrence.event_type}</strong><time>{occurrence.scheduled_local_time.slice(0, 5)}</time>
            <span className={`routine-state ${displayStatus === 'recorded' || displayStatus === 'exception' ? 'recorded' : isUpcoming ? 'scheduled' : 'unknown'}`}>{({ recorded: '기록 완료', exception: '예외 보고', scheduled: '예정', unconfirmed: '기록 미확인', cancelled: '일정 취소', superseded: '이전 버전 일정', time_unresolved: '시각 확인 필요' } as const)[displayStatus]}</span>
          </div>
          <p>{routine?.name ?? 'Care Routine'} · 일정은 {occurrence.timezone} 기준 · {record ? `수행자 ${record.performer_id?.slice(0, 8) ?? '미지정'} · 기록자 ${record.actor_id.slice(0, 8)} · 실제 발생 ${dateTimeFor(record.occurred_at, pet.timezone)} · 서버 기록 ${dateTimeFor(record.recorded_at, pet.timezone)}` : isUpcoming ? '예정된 일정 · 수행 사실은 아직 확인되지 않음' : '기록 미확인 · 실제 수행 여부는 확인되지 않음'}</p>
          {exception && <div className="guard-warning"><strong>예외 보고</strong><span>식사 상태에 일부 섭취 또는 거부 보고가 있습니다. 임상 기준에 따른 판정은 제공하지 않습니다.</span></div>}
          {evaluation && <div className="guard-warning"><strong>{evaluation.evaluation_status === 'CURRENT' ? 'CURRENT · 서버 데이터 신선도' : safetyStatusLabel(evaluation.evaluation_status)}</strong>
            {evaluation.result_codes.map((code) => <span key={code}>{safetyResultLabel(code)}</span>)}
            {evaluation.result_codes.length > 0 && (canAcknowledge ? <button type="button" className="secondary-action" onClick={() => void acknowledge(evaluation)}>경고 확인 기록</button> : acknowledged.includes(evaluation.id) ? <small>확인 이력이 있습니다. 경고가 해소되었다는 뜻은 아닙니다.</small> : null)}
          </div>}
          {!evaluation && <div className="guard-warning"><strong>UNVERIFIED · Safety Evaluation 없음</strong><span>현재 서버에서 평가 결과를 확인하지 못했습니다. 이전 상태로 대체하지 않습니다.</span></div>}
          {occurrence.status === 'SCHEDULE_TIME_UNRESOLVED' && <p role="alert">현지 시각이 존재하지 않거나 모호해 일정 시각을 자동 확정하지 않았습니다.</p>}
          {!record && ['SCHEDULED','SCHEDULE_TIME_UNRESOLVED'].includes(occurrence.status) && <Link className="button-link" to={`/record?event=${encodeURIComponent(occurrence.event_type)}&occurrence=${encodeURIComponent(occurrence.id)}`}>실제 발생 기록 열기</Link>}
        </li>;
      })}</ol> : <p className="small-note">오늘 생성된 일정이 없습니다. 루틴을 만들거나 서버에서 다시 확인해 주세요. 일정이 없어도 실제 기록은 빠른 기록에서 입력할 수 있습니다.</p>}
      <p className="small-note">일정이 지났거나 기록이 없다는 사실만으로 실제 미실시를 판정하지 않습니다. 실제 발생한 인슐린 투여는 경고와 무관하게 사후 기록할 수 있습니다.</p>
    </section>
    <section className="panel"><div className="section-heading"><h2>등록된 루틴</h2><button type="button" className="secondary-action" disabled={!canWrite} onClick={() => { setEditingId(null); setFormOpen(true); setName(''); setTimezone(pet.timezone); setDays([]); setTimes(''); setSteps([]); }}>새 루틴</button></div>
      {routines.map((routine) => {
        const version = versions.filter((item) => item.routine_id === routine.id).sort((a, b) => b.version_no - a.version_no)[0];
        return <article className="routine-config-row" key={routine.id}><div><strong>{routine.name}</strong><small>버전 {version?.version_no ?? '—'} · 개인 일정 · 수의사 승인 확인 {version?.care_plan_version_id ? '필요' : '불가'}</small></div><button type="button" className="secondary-action" disabled={!canWrite} onClick={() => beginEdit(routine)}>편집</button></article>;
      })}
      {!routines.length && <p className="small-note">등록된 루틴이 없습니다. 필요하면 관리용 일정을 직접 구성할 수 있습니다.</p>}
    </section>
    {formOpen && <section className="panel"><h2>{editingId ? '루틴 새 버전 만들기' : 'Care Routine 만들기'}</h2>
      <p className="small-note">단계 순서는 돌봄 안내로만 사용합니다. 임상적 조건이나 수의사 승인 지침을 등록하지 않습니다.</p>
      <form className="stack" onSubmit={(event) => void save(event)}>
        <label className="field-label">루틴 이름<input required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label className="field-label">시간대 (IANA)<input required value={timezone} onChange={(event) => setTimezone(event.target.value)} /></label>
        <fieldset className="invite-pets"><legend>반복 요일</legend><div className="day-picker">{dayLabels.map((day, index) => <label className="check-row" key={day}><input type="checkbox" checked={days.includes(index)} onChange={(event) => setDays((current) => event.target.checked ? [...current, index].sort() : current.filter((item) => item !== index))} />{day}</label>)}</div></fieldset>
        <label className="field-label">반복 시각<input required value={times} onChange={(event) => setTimes(event.target.value)} placeholder="사용자 입력 · 예: 08:00, 20:00" /><small>24시간 HH:MM, 쉼표로 구분. 처방 시각의 기본값은 제공하지 않습니다.</small></label>
        <fieldset className="invite-pets"><legend>단계와 안내용 선행 관계</legend>{steps.map((step, index) => <div className="step-editor" key={step.key}>
          <label className="field-label">단계 {index + 1}<select value={step.event_type} onChange={(event) => updateStep(index, { event_type: event.target.value })}>{Object.entries(eventLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
          <label className="field-label">선행 안내<select multiple value={step.predecessor_step_keys} onChange={(event) => updateStep(index, { predecessor_step_keys: Array.from(event.target.selectedOptions, (option) => option.value) })}>
            {steps.slice(0, index).map((prior, priorIndex) => <option value={prior.key} key={prior.key}>{priorIndex + 1}. {eventLabels[prior.event_type] ?? prior.event_type}</option>)}
          </select></label>
          <button type="button" className="danger-button" onClick={() => setSteps((current) => current.filter((_, itemIndex) => itemIndex !== index).map((item) => ({ ...item, predecessor_step_keys: item.predecessor_step_keys.filter((key) => key !== step.key) })))}>단계 삭제</button>
        </div>)}<button type="button" className="secondary-action" onClick={addStep}>단계 추가</button></fieldset>
        <div className="action-row"><button disabled={saving || !online || !canWrite}>{saving ? '저장 중…' : '서버에 루틴 저장'}</button><button type="button" className="secondary-action" onClick={() => { setEditingId(null); setFormOpen(false); setName(''); setDays([]); setTimes(''); setSteps([]); }}>취소</button></div>
      </form>
    </section>}
    <p className="medical-note">식사 → 투약 → 운동 순서는 관리 루틴의 예시일 뿐입니다. 실제 치료계획과 임상 판단은 담당 수의사의 확인을 따르며, 이 앱은 투여량·투여 가능 여부를 판단하지 않습니다.</p>
  </main>;
}

export type RoutineEventType = EventType | 'medication';
