-- Existing links retain their original time-only disclosure. Care values require
-- an explicit opt-in on a newly created link and never include notes or actors.
alter table public.glucose_share_links
  add column include_care_values boolean not null default false;
alter table public.glucose_share_links
  add constraint glucose_share_values_require_times check (not include_care_values or include_care_times);

create function public.create_glucose_share_link_v2(
  p_pet_id uuid, p_token_hash text, p_from_date date, p_to_date date,
  p_expires_at timestamptz, p_include_care_times boolean, p_include_care_values boolean
)
returns table(id uuid, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_exp timestamptz; v_now timestamptz := clock_timestamp();
begin
  if auth.uid() is null or not private.can_access_pet(p_pet_id,true) then
    raise exception 'PET_SHARE_ACCESS_DENIED' using errcode='42501';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$'
     or p_from_date is null or p_to_date is null or p_to_date < p_from_date or p_to_date > p_from_date + 365
     or p_expires_at is null or p_expires_at <= v_now or p_expires_at > v_now + interval '7 days'
     or (coalesce(p_include_care_values,false) and not coalesce(p_include_care_times,false)) then
    raise exception 'GLUCOSE_SHARE_INVALID' using errcode='22023';
  end if;
  insert into public.glucose_share_links(pet_id,created_by,token_hash,from_date,to_date,include_care_times,include_care_values,expires_at)
    values(p_pet_id,auth.uid(),p_token_hash,p_from_date,p_to_date,coalesce(p_include_care_times,false),coalesce(p_include_care_values,false),p_expires_at)
    returning glucose_share_links.id,glucose_share_links.expires_at into v_id,v_exp;
  insert into public.audit_log(actor_id,action,target_type,target_id,result,reason_code)
    values(auth.uid(),'GLUCOSE_SHARE_CREATED','glucose_share',v_id,'SUCCESS','READ_ONLY_LIMITED_RANGE');
  id := v_id; expires_at := v_exp; return next;
end;
$$;
revoke all on function public.create_glucose_share_link_v2(uuid,text,date,date,timestamptz,boolean,boolean) from public, anon;
grant execute on function public.create_glucose_share_link_v2(uuid,text,date,date,timestamptz,boolean,boolean) to authenticated;

create function public.list_my_glucose_share_links_v2(p_pet_id uuid)
returns table(id uuid,from_date date,to_date date,created_at timestamptz,expires_at timestamptz,revoked_at timestamptz,
  include_care_times boolean,include_care_values boolean)
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.can_access_pet(p_pet_id,true) then
    raise exception 'PET_SHARE_ACCESS_DENIED' using errcode='42501';
  end if;
  return query select s.id,s.from_date,s.to_date,s.created_at,s.expires_at,s.revoked_at,s.include_care_times,s.include_care_values
    from public.glucose_share_links s where s.pet_id=p_pet_id order by s.created_at desc limit 50;
end;
$$;
revoke all on function public.list_my_glucose_share_links_v2(uuid) from public, anon;
grant execute on function public.list_my_glucose_share_links_v2(uuid) to authenticated;

create or replace function public.resolve_glucose_share_link(p_token_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_share public.glucose_share_links%rowtype; v_pet public.pets%rowtype; v_result jsonb;
begin
  if p_token_hash is null or p_token_hash !~ '^[a-f0-9]{64}$' then return null; end if;
  select * into v_share from public.glucose_share_links s
   where s.token_hash=p_token_hash and s.revoked_at is null and s.expires_at>clock_timestamp();
  if not found then return null; end if;
  select * into v_pet from public.pets p where p.id=v_share.pet_id;
  if not found then return null; end if;
  insert into public.glucose_share_access_log(share_id) values(v_share.id);
  select jsonb_build_object(
    'pet_name',v_pet.name,'timezone',v_pet.timezone,'from_date',v_share.from_date,'to_date',v_share.to_date,
    'created_at',v_share.created_at,'expires_at',v_share.expires_at,
    'include_care_values',v_share.include_care_values,
    'target_range',(select jsonb_build_object('lower_mg_dl',t.lower_mg_dl,'upper_mg_dl',t.upper_mg_dl,
      'source_label',t.source_label,'effective_on',t.effective_on)
      from public.pet_glucose_target_ranges t where t.pet_id=v_pet.id and t.superseded_at is null),
    'measurements',coalesce((
      select jsonb_agg(jsonb_build_object('id',e.id,'occurred_at',e.occurred_at,'recorded_at',e.recorded_at,
        'value',jsonb_strip_nulls(jsonb_build_object(
          'observed_value',coalesce(r.patch->'value'->'observed_value',r.patch->'observed_value',e.value->'observed_value'),
          'measurement_condition',coalesce(r.patch->'value'->'measurement_condition',r.patch->'measurement_condition',e.value->'measurement_condition'),
          'measurement_source',coalesce(r.patch->'value'->'measurement_source',r.patch->'measurement_source',e.value->'measurement_source')
        )),
        'unit',coalesce(r.patch->>'unit',e.unit),'revision_kind',r.revision_kind)
        order by e.occurred_at,e.id)
      from public.health_events e
      left join lateral (select hr.patch,hr.revision_kind from public.health_event_revisions hr
        where hr.event_id=e.id order by hr.revision_no desc limit 1) r on true
      where e.pet_id=v_pet.id and e.event_type='glucose' and coalesce(r.revision_kind,'')<>'VOID'
        and e.unit='mg/dL'
        and e.occurred_at >= (v_share.from_date::timestamp at time zone v_pet.timezone)
        and e.occurred_at < ((v_share.to_date + 1)::timestamp at time zone v_pet.timezone)
    ),'[]'::jsonb),
    'care_times',case when v_share.include_care_times then coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'event_type',e.event_type,'occurred_at',e.occurred_at,
        'amount',case when v_share.include_care_values then
          case when e.event_type='insulin' then coalesce(r.patch->'value'->'administered_dose_value',r.patch->'administered_dose_value',e.value->'administered_dose_value')
            else coalesce(r.patch->'value'->'observed_value',r.patch->'observed_value',e.value->'observed_value') end end,
        'unit',case when v_share.include_care_values then
          case when e.event_type='insulin' then coalesce(r.patch->'value'->>'administered_dose_unit',r.patch->>'administered_dose_unit',e.value->>'administered_dose_unit',r.patch->>'unit',e.unit)
            else coalesce(r.patch->>'unit',e.unit) end end
      )) order by e.occurred_at,e.id)
      from public.health_events e
      left join lateral (select hr.patch,hr.revision_kind from public.health_event_revisions hr
        where hr.event_id=e.id order by hr.revision_no desc limit 1) r on true
      where e.pet_id=v_pet.id and e.event_type in ('meal','insulin') and coalesce(r.revision_kind,'')<>'VOID'
        and e.occurred_at >= (v_share.from_date::timestamp at time zone v_pet.timezone)
        and e.occurred_at < ((v_share.to_date + 1)::timestamp at time zone v_pet.timezone)
    ),'[]'::jsonb) else '[]'::jsonb end
  ) into v_result;
  return v_result;
end;
$$;
revoke all on function public.resolve_glucose_share_link(text) from public, anon, authenticated;
grant execute on function public.resolve_glucose_share_link(text) to service_role;
