import { useState } from 'react';
import { Link } from 'react-router-dom';
import { weightSamples, type WeightEvent, type WeightRevision } from '../lib/weight-trends';

export function WeightTrends({ events, revisions, timezone }: { events: WeightEvent[]; revisions: WeightRevision[]; timezone: string }) {
  const { samples, excluded, target } = weightSamples(events, revisions);
  const [days, setDays] = useState(90);
  const [now] = useState(() => Date.now());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const last = samples.at(-1);
  const previous = samples.at(-2);
  const shown = samples.filter(sample => !days || Date.parse(sample.occurredAt) >= now - days * 86400000);
  const selected = shown.find(sample => sample.id === selectedId) ?? shown.at(-1);
  const date = (instant: string) => new Intl.DateTimeFormat('ko-KR', { timeZone: timezone, dateStyle: 'medium' }).format(new Date(instant));
  const low = Math.max(0, Math.min(...shown.map(sample => sample.value), target ?? Infinity) - 1);
  const high = Math.max(...shown.map(sample => sample.value), target ?? 0) + 1;
  const firstTime = shown.length ? Date.parse(shown[0].occurredAt) : 0;
  const lastTime = shown.length ? Date.parse(shown.at(-1)!.occurredAt) : 1;
  const x = (instant: string) => lastTime === firstTime ? 270 : 55 + (Date.parse(instant) - firstTime) / (lastTime - firstTime) * 440;
  const y = (value: number) => 195 - (value - low) / (high - low) * 155;
  return <section className="panel weight-trends" aria-label="체중 흐름">
    <div className="trends-heading"><div><h2>체중 흐름</h2><strong>{last ? `${last.value} kg` : '아직 체중 기록이 없어요'}</strong>{last && <small> · {date(last.occurredAt)} 측정</small>}</div><Link className="button-link" to="/record?event=weight">체중 기록</Link></div>
    {target !== null && <p>목표 <strong>{target} kg</strong>{last && ` · 목표와의 차이 ${Number((last.value - target).toFixed(2)) > 0 ? '+' : ''}${Number((last.value - target).toFixed(2))} kg`}</p>}
    {last && previous && <p>직전 측정 대비 {Number((last.value - previous.value).toFixed(2)) > 0 ? '+' : ''}{Number((last.value - previous.value).toFixed(2))} kg</p>}
    <details><summary>체중 흐름 보기</summary>
      <div className="period-picker" aria-label="체중 조회 기간">{[30,90,365,0].map(value => <button type="button" key={value} className={`period-chip${days === value ? ' selected' : ''}`} aria-pressed={days === value} onClick={() => setDays(value)}>{value === 0 ? '전체' : value === 365 ? '1년' : `${value}일`}</button>)}</div>
      {shown.length > 0 ? <>
        <svg viewBox="0 0 550 235" role="img" aria-label="실제 측정 날짜에 비례한 체중 그래프. 아래 목록에서 측정값 선택 가능" style={{ width: '100%', display: 'block' }}>
          {[0,1,2,3].map(tick => { const value = low + (high-low)*tick/3; return <g key={tick}><line x1="55" x2="495" y1={y(value)} y2={y(value)} stroke="#d5dfda"/><text x="5" y={y(value)+4} fontSize="12">{value.toFixed(1)}</text></g>; })}
          <text x="10" y="20" fontSize="12">kg</text>
          {target !== null && <g><line x1="55" x2="495" y1={y(target)} y2={y(target)} stroke="#597b64" strokeDasharray="5 5"/><text x="350" y={y(target)-6} fontSize="12">목표 {target} kg</text></g>}
          {shown.map((sample,index) => { const prev = shown[index-1]; return <g key={sample.id}>{prev && Date.parse(sample.occurredAt)-Date.parse(prev.occurredAt) <= 45*86400000 && <line x1={x(prev.occurredAt)} y1={y(prev.value)} x2={x(sample.occurredAt)} y2={y(sample.value)} stroke="#8aab96"/>}<circle cx={x(sample.occurredAt)} cy={y(sample.value)} r={selected?.id === sample.id ? 6 : 4} fill="#39735d"/><circle cx={x(sample.occurredAt)} cy={y(sample.value)} r="18" fill="transparent" onClick={() => setSelectedId(sample.id)}/></g>; })}
          <text x="55" y="225" fontSize="12">{date(shown[0].occurredAt)}</text><text x="495" y="225" textAnchor="end" fontSize="12">{date(shown.at(-1)!.occurredAt)}</text>
        </svg>
        {selected && <p role="status"><strong>{selected.value} kg</strong> · {date(selected.occurredAt)}</p>}
        <small>측정한 날짜만 표시합니다. 45일을 넘는 공백은 연결하지 않으며, 선 사이의 값은 측정값이 아닙니다.</small>
        <ul className="weight-measurements">{[...shown].reverse().map(sample => <li key={sample.id}><button type="button" className="button-secondary" onClick={() => setSelectedId(sample.id)} aria-pressed={sample.id === selected?.id}><strong>{sample.value} kg</strong><span>{date(sample.occurredAt)}</span></button></li>)}</ul>
      </> : <p>이 기간에는 측정한 체중이 없습니다. 전체 기간을 선택하거나 새 기록을 남겨 주세요.</p>}
      {excluded > 0 && <p>단위 또는 값 확인이 필요한 기존 기록 {excluded}건은 그래프에서 제외했습니다.</p>}
    </details>
  </section>;
}
