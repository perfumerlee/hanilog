import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { measuredLineSegments, type GlucoseSample } from '../lib/health-trends';
import { callGlucoseShare, GlucoseShareRequestError, type GlucoseSharePayload } from '../lib/glucose-share';
import { supabase } from '../lib/supabase';

type ShareSample = GlucoseSample & { value: number };
const formatDate = (date: string) => new Intl.DateTimeFormat('ko-KR', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
const formatTime = (instant: string, timezone: string) => new Intl.DateTimeFormat('ko-KR', {
  timeZone: timezone, dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(instant));

export function GlucoseSharePage() {
  const { token = '' } = useParams();
  const [result, setResult] = useState<{ token: string; share?: GlucoseSharePayload; error?: string } | null>(null);
  const [selectedId, setSelectedId] = useState('');

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
  const selected = samples.find((item) => item.id === selectedId) ?? samples.at(-1) ?? null;

  return <main className="page-container public-glucose-share">
    <header className="page-heading"><p className="eyebrow">HaniLog · 건강 기록 공유</p>
      <h1>{share ? `${share.pet_name}의 혈당 기록` : '혈당 기록 공유'}</h1>
      {share && <p>{formatDate(share.from_date)} ~ {formatDate(share.to_date)} · 읽기 전용</p>}
    </header>
    {loading && <p className="notice" role="status">공유 권한과 최신 기록을 확인하고 있습니다…</p>}
    {error && !loading && <section className="panel empty-panel"><h2>링크를 확인할 수 없습니다</h2><p>{error}</p></section>}
    {share && !loading && <>
      <div className="notice notice-warning" role="note">보호자가 선택한 기간의 읽기 전용 정보입니다. 이 화면은 진단이나 투여 지시를 제공하지 않습니다.</div>
      <section className="panel share-target-summary">
        <h2>혈당 안정범위</h2>
        {share.target_range ? <><strong>{share.target_range.lower_mg_dl}–{share.target_range.upper_mg_dl} mg/dL</strong>
          <p>보호자가 입력한 혈당 안정범위 · {share.target_range.source_label} · 적용 시작 {formatDate(share.target_range.effective_on)}</p></>
          : <p>수의사에게서 받은 혈당 안정범위가 등록되어 있지 않습니다.</p>}
        {share.target_range && <small>그래프의 초록색 영역은 공유된 목표 참고 범위이며 안전 판정이나 치료 승인이 아닙니다.</small>}
      </section>
      <section className="panel trends-panel">
        <div className="section-heading"><div><p className="eyebrow">실제 측정값 · mg/dL</p><h2>선택 기간 그래프</h2></div></div>
        {samples.length ? <ShareChart samples={samples} timezone={share.timezone} target={share.target_range} onSelect={setSelectedId} selectedId={selected?.id ?? ''} />
          : <p className="trend-empty">선택한 기간에 호환 가능한 혈당 측정값이 없습니다.</p>}
        <p className="chart-caption">점은 실제 측정값입니다. 짧은 간격의 실제 기록만 직선으로 잇고, 그 사이의 수치는 측정값이 아닙니다.</p>
        {selected && <div className="share-selected-value" aria-live="polite"><strong>{selected.value} mg/dL</strong>
          <span>{formatTime(selected.occurredAt, share.timezone)} · {selected.condition ?? '측정 조건 미기록'}</span></div>}
      </section>
      {share.care_times.length > 0 && <section className="panel"><h2>같은 기간의 식사·인슐린 기록 시각</h2>
        <ul className="share-care-times">{share.care_times.map((item, index) => <li key={`${item.event_type}-${item.occurred_at}-${index}`}>
          <span>{item.event_type === 'meal' ? '식사 기록' : '인슐린 기록'}</span><time>{formatTime(item.occurred_at, share.timezone)}</time>
        </li>)}</ul><small>투여량과 수행자 정보는 공유되지 않습니다. 시각 표시는 관련성이나 투여 적정성 판단이 아닙니다.</small>
      </section>}
      <section className="panel measurement-list"><h2>측정값 목록 ({samples.length}건)</h2>
        {samples.length ? <ol>{[...samples].reverse().map((sample) => <li key={sample.id}>
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

function ShareChart({ samples, timezone, target, onSelect, selectedId }: {
  samples: ShareSample[]; timezone: string;
  target: GlucoseSharePayload['target_range']; onSelect: (id: string) => void; selectedId: string;
}) {
  const width = 800; const height = 280; const left = 56; const right = 18; const top = 20; const bottom = 42;
  const sorted = [...samples].sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.id.localeCompare(b.id));
  const times = sorted.map((item) => Date.parse(item.occurredAt));
  const vals = sorted.map((item) => item.value);
  const minTime = Math.min(...times); const maxTime = Math.max(...times);
  const minValue = Math.min(...vals, ...(target ? [target.lower_mg_dl] : []));
  const maxValue = Math.max(...vals, ...(target ? [target.upper_mg_dl] : []));
  const pad = Math.max(5, (maxValue - minValue) * .08);
  const low = Math.max(0, minValue - pad); const high = maxValue + pad;
  const x = (time: number) => maxTime === minTime ? (left + width - right) / 2 : left + (time - minTime) / (maxTime - minTime) * (width - left - right);
  const y = (value: number) => height - bottom - (value - low) / (high - low || 1) * (height - top - bottom);
  const segments = measuredLineSegments(sorted, 7);
  const paths = segments.filter((segment) => segment.length > 1).map((segment) =>
    `M ${x(Date.parse(segment[0].occurredAt))} ${y(segment[0].value)} ${segment.slice(1).map((item) => `L ${x(Date.parse(item.occurredAt))} ${y(item.value)}`).join(' ')}`);
  const start = new Date(minTime).toLocaleDateString('ko-KR', { timeZone: timezone, month: 'numeric', day: 'numeric' });
  const end = new Date(maxTime).toLocaleDateString('ko-KR', { timeZone: timezone, month: 'numeric', day: 'numeric' });
  const ticks = [low, (low + high) / 2, high];
  return <div className="share-chart-wrap"><svg className="glucose-chart share-chart" viewBox={`0 0 ${width} ${height}`} role="img"
    aria-label={`${sorted.length}개 실제 혈당 측정값, mg/dL 시간 그래프`}>
    {target && <><rect x={left} y={y(target.upper_mg_dl)} width={width - left - right} height={Math.max(0, y(target.lower_mg_dl) - y(target.upper_mg_dl))} className="target-band" />
      <text x={left + 8} y={y(target.upper_mg_dl) + 16} className="target-band-label">목표 참고 범위</text></>}
    {ticks.map((value) => <g key={value}><line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke="#dce7df" />
      <text x={left - 9} y={y(value) + 4} textAnchor="end" className="chart-axis-label">{Math.round(value)}</text></g>)}
    {paths.map((path, index) => <path key={index} d={path} className="actual-series-line" />)}
    {sorted.map((sample) => <circle key={sample.id} cx={x(Date.parse(sample.occurredAt))} cy={y(sample.value)} r={sample.id === selectedId ? 8 : 5}
      className={sample.id === selectedId ? 'chart-point selected' : 'chart-point'} role="button" tabIndex={0}
      aria-label={`${formatTime(sample.occurredAt, timezone)}, ${sample.value} mg/dL`} onClick={() => onSelect(sample.id)}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(sample.id); } }} />)}
    <text x={left} y={height - 12} className="chart-axis-label">{start}</text>
    <text x={width - right} y={height - 12} textAnchor="end" className="chart-axis-label">{end}</text>
    <text x={width - right} y={14} textAnchor="end" className="chart-unit-label">mg/dL</text>
  </svg></div>;
}
