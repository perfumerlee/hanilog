import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { measuredLineSegments, localDateKey, samplesForLocalDay, shiftLocalDate, trendLineSegments, trendPoints, type GlucoseSample, type TrendPeriod } from '../lib/health-trends';
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

export function GlucoseSharePage() {
  const { token = '' } = useParams();
  const [result, setResult] = useState<{ token: string; share?: GlucoseSharePayload; error?: string } | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [chosenDay, setChosenDay] = useState('');
  const [displayMode, setDisplayMode] = useState<'day' | 'period'>('day');
  const [period, setPeriod] = useState<TrendPeriod>('30d');
  const [showTrend, setShowTrend] = useState(false);
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
  const latest = [...samples].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt)).at(-1);
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
  const displayedSamples = displayMode === 'day' ? daily : periodSamples;
  const selected = displayedSamples.find((item) => item.id === selectedId) ?? displayedSamples.at(-1) ?? null;
  const actualSegments = measuredLineSegments(displayedSamples, displayMode === 'day' ? 6 / 24 : 7);
  const calculatedTrend = share && displayMode === 'period' && showTrend
    ? trendLineSegments(trendPoints(periodSamples, period, share.timezone), period) : [];

  return <main className="page-container public-glucose-share">
    <header className="page-heading pet-photo-heading">{share && <img className="pet-heading-portrait" src={portrait?.token === token ? portrait.url : PET_AVATARS[0].src} alt={`${share.pet_name} 프로필`} />}<div><p className="eyebrow">HaniLog · 건강 기록 공유</p>
      <h1>{share ? `${share.pet_name}의 혈당 기록` : '혈당 기록 공유'}</h1>
      {share && <p>{formatDate(share.from_date)} ~ {formatDate(share.to_date)} · 읽기 전용</p>}
    </div></header>
    {loading && <p className="notice" role="status">공유 권한과 최신 기록을 확인하고 있습니다…</p>}
    {error && !loading && <section className="panel empty-panel"><h2>링크를 확인할 수 없습니다</h2><p>{error}</p></section>}
    {share && !loading && <>
      <section className="panel trends-panel">
        <div className="section-heading"><h2>{displayMode === 'day' ? '하루 혈당 그래프' : '기간 혈당 추세'}</h2></div>
        <div className="trend-display-toggle" role="group" aria-label="공유 혈당 그래프 보기">
          <button type="button" className={displayMode === 'period' ? 'period-chip selected' : 'period-chip'} aria-pressed={displayMode === 'period'} onClick={() => { setDisplayMode('period'); setSelectedId(''); }}>기간 추세</button>
          <button type="button" className={displayMode === 'day' ? 'period-chip selected' : 'period-chip'} aria-pressed={displayMode === 'day'} onClick={() => { setDisplayMode('day'); setSelectedId(''); }}>하루 보기</button>
        </div>
        {displayMode === 'period' && <><label className="trend-toggle"><input type="checkbox" checked={showTrend} onChange={(event) => setShowTrend(event.target.checked)} />계산 추세 보기</label>
          <div className="period-picker" role="group" aria-label="공유 추세 기간">{periods.map((item) => <button type="button" key={item.id}
            className={period === item.id ? 'period-chip selected' : 'period-chip'} aria-pressed={period === item.id}
            onClick={() => { setPeriod(item.id); setSelectedId(''); }}>{item.label}</button>)}</div></>}
        {displayMode === 'day' && <div className="day-navigation">
          <button type="button" disabled={day <= share.from_date} onClick={() => setChosenDay(shiftLocalDate(day, -1))}>이전</button>
          <label className="field-label">날짜<input type="date" value={day} min={share.from_date} max={share.to_date} onChange={(event) => { if (event.target.value >= share.from_date && event.target.value <= share.to_date) setChosenDay(event.target.value); }} /></label>
          <button type="button" disabled={day >= share.to_date} onClick={() => setChosenDay(shiftLocalDate(day, 1))}>다음</button>
        </div>}
        <GlucoseScatterChart samples={displayedSamples} actualSegments={actualSegments} trendSegments={calculatedTrend} timezone={share.timezone} targetRange={share.target_range} onSelect={setSelectedId} selectedId={selected?.id ?? null} mode={displayMode} />
        {!displayedSamples.length && <p className="trend-empty">{displayMode === 'day' ? '이 날짜에' : '선택한 기간에'} 기록된 혈당 측정값이 없습니다.</p>}
        {selected && <div className="share-selected-value" aria-live="polite"><strong>{selected.value} mg/dL</strong>
          <span>{formatTime(selected.occurredAt, share.timezone)} · {glucoseMeasurementConditionLabel(selected.condition)}</span></div>}
      </section>
      {displayMode === 'day' && careTimes.length > 0 && <section className="panel"><h2>이날의 식사·인슐린 기록</h2>
        <ul className="share-care-times">{careTimes.map((item, index) => <li key={`${item.event_type}-${item.occurred_at}-${index}`}>
          <span>{item.event_type === 'meal' ? '식사' : '인슐린'}<strong>{typeof item.amount === 'number' && Number.isFinite(item.amount) ? `${item.amount}${item.unit ? ` ${item.unit}` : ' (단위 미기록)'}` : share.include_care_values ? '수치 미기록' : '수치 미공유'}</strong></span><time>{formatTime(item.occurred_at, share.timezone)}</time>
        </li>)}</ul>
      </section>}
      <section className="panel measurement-list"><h2>{displayMode === 'day' ? '이날' : '선택한 기간'} 측정값 ({displayedSamples.length}건)</h2>
        {displayedSamples.length ? <ol>{[...displayedSamples].reverse().map((sample) => <li key={sample.id}>
          <button type="button" className={selected?.id === sample.id ? 'sample-row active' : 'sample-row'} onClick={() => setSelectedId(sample.id)}>
            <span><strong>{sample.value} mg/dL</strong><small>{formatTime(sample.occurredAt, share.timezone)}</small></span>
            <span><small>{glucoseMeasurementConditionLabel(sample.condition)}{sample.revisionKind ? ' · 정정된 값' : ''}</small></span>
          </button>
        </li>)}</ol> : <p>표시할 실제 측정값이 없습니다.</p>}
      </section>
      <p className="timeline-footnote">공유 링크는 {new Date(share.expires_at).toLocaleString('ko-KR')}에 만료됩니다. 보호자가 링크를 취소하면 다시 열 수 없습니다.</p>
    </>}
  </main>;
}
