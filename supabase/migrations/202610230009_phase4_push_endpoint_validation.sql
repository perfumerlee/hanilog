create or replace function public.register_push_subscription(p_endpoint text,p_endpoint_hash text,p_p256dh text,p_auth text,p_expiration_time timestamptz default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
 if auth.uid() is null then raise exception 'UNAUTHENTICATED' using errcode='28000'; end if;
 if p_endpoint !~* '^https://fcm[.]googleapis[.]com(/[^[:space:]]*)?$'
   and p_endpoint !~* '^https://[a-z0-9.-]+[.]push[.]services[.]mozilla[.]com(/[^[:space:]]*)?$'
   and p_endpoint !~* '^https://[a-z0-9.-]+[.]notify[.]windows[.]com(/[^[:space:]]*)?$'
   and p_endpoint !~* '^https://[a-z0-9.-]+[.]push[.]apple[.]com(/[^[:space:]]*)?$' then
   raise exception 'INVALID_SUBSCRIPTION_ENDPOINT' using errcode='22023';
 end if;
 if length(p_endpoint)>4096 or p_endpoint_hash !~ '^[a-f0-9]{64}$'
   or p_p256dh !~ '^[A-Za-z0-9_-]{80,120}$' or p_auth !~ '^[A-Za-z0-9_-]{20,40}$'
   or (p_expiration_time is not null and p_expiration_time<=now()) then
   raise exception 'INVALID_SUBSCRIPTION' using errcode='22023';
 end if;
 insert into public.push_subscriptions(user_id,endpoint,endpoint_hash,p256dh,auth_secret,expiration_time,revoked_at)
 values(auth.uid(),p_endpoint,p_endpoint_hash,p_p256dh,p_auth,p_expiration_time,null)
 on conflict(endpoint_hash) do update set user_id=excluded.user_id,endpoint=excluded.endpoint,p256dh=excluded.p256dh,
   auth_secret=excluded.auth_secret,expiration_time=excluded.expiration_time,revoked_at=null
 where public.push_subscriptions.user_id=auth.uid()
 returning id into v_id;
 if v_id is null then raise exception 'SUBSCRIPTION_OWNED_BY_ANOTHER_USER' using errcode='42501'; end if;
 return v_id;
end; $$;
revoke all on function public.register_push_subscription(text,text,text,text,timestamptz) from public,anon;
grant execute on function public.register_push_subscription(text,text,text,text,timestamptz) to authenticated;
