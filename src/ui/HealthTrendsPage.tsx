import { useEffect, useMemo, useState, type PointerEvent } from 'react';
import { Link } from 'react-router-dom';
import { glucoseMeasurementConditionLabel } from '../lib/event-entry';
import {
  effectiveGlucoseValue, inPeriod, localDateKey, longGaps, measuredLineSegments, mgDlSamples, monthlyCounts,
  sortSamples, trendLineSegments, trendPoints,
  type GlucoseSample, type NumericGlucoseSample, type TrendPeriod, type TrendPoint,
} from '../lib/health-trends';
import { supabase } from '../lib/supabase';

type TrendPet = { id: string; name: string; timezone: string };
type RawEvent = {
  id: string; occurred_at: string; recorded_at: string; actor_id: string; performer_id: string | null;
  value: Record<string, unknown>; unit: string | null; source?: string; occurrence_id: string | null; event_type: string;
};
type Revision = { event_id: string; revision_no: number; revision_kind: 'CORRECT' | 'VOID'; patch: Record<string, unknown> };
type Props = { pet: TrendPet; userId: string; online: boolean; demoEvents?: RawEvent[] };

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
const timeOnly = (instant: string, timezone: string) => new Intl.DateTimeFormat('ko-KR', {
  timeZone: timezone, hour: '2-digit', minute: '2-digit',
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

export function HealthTrendsPage({ pet, userId, online, demoEvents }: Props) {
  const [period, setPeriod] = useState<TrendPeriod>('30d');
  const [events, setEvents] = useState<RawEvent[]>(demoEvents ?? []);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [loading, setLoading] = useState(!demoEvents);
  const [verified, setVerified] = useState(Boolean(demoEvents));
  const [message, setMessage] = useState(demoEvents ? 'DEMO · 합성 데이터이며 서버 조회가 아닙니다.' : '');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showTrend, setShowTrend] = useState(false);
  const [relatedEvents, setRelatedEvents] = useState<RawEvent[]>([]);
  const [now] = useState(() => new Date());
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
          .eq('pet_id', pet.id).eq('event_type', 'glucose')
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
  }, [demoEvents, online, pet.id]);

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
  const actualSegments = useMemo(() => measuredLineSegments(samples), [samples]);
  const derivedTrend = useMemo(() => trendPoints(samples, period, pet.timezone), [samples, period, pet.timezone]);
  const derivedSegments = useMemo(() => trendLineSegments(derivedTrend, period), [derivedTrend, period]);
  const trendSampleCount = derivedTrend.reduce((sum, point) => sum + point.count, 0);
  const newest = allSamples.at(-1);
  const previous = allSamples.at(-2);
  const selected = samples.find((item) => item.id === selectedId) ?? samples.at(-1) ?? null;
  const sameDay = selected ? allSamples.filter((item) => localDateKey(item.occurredAt, pet.timezone) === localDateKey(selected.occurredAt, pet.timezone)) : [];
  const selectedDay = selected ? localDateKey(selected.occurredAt, pet.timezone) : '';
  const monthly = useMemo(() => monthlyCounts(samples, pet.timezone), [samples, pet.timezone]);
  const gaps = useMemo(() => longGaps(samples, period === '7d' || period === '30d' ? 7 : period === '90d' ? 14 : 30), [samples, period]);
  const delta = newest && previous ? newest.value - previous.value : null;
  const excluded = samplesAndExcluded.excluded.filter((item) => period === 'all' || Date.parse(item.occurredAt) >= (period === '7d' ? now.getTime() - 7 * 86_400_000 : period === '30d' ? now.getTime() - 30 * 86_400_000 : period === '90d' ? now.getTime() - 90 * 86_400_000 : period === '1y' ? now.getTime() - 365 * 86_400_000 : 0));

  useEffect(() => {
    if (!selectedDay || demo || !online || !supabase) return;
    let active = true;
    const [year, month, day] = selectedDay.split('-').map(Number);
    const midnight = Date.UTC(year, month - 1, day);
    void supabase.from('health_events')
      .select('id,event_type,occurred_at,recorded_at,actor_id,performer_id,value,unit,source,occurrence_id')
      .eq('pet_id', pet.id).in('event_type', ['meal', 'insulin'])
      .gte('occurred_at', new Date(midnight - 14 * 60 * 60 * 1000).toISOString())
      .lt('occurred_at', new Date(midnight + 38 * 60 * 60 * 1000).toISOString())
      .order('occurred_at', { ascending: true }).then(({ data, error }) => {
        if (!active) return;
        if (error) { setRelatedEvents([]); return; }
        setRelatedEvents(((data ?? []) as RawEvent[]).filter((event) => localDateKey(event.occurred_at, pet.timezone) === selectedDay));
      });
    return () => { active = false; };
  }, [selectedDay, demo, online, pet.id, pet.timezone]);
  const dayContext = demoEvents
    ? demoEvents.filter((event) => ['meal', 'insulin'].includes(event.event_type) && localDateKey(event.occurred_at, pet.timezone) === selectedDay)
    : relatedEvents;

  return <main className="page-container trends-page">
    <section className="page-heading"><p className="eyebrow">건강 추세</p><h1>{pet.name}의 혈당 기록</h1>
      <p>저장된 실제 측정값만 시간순으로 표시합니다. 그래프는 측정 결과를 해석하거나 치료 효과를 판단하지 않습니다.</p></section>
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
        <div className="trends-heading"><div><p className="eyebrow">실제 측정값</p><h2>시간에 따른 기록</h2></div>
          <Link className="button-link trends-add" to="/record?event=glucose">혈당 기록 추가</Link></div>
        <div className="trend-controls">
          <label className="trend-toggle"><input type="checkbox" checked={showTrend} onChange={(event) => setShowTrend(event.target.checked)} />
            <span>계산 추세 보기</span></label>
          {showTrend && <span className="small-note">{period === '1y' || period === 'all' ? '월별 중앙값' : '7일 구간 중앙값'} · 실제 측정 {trendSampleCount}건 · 최소 3개 구간 필요</span>}
        </div>
        <div className="period-picker" role="group" aria-label="추세 기간">
          {periods.map((item) => <button type="button" key={item.id} className={period === item.id ? 'period-chip selected' : 'period-chip'}
            aria-pressed={period === item.id} onClick={() => { setPeriod(item.id); setSelectedId(null); }}>{item.label}</button>)}
        </div>
        {samples.length === 0 ? <div className="trend-empty"><h3>선택한 기간에 호환 가능한 혈당 기록이 없습니다</h3>
          <p>기록이 없는 구간은 빈 상태로 유지합니다. 측정값을 생성하거나 보간하지 않습니다.</p>
          {allSamples.length === 0 && <Link to="/record?event=glucose" className="text-link">실제로 측정한 값 기록하기</Link>}</div>
          : <>
            <GlucoseScatterChart samples={samples} actualSegments={actualSegments} trendSegments={showTrend ? derivedSegments : []}
              timezone={pet.timezone} selectedId={selected?.id ?? null} onSelect={setSelectedId} />
            <p className="chart-caption">X축은 실제 측정 시각에 비례합니다. 얇은 실선은 7일 이내의 실제 측정값끼리만 직선 연결하며 그 사이 값은 측정값이 아닙니다.
              {showTrend ? ' 점선은 선택한 기간별 중앙값으로 계산한 참고 추세이며 임상 판단이 아닙니다.' : ''} 단위: mg/dL</p>
            {showTrend && derivedSegments.length === 0 && <p className="small-note" role="status">연결 가능한 구간이 부족해 계산 추세를 표시하지 않습니다. 미측정 구간을 가로질러 추세선을 그리지 않습니다.</p>}
            {selected && <section className="sample-detail" aria-live="polite">
              <div><p className="eyebrow">선택한 측정</p><h3>{selected.value} mg/dL</h3><p>{dateTime(selected.occurredAt, pet.timezone)}</p></div>
              <dl><div><dt>측정 출처</dt><dd>{selected.source ?? '미기록'}</dd></div>
                <div><dt>측정 조건</dt><dd>{glucoseMeasurementConditionLabel(selected.condition)}</dd></div>
                <div><dt>실제 측정자</dt><dd>{actorName(selected.performerId, userId)}</dd></div>
                <div><dt>기록자</dt><dd>{actorName(selected.actorId, userId)}</dd></div>
                <div><dt>서버 기록 시각</dt><dd>{dateTime(selected.recordedAt, pet.timezone)}</dd></div>
                {selected.revisionKind && <div><dt>이력</dt><dd>정정 이력이 반영된 값</dd></div>}
                {selected.note && <div><dt>메모</dt><dd>{selected.note}</dd></div>}
              </dl>
              <Link className="text-link" to={`/timeline?date=${encodeURIComponent(localDateKey(selected.occurredAt, pet.timezone))}`}>하루 타임라인 열기 · {dateOnly(selected.occurredAt, pet.timezone)}</Link>
              {sameDay.length > 1 && <p className="small-note">이 날짜에 실제 기록된 측정 {sameDay.length}건 · 모든 측정 시각은 아래 목록에 표시됩니다.</p>}
              {dayContext.length > 0 && <div className="day-context"><h4>같은 날의 식사·인슐린 기록</h4>
                <ul>{dayContext.map((event) => <li key={event.id}><span>{timeOnly(event.occurred_at, pet.timezone)} · {event.event_type === 'meal' ? '식사 기록' : '인슐린 사실 기록'}</span>
                  <small>수행자 {actorName(event.performer_id, userId)} · 기록자 {actorName(event.actor_id, userId)}</small></li>)}</ul>
                <small>시각과 기록의 관계만 보여줍니다. 인슐린 용량 또는 혈당 변화의 의학적 예측을 제공하지 않습니다.</small>
              </div>}
            </section>}
          </>}
      </section>
      {(period === '1y' || period === 'all') && <section className="panel monthly-panel"><h2>월별 실제 검사 횟수</h2>
        {monthly.length ? <ul className="monthly-counts">{monthly.map((item) => <li key={item.month}><span>{item.month}</span><strong>{item.count}회</strong></li>)}</ul>
          : <p>선택한 기간의 월별 기록이 없습니다.</p>}
        <p className="small-note">저장된 측정 건수만 집계했습니다. 월 평균·중앙값은 계산하지 않습니다.</p></section>}
      {gaps.length > 0 && <section className="notice notice-warning gap-notice"><strong>기록 간격 안내</strong>
        <ul>{gaps.slice(-8).map((gap) => <li key={`${gap.from}-${gap.to}`}>{dateOnly(gap.from, pet.timezone)}부터 {dateOnly(gap.to, pet.timezone)}까지 {gap.days}일 간격 · 해당 기간의 측정값은 표시하지 않았습니다.</li>)}</ul>
      </section>}
      <section className="panel measurement-list"><h2>측정값 목록</h2>
        {samples.length ? <ol>{[...samples].reverse().map((sample) => <li key={sample.id}>
          <button type="button" className={selected?.id === sample.id ? 'sample-row active' : 'sample-row'} onClick={() => setSelectedId(sample.id)}
            aria-label={`${dateTime(sample.occurredAt, pet.timezone)}, ${sample.value} mg/dL, 측정 상세 선택`}>
            <span><strong>{sample.value} mg/dL</strong><small>{dateTime(sample.occurredAt, pet.timezone)}</small></span>
            <span><small>실제 측정자 {actorName(sample.performerId, userId)}</small><small>기록자 {actorName(sample.actorId, userId)}</small></span>
          </button>
        </li>)}</ol> : <p>선택한 기간에 측정값이 없습니다.</p>}
      </section>
      {excluded.length > 0 && <details className="panel excluded-panel"><summary>그래프에서 제외된 기존 기록 {excluded.length}건</summary>
        <p>저장 단위가 mg/dL인지 확인되지 않았거나 값 형식이 호환되지 않아 변환 없이 제외했습니다.</p>
        <ul>{excluded.slice(-20).reverse().map((item) => <li key={item.id}>{dateTime(item.occurredAt, pet.timezone)} · 저장 단위 {item.unit ?? '미기록'} · 그래프 미표시</li>)}</ul>
      </details>}
      <p className="timeline-footnote">혈액검사 항목은 검사법과 단위에 따라 별도로 관리해야 하며 이 혈당 그래프에 섞지 않습니다. 자동 진단이나 투약 판단은 제공하지 않습니다.</p>
    </>}
  </main>;
}

