-- Apply after 20261026000000_owner_location.sql. Existing iPhone requests and
-- the deployed Edge Function keep calling the same RPC with the same payload.
begin;

alter table public.owner_location
  add column trail jsonb not null default '[]'::jsonb
  check (jsonb_typeof(trail) = 'array' and jsonb_array_length(trail) <= 3);

-- Seed the current report so the next upload can already provide two samples.
update public.owner_location
set trail = jsonb_build_array(jsonb_build_object(
  'latitude', latitude,
  'longitude', longitude,
  'reported_at', reported_at,
  'received_at', received_at
));

create or replace function public.record_owner_location(
  p_latitude double precision,
  p_longitude double precision,
  p_reported_at timestamptz
) returns boolean
language sql
security invoker
set search_path = ''
as $$
  with saved as (
    insert into public.owner_location (id, latitude, longitude, reported_at, trail)
    values (true, p_latitude, p_longitude, p_reported_at,
      jsonb_build_array(jsonb_build_object(
        'latitude', p_latitude,
        'longitude', p_longitude,
        'reported_at', p_reported_at,
        'received_at', now()
      )))
    on conflict (id) do update set
      latitude = excluded.latitude,
      longitude = excluded.longitude,
      reported_at = excluded.reported_at,
      received_at = now(),
      trail = (
        select coalesce(jsonb_agg(recent.point order by (recent.point->>'reported_at')::timestamptz), '[]'::jsonb)
        from (
          select sample.point
          from jsonb_array_elements(public.owner_location.trail || excluded.trail) as sample(point)
          where (sample.point->>'reported_at')::timestamptz >= p_reported_at - interval '30 minutes'
          order by (sample.point->>'reported_at')::timestamptz desc
          limit 3
        ) as recent
      )
    where public.owner_location.reported_at < excluded.reported_at
    returning id
  )
  select exists (select 1 from saved);
$$;

revoke all on function public.record_owner_location(double precision, double precision, timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_owner_location(double precision, double precision, timestamptz)
  to service_role;

commit;
