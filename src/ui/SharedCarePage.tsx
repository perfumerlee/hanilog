import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { householdInvalidationChannel } from '../lib/realtime';

type Household = { id: string; name: string };
type Pet = { id: string; household_id: string; name: string };
type Membership = { id: string; user_id: string; role: string; status: string; created_at: string };
type Grant = { id: string; pet_id: string; user_id: string; access_role: 'CAREGIVER' | 'READ_ONLY'; status: string };
type Invitation = { id: string; invitee_email: string; membership_role: string; pet_ids: string[]; status: string; expires_at: string };

const messageFor = (error: { code?: string } | null, fallback: string) => {
  if (!error) return '';
  if (error.code === '42501') return '현재 권한이 없어 요청을 완료하지 못했습니다. 서버에서 접근권한을 다시 확인해 주세요.';
  if (error.code === '23505') return '이미 활성 멤버십 또는 초대가 존재합니다.';
  return fallback;
};

export function SharedCarePage({ households, pets, userId }: { households: Household[]; pets: Pet[]; userId: string }) {
  const [selectedHouseholdId, setSelectedHouseholdId] = useState(households[0]?.id ?? '');
  const householdId = households.some((item) => item.id === selectedHouseholdId) ? selectedHouseholdId : households[0]?.id ?? '';
  const [members, setMembers] = useState<Membership[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'CAREGIVER' | 'READ_ONLY'>('CAREGIVER');
  const [petIds, setPetIds] = useState<string[]>([]);
  const [inviteUrl, setInviteUrl] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [realtimeStatus, setRealtimeStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const location = useLocation();
  const householdPets = useMemo(() => pets.filter((pet) => pet.household_id === householdId), [householdId, pets]);

  const refresh = useCallback(async () => {
    if (!supabase || !householdId) return;
    setLoading(true);
    const petRows = pets;
    const householdPetIds = petRows.map((pet) => pet.id);
    const [memberResult, grantResult, inviteResult] = await Promise.all([
      supabase.from('household_memberships').select('id,user_id,role,status,created_at').eq('household_id', householdId).eq('status', 'ACTIVE').order('created_at'),
      householdPetIds.length ? supabase.from('pet_access_grants').select('id,pet_id,user_id,access_role,status').in('pet_id', householdPetIds).eq('status', 'ACTIVE') : Promise.resolve({ data: [], error: null }),
      supabase.from('household_invitations').select('id,invitee_email,membership_role,pet_ids,status,expires_at').eq('household_id', householdId).order('created_at', { ascending: false }).limit(30),
    ]);
    setMembers((memberResult.data ?? []) as Membership[]);
    setGrants((grantResult.data ?? []) as Grant[]);
    setInvitations((inviteResult.data ?? []) as Invitation[]);
    if (memberResult.error || grantResult.error) setNotice(messageFor(memberResult.error ?? grantResult.error, '공동 보호자 정보를 불러오지 못했습니다.'));
    else if (inviteResult.error) setInvitations([]); // Invite list is visible to the household manager only.
    setCanManage((memberResult.data ?? []).some((item) => item.user_id === userId && item.role === 'PRIMARY_CAREGIVER' && item.status === 'ACTIVE'));
    setLoading(false);
  }, [householdId, pets, userId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    if (!supabase || !householdId) return;
    let timer = 0;
    const refreshHint = () => { window.clearTimeout(timer); timer = window.setTimeout(() => { void refresh(); }, 150); };
    const channel = householdInvalidationChannel(supabase, householdId, refreshHint);
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') { setRealtimeStatus('connected'); refreshHint(); }
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') setRealtimeStatus('disconnected');
    });
    const check = () => { void refresh(); };
    window.addEventListener('focus', check);
    const interval = window.setInterval(check, 60_000);
    return () => { window.clearTimeout(timer); window.clearInterval(interval); window.removeEventListener('focus', check); void supabase?.removeChannel(channel); };
  }, [householdId, pets, refresh]);

  useEffect(() => {
    const clearOnRevocation = () => {
      setMembers([]); setGrants([]); setInvitations([]);
      setNotice('접근권한 변경을 확인 중입니다. 서버에서 목록을 다시 불러옵니다.');
      void refresh();
    };
    window.addEventListener('hanilog:access-changed', clearOnRevocation);
    return () => window.removeEventListener('hanilog:access-changed', clearOnRevocation);
  }, [refresh]);

  async function createInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase || !householdId || !email.trim() || !petIds.length) return;
    setBusy(true); setNotice(''); setInviteUrl('');
    const { data, error } = await supabase.rpc('create_household_invitation', {
      p_household_id: householdId, p_invitee_email: email.trim(), p_membership_role: role, p_pet_ids: petIds, p_expires_at: null,
    });
    if (error) setNotice(messageFor(error, '초대를 만들지 못했습니다.'));
    else {
      const result = data as { token?: string };
      if (!result.token) setNotice('초대 응답을 확인할 수 없습니다. 초대 링크는 표시하지 않았습니다.');
      else {
        const url = new URL(location.pathname, window.location.origin);
        url.hash = `/invite?token=${encodeURIComponent(result.token)}`;
        setInviteUrl(url.toString());
        setNotice('초대를 만들었습니다. 이 토큰은 서버에 해시로만 저장되며, 링크를 초대받은 사람에게 안전하게 전달하세요. 링크만으로는 기록을 열람할 수 없습니다.');
        setEmail(''); await refresh();
      }
    }
    setBusy(false);
  }

  async function changeGrant(petId: string, memberId: string, nextRole: 'CAREGIVER' | 'READ_ONLY' | 'REVOKE') {
    if (!supabase) return;
    setBusy(true); setNotice('');
    const current = grants.find((grant) => grant.pet_id === petId && grant.user_id === memberId);
    const { error } = await supabase.rpc('manage_pet_access', {
      p_pet_id: petId, p_user_id: memberId, p_access_role: nextRole === 'REVOKE' ? current?.access_role ?? 'READ_ONLY' : nextRole,
      p_revoke: nextRole === 'REVOKE',
    });
    setNotice(messageFor(error, 'Pet 접근권한을 변경하지 못했습니다.') || 'Pet 접근권한을 서버에서 변경했습니다.');
    await refresh(); setBusy(false);
  }

  async function revokeMember(member: Membership) {
    if (!supabase || member.user_id === userId) return;
    setBusy(true); setNotice('');
    const { error } = await supabase.rpc('revoke_household_member', { p_household_id: householdId, p_user_id: member.user_id });
    setNotice(messageFor(error, '멤버 권한을 철회하지 못했습니다.') || '멤버십과 해당 Household의 Pet 권한을 함께 철회했습니다.');
    await refresh(); setBusy(false);
  }

  async function revokeInvitation(invitationId: string) {
    if (!supabase) return;
    setBusy(true); setNotice('');
    const { error } = await supabase.rpc('revoke_household_invitation', { p_invitation_id: invitationId });
    setNotice(messageFor(error, '초대를 철회하지 못했습니다.') || '초대를 철회했습니다.');
    await refresh(); setBusy(false);
  }

  return <main className="page-container">
    <section className="page-heading"><p className="eyebrow">Shared Care</p><h1>함께 돌보는 사람</h1>
      <p>초대 수락 전에는 Household나 건강기록 접근권한이 없습니다. 초대에는 선택한 Pet 접근 범위만 포함됩니다.</p></section>
    {notice && <div role="status" className="notice notice-warning">{notice}</div>}
    {inviteUrl && <section className="panel"><h2>초대 링크</h2><label className="field-label">한 번 표시되는 링크<input readOnly value={inviteUrl} onFocus={(event) => event.currentTarget.select()} /></label>
      <p className="small-note">이 링크는 초대 대상 이메일로 로그인한 사용자만 수락할 수 있고, 만료 또는 사용 후 재사용할 수 없습니다. 링크 전달 채널의 안전성은 보호자가 확인하세요.</p></section>}
    {!households.length ? <section className="panel empty-panel"><h2>Household가 없습니다</h2><p>먼저 Dashboard에서 공동 돌봄 Household와 Pet을 등록해 주세요.</p><Link className="button-link" to="/">Dashboard로 이동</Link></section> : <>
      <section className="panel"><label className="field-label">관리 Household<select value={householdId} onChange={(event) => { setSelectedHouseholdId(event.target.value); setPetIds([]); setInviteUrl(''); }}>
        {households.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
      </select></label></section>
      <section className="panel"><div className="section-heading"><h2>보호자 초대</h2><span className="small-note">Primary caregiver가 발급</span></div>
        <form className="stack" onSubmit={(event) => void createInvite(event)}>
          <label className="field-label">초대받을 이메일<input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label className="field-label">역할<select value={role} onChange={(event) => setRole(event.target.value as typeof role)}><option value="CAREGIVER">공동 보호자 · 기록 가능</option><option value="READ_ONLY">읽기 전용</option></select></label>
          <fieldset className="invite-pets"><legend>접근을 허용할 Pet</legend>{householdPets.map((pet) => <label className="check-row" key={pet.id}>
            <input type="checkbox" checked={petIds.includes(pet.id)} onChange={(event) => setPetIds((current) => event.target.checked ? [...current, pet.id] : current.filter((id) => id !== pet.id))} />{pet.name}
          </label>)}</fieldset>
          <button disabled={busy || !canManage || !petIds.length}>{busy ? '처리 중…' : '초대 링크 발급'}</button>
          {!canManage && <p className="small-note">초대·권한 변경은 주 보호자만 할 수 있습니다. 현재 로그인한 역할에서 확인되지 않았습니다.</p>}
        </form>
      </section>
      <section className="panel"><div className="section-heading"><h2>현재 멤버</h2><button type="button" className="secondary-action" onClick={() => void refresh()} disabled={loading}>새로 확인</button></div>
        <p className="small-note" role="status">권한 변경 실시간 {realtimeStatus === 'connected' ? '연결됨' : realtimeStatus === 'connecting' ? '연결 확인 중' : '끊김 · 주기적으로 서버 재확인'}</p>
        {loading ? <p role="status">서버에서 권한을 확인하고 있습니다…</p> : <ul className="member-list">{members.map((member) => <li key={member.id}>
          <div className="member-heading"><strong>{member.role === 'PRIMARY_CAREGIVER' ? '주 보호자' : member.role === 'READ_ONLY' ? '읽기 전용' : '공동 보호자'}</strong><code>{member.user_id === userId ? '나' : member.user_id.slice(0, 8)}</code></div>
          {member.role !== 'PRIMARY_CAREGIVER' && householdPets.map((pet) => {
            const grant = grants.find((item) => item.pet_id === pet.id && item.user_id === member.user_id);
          return <div className="grant-row" key={pet.id}><span>{pet.name}</span><select aria-label={`${pet.name} 접근 역할`} value={grant?.access_role ?? 'NONE'} disabled={busy || !canManage || member.user_id === userId}
            onChange={(event) => {
              const nextRole = event.target.value;
              if (nextRole === 'NONE') { if (grant) void changeGrant(pet.id, member.user_id, 'REVOKE'); }
              else void changeGrant(pet.id, member.user_id, nextRole as 'CAREGIVER' | 'READ_ONLY' | 'REVOKE');
            }}>
              <option value="NONE">접근 없음</option><option value="CAREGIVER" disabled={member.role === 'READ_ONLY'}>기록 가능</option><option value="READ_ONLY">읽기 전용</option>
              {grant && <option value="REVOKE">접근 철회</option>}
              </select></div>;
          })}
          {member.role !== 'PRIMARY_CAREGIVER' && member.user_id !== userId && <button className="danger-button" type="button" disabled={busy || !canManage} onClick={() => void revokeMember(member)}>Household 멤버십 철회</button>}
        </li>)}{!members.length && <li>현재 멤버를 확인하지 못했습니다.</li>}</ul>}
        <p className="small-note">사용자 표시는 개인정보 최소화를 위해 계정 UUID 일부만 사용합니다. 권한 변경은 서버에서 다시 검사되고 감사됩니다.</p>
      </section>
      <section className="panel"><div className="section-heading"><h2>초대 상태</h2><span className="small-note">링크의 토큰은 표시하지 않음</span></div>
        {invitations.length ? <ul className="invite-list">{invitations.map((item) => <li key={item.id}><strong>{item.invitee_email}</strong><span>{item.membership_role === 'READ_ONLY' ? '읽기 전용' : '공동 보호자'} · {item.status}</span><small>만료 {new Date(item.expires_at).toLocaleString()}</small>
          {item.status === 'PENDING' && <button type="button" className="danger-button" disabled={busy || !canManage} onClick={() => void revokeInvitation(item.id)}>초대 철회</button>}</li>)}</ul> : <p className="small-note">초대가 없거나 현재 역할에서 목록을 볼 권한이 없습니다.</p>}
      </section>
    </>}
  </main>;
}

