import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { weightSamples, type WeightEvent, type WeightRevision } from '../lib/weight-trends';

export function WeightTrends({ events, revisions, timezone, readOnly = false, sharedTarget = null, onSaveTarget }: { events: WeightEvent[]; revisions: WeightRevision[]; timezone: string; readOnly?: boolean; sharedTarget?: number | null; onSaveTarget?: (eventId: string, expectedRevision: number, value: Record<string, unknown>) => Promise<boolean> }) {
  const { samples, excluded, target: eventTarget } = weightSamples(events, revisions);
  const target = sharedTarget ?? eventTarget;
  const [days, setDays] = useState(90);
  const [now] = useState(() => Date.now());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingTarget, setEditingTarget] = useState(false);
  const [targetDraft, setTargetDraft] = useState('');
  const [targetSaving, setTargetSaving] = useState(false);
  const [targetError, setTargetError] = useState('');
  const chartRef = useRef<SVGSVGElement>(null);
  const [chartWidth, setChartWidth] = useState(550);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setChartWidth(Math.max(300, entry.contentRect.width)));
    observer.observe(chart);
    return () => observer.disconnect();
  }, []);
  const last = samples.at(-1);
  const previous = samples.at(-2);
  const targetDifference = last && target !== null ? Number((last.value - target).toFixed(2)) : null;
  const previousDifference = last && previous ? Number((last.value - previous.value).toFixed(2)) : null;
  const shown = samples.filter(sample => !days || Date.parse(sample.occurredAt) >= now - days * 86400000);
  const selected = shown.find(sample => sample.id === selectedId) ?? shown.at(-1);
  const date = (instant: string) => new Intl.DateTimeFormat('ko-KR', { timeZone: timezone, dateStyle: 'medium' }).format(new Date(instant));
  const low = 0;
  // Keep 0–30 kg as baseline, extend in 3 kg steps rather than clipping larger pets.
  const high = Math.ceil(Math.max(30, ...shown.map(sample => sample.value), target ?? 0) / 3) * 3;
  const firstTime = shown.length ? Date.parse(shown[0].occurredAt) : 0;
  const lastTime = shown.length ? Date.parse(shown.at(-1)!.occurredAt) : 1;
  const x = (instant: string) => lastTime === firstTime ? chartWidth / 2 : 55 + (Date.parse(instant) - firstTime) / (lastTime - firstTime) * (chartWidth - 110);
  const y = (value: number) => 330 - (value - low) / (high - low) * 285;
  async function saveTarget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextTarget = Number(targetDraft);
    if (!last || !onSaveTarget || !targetDraft.trim() || !Number.isFinite(nextTarget) || nextTarget <= 0) {
      setTargetError('0보다 큰 목표 체중을 kg으로 입력해 주세요.'); return;
    }
    const original = events.find(item => item.id === last.id);
    const latest = revisions.filter(item => item.event_id === last.id).sort((a, b) => b.revision_no - a.revision_no)[0];
    if (!original) { setTargetError('체중 기록을 다시 불러온 뒤 시도해 주세요.'); return; }
    const revisedValue = latest?.patch.value;
    const effectiveValue = { ...original.value, ...(revisedValue && typeof revisedValue === 'object' && !Array.isArray(revisedValue) ? revisedValue : {}), observed_value: last.value, target_weight_kg: nextTarget };
    setTargetSaving(true); setTargetError('');
    try {
      const saved = await onSaveTarget(last.id, latest?.revision_no ?? 0, effectiveValue);
      if (saved) setEditingTarget(false);
      else setTargetError('목표 체중을 저장하지 못했습니다. 최신 기록을 확인한 뒤 다시 시도해 주세요.');
    } catch { setTargetError('목표 체중을 저장하지 못했습니다. 연결을 확인해 주세요.'); }
    finally { setTargetSaving(false); }
  }
  return <section className="panel weight-trends" aria-label="체중 흐름">
    <div className="trends-heading"><h2>체중 흐름</h2>{!readOnly && <Link className="button-link" to="/record?event=weight">체중 기록</Link>}</div>
    <div className="weight-current" aria-label="최근 체중 측정"><span>최근 측정</span><strong>{last ? `${last.value} kg` : '기록 없음'}</strong>{last && <small>{date(last.occurredAt)} 측정</small>}</div>
    <div className="weight-summary" aria-label="체중 요약">
      <div className="weight-summary-item weight-summary-target"><span>목표 체중</span><strong>{target !== null ? `${target} kg` : '설정 전'}</strong>{!readOnly && onSaveTarget && last && <button type="button" className="weight-target-edit" onClick={() => { setTargetDraft(target === null ? '' : String(target)); setTargetError(''); setEditingTarget(current => !current); }}>{target === null ? '목표 설정' : '목표 변경'}</button>}</div>
      <div className="weight-summary-item"><span>목표와의 차이</span><strong>{targetDifference === null ? '—' : `${Math.abs(targetDifference)} kg`}</strong><small>{targetDifference === null ? '목표 설정 후 표시' : targetDifference < 0 ? '목표보다 낮음' : targetDifference > 0 ? '목표보다 높음' : '목표와 같음'}</small></div>
      <div className="weight-summary-item"><span>직전 측정 대비</span><strong>{previousDifference === null ? '—' : `${previousDifference > 0 ? '+' : ''}${previousDifference} kg`}</strong><small>{previousDifference === null ? '이전 측정 없음' : date(previous!.occurredAt)}</small></div>
    </div>
    {editingTarget && onSaveTarget && !readOnly && <form className="weight-goal-editor" onSubmit={(event) => void saveTarget(event)}><label className="field-label">목표 체중 (kg)<input type="number" inputMode="decimal" min="0.01" step="any" value={targetDraft} onChange={(event) => setTargetDraft(event.target.value)} required /></label><button type="submit" className="button-primary" disabled={targetSaving}>{targetSaving ? '저장 중…' : '목표 저장'}</button>{targetError && <p role="alert">{targetError}</p>}<small>가장 최근 체중 기록에 정정 이력으로 저장합니다. 측정값은 바뀌지 않습니다.</small></form>}
    <details><summary>체중 흐름 보기</summary>
      <div className="weight-period-picker" aria-label="체중 조회 기간">{[30,90,365,0].map(value => <button type="button" key={value} className={`period-chip${days === value ? ' selected' : ''}`} aria-pressed={days === value} onClick={() => setDays(value)}>{value === 0 ? '전체' : value === 365 ? '1년' : `${value}일`}</button>)}</div>
      {shown.length > 0 ? <>
        {target !== null && <div className="weight-chart-legend"><span className="weight-legend-line" aria-hidden="true"/>목표 {target} kg</div>}
        <svg ref={chartRef} className="weight-chart" viewBox={`0 0 ${chartWidth} 375`} role="img" aria-label={`실제 측정 날짜에 비례한 체중 그래프${target !== null ? `, 목표 체중 ${target} kg 기준선` : ''}. 아래 목록에서 측정값 선택 가능`}>
          {Array.from({ length: high / 3 + 1 }, (_, tick) => tick * 3).map(value => { const tick = value; return <g key={tick}><line x1="55" x2={chartWidth - 55} y1={y(value)} y2={y(value)} stroke="#d5dfda"/><text x="5" y={y(value)+4} fontSize="12">{value}</text></g>; })}
          <text x="10" y="20" fontSize="12">kg</text>
          {target !== null && <g className="weight-target-marker" aria-label={`목표 체중 ${target} kg 기준선`}>
            <line x1="55" x2={chartWidth - 55} y1={y(target)} y2={y(target)} stroke="#54786c" strokeWidth="2" strokeDasharray="8 5" />
          </g>}
          {shown.map((sample,index) => { const prev = shown[index-1]; return <g key={sample.id}>{prev && Date.parse(sample.occurredAt)-Date.parse(prev.occurredAt) <= 45*86400000 && <line x1={x(prev.occurredAt)} y1={y(prev.value)} x2={x(sample.occurredAt)} y2={y(sample.value)} stroke="#8aab96"/>}<circle cx={x(sample.occurredAt)} cy={y(sample.value)} r={selected?.id === sample.id ? 6 : 4} fill="#39735d"/><circle cx={x(sample.occurredAt)} cy={y(sample.value)} r="18" fill="transparent" onClick={() => setSelectedId(sample.id)}/></g>; })}
          {selected && <g className="weight-tooltip" pointerEvents="none" transform={`translate(${Math.max(55, Math.min(chartWidth - 175, x(selected.occurredAt)-80))}, ${Math.max(10, y(selected.value)-65)})`}>
            <rect width="165" height="55" rx="9" fill="#fffefa" stroke="#39735d" />
            <text x="10" y="22" fontSize="17" fontWeight="700" fill="#174e41">{selected.value} kg</text>
            <text x="10" y="43" fontSize="12" fill="#385c51">{date(selected.occurredAt)}</text>
          </g>}
          <text x="55" y="365" fontSize="12">{date(shown[0].occurredAt)}</text><text x={chartWidth - 55} y="365" textAnchor="end" fontSize="12">{date(shown.at(-1)!.occurredAt)}</text>
        </svg>
        <h3 className="weight-list-heading">측정값 목록 : {shown.length}건</h3>
        <ul className="weight-measurements">{[...shown].reverse().map(sample => <li key={sample.id}><button type="button" className={sample.id === selected?.id ? 'sample-row active' : 'sample-row'} onClick={() => setSelectedId(sample.id)} aria-pressed={sample.id === selected?.id}><strong>{sample.value} kg</strong><span>{date(sample.occurredAt)}</span></button></li>)}</ul>
      </> : <><h3 className="weight-list-heading">측정값 목록 : 0건</h3><p>이 기간에는 측정한 체중이 없습니다. 전체 기간을 선택하거나 새 기록을 남겨 주세요.</p></>}
      {excluded > 0 && <p>단위 또는 값 확인이 필요한 기존 기록 {excluded}건은 그래프에서 제외했습니다.</p>}
    </details>
  </section>;
}
