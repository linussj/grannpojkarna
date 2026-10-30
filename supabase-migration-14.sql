-- Grannpojkarna: ungefärliga kartpositioner och avstånd i jobbbevakningar.
-- Kör efter supabase-migration-13.sql.

alter table public.jobs
  add column if not exists latitude numeric(9, 6),
  add column if not exists longitude numeric(9, 6);

alter table public.jobs drop constraint if exists jobs_map_coordinates_check;
alter table public.jobs
  add constraint jobs_map_coordinates_check check (
    (latitude is null and longitude is null)
    or (latitude between -90 and 90 and longitude between -180 and 180)
  );

alter table public.job_alerts
  add column if not exists origin_latitude numeric(9, 6),
  add column if not exists origin_longitude numeric(9, 6),
  add column if not exists radius_km integer;

alter table public.job_alerts drop constraint if exists job_alerts_radius_check;
alter table public.job_alerts
  add constraint job_alerts_radius_check check (
    (radius_km is null and origin_latitude is null and origin_longitude is null)
    or (
      radius_km in (5, 10, 25)
      and origin_latitude between -90 and 90
      and origin_longitude between -180 and 180
    )
  );

create or replace function public.edit_my_open_job(
  p_job_id bigint,
  p_title text,
  p_description text,
  p_location text,
  p_timing text,
  p_budget_sek integer,
  p_price_type text,
  p_category text,
  p_date_start date,
  p_date_end date,
  p_image_paths text[],
  p_latitude numeric,
  p_longitude numeric
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null
    or char_length(trim(coalesce(p_title, ''))) not between 4 and 100
    or char_length(trim(coalesce(p_description, ''))) not between 80 and 3000
    or char_length(trim(coalesce(p_location, ''))) not between 2 and 120
    or char_length(trim(coalesce(p_timing, ''))) not between 2 and 80
    or p_budget_sek is null or p_budget_sek not between 1 and 10000000
    or p_price_type not in ('fixed', 'hourly', 'quote')
    or p_category not in (
      'Flytt & bärhjälp', 'Trädgård', 'Montering & småfix', 'Målning',
      'Rengöring', 'Bortforsling & transport', 'Djurpassning',
      'Teknikhjälp', 'Större projekt', 'Övrigt'
    )
    or (p_date_start is not null and p_date_end is not null and p_date_end < p_date_start)
    or cardinality(coalesce(p_image_paths, array[]::text[])) > 5
    or ((p_latitude is null) <> (p_longitude is null))
    or (p_latitude is not null and (p_latitude not between -90 and 90 or p_longitude not between -180 and 180))
  then
    raise exception 'INVALID_JOB_DATA';
  end if;

  update public.jobs
  set
    title = trim(p_title),
    description = trim(p_description),
    location = trim(p_location),
    latitude = p_latitude,
    longitude = p_longitude,
    timing = trim(p_timing),
    budget_sek = p_budget_sek,
    price_type = p_price_type,
    category = p_category,
    date_start = p_date_start,
    date_end = p_date_end,
    image_paths = coalesce(p_image_paths, array[]::text[])
  where id = p_job_id
    and user_id = auth.uid()
    and status = 'open';

  if not found then
    raise exception 'JOB_UNAVAILABLE';
  end if;

  return true;
end;
$$;

revoke all on function public.edit_my_open_job(bigint, text, text, text, text, integer, text, text, date, date, text[], numeric, numeric) from public, anon;
grant execute on function public.edit_my_open_job(bigint, text, text, text, text, integer, text, text, date, date, text[], numeric, numeric) to authenticated;
