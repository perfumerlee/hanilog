import { useId } from 'react';

export function RecordChoices({ label, value, options, onChange }: {
  label: string; value: string; options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const name = useId();
  return <fieldset className="record-choices"><legend>{label}</legend>
    <div>{options.map((option) => <label key={option.value} className={value === option.value ? 'is-selected' : ''}>
      <input type="radio" name={name} checked={value === option.value} onChange={() => onChange(option.value)} />
      <span>{option.label}</span>
    </label>)}</div>
  </fieldset>;
}

const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export function RecordDateStrip({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const selected = value.slice(0, 10);
  const center = new Date(`${selected}T12:00:00`);
  const validCenter = Number.isNaN(center.getTime()) ? new Date() : center;
  const today = dateKey(new Date());
  const choose = (day: string) => { if (day) onChange(`${day}T${value.slice(11) || '12:00'}`); };
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(validCenter); date.setDate(date.getDate() + index - 3); return date;
  });
  return <section className="record-date-strip" aria-label="기록 날짜 선택">
    <div className="record-date-heading"><label>기록 날짜<input type="date" value={selected} onChange={(event) => choose(event.target.value)} /></label>
      <button type="button" className="secondary-action" onClick={() => choose(today)}>오늘</button></div>
    <div className="record-week">{days.map((day) => {
      const key = dateKey(day);
      return <button type="button" key={key} aria-pressed={key === selected}
        aria-label={day.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}
        onClick={() => choose(key)}><small>{day.toLocaleDateString('ko-KR', { weekday: 'short' })}</small>
        <strong>{day.getDate()}</strong><span>{key === today ? '오늘' : key === selected ? '선택' : '\u00a0'}</span></button>;
    })}</div>
    <p className="small-note">날짜와 아래 시각은 이 기기의 시간대 기준입니다. 과거 기록은 실제 발생 시각을 확인해 주세요.</p>
  </section>;
}
