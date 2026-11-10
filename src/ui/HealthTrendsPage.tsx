import { WeightTrends } from './WeightTrends';
import { useEffect, useMemo, useState, useRef, type PointerEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { glucoseMeasurementConditionLabel } from '../lib/event-entry';
import {
  DAILY_GLUCOSE_CONNECTION_GAP_DAYS, effectiveGlucoseValue, inPeriod, localDateKey, localMinuteOfDay, longGaps, measuredLineSegments, mgDlSamples, monthlyCounts, samplesForLocalDay,
  shiftLocalDate, sortSamples,
  type GlucoseSample, type NumericGlucoseSample, type TrendPeriod, type TrendPoint,
} from '../lib/health-trends';
import { supabase } from '../lib/supabase';
import { downloadPetProfilePhoto } from '../lib/pet-profile-persistence';
import { PET_AVATARS, isPetAvatarId } from '../lib/pet-profile';
import { GlucoseCareTools } from './GlucoseCareTools';

type TrendPet = { id: string; name: string; timezone: string; profileCanEdit?: boolean; profile_avatar_id?: string | null; profile_photo_object_path?: string | null };
type TargetRange = { id: string; lower_mg_dl: number; upper_mg_dl: number; source_label: string; effective_on: string };
type RawEvent = {
  id: string; occurred_at: string; recorded_at: string; actor_id: string; performer_id: string | null;
  value: Record<string, unknown>; unit: string | null; source?: string; occurrence_id: string | null; event_type: string;
};
type Revision = { event_id: string; revision_no: number; revision_kind: 'CORRECT' | 'VOID'; patch: Record<string, unknown> };
type Props = { pet: TrendPet; userId: string; online: boolean; demoEvents?: RawEvent[]; refreshVersion?: number; onSaveWeightTarget?: (eventId: string, expectedRevision: number, value: Record<string, unknown>) => Promise<boolean> };

const periods: { id: TrendPeriod; label: string }[] = [
  { id: '7d', label: '7일' }, { id: '30d', label: '30일' }, { id: '90d', label: '90일' },
  { id: '1y', label: '1년' }, { id: 'all', label: '전체' },
];
const dateTime = (instant: string, timezone: string) => new Intl.DateTimeFormat('ko-KR', {
  timeZone: timezone, dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(instant));
const dateOnly = (instant: string, timezone: string) => new Intl.DateTimeFormat('ko-KR', {
  timeZone: timezone, dateStyle: 'medium',
}).format(new Date(instant));
const actorName = (id: string | null | undefined, userId: string) => !id ? '미지정' : id === userId ? '나' : `공동 보호자 · ${id.slice(0, 8)}`;

function toSample(event: RawEvent, revision?: Revision): GlucoseSample | null {
  const value = revision?.patch.value;
  const correctedValue = effectiveGlucoseValue(event.value, revision?.patch);
  if (correctedValue === null || correctedValue === undefined || correctedValue === '') return null;
  const patchUnit = typeof revision?.patch.unit === 'string' ? revision.patch.unit : event.unit;
  const number = typeof correctedValue === 'number' ? correctedValue : Number(correctedValue);
  if (!Number.isFinite(number)) return null;
  const revisedValue = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const valuePatch = { ...event.value, ...revisedValue, ...(revision?.patch ?? {}) };
  return {
    id: event.id, occurredAt: event.occurred_at, recordedAt: event.recorded_at, value: number, unit: patchUnit,
    source: typeof valuePatch.measurement_source === 'string' ? valuePatch.measurement_source : '미기록',
    condition: typeof valuePatch.measurement_condition === 'string' ? valuePatch.measurement_condition : undefined,
    performerId: event.performer_id, actorId: event.actor_id,
    note: typeof valuePatch.note === 'string' ? valuePatch.note : undefined,
    revisionKind: revision?.revision_kind,
  };
}

export function HealthTrendsPage({ pet, userId, online, demoEvents, refreshVersion, onSaveWeightTarget }: Props) {
  const [portrait, setPortrait] = useState<{ path: string; url: string } | null>(null);
  useEffect(() => {
    if (!online || !supabase || !pet.profile_photo_object_path) return;
    let active = true;
    let url = '';
    void downloadPetProfilePhoto(supabase, pet.profile_photo_object_path).then((blob) => {
      if (active) { url = URL.createObjectURL(blob); setPortrait({ path: pet.profile_photo_object_path!, url }); }
    }).catch(() => undefined);
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [pet.id, pet.profile_photo_object_path, online]);
  const [searchParams] = useSearchParams();
  const [period, setPeriod] = useState<TrendPeriod>('30d');
 const [custom,setCustom]=useState(false);
 const [from,setFrom]=useState('');
 const [to,setTo]=useState('');
  // Day view is the primary workflow; an explicit query parameter can still open period trends.
  const [displayMode, setDisplayMode] = useState<'period' | 'day'>(() => searchParams.get('view') === 'period' ? 'period' : 'day');
  const [events, setEvents] = useState<RawEvent[]>(demoEvents ?? []);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [loading, setLoading] = useState(!demoEvents);
  const [verified, setVerified] = useState(Boolean(demoEvents));
  const [message, setMessage] = useState(demoEvents ? 'DEMO · 합성 데이터이며 서버 조회가 아닙니다.' : '');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [now] = useState(() => new Date());
  const [selectedDay, setSelectedDay] = useState(() => localDateKey(new Date().toISOString(), pet.timezone));
  const [targetRange, setTargetRange] = useState<TargetRange | null>(null);
  const [targetPetId, setTargetPetId] = useState<string | null>(null);
  const demo = Boolean(demoEvents);
  const sourceEvents = demoEvents ?? events;

  useEffect(() => {
    if (demoEvents) {
      return;
    }
    if (!online || !supabase) {
      return;
    }
    let active = true;
    void (async () => {
      const rows: RawEvent[] = [];
      const pageSize = 1000;
      for (let start = 0; ; start += pageSize) {
        const result = await supabase!.from('health_events')
          .select('id,event_type,occurred_at,recorded_at,actor_id,performer_id,value,unit,source,occurrence_id')
          .eq('pet_id', pet.id).in('event_type', ['glucose', 'weight'])
          .order('occurred_at', { ascending: true }).order('id', { ascending: true })
          .range(start, start + pageSize - 1);
        if (result.error) throw result.error;
        rows.push(...(result.data as RawEvent[]));
        if ((result.data?.length ?? 0) < pageSize) break;
      }
      const eventIds = rows.map((row) => row.id);
      const revisionRows: Revision[] = [];
      for (let start = 0; start < eventIds.length; start += 500) {
        const ids = eventIds.slice(start, start + 500);
        const result = await supabase!.from('health_event_revisions')
          .select('event_id,revision_no,revision_kind,patch').in('event_id', ids).order('revision_no', { ascending: true });
        if (result.error) throw result.error;
        revisionRows.push(...(result.data as Revision[]));
      }
      if (!active) return;
      setEvents(rows); setRevisions(revisionRows); setVerified(true); setLoading(false); setMessage('');
    })().catch(() => {
      if (!active) return;
      setEvents([]); setRevisions([]); setVerified(false); setLoading(false);
      setMessage('서버 추세를 불러오지 못했습니다. 접근권한과 연결을 확인할 때까지 최신 데이터는 표시하지 않습니다.');
    });
    return () => { active = false; };
  }, [demoEvents, online, pet.id, refreshVersion]);

  useEffect(() => {
    if (demo || !online || !supabase) return;
    let active = true;
    void supabase.from('pet_glucose_target_ranges').select('id,lower_mg_dl,upper_mg_dl,source_label,effective_on')
      .eq('pet_id', pet.id).is('superseded_at', null).maybeSingle()
      .then(({ data, error }) => { if (active) { setTargetRange(error ? null : data as TargetRange | null); setTargetPetId(pet.id); } });
    return () => { active = false; };
  }, [demo, online, pet.id]);
  const activeTargetRange = !demo && online && targetPetId === pet.id ? targetRange : null;

  const isVerified = demo || (online && verified);
  const isLoading = !demo && online && loading;
  const currentMessage = demo
    ? 'DEMO · 합성 데이터이며 서버 저장 또는 서버 조회가 아닙니다.'
    : !online || !supabase
      ? 'UNVERIFIED · 오프라인 또는 서버 연결 없음 · 최신 추세를 확인할 수 없습니다.'
      : message;

  const samplesAndExcluded = useMemo(() => {
    const latestByEvent = new Map<string, Revision>();
    for (const revision of revisions) {
      const current = latestByEvent.get(revision.event_id);
      if (!current || current.revision_no < revision.revision_no) latestByEvent.set(revision.event_id, revision);
    }
    const mapped = sourceEvents.filter((event) => event.event_type === 'glucose')
      .map((event) => toSample(event, latestByEvent.get(event.id))).filter((item): item is GlucoseSample => Boolean(item));
    return mgDlSamples(mapped);
  }, [sourceEvents, revisions]);
  const allSamples = samplesAndExcluded.valid;
  const samples = useMemo<NumericGlucoseSample[]>(() => inPeriod(allSamples, period, now), [allSamples, period, now]);
  const dailySamples = useMemo(() => samplesForLocalDay(allSamples, selectedDay, pet.timezone), [allSamples, selectedDay, pet.timezone]);
  const displayedSamples = displayMode === 'day' ? dailySamples : custom ? allSamples.filter(item => { const day=localDateKey(item.occurredAt,pet.timezone); return from && to && from <= to && day >= from && day <= to; }) : samples;
  const actualSegments = useMemo(() => displayMode === 'day'
    ? measuredLineSegments(displayedSamples, DAILY_GLUCOSE_CONNECTION_GAP_DAYS) : measuredLineSegments(displayedSamples), [displayMode, displayedSamples]);
  const newest = allSamples.at(-1);
  const previous = allSamples.at(-2);
  const average = displayedSamples.length >= 3 ? displayedSamples.reduce((sum, item) => sum + item.value, 0) / displayedSamples.length : null;
  const selected = displayedSamples.find((item) => item.id === selectedId) ?? displayedSamples.at(-1) ?? null;
  const monthly = useMemo(() => monthlyCounts(samples, pet.timezone), [samples, pet.timezone]);
  const gaps = useMemo(() => longGaps(samples, period === '7d' || period === '30d' ? 7 : period === '90d' ? 14 : 30), [samples, period]);
  const delta = newest && previous ? newest.value - previous.value : null;
  const excluded = samplesAndExcluded.excluded.filter((item) => period === 'all' || Date.parse(item.occurredAt) >= (period === '7d' ? now.getTime() - 7 * 86_400_000 : period === '30d' ? now.getTime() - 30 * 86_400_000 : period === '90d' ? now.getTime() - 90 * 86_400_000 : period === '1y' ? now.getTime() - 365 * 86_400_000 : 0));

  const glucoseCareTools = <GlucoseCareTools petId={pet.id} petName={pet.name} timezone={pet.timezone} canEdit={pet.profileCanEdit === true} demo={demo} target={activeTargetRange}
    onTargetSaved={async () => {
      if (!supabase || demo) return;
      const { data } = await supabase.from('pet_glucose_target_ranges').select('id,lower_mg_dl,upper_mg_dl,source_label,effective_on')
        .eq('pet_id', pet.id).is('superseded_at', null).maybeSingle();
      setTargetRange(data as TargetRange | null);
    }} />;

  return <main className="page-container trends-page">
    <section className="page-heading pet-photo-heading"><img className="pet-heading-portrait" src={online && portrait && portrait.path === pet.profile_photo_object_path ? portrait.url : PET_AVATARS.find((item) => item.id === (isPetAvatarId(pet.profile_avatar_id) ? pet.profile_avatar_id : 'dog-1'))!.src} alt={`${pet.name} 프로필`} /><div><p className="eyebrow">혈당기록</p><h1>{pet.name}의 혈당 기록</h1>
      <p>실제 측정값과 수의사에게서 안내받은 혈당 안정범위를 확인합니다. 그래프는 치료 효과나 투여 적정성을 판단하지 않습니다.</p></div></section>
    {currentMessage && <div className={demo ? 'notice notice-success' : 'notice notice-warning'} role={demo ? 'status' : 'alert'}>{currentMessage}</div>}
    {!online && !demo && <div className="notice notice-warning" role="status">UNVERIFIED · 마지막으로 본 값은 현재 최신 기록으로 확인되지 않았습니다.</div>}
    {isLoading && <p className="load-state" role="status">서버의 혈당 기록과 정정 이력을 확인하고 있습니다…</p>}
    {!isLoading && isVerified && <>
      <section className="panel trends-summary" aria-label="최근 측정 비교">
        <div><span className="eyebrow">최근 측정</span><strong>{newest ? `${newest.value} mg/dL` : '기록 없음'}</strong>
          <small>{newest ? dateTime(newest.occurredAt, pet.timezone) : '측정값이 없습니다'}</small></div>
        <div><span className="eyebrow">직전 측정 비교</span><strong>{delta === null ? '비교할 기록 없음' : `${delta > 0 ? '+' : ''}${delta} mg/dL`}</strong>
          <small>{delta === null || !previous ? '건강 상태의 개선·악화를 의미하지 않습니다' : `직전 측정 ${dateTime(previous.occurredAt, pet.timezone)} · 해석이 아닌 값 차이`}</small></div>
      </section>
      <section className="panel trends-panel">
        <div className="trends-heading"><div><p className="eyebrow">실제 측정값 : {displayedSamples.length}건</p><h2>{displayMode === 'day' ? `${selectedDay} 시간대별 혈당` : '시간에 따른 기록'}</h2></div>
          <Link className="button-link trends-add" to="/record?event=glucose">혈당 기록 추가</Link></div>
        <div className="trend-display-toggle" role="group" aria-label="혈당 그래프 보기">
          <button type="button" className={displayMode === 'period' ? 'period-chip selected' : 'period-chip'} aria-pressed={displayMode === 'period'} onClick={() => setDisplayMode('period')}>기간 추세</button>
          <button type="button" className={displayMode === 'day' ? 'period-chip selected' : 'period-chip'} aria-pressed={displayMode === 'day'} onClick={() => { setDisplayMode('day'); setSelectedId(null); }}>하루 보기</button>
        </div>
        {displayMode === 'day' && <div className="daily-graph-date">
          <button type="button" className="button-secondary" aria-label="이전 날짜" onClick={() => setSelectedDay((day) => shiftLocalDate(day, -1))}>이전</button>
          <label className="field-label">날짜<input type="date" value={selectedDay} onChange={(event) => { setSelectedDay(event.target.value); setSelectedId(null); }} /></label>
          <button type="button" className="button-secondary" aria-label="다음 날짜" onClick={() => setSelectedDay((day) => shiftLocalDate(day, 1))}>다음</button>
        </div>}

        {displayMode === 'period' && <div className="period-picker" role="group" aria-label="추세 기간">
          {periods.map((item) => <button type="button" key={item.id} className={!custom && period === item.id ? 'period-chip selected' : 'period-chip'}
            aria-pressed={!custom && period === item.id} onClick={() => { setCustom(false); setPeriod(item.id); setSelectedId(null); }}>{item.label}</button>)}<button type="button" className={custom ? "period-chip selected" : "period-chip"} aria-pressed={custom} onClick={() => setCustom(true)}>기간 지정</button>
        </div>}
        {displayMode === "period" && custom && <div className="custom-date-range"><label>시작일<input type="date" value={from} onChange={e=>setFrom(e.target.value)} /></label><label>종료일<input type="date" min={from} value={to} onChange={e=>setTo(e.target.value)} /></label>{to && from > to && <p role="alert">종료일을 확인해 주세요.</p>}</div>}
        {average !== null && <p className="glucose-average">평균 혈당 <strong>{average.toFixed(1)} mg/dL</strong><small>현재 그래프의 측정 {displayedSamples.length}건 · 산술평균</small></p>}
        {displayedSamples.length === 0 && <div className="trend-empty"><h3>{displayMode === 'day' ? '선택한 날짜에 혈당 기록이 없습니다' : '선택한 기간에 호환 가능한 혈당 기록이 없습니다'}</h3>
          <p>기록이 없는 구간은 빈 상태로 유지합니다. 측정값을 생성하거나 보간하지 않습니다.</p>
          {allSamples.length === 0 && <Link to="/record?event=glucose" className="text-link">실제로 측정한 값 기록하기</Link>}</div>}
        {(displayedSamples.length > 0 || (displayMode === 'day' && activeTargetRange !== null)) && <>
            <GlucoseScatterChart samples={displayedSamples} actualSegments={actualSegments} trendSegments={[]}
              timezone={pet.timezone} selectedId={selected?.id ?? null} onSelect={setSelectedId} mode={displayMode} targetRange={activeTargetRange} />


            {selected && <section className="sample-detail" aria-live="polite">
              <div className="share-selected-value"><strong>{selected.value} mg/dL</strong><span>{dateTime(selected.occurredAt, pet.timezone)} · {glucoseMeasurementConditionLabel(selected.condition)}</span></div>
              <details className="measurement-detail-extra"><summary>측정 상세 정보</summary><dl><div><dt>측정 출처</dt><dd>{selected.source ?? '미기록'}</dd></div>
                <div><dt>실제 측정자</dt><dd>{actorName(selected.performerId, userId)}</dd></div>
                <div><dt>기록자</dt><dd>{actorName(selected.actorId, userId)}</dd></div>
                <div><dt>서버 기록 시각</dt><dd>{dateTime(selected.recordedAt, pet.timezone)}</dd></div>
                {selected.revisionKind && <div><dt>이력</dt><dd>정정 이력이 반영된 값</dd></div>}
                {selected.note && <div><dt>메모</dt><dd>{selected.note}</dd></div>}
              </dl></details>
            </section>}
          </>}
        <section className="measurement-list"><h2>측정값 목록 : {displayedSamples.length}건</h2>
          {displayedSamples.length ? <ol>{[...displayedSamples].reverse().map((sample) => <li key={sample.id}>
            <button type="button" className={selected?.id === sample.id ? 'sample-row active' : 'sample-row'} onClick={() => setSelectedId(sample.id)}
              aria-label={`${dateTime(sample.occurredAt, pet.timezone)}, ${sample.value} mg/dL, 측정 상세 선택`}>
              <strong>{sample.value} mg/dL</strong><time dateTime={sample.occurredAt}>{dateTime(sample.occurredAt, pet.timezone)}</time>
            </button>
          </li>)}</ol> : <p>선택한 기간에 측정값이 없습니다.</p>}
        </section>
      </section>
      <WeightTrends key={pet.id} events={sourceEvents} revisions={revisions} timezone={pet.timezone} onSaveTarget={onSaveWeightTarget} />
      {glucoseCareTools}
      <Link className="button-link timeline-link" to={`/timeline?date=${encodeURIComponent(selected ? localDateKey(selected.occurredAt, pet.timezone) : selectedDay)}`}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
        하루 타임라인 열기
      </Link>
      {displayMode === 'period' && (period === '1y' || period === 'all') && <section className="panel monthly-panel"><h2>월별 실제 검사 횟수</h2>
        {monthly.length ? <ul className="monthly-counts">{monthly.map((item) => <li key={item.month}><span>{item.month}</span><strong>{item.count}회</strong></li>)}</ul>
          : <p>선택한 기간의 월별 기록이 없습니다.</p>}
        <p className="small-note">저장된 측정 건수만 집계했습니다. 월 평균·중앙값은 계산하지 않습니다.</p></section>}
      {displayMode === 'period' && gaps.length > 0 && <section className="notice notice-warning gap-notice"><strong>기록 간격 안내</strong>
        <ul>{gaps.slice(-8).map((gap) => <li key={`${gap.from}-${gap.to}`}>{dateOnly(gap.from, pet.timezone)}부터 {dateOnly(gap.to, pet.timezone)}까지 {gap.days}일 간격 · 해당 기간의 측정값은 표시하지 않았습니다.</li>)}</ul>
      </section>}
      {excluded.length > 0 && <details className="panel excluded-panel"><summary>그래프에서 제외된 기존 기록 {excluded.length}건</summary>
        <p>저장 단위가 mg/dL인지 확인되지 않았거나 값 형식이 호환되지 않아 변환 없이 제외했습니다.</p>
        <ul>{excluded.slice(-20).reverse().map((item) => <li key={item.id}>{dateTime(item.occurredAt, pet.timezone)} · 저장 단위 {item.unit ?? '미기록'} · 그래프 미표시</li>)}</ul>
      </details>}
    </>}
  </main>;
}

export function GlucoseScatterChart({ samples, actualSegments, trendSegments, timezone, selectedId, onSelect, mode, targetRange }: {
  samples: NumericGlucoseSample[]; actualSegments: NumericGlucoseSample[][]; trendSegments: TrendPoint[][];
  timezone: string; selectedId: string | null; onSelect: (id: string) => void; mode: 'period' | 'day'; targetRange: Pick<TargetRange, 'lower_mg_dl' | 'upper_mg_dl'> | null;
}) {
  const sorted = sortSamples(samples);
  const chartRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const height = 480;
  useEffect(() => {
    if (!chartRef.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setWidth(Math.max(280, entry.contentRect.width));
    });
    observer.observe(chartRef.current);
    return () => observer.disconnect();
  }, []);
  const left = 60; const right = 18; const top = 18; const bottom = 48;
  const times = sorted.map((item) => Date.parse(item.occurredAt));
  const values = sorted.map((item) => item.value);
  const minTime = Math.min(...times); const maxTime = Math.max(...times);
  const minValue = 0;
  const maxValue = Math.ceil(Math.max(500, ...values, targetRange?.upper_mg_dl ?? 0) / 50) * 50;
  const xFor = (time: number) => mode === 'day'
    ? left + localMinuteOfDay(new Date(time).toISOString(), timezone) / 1440 * (width - left - right)
    : maxTime === minTime ? (width + left - right) / 2 : left + (time - minTime) / (maxTime - minTime) * (width - left - right);
  const yFor = (value: number) => height - bottom - (value - minValue) / (maxValue - minValue || 1) * (height - top - bottom);
  const tickValues = Array.from({ length: maxValue / 50 + 1 }, (_, index) => index * 50);
  const periodSpan = maxTime - minTime;
  const periodTickCount = periodSpan > 0 ? Math.min(width < 470 ? 3 : width < 760 ? 4 : 6,
    Math.max(2, Math.floor(periodSpan / 86_400_000) + 1)) : 1;
  const periodFormatter = new Intl.DateTimeFormat('ko-KR', periodSpan < 2 * 86_400_000
    ? { timeZone: timezone, month: 'numeric', day: 'numeric', hour: 'numeric' }
    : { timeZone: timezone, month: 'numeric', day: 'numeric' });
  const periodTicks = mode === 'period' && times.length > 0 ? Array.from({ length: periodTickCount }, (_, index) => {
    const time = periodTickCount === 1 ? minTime : minTime + periodSpan * index / (periodTickCount - 1);
    return { time, label: periodFormatter.format(new Date(time)) };
  }).filter((tick, index, ticks) => index === 0 || tick.label !== ticks[index - 1].label) : [];
  const xTicks = mode === 'day' ? Array.from({ length: 25 }, (_, hour) => hour * 60) : [];
  const compactTimeLabels = width < 620;
  const timeLabelSize = Math.max(10, Math.min(15, width / 32));
  const xPositionForMinute = (minute: number) => left + minute / 1440 * (width - left - right);
  const pathsFor = <T extends { occurredAt: string; value: number }>(segments: T[][]) => segments.map((segment) =>
    segment.length > 1 ? `M ${xFor(Date.parse(segment[0].occurredAt))} ${yFor(segment[0].value)} ${segment.slice(1).map((point) => `L ${xFor(Date.parse(point.occurredAt))} ${yFor(point.value)}`).join(' ')}` : '').filter(Boolean);
  const actualPaths = actualSegments.map((segment) => {
    if (segment.length < 2) return '';
    const points = segment.map((point) => ({ x: xFor(Date.parse(point.occurredAt)), y: yFor(point.value) }));
    if (points.some((point, index) => index > 0 && point.x <= points[index - 1].x)) return pathsFor([segment])[0];
    const slopes = points.slice(1).map((point, index) => (point.y - points[index].y) / (point.x - points[index].x));
    const tangents = points.map((_, index) => {
      if (index === 0) return slopes[0];
      if (index === points.length - 1) return slopes.at(-1)!;
      if (slopes[index - 1] * slopes[index] <= 0) return 0;
      return Math.sign(slopes[index]) * Math.min(Math.abs(slopes[index - 1]), Math.abs(slopes[index]));
    });
    return `M ${points[0].x} ${points[0].y} ` + points.slice(1).map((point, index) => {
      const previous = points[index]; const dx = point.x - previous.x;
      return `C ${previous.x + dx / 3} ${previous.y + tangents[index] * dx / 3} ${point.x - dx / 3} ${point.y - tangents[index + 1] * dx / 3} ${point.x} ${point.y}`;
    }).join(' ');
  }).filter(Boolean);
  const trendPaths = pathsFor(trendSegments);
  const [dismissedId, setDismissedId] = useState<string | null>(null);
  const selectPoint = (id: string) => { onSelect(id); setDismissedId(null); };
  const tooltipSample = selectedId === dismissedId ? undefined : sorted.find((sample) => sample.id === selectedId);
  const tooltipWidth = 176;
  const tooltipHeight = 70;
  const tooltipPointX = tooltipSample ? xFor(Date.parse(tooltipSample.occurredAt)) : 0;
  const tooltipPointY = tooltipSample ? yFor(tooltipSample.value) : 0;
  const tooltipX = Math.max(left, Math.min(width - right - tooltipWidth, tooltipPointX - tooltipWidth / 2));
  const tooltipAbove = tooltipPointY - tooltipHeight - 14 >= top;
  const tooltipY = tooltipAbove ? tooltipPointY - tooltipHeight - 14 : tooltipPointY + 14;
  const selectNearest = (event: PointerEvent<SVGSVGElement>) => {
    const svg = event.currentTarget;
    const matrix = svg.getScreenCTM();
    if (!matrix) return;
    const point = svg.createSVGPoint();
    let closest: NumericGlucoseSample | null = null;
    let distance = Number.POSITIVE_INFINITY;
    for (const sample of sorted) {
      point.x = xFor(Date.parse(sample.occurredAt)); point.y = yFor(sample.value);
      const screenPoint = point.matrixTransform(matrix);
      const nextDistance = Math.hypot(screenPoint.x - event.clientX, screenPoint.y - event.clientY);
      if (nextDistance < distance) { distance = nextDistance; closest = sample; }
    }
    if (closest && distance <= 22) selectPoint(closest.id);
    else setDismissedId(selectedId);
  };
  return <div ref={chartRef} className="chart-scroll" role="group" aria-label="실제 혈당 측정값 산점도와 데이터 목록">
    <svg className="glucose-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${mode === 'day' ? '하루 시간대별' : '기간별'} 실제 측정 기록 ${sorted.length}건과 mg/dL 값. 측정점을 선택하면 상세 정보를 확인합니다.`}
      onPointerUp={selectNearest}>
      {targetRange && <rect x={left} y={yFor(targetRange.upper_mg_dl)} width={width - left - right}
        height={Math.max(0, yFor(targetRange.lower_mg_dl) - yFor(targetRange.upper_mg_dl))} className="target-band" />}
      {tickValues.map((value) => <g key={value}>
        <line x1={left} x2={width - right} y1={yFor(value)} y2={yFor(value)} stroke="#dce7df" strokeDasharray="4 6" />
        <text x={left - 10} y={yFor(value) + 5} textAnchor="end" className="chart-axis-label">{Number(value.toFixed(1))}</text>
      </g>)}
      {targetRange && <text x={left + 8} y={yFor(targetRange.upper_mg_dl) + 16} className="target-band-label">
        혈당 안정범위 {targetRange.lower_mg_dl}–{targetRange.upper_mg_dl} mg/dL</text>}
      {xTicks.map((minute) => {
        const major = minute % 180 === 0;
        const hour = minute / 60;
        const meridiem = hour < 12 || hour === 24 ? '오전' : '오후';
        const clockHour = hour % 12 || 12;
        const x = xPositionForMinute(minute);
        return <g key={minute} className="hour-tick">
          <line x1={x} x2={x} y1={height - bottom} y2={height - bottom + (major ? 9 : 5)} stroke="#8da295" />
          {major && <text x={x} y={height - bottom + 23} textAnchor={minute === 0 ? 'start' : minute === 1440 ? 'end' : 'middle'}
            className="chart-axis-label time-axis-label" style={{ fontSize: timeLabelSize }} aria-label={hour === 24 ? '다음 날 오전 12시' : meridiem + ' ' + clockHour + '시'}>
            {compactTimeLabels ? <><tspan x={x}>{meridiem}</tspan><tspan x={x} dy="1.2em">{clockHour}시</tspan></> : meridiem + ' ' + clockHour + '시'}
          </text>}
        </g>;
      })}
      <line x1={left} x2={width - right} y1={height - bottom} y2={height - bottom} stroke="#8da295" />
      {actualPaths.map((path, index) => <path key={`actual-${index}`} d={path} className="actual-series-line" aria-hidden="true" />)}
      {trendPaths.map((path, index) => <path key={`trend-${index}`} d={path} className="derived-trend-line" aria-hidden="true" />)}
      {mode === 'period' && periodTicks.map((tick, index) => <g key={`${tick.time}-${index}`}>
        <line x1={xFor(tick.time)} x2={xFor(tick.time)} y1={height - bottom} y2={height - bottom + 7} stroke="#8da295" />
        <text x={xFor(tick.time)} y={height - 14} textAnchor={index === 0 ? 'start' : index === periodTicks.length - 1 ? 'end' : 'middle'}
          className="chart-axis-label">{tick.label}</text>
      </g>)}
      {sorted.map((sample, index) => <g key={`${sample.id}-${index}`}>
        <circle cx={xFor(Date.parse(sample.occurredAt))} cy={yFor(sample.value)} r={sample.id === selectedId ? 8 : sorted.length > 120 ? 3.5 : sorted.length > 40 ? 5 : 7}
          className={sample.id === selectedId ? 'chart-point selected' : 'chart-point'}
          role="button" tabIndex={0} aria-label={dateTime(sample.occurredAt, timezone) + ' · ' + sample.value + ' mg/dL'}
          onClick={() => selectPoint(sample.id)} onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectPoint(sample.id); }
            if (event.key === 'Escape') setDismissedId(selectedId);
          }} />
        <title>{dateTime(sample.occurredAt, timezone)} · {sample.value} mg/dL</title>
      </g>)}
      {tooltipSample && <g className="glucose-point-tooltip" role="status" aria-live="polite" style={{ pointerEvents: 'none' }}>
        <line x1={tooltipPointX} y1={tooltipPointY} x2={Math.max(tooltipX + 12, Math.min(tooltipX + tooltipWidth - 12, tooltipPointX))}
          y2={tooltipAbove ? tooltipY + tooltipHeight : tooltipY} stroke="#527560" />
        <rect x={tooltipX} y={tooltipY} width={tooltipWidth} height={tooltipHeight} rx={10} fill="#fffefa" stroke="#527560" />
        <text x={tooltipX + 12} y={tooltipY + 23} fill="#174b40" fontSize={17} fontWeight={700}>{tooltipSample.value} mg/dL</text>
        <text x={tooltipX + 12} y={tooltipY + 43} fill="#405e4d" fontSize={12}>{new Intl.DateTimeFormat('ko-KR', {timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric'}).format(new Date(tooltipSample.occurredAt))}</text>
        <text x={tooltipX + 12} y={tooltipY + 59} fill="#405e4d" fontSize={13}>{new Intl.DateTimeFormat('ko-KR', {timeZone: timezone, hour: 'numeric', minute: '2-digit', second: '2-digit'}).format(new Date(tooltipSample.occurredAt))}</text>
      </g>}
      <text x={width - right} y={14} textAnchor="end" className="chart-unit-label">mg/dL</text>
    </svg>
  </div>;
}
