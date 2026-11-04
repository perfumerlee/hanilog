import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { measuredLineSegments, localDateKey, samplesForLocalDay, shiftLocalDate, type GlucoseSample } from '../lib/health-trends';
import { callGlucoseShare, GlucoseShareRequestError, type GlucoseSharePayload } from '../lib/glucose-share';
import { supabase } from '../lib/supabase';

import { GlucoseScatterChart } from './HealthTrendsPage';

type ShareSample = GlucoseSample & { value: number };
const formatDate = (date: string) => new Intl.DateTimeFormat('ko-KR', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
const formatTime = (instant: string, timezone: string) => new Intl.DateTimeFormat('ko-KR', {
  timeZone: timezone, dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(instant));

export function GlucoseSharePage() {
  const { token = '' } = useParams();
  const [result, setResult] = useState<{ token: string; share?: GlucoseSharePayload; error?: string } | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [chosenDay, setChosenDay] = useState('');

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
  const day = chosenDay || (share && latest ? localDateKey(latest.occurredAt, share.timezone) : share?.to_date ?? '');
  const daily = share ? samplesForLocalDay(samples, day, share.timezone) : [];
  const careTimes = share?.care_times.filter((item) => localDateKey(item.occurred_at, share.timezone) === day) ?? [];
  const selected = daily.find((item) => item.id === selectedId) ?? daily.at(-1) ?? null;

  return <main className="page-container public-glucose-share">
    <header className="page-heading"><p className="eyebrow">HaniLog · 건강 기록 공유</p>
      <h1>{share ? `${share.pet_name}의 혈당 기록` : '혈당 기록 공유'}</h1>
      {share && <p>{formatDate(share.from_date)} ~ {formatDate(share.to_date)} · 읽기 전용</p>}
    </header>
    {loading && <p className="notice" role="status">공유 권한과 최신 기록을 확인하고 있습니다…</p>}
    {error && !loading && <section className="panel empty-panel"><h2>링크를 확인할 수 없습니다</h2><p>{error}</p></section>}
    {share && !loading && <>
      <div className="notice notice-warning" role="note">보호자가 선택한 기간의 읽기 전용 정보입니다. 이 화면은 진단이나 투여 지시를 제공하지 않습니다.</div>
      <section className="panel trends-panel">
        <div className="section-heading"><div><p className="eyebrow">실제 측정값 · mg/dL</p><h2>하루 혈당 그래프</h2></div></div>
        <div className="day-navigation">
          <button type="button" disabled={day <= share.from_date} onClick={() => setChosenDay(shiftLocalDate(day, -1))}>이전</button>
          <label className="field-label">날짜<input type="date" value={day} min={share.from_date} max={share.to_date} onChange={(event) => { if (event.target.value >= share.from_date && event.target.value <= share.to_date) setChosenDay(event.target.value); }} /></label>
          <button type="button" disabled={day >= share.to_date} onClick={() => setChosenDay(shiftLocalDate(day, 1))}>다음</button>
        </div>
        <GlucoseScatterChart samples={daily} actualSegments={measuredLineSegments(daily, .25)} trendSegments={[]} timezone={share.timezone} targetRange={share.target_range} onSelect={setSelectedId} selectedId={selected?.id ?? null} mode="day" />
        {!daily.length && <p className="trend-empty">이 날짜에 기록된 혈당 측정값이 없습니다.</p>}
        <p className="chart-caption">생활 시간대 {share.timezone} · 00:00~24:00. 점은 실제 측정값이며 6시간 이내 기록만 연결합니다. 중간 값은 측정값이 아닙니다. 초록색 혈당 안정범위는 설정된 참고 범위입니다.</p>
        {selected && <div className="share-selected-value" aria-live="polite"><strong>{selected.value} mg/dL</strong>
          <span>{formatTime(selected.occurredAt, share.timezone)} · {selected.condition ?? '측정 조건 미기록'}</span></div>}
      </section>
      {careTimes.length > 0 && <section className="panel"><h2>이날의 식사·인슐린 기록 시각</h2>
        <ul className="share-care-times">{careTimes.map((item, index) => <li key={`${item.event_type}-${item.occurred_at}-${index}`}>
          <span>{item.event_type === 'meal' ? '식사 기록' : '인슐린 기록'}</span><time>{formatTime(item.occurred_at, share.timezone)}</time>
        </li>)}</ul><small>투여량과 수행자 정보는 공유되지 않습니다. 시각 표시는 관련성이나 투여 적정성 판단이 아닙니다.</small>
      </section>}
      <section className="panel measurement-list"><h2>이날 측정값 ({daily.length}건)</h2>
        {daily.length ? <ol>{[...daily].reverse().map((sample) => <li key={sample.id}>
          <button type="button" className={selected?.id === sample.id ? 'sample-row active' : 'sample-row'} onClick={() => setSelectedId(sample.id)}>
            <span><strong>{sample.value} mg/dL</strong><small>{formatTime(sample.occurredAt, share.timezone)}</small></span>
            <span><small>{sample.condition ?? '측정 조건 미기록'}</small><small>{sample.revisionKind ? '정정된 값' : '실제 측정값'}</small></span>
          </button>
        </li>)}</ol> : <p>표시할 실제 측정값이 없습니다.</p>}
      </section>
      <p className="timeline-footnote">공유 링크는 {new Date(share.expires_at).toLocaleString('ko-KR')}에 만료됩니다. 보호자가 링크를 취소하면 다시 열 수 없습니다.</p>
    </>}
  </main>;
}
