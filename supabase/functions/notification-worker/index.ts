import { createClient } from 'npm:@supabase/supabase-js@2';
import { send as sendWebPush, type Subscription } from 'jsr:@daaku/webpush@0.2.0';

type Outbox = { id: string; notification_id: string; recipient_user_id: string; pet_id: string; channel: 'PUSH'|'EMAIL'; attempt_count: number };
type Notice = { id: string; title: string; body: string; action_path: string; expires_at: string; invalidated_at: string | null };
const constantTimeEqual = (a: string, b: string) => {
  const encoder = new TextEncoder(); const left = encoder.encode(a); const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
};
const retryDelay = (attempt: number) => Math.min(86400, 30 * 2 ** Math.min(attempt, 10)) + Math.floor(Math.random() * 20);

Deno.serve(async (request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const workerSecret = Deno.env.get('NOTIFICATION_WORKER_SECRET');
  const supplied = request.headers.get('x-hanilog-worker-secret') ?? '';
  if (!workerSecret || !constantTimeEqual(workerSecret, supplied)) return new Response('Unauthorized', { status: 401 });
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return new Response('Worker configuration unavailable', { status: 503 });
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const mode = Deno.env.get('NOTIFICATION_DELIVERY_MODE') ?? 'mock';
  if (!['mock','live'].includes(mode)) return new Response('Invalid delivery mode', { status: 503 });

  const horizon = await db.rpc('prepare_notification_occurrences', { p_days: 7 });
  const unconfirmed = await db.rpc('materialize_unconfirmed_notifications');
  const reconciled = await db.rpc('reconcile_notification_outbox');
  if (horizon.error || unconfirmed.error || reconciled.error) return new Response('Notification preparation failed', { status: 500 });
  const { data: rows, error } = await db.rpc('claim_notification_outbox', { p_limit: 50 });
  if (error) return new Response('Outbox claim failed', { status: 500 });
  let processed = 0;
  for (const row of (rows ?? []) as Outbox[]) {
    let providerMessageId: string | null = null;
    try {
      const [{ data: notice }, { data: preference }, { data: grant }] = await Promise.all([
        db.from('in_app_notifications').select('id,title,body,action_path,expires_at,invalidated_at').eq('id', row.notification_id).maybeSingle(),
        db.from('notification_preferences').select('push_enabled,email_enabled').eq('pet_id',row.pet_id).eq('user_id',row.recipient_user_id).eq('notification_type',(await db.from('in_app_notifications').select('notification_type').eq('id',row.notification_id).maybeSingle()).data?.notification_type ?? '').maybeSingle(),
        db.from('pet_access_grants').select('id').eq('pet_id',row.pet_id).eq('user_id',row.recipient_user_id).eq('status','ACTIVE').maybeSingle(),
      ]);
      const noticeRow = notice as Notice | null;
      if (!noticeRow || noticeRow.invalidated_at || Date.parse(noticeRow.expires_at) <= Date.now() || !grant ||
        !(row.channel === 'PUSH' ? preference?.push_enabled : preference?.email_enabled)) {
        await db.rpc('finish_notification_delivery',{p_outbox_id:row.id,p_result:'SUPPRESSED',p_error_code:'RECIPIENT_OR_PREFERENCE_INVALID'});
        continue;
      }
      if (mode === 'mock') {
        await db.rpc('finish_notification_delivery',{p_outbox_id:row.id,p_result:'MOCK_ACCEPTED',p_provider_message_id:`mock-${row.id}`});
        processed++; continue;
      }
      if (row.channel === 'PUSH') {
        if (!Deno.env.get('VAPID_PRIVATE_KEY') || !Deno.env.get('VAPID_SUBJECT')) throw Object.assign(new Error('PUSH_PROVIDER_UNCONFIGURED'),{code:'PUSH_PROVIDER_UNCONFIGURED',permanent:true});
        const { data: subs } = await db.from('push_subscriptions').select('id,endpoint,endpoint_hash,p256dh,auth_secret,expiration_time').eq('user_id',row.recipient_user_id).is('revoked_at',null);
        const expiredSubs=(subs??[]).filter((sub)=>sub.expiration_time && Date.parse(sub.expiration_time)<=Date.now());
        if (expiredSubs.length) await db.from('push_subscriptions').update({revoked_at:new Date().toISOString()}).in('id',expiredSubs.map((sub)=>sub.id));
        const activeSubs=(subs??[]).filter((sub)=>!sub.expiration_time||Date.parse(sub.expiration_time)>Date.now());
        if (!activeSubs.length) throw Object.assign(new Error('NO_ACTIVE_SUBSCRIPTION'),{code:'NO_ACTIVE_SUBSCRIPTION',permanent:true});
        const vapid = Deno.env.get('VAPID_PRIVATE_KEY')!;
        let sent = false;
        for (const sub of activeSubs) {
          try {
            await sendWebPush({ endpoint:sub.endpoint, keys:{p256dh:sub.p256dh,auth:sub.auth_secret} } as Subscription,
              JSON.stringify({notificationId:noticeRow.id,petId:row.pet_id}),{vapid,subscriber:Deno.env.get('VAPID_SUBJECT')!,ttl:Math.max(0,Math.floor((Date.parse(noticeRow.expires_at)-Date.now())/1000)),topic:noticeRow.id.replace(/-/g,'').slice(0,32)});
            sent=true;
          } catch (providerError) {
            const permanent = typeof providerError==='object' && providerError!==null && 'permanent' in providerError && Boolean(providerError.permanent);
            if (permanent) await db.from('push_subscriptions').update({revoked_at:new Date().toISOString()}).eq('id',sub.id);
            if (!permanent) throw Object.assign(new Error('PUSH_PROVIDER_RETRYABLE'),{code:'PUSH_PROVIDER_RETRYABLE',permanent:false});
          }
        }
        if (!sent) throw Object.assign(new Error('PUSH_SUBSCRIPTIONS_EXPIRED'),{code:'PUSH_SUBSCRIPTIONS_EXPIRED',permanent:true});
      } else {
        const resendKey=Deno.env.get('RESEND_API_KEY'); const from=Deno.env.get('RESEND_FROM');
        if (!resendKey || !from) throw Object.assign(new Error('EMAIL_PROVIDER_UNCONFIGURED'),{code:'EMAIL_PROVIDER_UNCONFIGURED',permanent:true});
        const { data: userResult, error: userError } = await db.auth.admin.getUserById(row.recipient_user_id);
        const email=userResult.user?.email;
        if (userError || !email || !userResult.user?.email_confirmed_at) throw Object.assign(new Error('EMAIL_RECIPIENT_UNAVAILABLE'),{code:'EMAIL_RECIPIENT_UNAVAILABLE',permanent:true});
        const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${resendKey}`,'Content-Type':'application/json','Idempotency-Key':`hanilog-${row.id}`},body:JSON.stringify({from,to:[email],subject:'HaniLog 돌봄 일정 안내',text:'HaniLog에 확인할 돌봄 안내가 있습니다. 로그인하여 최신 기록을 확인해 주세요.'})});
        if (!response.ok) throw Object.assign(new Error('EMAIL_PROVIDER_REJECTED'),{code:`RESEND_${response.status}`,permanent:response.status>=400&&response.status<500});
        const result = await response.json().catch(() => ({}));
        if (typeof result.id === 'string') providerMessageId = result.id;
      }
      const { error: finishError } = await db.rpc('finish_notification_delivery',{p_outbox_id:row.id,p_result:mode==='mock'?'MOCK_ACCEPTED':'ACCEPTED',p_provider_message_id:mode==='mock'?`mock-${row.id}`:providerMessageId});
      if (finishError) throw Object.assign(new Error('DELIVERY_STATUS_PERSIST_FAILED'),{code:'DELIVERY_STATUS_PERSIST_FAILED'});
      processed++;
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String((error as Error & {code:string}).code) : 'DELIVERY_FAILED';
      const permanent = typeof error==='object' && error!==null && 'permanent' in error && Boolean((error as {permanent:unknown}).permanent);
      await db.rpc('finish_notification_delivery',{p_outbox_id:row.id,p_result:permanent?'PERMANENT_FAILURE':'RETRYABLE_FAILURE',p_error_code:code,p_retry_seconds:permanent?null:retryDelay(row.attempt_count)});
    }
  }
  return Response.json({ processed, claimed:(rows??[]).length, preparation:{created_occurrences:horizon.data,unconfirmed:unconfirmed.data,suppressed:reconciled.data}, mode });
});
