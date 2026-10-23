-- New glucose events must use the product's fixed mg/dL storage unit.
-- Existing rows are not rewritten, constrained, or converted.
create or replace function private.enforce_glucose_unit_mg_dl()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.event_type = 'glucose' and new.unit is distinct from 'mg/dL' then
    raise exception 'GLUCOSE_UNIT_MUST_BE_MG_DL' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_glucose_unit_mg_dl() from public, anon, authenticated;

drop trigger if exists health_events_glucose_unit_mg_dl on public.health_events;
create trigger health_events_glucose_unit_mg_dl
before insert on public.health_events
for each row execute function private.enforce_glucose_unit_mg_dl();
