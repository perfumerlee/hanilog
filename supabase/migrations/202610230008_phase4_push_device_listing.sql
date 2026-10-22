create or replace function public.list_my_push_subscriptions()
returns table(endpoint_hash text,created_at timestamptz,expiration_time timestamptz,last_success_at timestamptz)
language sql stable security definer set search_path='' as $$
  select s.endpoint_hash,s.created_at,s.expiration_time,s.last_success_at
  from public.push_subscriptions s where s.user_id=auth.uid() and s.revoked_at is null order by s.created_at desc;
$$;
revoke all on function public.list_my_push_subscriptions() from public,anon;
grant execute on function public.list_my_push_subscriptions() to authenticated;
