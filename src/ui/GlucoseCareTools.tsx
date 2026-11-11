import { useState, type FormEvent } from 'react';
import { callGlucoseShare, createShareToken, glucoseShareUrl, GlucoseShareRequestError, normalizeGuardianPhone, type GlucoseShareRange } from '../lib/glucose-share';
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
  const [includeCareValues, setIncludeCareValues] = useState(false);
  const [includeSymptoms, setIncludeSymptoms] = useState(false);
  const [acknowledgeBearerLink, setAcknowledgeBearerLink] = useState(false);
  const [expiresDays, setExpiresDays] = useState('1');
  const [shares, setShares] = useState<GlucoseShareRange[]>([]);
  const [newLink, setNewLink] = useState('');
  const [activeLinks, setActiveLinks] = useState<Record<string, string>>({});
  const [recipientPhone, setRecipientPhone] = useState('');
  const [guardianPhoneInput, setGuardianPhoneInput] = useState('');
  const [shareGuardianContact, setShareGuardianContact] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [now] = useState(() => Date.now());

  async function copyNewLink() {
    if (!newLink) return;
    try {
      await navigator.clipboard.writeText(newLink);
      setMessage('공유 링크를 복사했습니다. 문자나 메신저에 직접 붙여 넣어 보내세요.');
    } catch {
      setMessage('자동 복사가 안 됐습니다. 아래 링크를 선택해 복사해 주세요.');
    }
  }

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
    if (error) setMessage(error.code === '42501' ? '이 혈당 안정범위를 변경할 권한이 없습니다.' : '혈당 안정범위를 저장하지 못했습니다. 서버 적용과 입력값을 확인해 주세요.');
    else { setMessage('혈당 안정범위 저장을 확인했습니다.'); await onTargetSaved(); setTargetOpen(false); }
  }

  async function createShare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !canEdit || demo) { setMessage('승인된 보호자 계정으로 운영 서버에 연결해야 공유 링크를 만들 수 있습니다.'); return; }
    if (!fromDate || !toDate || fromDate > toDate || (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000 > 365) {
      setMessage('공유 시작일과 종료일을 확인해 주세요. 최대 1년 범위를 선택할 수 있습니다.'); return;
    }
    const guardianPhone = shareGuardianContact ? normalizeGuardianPhone(guardianPhoneInput) : null;
    if (shareGuardianContact && !guardianPhone) { setMessage('공유할 보호자 전화번호를 확인해 주세요.'); return; }
    setPending(true); setNewLink(''); setMessage('');
    try {
      const { token, tokenHash } = createShareToken();
      const result = await callGlucoseShare<{ share: GlucoseShareRange }>(supabase, {
        action: 'create', pet_id: petId, token_hash: await tokenHash, from_date: fromDate, to_date: toDate < today(timezone) ? today(timezone) : toDate,
        expires_days: Number(expiresDays), include_care_times: includeCareTimes, include_care_values: includeCareTimes && includeCareValues,
        guardian_contact_phone: guardianPhone, include_symptoms: includeSymptoms,
      });
      if (!result.share?.id) throw new Error('SHARE_CREATE_FAILED');
      const link = glucoseShareUrl(token);
      setNewLink(link);
      setActiveLinks((current) => ({ ...current, [result.share.id]: link }));
      try { await navigator.clipboard.writeText(link); setMessage(`${petName}의 혈당 공유 링크를 복사했습니다. 문자나 메신저에 직접 붙여 넣어 보내세요.`); }
      catch { setMessage('공유 링크를 만들었습니다. 아래 복사 버튼을 눌러 전달해 주세요.'); }
      await loadShares();
    } catch (error) {
      const code = error instanceof GlucoseShareRequestError ? error.code : error instanceof Error ? error.message : '';
      setMessage(code === 'ACCESS_DENIED' ? '이 반려동물의 공유 링크를 만들 권한이 없습니다.'
        : code === 'UNAUTHENTICATED' ? '로그인 인증이 만료되었습니다. 다시 로그인한 뒤 공유 링크를 만들어 주세요.'
        : code === 'SHARE_FUNCTION_NOT_DEPLOYED' ? '공유 기능 서버가 아직 운영 환경에 적용되지 않았습니다. 서버 배포가 필요합니다.'
          : code === 'SHARE_SCHEMA_UNAVAILABLE' ? '공유 기능의 데이터베이스 설정이 아직 운영 환경에 적용되지 않았습니다.'
            : code === 'SHARE_SERVICE_UNAVAILABLE' ? '공유 서버가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해 주세요.'
              : '공유 링크를 만들지 못했습니다. 오류 코드: ' + (/^[A-Z_]{3,64}$/.test(code) ? code : 'NETWORK_ERROR'));
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

  async function copyOrRenew(item: GlucoseShareRange) {
    const existing = activeLinks[item.id];
    if (existing) {
      setNewLink(existing);
      try { await navigator.clipboard.writeText(existing); setMessage('공유 링크를 다시 복사했습니다.'); }
      catch { setMessage('자동 복사가 안 됐습니다. 표시된 링크를 직접 복사해 주세요.'); }
      return;
    }
    if (!supabase || pending) return;
    setPending(true); setMessage('');
    try {
      const { token, tokenHash } = createShareToken();
      const result = await callGlucoseShare<{ share: GlucoseShareRange }>(supabase, {
        action: 'create', pet_id: petId, token_hash: await tokenHash, from_date: item.from_date,
        to_date: item.to_date < today(timezone) ? today(timezone) : item.to_date,
          expires_days: 1, include_care_times: item.include_care_times, include_care_values: item.include_care_values === true,
        guardian_contact_phone: item.guardian_contact_phone ?? null, include_symptoms: item.include_symptoms === true,
      });
      const link = glucoseShareUrl(token);
      setActiveLinks((current) => ({ ...current, [result.share.id]: link }));
      setNewLink(link);
      try { await navigator.clipboard.writeText(link); setMessage('새 링크를 발급하고 복사했습니다. 이전 링크도 만료 전까지 유효합니다.'); }
      catch { setMessage('새 링크를 발급했습니다. 아래 링크를 직접 복사해 주세요.'); }
      await loadShares();
    } catch { setMessage('새 링크를 발급하지 못했습니다. 연결과 권한을 확인해 주세요.'); }
    finally { setPending(false); }
  }

  function composeText(link: string) {
    const phone = recipientPhone.replace(/[\s()-]/g, '');
    if (!/^\+?\d{8,15}$/.test(phone)) { setMessage('받는 분의 전화번호를 확인해 주세요.'); return; }
    const body = `${petName}의 혈당기록\n${link}`;
    window.location.href = `sms:${phone}?body=${encodeURIComponent(body)}`;
    setMessage('문자 앱에서 내용을 확인한 뒤 직접 전송해 주세요. 앱에서는 실제 전송 여부를 확인할 수 없습니다.');
  }

  return <section className="panel glucose-care-tools">
    <h2>혈당 기준과 공유</h2>
    <details className="glucose-target-tools">
      <summary><strong>혈당 안정범위</strong><span>{target ? `${target.lower_mg_dl}–${target.upper_mg_dl} mg/dL` : '설정 안 됨'}</span></summary>
      <div className="glucose-tool-content">
      <div className="section-heading"><div><p className="eyebrow">수의사 안내</p><h3>혈당 안정범위</h3></div>
        {canEdit && !demo && <button type="button" className="text-button" aria-expanded={targetOpen} onClick={() => {
          if (!targetOpen && target) {
            setLower(String(target.lower_mg_dl)); setUpper(String(target.upper_mg_dl));
            setSource(target.source_label); setEffectiveOn(target.effective_on);
          }
          setTargetOpen((value) => !value);
        }}>{target ? '범위 수정' : '범위 입력'}</button>}</div>
      {target ? <><strong className="target-range-value">{target.lower_mg_dl}–{target.upper_mg_dl} mg/dL</strong>
        <small>{target.source_label} · 적용 시작 {target.effective_on}</small></>
        : <p className="small-note">등록된 혈당 안정범위가 없습니다. 임의 범위는 표시하지 않습니다.</p>}
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
      </div>
    </details>
    <details className="glucose-share-tools" onToggle={(event) => {
      const opening = event.currentTarget.open;
      setShareOpen(opening);
      if (opening) void loadShares();
    }}>
      <summary><strong>주치의와 혈당 공유</strong><span>혈당·체중을 함께 공유</span></summary>
      <div className="glucose-tool-content">
      {!demo && canEdit && <p className="eyebrow">혈당·체중 읽기 전용 · 만료 및 취소 가능</p>}
      {!demo && <p className="notice notice-warning" role="note">현재 링크는 별도의 수신자 인증 없이, 링크를 가진 사람이면 누구나 열 수 있습니다. 문자나 메신저 전달 시 재전달될 수 있어요. 수신자 확인 기능은 아직 제공하지 않습니다.</p>}
      {shareOpen && canEdit && !demo && <form className="glucose-share-form" onSubmit={(event) => void createShare(event)}>
        <div className="form-grid">
          <label className="field-label">공유 시작일<input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} required /></label>
          <label className="field-label">공유 종료일<input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} required /></label>
          <label className="field-label">링크 만료<select value={expiresDays} onChange={(event) => setExpiresDays(event.target.value)}>
            <option value="1">24시간</option><option value="3">3일</option><option value="7">7일</option>
          </select></label>
        </div>
        <label className="check-row"><input type="checkbox" checked={includeCareTimes} onChange={(event) => { setIncludeCareTimes(event.target.checked); if (!event.target.checked) setIncludeCareValues(false); }} />같은 기간의 식사·인슐린 기록 시각도 포함</label>
        {includeCareTimes && <label className="check-row"><input type="checkbox" checked={includeCareValues} onChange={(event) => setIncludeCareValues(event.target.checked)} />식사 내용·섭취량과 인슐린 제품·투여량을 함께 공유 (민감정보)</label>}
        <label className="check-row"><input type="checkbox" checked={includeSymptoms} onChange={(event) => setIncludeSymptoms(event.target.checked)} />증상·컨디션 기록 전체 이력도 공유 (선택한 날짜 범위와 별개)</label>
        {includeSymptoms && <small className="share-contact-disclosure">이 링크가 열려 있는 동안 날짜 범위 밖의 증상·컨디션 메모도 모두 표시됩니다. 민감한 내용이 포함될 수 있으니 공유 대상을 확인해 주세요.</small>}
        <label className="check-row share-access-ack"><input type="checkbox" checked={acknowledgeBearerLink} required onChange={(event) => setAcknowledgeBearerLink(event.target.checked)} />링크만 가진 사람도 만료 전까지 열람할 수 있음을 확인했습니다.</label>
        <label className="check-row"><input type="checkbox" checked={shareGuardianContact} onChange={(event) => setShareGuardianContact(event.target.checked)} />공유 페이지에 보호자 연락 버튼 표시</label>
        {shareGuardianContact && <><label className="field-label full-field">보호자 전화번호<input type="tel" inputMode="tel" autoComplete="tel" value={guardianPhoneInput} onChange={(event) => setGuardianPhoneInput(event.target.value)} placeholder="예: 010-1234-5678" required /></label>
          <small className="share-contact-disclosure">이 번호는 공유 링크를 열 수 있는 사람에게 표시됩니다. 연락처를 공유해도 괜찮은 경우에만 선택하세요.</small></>}
        <button type="submit" className="button-primary" disabled={pending}>{pending ? '안전한 링크 생성 중…' : '링크 만들고 복사'}</button>
        {newLink && <div className="share-link-result">
          <label className="field-label full-field">공유 링크<input readOnly value={newLink} onFocus={(event) => event.currentTarget.select()} /></label>
          <button type="button" className="button-secondary" onClick={() => void copyNewLink()}>링크 복사</button>
          <label className="field-label full-field">받는 분 전화번호 (기기에 저장되지 않음)<input type="tel" inputMode="tel" autoComplete="off" value={recipientPhone} onChange={(event) => setRecipientPhone(event.target.value)} placeholder="전화번호 입력" /></label>
          <button type="button" className="button-secondary" onClick={() => composeText(newLink)}>문자 앱에서 보내기</button>
        </div>}
      </form>}
      {shares.some((item) => !item.revoked_at && Date.parse(item.expires_at) > now) && <ul className="glucose-share-list">
        {shares.filter((item) => !item.revoked_at && Date.parse(item.expires_at) > now).map((item) => <li key={item.id}>
          <span>{item.from_date} ~ {item.to_date}<small>만료 {new Date(item.expires_at).toLocaleString('ko-KR')} · {item.include_care_values ? '식사 내용·인슐린 제품·수치 포함' : item.include_care_times ? '식사·인슐린 시각만' : '혈당·체중'}{item.include_symptoms ? ' · 증상·컨디션 전체 이력' : ''}</small></span>
          <div className="share-list-actions"><button type="button" className="text-button" disabled={pending} onClick={() => void copyOrRenew(item)}>{activeLinks[item.id] ? '다시 복사' : '새 링크 발급·복사'}</button>
          {activeLinks[item.id] && <button type="button" className="text-button" onClick={() => { setNewLink(activeLinks[item.id]); setMessage('아래에 받는 분 번호를 입력하고 문자 앱을 여세요.'); }}>문자로 보내기</button>}
          <button type="button" className="text-button" disabled={pending} onClick={() => void revoke(item.id)}>링크 취소</button></div>
        </li>)}
      </ul>}
      {demo && <small>DEMO에서는 공유 링크가 생성되지 않습니다.</small>}
      </div>
    </details>
    {message && <p role="status" className="small-note glucose-tools-message">{message}</p>}
  </section>;
}
