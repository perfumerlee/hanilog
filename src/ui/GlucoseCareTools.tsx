import { useState, type FormEvent } from 'react';
import { callGlucoseShare, createShareToken, glucoseShareUrl, type GlucoseShareRange } from '../lib/glucose-share';
import { supabase } from '../lib/supabase';
import { localDateKey } from '../lib/health-trends';

type PetTarget = { id: string; lower_mg_dl: number; upper_mg_dl: number; source_label: string; effective_on: string };
type Props = { petId: string; petName: string; timezone: string; canEdit: boolean; demo?: boolean;
  target: PetTarget | null; onTargetSaved: () => Promise<void> };
const today = (timezone: string) => localDateKey(new Date().toISOString(), timezone);
const dayShift = (date: string, days: number) => {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};

export function GlucoseCareTools({ petId, petName, timezone, canEdit, demo = false, target, onTargetSaved }: Props) {
  const [targetOpen, setTargetOpen] = useState(false);
  const [lower, setLower] = useState('');
  const [upper, setUpper] = useState('');
  const [source, setSource] = useState('');
  const [effectiveOn, setEffectiveOn] = useState(() => today(timezone));
  const [shareOpen, setShareOpen] = useState(false);
  const [fromDate, setFromDate] = useState(() => dayShift(today(timezone), -29));
  const [toDate, setToDate] = useState(() => today(timezone));
  const [includeCareTimes, setIncludeCareTimes] = useState(false);
  const [expiresDays, setExpiresDays] = useState('1');
  const [shares, setShares] = useState<GlucoseShareRange[]>([]);
  const [newLink, setNewLink] = useState('');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [now] = useState(() => Date.now());

  async function loadShares() {
    if (!supabase || demo || !canEdit) return;
    try {
      const result = await callGlucoseShare<{ shares: GlucoseShareRange[] }>(supabase, { action: 'list', pet_id: petId });
      setShares(result.shares ?? []);
    } catch {
      setMessage((current) => current || '공유 링크 상태를 불러오지 못했습니다. 서버 기능 적용 여부를 확인해 주세요.');
    }
  }

  async function saveTarget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const low = Number(lower); const high = Number(upper);
    if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high <= low || !source.trim() || !effectiveOn) {
      setMessage('낮은 값·높은 값·수의사 또는 병원 출처·적용 날짜를 확인해 주세요.'); return;
    }
    if (!supabase || !canEdit || demo) { setMessage('서버에 연결된 편집 권한이 필요합니다.'); return; }
    setPending(true); setMessage('');
    const { error } = await supabase.rpc('set_pet_glucose_target_range', {
      p_pet_id: petId, p_lower_mg_dl: low, p_upper_mg_dl: high, p_source_label: source.trim(), p_effective_on: effectiveOn,
    });
    setPending(false);
    if (error) setMessage(error.code === '42501' ? '이 목표 범위를 변경할 권한이 없습니다.' : '목표 범위를 저장하지 못했습니다. 서버 적용과 입력값을 확인해 주세요.');
    else { setMessage('목표 범위 저장을 확인했습니다.'); await onTargetSaved(); setTargetOpen(false); }
  }

  async function createShare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !canEdit || demo) { setMessage('승인된 보호자 계정으로 운영 서버에 연결해야 공유 링크를 만들 수 있습니다.'); return; }
    if (!fromDate || !toDate || fromDate > toDate || (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000 > 365) {
      setMessage('공유 시작일과 종료일을 확인해 주세요. 최대 1년 범위를 선택할 수 있습니다.'); return;
    }
    setPending(true); setNewLink(''); setMessage('');
    try {
      const { token, tokenHash } = createShareToken();
      const expiresAt = new Date(Date.now() + Number(expiresDays) * 86_400_000).toISOString();
      const result = await callGlucoseShare<{ share: GlucoseShareRange }>(supabase, {
        action: 'create', pet_id: petId, token_hash: await tokenHash, from_date: fromDate, to_date: toDate,
        expires_at: expiresAt, include_care_times: includeCareTimes,
      });
      if (!result.share?.id) throw new Error('SHARE_CREATE_FAILED');
      const link = glucoseShareUrl(token);
      setNewLink(link);
      try { await navigator.clipboard.writeText(link); setMessage(`${petName}의 선택 기간 혈당 링크를 복사했습니다. 링크를 받은 사람은 만료 전까지 읽을 수 있습니다.`); }
      catch { setMessage('링크를 만들었습니다. 아래 주소를 직접 복사해 주세요. 링크를 받은 사람은 만료 전까지 읽을 수 있습니다.'); }
      await loadShares();
    } catch (error) {
      setMessage(error instanceof Error && error.message === 'ACCESS_DENIED' ? '이 반려동물의 공유 링크를 만들 권한이 없습니다.'
        : '공유 링크를 만들지 못했습니다. 운영 서버 migration과 glucose-share 함수 적용 상태를 확인해 주세요.');
    } finally { setPending(false); }
  }

  async function revoke(id: string) {
    if (!supabase || demo) return;
    setPending(true); setMessage('');
    try {
      await callGlucoseShare(supabase, { action: 'revoke', share_id: id });
      setMessage('공유 링크를 취소했습니다. 이후 새 요청은 거부됩니다.'); await loadShares();
    } catch { setMessage('링크를 취소하지 못했습니다. 연결과 권한을 확인해 주세요.'); }
    finally { setPending(false); }
  }

  return <section className="panel glucose-care-tools">
    <h2>혈당 기준과 공유</h2>
    <section className="glucose-target-tools">
      <div className="section-heading"><div><p className="eyebrow">수의사 안내</p><h3>목표 범위</h3></div>
        {canEdit && !demo && <button type="button" className="text-button" aria-expanded={targetOpen} onClick={() => {
          if (!targetOpen && target) {
            setLower(String(target.lower_mg_dl)); setUpper(String(target.upper_mg_dl));
            setSource(target.source_label); setEffectiveOn(target.effective_on);
          }
          setTargetOpen((value) => !value);
        }}>{target ? '범위 수정' : '범위 입력'}</button>}</div>
      {target ? <><strong className="target-range-value">{target.lower_mg_dl}–{target.upper_mg_dl} mg/dL</strong>
        <small>{target.source_label} · 적용 시작 {target.effective_on}</small></>
        : <p className="small-note">등록된 수의사 안내 범위가 없습니다. 임의 범위는 표시하지 않습니다.</p>}
      {targetOpen && <form className="target-range-form" onSubmit={(event) => void saveTarget(event)}>
        <p>담당 수의사에게 안내받은 수치만 입력하세요. HaniLog는 정상·위험 여부나 투여 적정성을 판단하지 않습니다.</p>
        <div className="form-grid">
          <label className="field-label">범위 하한 (mg/dL)<input type="number" inputMode="decimal" min="0.01" step="any" value={lower} onChange={(event) => setLower(event.target.value)} required /></label>
          <label className="field-label">범위 상한 (mg/dL)<input type="number" inputMode="decimal" min="0.01" step="any" value={upper} onChange={(event) => setUpper(event.target.value)} required /></label>
          <label className="field-label">안내 출처<input maxLength={160} value={source} onChange={(event) => setSource(event.target.value)} placeholder="예: 담당 병원 안내" required /></label>
          <label className="field-label">적용 시작일<input type="date" value={effectiveOn} onChange={(event) => setEffectiveOn(event.target.value)} required /></label>
        </div>
        <button type="submit" className="button-primary" disabled={pending}>{pending ? '저장 중…' : '범위 저장'}</button>
      </form>}
      <small className="target-range-disclaimer">초록색 영역은 기록 확인용 참고 범위입니다. 치료 효과나 안전을 보증하지 않습니다.</small>
    </section>
    <section className="glucose-share-tools">
      <div className="section-heading"><div><p className="eyebrow">읽기 전용</p><h3>주치의와 공유</h3></div>
        {canEdit && !demo && <button type="button" className="text-button" aria-expanded={shareOpen} onClick={() => {
          const opening = !shareOpen;
          setShareOpen(opening);
          if (opening) void loadShares();
        }}>{shareOpen ? '접기' : '공유 링크 만들기'}</button>}</div>
      <p className="small-note">선택한 기간의 그래프와 실제 혈당값만 보여줍니다. 링크를 받은 사람은 보호자 인증 없이 열 수 있으니 전달 대상과 만료일을 확인하세요.</p>
      {shareOpen && <form className="glucose-share-form" onSubmit={(event) => void createShare(event)}>
        <div className="form-grid">
          <label className="field-label">공유 시작일<input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} required /></label>
          <label className="field-label">공유 종료일<input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} required /></label>
          <label className="field-label">링크 만료<select value={expiresDays} onChange={(event) => setExpiresDays(event.target.value)}>
            <option value="1">24시간</option><option value="3">3일</option><option value="7">7일</option>
          </select></label>
        </div>
        <label className="check-row"><input type="checkbox" checked={includeCareTimes} onChange={(event) => setIncludeCareTimes(event.target.checked)} />같은 기간의 식사·인슐린 기록 시각도 포함</label>
        <button type="submit" className="button-primary" disabled={pending}>{pending ? '안전한 링크 생성 중…' : '링크 만들고 복사'}</button>
        {newLink && <label className="field-label full-field">공유 링크<input readOnly value={newLink} onFocus={(event) => event.currentTarget.select()} /></label>}
      </form>}
      {shares.some((item) => !item.revoked_at && Date.parse(item.expires_at) > now) && <ul className="glucose-share-list">
        {shares.filter((item) => !item.revoked_at && Date.parse(item.expires_at) > now).map((item) => <li key={item.id}>
          <span>{item.from_date} ~ {item.to_date}<small>만료 {new Date(item.expires_at).toLocaleString('ko-KR')}</small></span>
          <button type="button" className="text-button" disabled={pending} onClick={() => void revoke(item.id)}>링크 취소</button>
        </li>)}
      </ul>}
      {demo && <small>DEMO에서는 공유 링크가 생성되지 않습니다.</small>}
    </section>
    {message && <p role="status" className="small-note glucose-tools-message">{message}</p>}
  </section>;
}