export function InvitationAcceptPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const token = new URLSearchParams(location.search).get('token') ?? '';
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('초대의 상태와 로그인한 이메일을 서버에서 확인해야 Pet 기록에 접근할 수 있습니다.');
  const [resolved, setResolved] = useState(false);

  async function resolve(accept: boolean) {
    if (!supabase || !token) return;
    setBusy(true);
    const { data, error } = await supabase.rpc('resolve_household_invitation', { p_token: token, p_accept: accept });
    if (error) setMessage(error.code === '42501' ? '초대가 유효하지 않거나 만료·사용되었거나, 현재 로그인 이메일과 일치하지 않습니다.' : '초대 응답을 서버에서 확인하지 못했습니다. 다시 조회해 주세요.');
    else {
      const status = (data as { status?: string } | null)?.status;
      setMessage(status === 'ACCEPTED' ? '초대를 수락했습니다. Pet 접근권한이 서버에 반영됐습니다.' : status === 'EXPIRED' ? '초대가 만료되었습니다.' : '초대를 거절했습니다.');
      setResolved(true);
      navigate('/invite', { replace: true });
    }
    setBusy(false);
  }

  return <main className="page-container"><section className="page-heading"><p className="eyebrow">초대 확인</p><h1>공동 돌봄 초대</h1></section>
    <section className="panel"><p role="status">{message}</p>{!token ? <p role="alert" className="error-text">초대 토큰이 없습니다.</p> : !resolved && <div className="action-row">
      <button disabled={busy} onClick={() => void resolve(true)}>{busy ? '확인 중…' : '로그인한 이메일로 수락'}</button>
      <button className="secondary-action" disabled={busy} onClick={() => void resolve(false)}>거절</button>
    </div>}
      <p className="small-note">수락 전에는 초대 링크만으로 비공개 Pet 기록을 조회할 수 없습니다. 수락은 현재 로그인 이메일과 일치할 때만 가능합니다.</p>
    </section><Link className="button-link" to="/">Pet 목록 새로고침</Link>
  </main>;
}
