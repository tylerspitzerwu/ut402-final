-- One current position, with no application-level location history.
create table public.owner_location (
  id boolean primary key default true check (id = true),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  reported_at timestamptz not null,
  received_at timestamptz not null default now()
);

alter table public.owner_location enable row level security;
revoke all on table public.owner_location from public, anon, authenticated;
grant select, insert, update on table public.owner_location to service_role;

-- The timestamp guard is atomic: a delayed/retried upload cannot replace a
-- newer position. No device-provided owner ID or database key is accepted.
create function public.record_owner_location(
  p_latitude double precision,
  p_longitude double precision,
  p_reported_at timestamptz
) returns boolean
language sql
security invoker
set search_path = ''
as $$
  with saved as (
    insert into public.owner_location (id, latitude, longitude, reported_at)
    values (true, p_latitude, p_longitude, p_reported_at)
    on conflict (id) do update set
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      reported_at = excluded.reported_at,
      received_at = now()
    where public.owner_location.reported_at < excluded.reported_at
    returning id
  )
  select exists (select 1 from saved);
$$;

revoke all on function public.record_owner_location(double precision, double precision, timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_owner_location(double precision, double precision, timestamptz)
  to service_role;
