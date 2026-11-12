-- Normalize the legacy misspelling while preserving each event's original value
-- and correction history. System-generated revisions intentionally have no user actor.
alter table public.health_event_revisions
  alter column actor_id drop not null;

comment on column public.health_event_revisions.actor_id is
  'Authenticated caregiver for user revisions; NULL for audited system-generated normalization revisions.';

do $$
declare
  v_event record;
  v_latest_revision integer;
  v_effective_label text;
  v_revision record;
  v_value jsonb;
  v_patch jsonb;
begin
  -- Serialize normalization with all existing event corrections for this brief transaction.
  lock table public.health_events, public.health_event_revisions in share row exclusive mode;
  with updated_pets as (
    update public.pets
       set default_insulin_product = '캐닌슐린'
     where default_insulin_product = '캐니슐린'
     returning id
  )
  insert into public.audit_log(actor_id, action, target_type, target_id, result, reason_code)
  select null, 'SYSTEM_DATA_NORMALIZED', 'pet', p.id, 'SUCCESS', 'INSULIN_DEFAULT_LABEL_SPELLING'
    from updated_pets p;

  for v_event in
    select e.id
      from public.health_events e
     where e.event_type = 'insulin'
       and coalesce((
         select r.revision_kind
           from public.health_event_revisions r
          where r.event_id = e.id
          order by r.revision_no desc
          limit 1
       ), 'CORRECT') <> 'VOID'
     order by e.id
  loop
    -- Match the event lock used by revise_health_event to avoid racing a caregiver edit.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_event.id::text, 1));

    select e.value into v_value from public.health_events e where e.id = v_event.id;
    v_patch := '{}'::jsonb;
    for v_revision in
      select r.patch from public.health_event_revisions r
       where r.event_id = v_event.id and r.revision_kind = 'CORRECT'
       order by r.revision_no
    loop
      v_patch := v_patch || (v_revision.patch - 'value');
      if jsonb_typeof(v_revision.patch->'value') = 'object' then
        v_value := v_value || (v_revision.patch->'value');
      end if;
    end loop;
    v_effective_label := v_value->>'insulin_product_label';

    if v_effective_label = '캐니슐린' then
      select coalesce(max(r.revision_no), 0)
        into v_latest_revision
        from public.health_event_revisions r
       where r.event_id = v_event.id;

      insert into public.health_event_revisions(event_id, revision_no, revision_kind, patch, reason_code, actor_id)
      values (
        v_event.id,
        v_latest_revision + 1,
        'CORRECT',
        v_patch || jsonb_build_object('value', v_value || jsonb_build_object('insulin_product_label', '캐닌슐린')),
        'SYSTEM_INSULIN_LABEL_SPELLING_NORMALIZED',
        null
      );

      insert into public.audit_log(actor_id, action, target_type, target_id, result, reason_code)
      values (null, 'SYSTEM_DATA_NORMALIZED', 'health_event', v_event.id, 'SUCCESS', 'INSULIN_PRODUCT_LABEL_SPELLING');
    end if;
  end loop;
end;
$$;