function GlucoseScatterChart({ samples, actualSegments, trendSegments, timezone, selectedId, onSelect }: {
  samples: NumericGlucoseSample[]; actualSegments: NumericGlucoseSample[][]; trendSegments: TrendPoint[][];
  timezone: string; selectedId: string | null; onSelect: (id: string) => void;
}) {
  const sorted = sortSamples(samples);
  const width = 800; const height = 300;
  const left = 60; const right = 18; const top = 18; const bottom = 48;
  const times = sorted.map((item) => Date.parse(item.occurredAt));
  const values = sorted.map((item) => item.value);
  const minTime = Math.min(...times); const maxTime = Math.max(...times);
  const minValue = Math.min(...values); const maxValue = Math.max(...values);
  const xFor = (time: number) => maxTime === minTime ? (width + left - right) / 2 : left + (time - minTime) / (maxTime - minTime) * (width - left - right);
  const yFor = (value: number) => maxValue === minValue ? (height - bottom + top) / 2 : height - bottom - (value - minValue) / (maxValue - minValue) * (height - top - bottom);
  const tickValues = minValue === maxValue ? [minValue] : [minValue, (minValue + maxValue) / 2, maxValue];
  const startLabel = new Intl.DateTimeFormat('ko-KR', { timeZone: timezone, month: 'numeric', day: 'numeric' }).format(new Date(minTime));
  const endLabel = new Intl.DateTimeFormat('ko-KR', { timeZone: timezone, month: 'numeric', day: 'numeric' }).format(new Date(maxTime));
  const pathsFor = <T extends { occurredAt: string; value: number }>(segments: T[][]) => segments.map((segment) =>
    segment.length > 1 ? `M ${xFor(Date.parse(segment[0].occurredAt))} ${yFor(segment[0].value)} ${segment.slice(1).map((point) => `L ${xFor(Date.parse(point.occurredAt))} ${yFor(point.value)}`).join(' ')}` : '').filter(Boolean);
  const actualPaths = pathsFor(actualSegments);
  const trendPaths = pathsFor(trendSegments);
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
    if (closest && distance <= 22) onSelect(closest.id);
  };
  return <div className="chart-scroll" role="group" aria-label="실제 혈당 측정값 산점도와 데이터 목록">
    <svg className="glucose-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`측정 기록 ${sorted.length}건의 실제 측정 시각과 mg/dL 값 그래프. 측정점을 선택하면 상세 정보를 확인합니다.`}
      onPointerUp={selectNearest}>
      {tickValues.map((value) => <g key={value}>
        <line x1={left} x2={width - right} y1={yFor(value)} y2={yFor(value)} stroke="#dce7df" strokeDasharray="4 6" />
        <text x={left - 10} y={yFor(value) + 5} textAnchor="end" className="chart-axis-label">{Number(value.toFixed(1))}</text>
      </g>)}
      <line x1={left} x2={width - right} y1={height - bottom} y2={height - bottom} stroke="#8da295" />
      {actualPaths.map((path, index) => <path key={`actual-${index}`} d={path} className="actual-series-line" aria-hidden="true" />)}
      {trendPaths.map((path, index) => <path key={`trend-${index}`} d={path} className="derived-trend-line" aria-hidden="true" />)}
      <text x={left} y={height - 14} className="chart-axis-label">{startLabel}</text>
      <text x={width - right} y={height - 14} textAnchor="end" className="chart-axis-label">{endLabel}</text>
      {sorted.map((sample, index) => <g key={`${sample.id}-${index}`} aria-hidden="true">
        <circle cx={xFor(Date.parse(sample.occurredAt))} cy={yFor(sample.value)} r={sample.id === selectedId ? 8 : sorted.length > 120 ? 3.5 : sorted.length > 40 ? 5 : 7}
          className={sample.id === selectedId ? 'chart-point selected' : 'chart-point'} />
        <title>{dateTime(sample.occurredAt, timezone)} · {sample.value} mg/dL</title>
      </g>)}
      <text x={width - right} y={14} textAnchor="end" className="chart-unit-label">mg/dL</text>
    </svg>
  </div>;
}
