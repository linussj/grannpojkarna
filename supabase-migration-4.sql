-- Grannpojkarna: tidsbegränsad tillgänglighet och publik utförarlista.
-- Kör efter supabase-migration-3.sql.

alter table public.profiles
  add column if not exists availability_status text not null default 'unavailable',
  add column if not exists available_until timestamptz;

alter table public.profiles drop constraint if exists profiles_availability_status_check;
alter table public.profiles
  add constraint profiles_availability_status_check
  check (availability_status in ('unavailable', 'now', 'today'));

create index if not exists profiles_active_availability_idx
  on public.profiles (available_until desc)
  where performer_enabled = true and availability_status <> 'unavailable';

create or replace function public.set_my_availability(p_status text)
returns table (
  availability_status text,
  available_until timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_until timestamptz;
begin
  if p_status not in ('unavailable', 'now', 'today') then
    raise exception 'Invalid availability status';
  end if;

  if not exists (
    select 1
    from public.profiles
    where id = auth.uid() and performer_enabled = true
  ) then
    raise exception 'An active performer profile is required';
  end if;

  v_until := case p_status
    when 'now' then now() + interval '4 hours'
    when 'today' then (
      date_trunc('day', now() at time zone 'Europe/Stockholm') + interval '1 day'
    ) at time zone 'Europe/Stockholm'
    else null
  end;

  return query
  update public.profiles as p
  set
    availability_status = p_status,
    available_until = v_until
  where id = auth.uid()
  returning p.availability_status, p.available_until;
end;
$$;

create or replace function public.get_available_performers()
returns table (
  id uuid,
  display_name text,
  bio text,
  service_area text,
  skills text[],
  avatar_path text,
  availability_status text,
  available_until timestamptz,
  average_rating numeric,
  review_count bigint,
  completed_jobs bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.id,
    p.display_name,
    p.bio,
    p.service_area,
    p.skills,
    p.avatar_path,
    p.availability_status,
    p.available_until,
    coalesce(r.average_rating, 0),
    coalesce(r.review_count, 0),
    coalesce(j.completed_jobs, 0)
  from public.profiles p
  left join lateral (
    select
      round(avg(reviews.rating)::numeric, 2) as average_rating,
      count(*) as review_count
    from public.reviews
    where reviews.reviewee_id = p.id
  ) r on true
  left join lateral (
    select count(*) as completed_jobs
    from public.jobs
    where jobs.performer_id = p.id and jobs.status = 'completed'
  ) j on true
  where p.performer_enabled = true
    and p.availability_status <> 'unavailable'
    and p.available_until > now()
  order by
    case p.availability_status when 'now' then 0 else 1 end,
    coalesce(r.average_rating, 0) desc,
    coalesce(j.completed_jobs, 0) desc,
    p.display_name asc;
$$;

revoke all on function public.set_my_availability(text) from public;
revoke all on function public.get_available_performers() from public;

grant execute on function public.set_my_availability(text) to authenticated;
grant execute on function public.get_available_performers() to anon, authenticated;
