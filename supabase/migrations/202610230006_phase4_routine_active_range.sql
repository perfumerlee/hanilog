create or replace function public.ensure_routine_occurrences(p_pet_id uuid,p_local_date date)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer:=0; r record; d record; tm record; st record; v_local timestamp; v_candidate timestamptz; v_matches integer;
begin
  if auth.role()<>'service_role' and not private.can_access_pet(p_pet_id,true) then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if p_local_date < (clock_timestamp() at time zone 'UTC')::date - 2 or p_local_date > (clock_timestamp() at time zone 'UTC')::date + 31 then
    raise exception 'DATE_OUT_OF_RANGE' using errcode='22023'; end if;
  for r in select cr.id routine_id,cr.pet_id,cr.care_plan_id,cr.timezone,cr.name,rv.id version_id,rv.care_plan_version_id,rv.recurrence,rv.steps
    from public.care_routines cr join lateral (select * from public.care_routine_versions x where x.routine_id=cr.id
      and (x.valid_from is null or x.valid_from<=p_local_date) and (x.valid_to is null or x.valid_to>=p_local_date)
      order by x.version_no desc limit 1) rv on true where cr.pet_id=p_pet_id
      and (cr.active_from is null or cr.active_from<=p_local_date) and (cr.active_to is null or cr.active_to>=p_local_date) loop
    for tm in select value time_text from jsonb_array_elements_text(r.recurrence->'times') loop
      for d in select value day_text from jsonb_array_elements_text(r.recurrence->'days') loop
        if extract(dow from p_local_date)::integer=d.day_text::integer then
          v_local:=p_local_date + tm.time_text::time; v_candidate:=v_local at time zone r.timezone; v_matches:=0;
          for st in select generate_series(-180,180,15) offset_minutes loop
            if (v_candidate + make_interval(mins=>st.offset_minutes)) at time zone r.timezone = v_local then v_matches:=v_matches+1; end if;
          end loop;
          if (v_candidate at time zone r.timezone)<>v_local then v_matches:=0; end if;
          for st in select value step_value from jsonb_array_elements(r.steps) loop
            insert into public.routine_occurrences(pet_id,routine_version_id,care_plan_version_id,care_plan_id,occurrence_key,step_key,event_type,
              scheduled_local_date,scheduled_local_time,timezone,disambiguation,scheduled_at,status)
            values(r.pet_id,r.version_id,r.care_plan_version_id,r.care_plan_id,to_char(p_local_date,'YYYY-MM-DD')||':'||tm.time_text,
              st.step_value->>'key',st.step_value->>'event_type',p_local_date,tm.time_text::time,r.timezone,
              case when v_matches=1 then 'NOT_AMBIGUOUS' else null end,case when v_matches=1 then v_candidate else null end,
              case when v_matches=1 then 'SCHEDULED' else 'SCHEDULE_TIME_UNRESOLVED' end)
            on conflict(routine_version_id,occurrence_key,step_key) do nothing;
            if found then v_count:=v_count+1; end if;
          end loop;
        end if;
      end loop;
    end loop;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.ensure_routine_occurrences(uuid,date) from public,anon;
grant execute on function public.ensure_routine_occurrences(uuid,date) to authenticated,service_role;
