import { WeightTrends } from './WeightTrends';
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { measuredLineSegments, localDateKey, samplesForLocalDay, shiftLocalDate, type GlucoseSample, type TrendPeriod } from '../lib/health-trends';
import { callGlucoseShare, GlucoseShareRequestError, type GlucoseSharePayload } from '../lib/glucose-share';
import { supabase } from '../lib/supabase';
import { PET_AVATARS } from '../lib/pet-profile';
import { glucoseMeasurementConditionLabel } from '../lib/event-entry';

import { GlucoseScatterChart } from './HealthTrendsPage';

type ShareSample = GlucoseSample & { value: number };
const periods: { id: TrendPeriod; label: string; days?: number }[] = [
  { id: '7d', label: '7일', days: 7 }, { id: '30d', label: '30일', days: 30 },
  { id: '90d', label: '90일', days: 90 }, { id: '1y', label: '1년', days: 365 }, { id: 'all', label: '전체' },
];
const formatDate = (date: string) => new Intl.DateTimeFormat('ko-KR', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
const formatTime = (instant: string, timezone: string) => new Intl.DateTimeFormat('ko-KR', {
  timeZone: timezone, dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(instant));
const formatClock = (instant: string, timezone: string) => new Intl.DateTimeFormat('ko-KR', {
  timeZone: timezone, hour: 'numeric', minute: '2-digit',
}).format(new Date(instant));
const formatTimelineDate = (instant: string, timezone: string) => new Intl.DateTimeFormat('ko-KR', {
  timeZone: timezone, year: 'numeric', month: 'numeric', day: 'numeric',
}).format(new Date(instant));

function ShareCareIcon({ type }: { type: 'meal' | 'insulin' }) {
  return <span className={`share-care-icon share-care-icon--${type}`} aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">
    {type === 'meal' ? <g fill="currentColor" transform="rotate(-38 12 12)"><rect x="10.5" y="5" width="3" height="14" rx="1.5"/><circle cx="9" cy="6.8" r="3.2"/><circle cx="15" cy="6.8" r="3.2"/><circle cx="9" cy="17.2" r="3.2"/><circle cx="15" cy="17.2" r="3.2"/></g>
      : <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" transform="rotate(42 12 12)">
        <rect x="8" y="5.5" width="8" height="12" rx="1.5"/><path d="M7 5.5h10M12 2v3.5M9 2h6M12 17.5V22m-2 0h4M8.5 9h3M8.5 12h3M8.5 15h3"/>
      </g>}
  </svg></span>;
}

function GuardianContactIcon({ type }: { type: 'phone' | 'message' }) {
  return <svg className="guardian-contact-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    {type === 'phone'
      ? <path d="M7 3.5h3l1.5 4-2 1.7a15 15 0 0 0 5.3 5.3l1.7-2 4 1.5v3c0 1.1-.9 2-2 2A15.5 15.5 0 0 1 5 5.5c0-1.1.9-2 2-2Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      : <path d="M4 5.5h16v11H9l-5 3v-14Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />}
  </svg>;
}

export function GlucoseSharePage() {
  const { token = '' } = useParams();
  const [result, setResult] = useState<{ token: string; share?: GlucoseSharePayload; error?: string } | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [chosenDay, setChosenDay] = useState('');
  const [displayMode, setDisplayMode] = useState<'day' | 'period'>('day');
  const [period, setPeriod] = useState<TrendPeriod>('30d');
 const [custom,setCustom]=useState(false);
 const [from,setFrom]=useState('');
 const [to,setTo]=useState('');
  const [portrait, setPortrait] = useState<{ token: string; url: string } | null>(null);

  useEffect(() => {
    let active = true;
    if (!supabase || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      return () => { active = false; };
    }
    void callGlucoseShare<{ share: GlucoseSharePayload }>(supabase, { action: 'resolve', token })
      .then((response) => { if (active) { setResult({ token, share: response.share }); setSelectedId(response.share.measurements.at(-1)?.id ?? ''); } })
      .catch((error: unknown) => {
        if (!active) return;
        const code = error instanceof GlucoseShareRequestError ? error.code : '';
        const unavailable = code === 'SHARE_FUNCTION_NOT_DEPLOYED' || code === 'SHARE_SCHEMA_UNAVAILABLE' || code === 'SHARE_SERVICE_UNAVAILABLE';
        setResult({ token, error: unavailable
          ? '혈당 공유 서버가 아직 준비되지 않았거나 일시적으로 응답하지 않습니다. 링크를 만든 보호자에게 확인을 요청해 주세요.'
          : '공유 링크가 만료되었거나 취소되었거나 현재 열 수 없습니다. 링크를 만든 보호자에게 새 링크를 요청해 주세요.' });
      });
    return () => { active = false; };
  }, [token]);

  const share = result?.token === token ? result.share ?? null : null;
  useEffect(() => {
    if (!share || !supabase?.functions?.invoke) return;
    let active = true;
    let url = '';
    void supabase.functions.invoke<Blob>('glucose-share', { body: { action: 'photo', token } }).then(({ data, error }) => {
      if (active && !error && data instanceof Blob && data.type === 'application/octet-stream' && data.size <= 1048576) {
        url = URL.createObjectURL(new Blob([data], { type: 'image/jpeg' })); setPortrait({ token, url });
      }
    }).catch(() => undefined);
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [share, token]);
  const invalidToken = !supabase || !/^[A-Za-z0-9_-]{43}$/.test(token);
  const error = invalidToken ? '공유 링크를 열 수 없습니다. 링크가 올바른지 확인해 주세요.'
    : result?.token === token ? result.error ?? '' : '';
  const loading = !invalidToken && result?.token !== token;

  const samples = useMemo<ShareSample[]>(() => (share?.measurements ?? []).filter((item) => item.unit === 'mg/dL')
    .map((item) => ({ id: item.id, occurredAt: item.occurred_at, recordedAt: item.recorded_at,
      value: Number(item.value.observed_value), unit: item.unit,
      condition: typeof item.value.measurement_condition === 'string' ? item.value.measurement_condition : undefined,
      source: typeof item.value.measurement_source === 'string' ? item.value.measurement_source : '미기록',
      revisionKind: item.revision_kind === 'CORRECT' ? 'CORRECT' as const : undefined }))
    .filter((item) => Number.isFinite(item.value)), [share]);
  const chronologicalSamples = [...samples].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id));
  const latest = chronologicalSamples.at(-1);
  const previous = chronologicalSamples.at(-2);
  const delta = latest && previous ? latest.value - previous.value : null;
  const todayInPetTimezone = share ? localDateKey(new Date().toISOString(), share.timezone) : '';
  const day = chosenDay || (share && share.from_date <= todayInPetTimezone && todayInPetTimezone <= share.to_date
    ? todayInPetTimezone : share && latest ? localDateKey(latest.occurredAt, share.timezone) : share?.to_date ?? '');
  const daily = share ? samplesForLocalDay(samples, day, share.timezone) : [];
  const careTimes = (share?.care_times.filter((item) => localDateKey(item.occurred_at, share.timezone) === day) ?? [])
    .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at)
      || (a.event_type === 'meal' ? -1 : 1) - (b.event_type === 'meal' ? -1 : 1));
  const anchorDay = share && todayInPetTimezone < share.to_date ? todayInPetTimezone : share?.to_date ?? '';
  const periodDays = periods.find((item) => item.id === period)?.days;
  const cutoffDay = periodDays && anchorDay ? shiftLocalDate(anchorDay, 1 - periodDays) : share?.from_date ?? '';
  const periodSamples = share ? samples.filter((item) => localDateKey(item.occurredAt, share.timezone) >= cutoffDay
    && localDateKey(item.occurredAt, share.timezone) <= anchorDay) : [];
  const displayedSamples = displayMode === 'day' ? daily : custom ? samples.filter(item => { const day=localDateKey(item.occurredAt,share?.timezone ?? 'UTC'); return from && to && from <= to && day >= from && day <= to; }) : periodSamples;
  const average = displayedSamples.length >= 3 ? displayedSamples.reduce((sum, item) => sum + item.value, 0) / displayedSamples.length : null;
  const selected = displayedSamples.find((item) => item.id === selectedId) ?? displayedSamples.at(-1) ?? null;
  const actualSegments = measuredLineSegments(displayedSamples, displayMode === 'day' ? Number.POSITIVE_INFINITY : 7);

  if (loading) return <main className="page-container trends-loading-page public-glucose-share" role="status" aria-live="polite" aria-busy="true">
    <div className="loading-spinner" aria-hidden="true" /><h1>공유 기록을 불러오고 있어요</h1>
    <p>공유 권한과 최신 기록을 확인하고 있습니다.</p>
  </main>;

  return <main className="page-container public-glucose-share">
    <header className="page-heading pet-photo-heading">{share && <img className="pet-heading-portrait" src={portrait?.token === token ? portrait.url : PET_AVATARS[0].src} alt={`${share.pet_name} 프로필`} />}<div><p className="eyebrow">HaniLog · 건강 기록 공유</p>
      <h1>{share ? `${share.pet_name}의 혈당 기록` : '혈당 기록 공유'}</h1>
      {share && <p>{samples.length ? formatDate(localDateKey(samples.reduce((a,b)=>a.occurredAt < b.occurredAt ? a : b).occurredAt,share.timezone)) : '기록 없음'} ~ {formatDate(todayInPetTimezone)}</p>}
    </div></header>
    {error && !loading && <section className="panel empty-panel"><h2>링크를 확인할 수 없습니다</h2><p>{error}</p></section>}
    {share && !loading && <>
      <section className="panel trends-summary" aria-label="최근 측정 비교">
        <div><span className="eyebrow">최근 측정</span><strong>{latest ? `${latest.value} mg/dL` : '기록 없음'}</strong>
          <small>{latest ? formatTime(latest.occurredAt, share.timezone) : '측정값이 없습니다'}</small></div>
        <div><span className="eyebrow">직전 측정 비교</span><strong>{delta === null ? '비교할 기록 없음' : `${delta > 0 ? '+' : ''}${delta} mg/dL`}</strong>
          <small>{delta === null || !previous ? '건강 상태의 개선·악화를 의미하지 않습니다' : `직전 측정 ${formatTime(previous.occurredAt, share.timezone)} · 해석이 아닌 값 차이`}</small></div>
      </section>
      <section className="panel trends-panel">
        <div className="trends-heading"><div><p className="eyebrow">실제 측정값 : {displayedSamples.length}건</p><h2>{displayMode === 'day' ? `${day} 시간대별 혈당` : '시간에 따른 기록'}</h2></div></div>
        <div className="trend-display-toggle" role="group" aria-label="공유 혈당 그래프 보기">
          <button type="button" className={displayMode === 'period' ? 'period-chip selected' : 'period-chip'} aria-pressed={displayMode === 'period'} onClick={() => { setDisplayMode('period'); setSelectedId(''); }}>기간 추세</button>
          <button type="button" className={displayMode === 'day' ? 'period-chip selected' : 'period-chip'} aria-pressed={displayMode === 'day'} onClick={() => { setDisplayMode('day'); setSelectedId(''); }}>하루 보기</button>
        </div>
        {displayMode === 'period' && <>
          <div className="period-picker" role="group" aria-label="공유 추세 기간">{periods.map((item) => <button type="button" key={item.id}
            className={!custom && period === item.id ? 'period-chip selected' : 'period-chip'} aria-pressed={!custom && period === item.id}
            onClick={() => { setCustom(false); setPeriod(item.id); setSelectedId(''); }}>{item.label}</button>)}<button type="button" className={custom ? "period-chip selected" : "period-chip"} aria-pressed={custom} onClick={() => setCustom(true)}>기간 지정</button></div></>}
        {displayMode === "period" && custom && <div className="custom-date-range"><label>시작일<input type="date" value={from} onChange={e=>setFrom(e.target.value)} /></label><label>종료일<input type="date" min={from} value={to} onChange={e=>setTo(e.target.value)} /></label>{to && from > to && <p role="alert">종료일을 확인해 주세요.</p>}</div>}
        {displayMode === 'day' && <div className="day-navigation">
          <button type="button" disabled={day <= share.from_date} onClick={() => setChosenDay(shiftLocalDate(day, -1))}>이전</button>
          <label className="field-label">날짜<input type="date" value={day} min={share.from_date} max={share.to_date} onChange={(event) => { if (event.target.value >= share.from_date && event.target.value <= share.to_date) setChosenDay(event.target.value); }} /></label>
          <button type="button" disabled={day >= share.to_date} onClick={() => setChosenDay(shiftLocalDate(day, 1))}>다음</button>
        </div>}
        {average !== null && <p className="glucose-average">평균 혈당 <strong>{average.toFixed(1)} mg/dL</strong><small>현재 그래프의 측정 {displayedSamples.length}건 · 산술평균</small></p>}
        <GlucoseScatterChart samples={displayedSamples} actualSegments={actualSegments} trendSegments={[]} timezone={share.timezone} targetRange={share.target_range} onSelect={setSelectedId} selectedId={selected?.id ?? null} mode={displayMode} />
        {!displayedSamples.length && <p className="trend-empty">{displayMode === 'day' ? '이 날짜에' : '선택한 기간에'} 기록된 혈당 측정값이 없습니다.</p>}
        {selected && <div className="share-selected-value" aria-live="polite"><strong>{selected.value} mg/dL</strong>
          <span>{formatTime(selected.occurredAt, share.timezone)} · {glucoseMeasurementConditionLabel(selected.condition)}</span></div>}
        <section className="measurement-list"><h2>측정값 목록 : {displayedSamples.length}건</h2>
        {displayedSamples.length ? <ol>{[...displayedSamples].reverse().map((sample) => <li key={sample.id}>
          <button type="button" className={selected?.id === sample.id ? 'sample-row active' : 'sample-row'} onClick={() => setSelectedId(sample.id)}>
            <span><strong>{sample.value} mg/dL</strong><small>{formatTime(sample.occurredAt, share.timezone)}</small></span>
            <span><small>{glucoseMeasurementConditionLabel(sample.condition)}{sample.revisionKind ? ' · 정정된 값' : ''}</small></span>
          </button>
        </li>)}</ol> : <p>표시할 실제 측정값이 없습니다.</p>}
        </section>
      </section>
      {share.weights && <WeightTrends key={token} events={share.weights} revisions={[]} timezone={share.timezone} sharedTarget={share.weight_target_kg} readOnly />}
      {displayMode === 'day' && careTimes.length > 0 && <section className="panel"><h2 className="share-section-heading">이날의 식사·인슐린 기록</h2>
        <ol className="share-care-timeline">{careTimes.map((item, index) => <li className={`share-care-timeline-item ${item.event_type}`} key={`${item.event_type}-${item.occurred_at}-${index}`}>
          <time dateTime={item.occurred_at}><span>{formatTimelineDate(item.occurred_at, share.timezone)}</span><span>{formatClock(item.occurred_at, share.timezone)}</span></time>
          <span className="share-care-timeline-node" aria-hidden="true" />
          <div><span className="share-care-kind"><ShareCareIcon type={item.event_type} />{item.event_type === 'meal' ? '식사' : '인슐린'}</span><strong>{typeof item.amount === 'number' && Number.isFinite(item.amount) ? `${item.amount}${item.unit ? ` ${item.unit}` : ' (단위 미기록)'}` : share.include_care_values ? '수치 미기록' : '수치 미공유'}</strong></div>
        </li>)}</ol>
      </section>}
      <section className="panel share-validity" aria-label="공유 기록 기간"><h2 className="share-section-heading">공유 기록 기간</h2><p>{formatDate(share.from_date)} ~ {formatDate(share.to_date)}</p></section>
      <section className="panel share-guardian-contact" aria-label="보호자 연락처">
        <h2 className="share-section-heading">보호자에게 연락</h2>{share.guardian_contact_phone
          ? <><p>{share.pet_name}의 기록에 대해 보호자에게 문의할 수 있습니다.</p>
            <div className="share-guardian-actions"><a className="button-primary" href={`tel:${share.guardian_contact_phone}`}><GuardianContactIcon type="phone" /><span>전화 하기</span></a>
              <a className="button-secondary" href={`sms:${share.guardian_contact_phone}?body=${encodeURIComponent(`${share.pet_name}의 혈당 기록을 확인했습니다. 관련해 연락드립니다.`)}`}><GuardianContactIcon type="message" /><span>문자 보내기</span></a></div></>
          : <p>이 링크에는 보호자 연락처가 포함되지 않았습니다. 연락처를 포함한 새 공유 링크를 보호자에게 요청해 주세요.</p>}
      </section>

    </>}
  </main>;
}
