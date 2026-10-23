import { createClient } from 'npm:@supabase/supabase-js@2';
import { send as sendWebPush, type Subscription } from 'jsr:@daaku/webpush@0.2.0';
import { classifyResendResponse, parseRetryAfter, retryDelaySeconds } from '../_shared/notification-retry.ts';

type Outbox = { id: string; notification_id: string; recipient_user_id: string; pet_id: string; channel: 'PUSH'|'EMAIL'; attempt_count: number };
type Notice = { id: string; title: string; body: string; expires_at: string; invalidated_at: string | null; notification_type: string };
type DeviceDelivery = { id: string; subscription_id: string | null; attempt_count: number };
const constantTimeEqual = (a: string, b: string) => {
  const encoder = new TextEncoder(); const left = encoder.encode(a); const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  for (let i = 0; i < Math.max(left.length, right.length); i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
};
const codedError = (code: string, permanent = false, retryAfterSeconds: number | null = null, duplicatePossible = false) =>
  Object.assign(new Error(code), { code, permanent, retryAfterSeconds, duplicatePossible });
const errInfo = (error: unknown) => {
  if (typeof error !== 'object' || error === null) return { code: 'DELIVERY_FAILED', permanent: false, retryAfterSeconds: null, duplicatePossible: true };
  const item = error as { code?: unknown; permanent?: unknown; retryAfterSeconds?: unknown; duplicatePossible?: unknown };
  return { code: typeof item.code === 'string' ? item.code : 'DELIVERY_FAILED', permanent: item.permanent === true,
    retryAfterSeconds: typeof item.retryAfterSeconds === 'number' ? item.retryAfterSeconds : null, duplicatePossible: item.duplicatePossible === true };
};

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
  let testFailHashes: string[] = [];
  let mockEmailStatus: number | null = null; let mockEmailRetryAfter: string | null = null;
  if (mode === 'mock') {
    const body = await request.json().catch(() => ({})) as { mock_push_fail_endpoint_hashes?: unknown; mock_email_status?: unknown; mock_email_retry_after?: unknown };
    if (Array.isArray(body.mock_push_fail_endpoint_hashes)) testFailHashes = body.mock_push_fail_endpoint_hashes
      .filter((value): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value));
    if (typeof body.mock_email_status === 'number' && Number.isInteger(body.mock_email_status) && body.mock_email_status>=400 && body.mock_email_status<=599) {
      mockEmailStatus=body.mock_email_status;
    }
    if (typeof body.mock_email_retry_after === 'string' && body.mock_email_retry_after.length<=128) mockEmailRetryAfter=body.mock_email_retry_after;
  }

  const horizon = await db.rpc('prepare_notification_occurrences', { p_days: 7 });
  const unconfirmed = await db.rpc('materialize_unconfirmed_notifications');
  const reconciled = await db.rpc('reconcile_notification_outbox');
  if (horizon.error || unconfirmed.error || reconciled.error) return new Response('Notification preparation failed', { status: 500 });
  const { data: rows, error } = await db.rpc('claim_notification_outbox', { p_limit: 50 });
  if (error) return new Response('Outbox claim failed', { status: 500 });
  let processed = 0;
  let statusPersistenceFailed = false;
  for (const row of (rows ?? []) as Outbox[]) {
    let providerMessageId: string | null = null;
    try {
      const [{ data: notice }, { data: preference }, { data: grant }] = await Promise.all([
        db.from('in_app_notifications').select('id,title,body,expires_at,invalidated_at,notification_type').eq('id', row.notification_id).maybeSingle(),
        db.from('notification_preferences').select('push_enabled,email_enabled').eq('pet_id',row.pet_id).eq('user_id',row.recipient_user_id)
          .eq('notification_type',(await db.from('in_app_notifications').select('notification_type').eq('id',row.notification_id).maybeSingle()).data?.notification_type ?? '').maybeSingle(),
        db.from('pet_access_grants').select('id').eq('pet_id',row.pet_id).eq('user_id',row.recipient_user_id).eq('status','ACTIVE').maybeSingle(),
      ]);
      const noticeRow = notice as Notice | null;
      if (!noticeRow || noticeRow.invalidated_at || Date.parse(noticeRow.expires_at) <= Date.now() || !grant ||
        !(row.channel === 'PUSH' ? preference?.push_enabled : preference?.email_enabled)) {
        await db.rpc('finish_notification_delivery',{p_outbox_id:row.id,p_result:'SUPPRESSED',p_error_code:'RECIPIENT_OR_PREFERENCE_INVALID'});
        continue;
      }

      if (row.channel === 'PUSH') {
        const { error: prepareError } = await db.rpc('prepare_notification_push_deliveries',{p_outbox_id:row.id});
        if (prepareError) throw codedError('PUSH_TARGET_PREPARATION_FAILED');
        const { data: deliveries, error: claimError } = await db.rpc('claim_notification_push_deliveries',{p_outbox_id:row.id,p_limit:50});
        if (claimError) throw codedError('PUSH_DEVICE_CLAIM_FAILED');
        if (!deliveries?.length) {
          const { count, error: countError } = await db.from('notification_push_deliveries').select('id',{count:'exact',head:true}).eq('outbox_id',row.id);
          if (countError) throw codedError('PUSH_TARGET_COUNT_FAILED');
          const outcome = !count ? 'PERMANENT_FAILURE' : 'ACCEPTED';
          const { error: finishError } = await db.rpc('finish_notification_delivery',{p_outbox_id:row.id,p_result:outcome,p_error_code:!count?'NO_ACTIVE_SUBSCRIPTION':null});
          if (finishError) throw codedError('DELIVERY_STATUS_PERSIST_FAILED');
          processed++; continue;
        }
        if (mode === 'live' && (!Deno.env.get('VAPID_PRIVATE_KEY') || !Deno.env.get('VAPID_SUBJECT'))) throw codedError('PUSH_PROVIDER_UNCONFIGURED',true);

        for (const delivery of deliveries as DeviceDelivery[]) {
          let result: 'ACCEPTED'|'MOCK_ACCEPTED'|'RETRYABLE_FAILURE'|'PERMANENT_FAILURE'|'SUPPRESSED' = 'ACCEPTED';
          let errorCode: string | null = null; let retrySeconds: number | null = null; let duplicatePossible = false; let deviceProviderId: string | null = null;
          try {
            const [{ data: currentNotice },{ data: currentGrant },{ data: currentPref },{ data: sub }] = await Promise.all([
              db.from('in_app_notifications').select('invalidated_at,expires_at').eq('id',row.notification_id).maybeSingle(),
              db.from('pet_access_grants').select('id').eq('pet_id',row.pet_id).eq('user_id',row.recipient_user_id).eq('status','ACTIVE').maybeSingle(),
              db.from('notification_preferences').select('push_enabled').eq('pet_id',row.pet_id).eq('user_id',row.recipient_user_id).eq('notification_type',noticeRow.notification_type).maybeSingle(),
              delivery.subscription_id ? db.from('push_subscriptions').select('id,endpoint,endpoint_hash,p256dh,auth_secret,expiration_time,revoked_at')
                .eq('id',delivery.subscription_id).eq('user_id',row.recipient_user_id).maybeSingle() : Promise.resolve({data:null,error:null}),
            ]);
            if (!currentNotice || currentNotice.invalidated_at || Date.parse(currentNotice.expires_at)<=Date.now() || !currentGrant || !currentPref?.push_enabled ||
              !sub || sub.revoked_at || (sub.expiration_time && Date.parse(sub.expiration_time)<=Date.now())) {
              result='SUPPRESSED'; errorCode='RECIPIENT_OR_DEVICE_NO_LONGER_ELIGIBLE';
            } else if (mode === 'mock' && testFailHashes.includes(sub.endpoint_hash)) {
              result='RETRYABLE_FAILURE'; errorCode='MOCK_TRANSIENT_FAILURE'; retrySeconds=30;
            } else if (mode === 'mock') {
              result='MOCK_ACCEPTED'; deviceProviderId=`mock-${delivery.id}-${delivery.attempt_count}`;
            } else {
              const vapid=Deno.env.get('VAPID_PRIVATE_KEY')!;
              await sendWebPush({endpoint:sub.endpoint,keys:{p256dh:sub.p256dh,auth:sub.auth_secret}} as Subscription,
                JSON.stringify({notificationId:noticeRow.id,petId:row.pet_id}),
                {vapid,subscriber:Deno.env.get('VAPID_SUBJECT')!,ttl:Math.max(0,Math.floor((Date.parse(noticeRow.expires_at)-Date.now())/1000)),topic:noticeRow.id.replace(/-/g,'').slice(0,32)});
            }
          } catch (providerError) {
            const info=errInfo(providerError);
            const statusCode=typeof providerError==='object'&&providerError!==null&&'statusCode' in providerError
              ? Number((providerError as {statusCode:unknown}).statusCode) : 0;
            const permanent=info.permanent || statusCode===404 || statusCode===410;
            result=permanent?'PERMANENT_FAILURE':'RETRYABLE_FAILURE';
            errorCode=permanent?'PUSH_SUBSCRIPTION_GONE':'PUSH_PROVIDER_RETRYABLE';
            retrySeconds=retryDelaySeconds(delivery.attempt_count,info.retryAfterSeconds);
            duplicatePossible=!permanent;
          }
          const { error: deviceFinishError } = await db.rpc('finish_notification_push_delivery',{
            p_delivery_id:delivery.id,p_result:result,p_error_code:errorCode,p_provider_message_id:deviceProviderId,
            p_retry_seconds:retrySeconds,p_duplicate_possible:duplicatePossible,
          });
          if (deviceFinishError) throw codedError('PUSH_DEVICE_STATUS_PERSIST_FAILED');
        }
        const { error: finishError } = await db.rpc('finish_notification_delivery',{
          p_outbox_id:row.id,p_result:'ACCEPTED',p_error_code:null,p_provider_message_id:null,p_retry_seconds:null,p_duplicate_possible:false,
        });
        if (finishError) throw codedError('DELIVERY_STATUS_PERSIST_FAILED');
        processed++; continue;
      }

      if (mode === 'mock') {
        if (mockEmailStatus !== null) {
          const retryAfter=parseRetryAfter(mockEmailRetryAfter);
          const retryable=classifyResendResponse(mockEmailStatus)==='RETRYABLE';
          throw codedError(`RESEND_${mockEmailStatus}`,!retryable,retryAfter,retryable&&(mockEmailStatus===408||mockEmailStatus>=500));
        }
        const { error: finishError } = await db.rpc('finish_notification_delivery',{p_outbox_id:row.id,p_result:'MOCK_ACCEPTED',p_provider_message_id:`mock-${row.id}`});
        if (finishError) throw codedError('DELIVERY_STATUS_PERSIST_FAILED');
        processed++; continue;
      }
      const resendKey=Deno.env.get('RESEND_API_KEY'); const from=Deno.env.get('RESEND_FROM');
      if (!resendKey || !from) throw codedError('EMAIL_PROVIDER_UNCONFIGURED',true);
      const { data: userResult, error: userError } = await db.auth.admin.getUserById(row.recipient_user_id);
      const email=userResult.user?.email;
      if (userError || !email || !userResult.user?.email_confirmed_at) throw codedError('EMAIL_RECIPIENT_UNAVAILABLE',true);
      let response: Response;
      try {
        response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${resendKey}`,'Content-Type':'application/json','Idempotency-Key':`hanilog-${row.id}`},
          body:JSON.stringify({from,to:[email],subject:'HaniLog 돌봄 일정 안내',text:'HaniLog에 확인할 돌봄 안내가 있습니다. 로그인하여 최신 기록을 확인해 주세요.'})});
      } catch { throw codedError('RESEND_NETWORK_OUTCOME_UNKNOWN',false,null,true); }
      if (!response.ok) {
        const status=response.status; const retryAfter=parseRetryAfter(response.headers.get('Retry-After'));
        if (classifyResendResponse(status)==='PERMANENT') throw codedError(`RESEND_${status}`,true);
        throw codedError(`RESEND_${status}`,false,retryAfter,status===408||status>=500);
      }
      const result = await response.json().catch(() => ({}));
      if (typeof result.id === 'string') providerMessageId = result.id;
      const { error: finishError } = await db.rpc('finish_notification_delivery',{
        p_outbox_id:row.id,p_result:'ACCEPTED',p_error_code:null,p_provider_message_id:providerMessageId,p_retry_seconds:null,p_duplicate_possible:false,
      });
      if (finishError) throw codedError('DELIVERY_STATUS_PERSIST_FAILED',false,null,true);
      processed++;
    } catch (error) {
      const info=errInfo(error);
      const delay=info.permanent?null:retryDelaySeconds(row.attempt_count,info.retryAfterSeconds);
      await db.rpc('finish_notification_delivery',{
        p_outbox_id:row.id,p_result:info.permanent?'PERMANENT_FAILURE':'RETRYABLE_FAILURE',p_error_code:info.code,p_provider_message_id:null,
        p_retry_seconds:delay,p_duplicate_possible:info.duplicatePossible,
      }).then(({error:statusError})=>{ if (statusError) statusPersistenceFailed=true; });
    }
  }
  if (statusPersistenceFailed) return new Response('Notification delivery state could not be saved', { status: 503 });
  return Response.json({ processed, claimed:(rows??[]).length, preparation:{created_occurrences:horizon.data,unconfirmed:unconfirmed.data,suppressed:reconciled.data}, mode });
});
