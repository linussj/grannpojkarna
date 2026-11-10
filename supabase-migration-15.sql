-- Grannpojkarna: tydligare prissättning och e-postkö för viktiga händelser.
-- Kör efter supabase-migration-14.sql.

alter table public.profiles
  add column if not exists email_transactional_enabled boolean not null default true;

alter table public.jobs
  add column if not exists material_cost_type text;

alter table public.jobs alter column budget_sek drop not null;

alter table public.jobs drop constraint if exists jobs_budget_sek_check;
alter table public.jobs
  add constraint jobs_budget_sek_check check (
    (price_type = 'quote' and budget_sek is null)
    or budget_sek between 1 and 10000000
  );

alter table public.jobs drop constraint if exists jobs_material_cost_type_check;
alter table public.jobs
  add constraint jobs_material_cost_type_check check (
    material_cost_type is null
    or (price_type = 'fixed' and material_cost_type in ('included', 'extra', 'none'))
  );

create table if not exists public.email_notification_queue (
  id bigint generated always as identity primary key,
  notification_id bigint references public.notifications(id) on delete cascade,
  job_id bigint references public.jobs(id) on delete cascade,
  recipient_user_id uuid references auth.users(id) on delete cascade,
  recipient_email text,
  kind text not null,
  subject text not null check (char_length(subject) between 1 and 160),
  body text not null check (char_length(body) between 1 and 1000),
  action_url text,
  dedupe_key text not null unique,
  status text not null default 'queued' check (status in ('queued', 'processing', 'sent', 'failed')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 10),
  available_at timestamptz not null default now(),
  processing_started_at timestamptz,
  sent_at timestamptz,
  provider_id text,
  last_error text check (last_error is null or char_length(last_error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint email_notification_queue_recipient_check check (
    recipient_user_id is not null or recipient_email is not null
  )
);

create index if not exists email_notification_queue_pending_idx
  on public.email_notification_queue (status, available_at, created_at)
  where status in ('queued', 'failed');

create index if not exists email_notification_queue_notification_idx
  on public.email_notification_queue (notification_id)
  where notification_id is not null;

create index if not exists email_notification_queue_job_idx
  on public.email_notification_queue (job_id)
  where job_id is not null;

create index if not exists email_notification_queue_recipient_idx
  on public.email_notification_queue (recipient_user_id)
  where recipient_user_id is not null;

alter table public.email_notification_queue enable row level security;
revoke all on public.email_notification_queue from anon, authenticated;
revoke all on sequence public.email_notification_queue_id_seq from anon, authenticated;
grant select, insert, update on public.email_notification_queue to service_role;
grant usage, select on sequence public.email_notification_queue_id_seq to service_role;

create or replace function public.queue_notification_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.type not in (
    'job_application', 'job_accepted', 'application_declined',
    'job_started', 'job_completed', 'job_cancelled', 'payout_ready',
    'new_message', 'direct_message'
  ) then
    return new;
  end if;

  if not exists (
    select 1
    from public.profiles p
    where p.id = new.user_id
      and p.email_transactional_enabled = true
  ) then
    return new;
  end if;

  insert into public.email_notification_queue (
    notification_id,
    job_id,
    recipient_user_id,
    kind,
    subject,
    body,
    action_url,
    dedupe_key
  ) values (
    new.id,
    new.job_id,
    new.user_id,
    new.type,
    'Grannpojkarna: ' || new.title,
    new.body,
    case
      when new.type = 'direct_message' then 'https://grannpojkarna.se/konto.html#messages'
      when new.job_id is not null then 'https://grannpojkarna.se/konto.html#jobs'
      else 'https://grannpojkarna.se/konto.html'
    end,
    'notification-' || new.id::text
  )
  on conflict (dedupe_key) do nothing;

  return new;
end;
$$;

revoke all on function public.queue_notification_email() from public, anon, authenticated;

drop trigger if exists notifications_queue_email on public.notifications;
create trigger notifications_queue_email
after insert on public.notifications
for each row execute function public.queue_notification_email();

create or replace function public.queue_admin_new_job_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.email_notification_queue (
    job_id,
    recipient_email,
    kind,
    subject,
    body,
    action_url,
    dedupe_key
  ) values (
    new.id,
    'info@grannpojkarna.se',
    'admin_new_job',
    'Nytt jobb: ' || new.title,
    new.location || ' · ' || new.timing || E'\n\n' || left(new.description, 700),
    'https://grannpojkarna.se/jobb.html',
    'admin-new-job-' || new.id::text
  )
  on conflict (dedupe_key) do nothing;

  return new;
end;
$$;

revoke all on function public.queue_admin_new_job_email() from public, anon, authenticated;

drop trigger if exists jobs_queue_admin_email on public.jobs;
create trigger jobs_queue_admin_email
after insert on public.jobs
for each row execute function public.queue_admin_new_job_email();

create or replace function public.claim_email_notification_batch(p_limit integer default 25)
returns setof public.email_notification_queue
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  update public.email_notification_queue q
  set
    status = 'processing',
    attempt_count = q.attempt_count + 1,
    processing_started_at = now(),
    updated_at = now(),
    last_error = null
  where q.id in (
    select pending.id
    from public.email_notification_queue pending
    where (
        pending.status in ('queued', 'failed')
        or (pending.status = 'processing' and pending.processing_started_at < now() - interval '15 minutes')
      )
      and pending.available_at <= now()
      and pending.attempt_count < 3
    order by pending.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 25), 50))
  )
  returning q.*;
end;
$$;

revoke all on function public.claim_email_notification_batch(integer) from public, anon, authenticated;
grant execute on function public.claim_email_notification_batch(integer) to service_role;

create or replace function public.claim_open_job(
  p_job_id bigint,
  p_message text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller_id uuid := auth.uid();
  v_budget_sek integer;
  v_message text := trim(coalesce(p_message, ''));
begin
  if v_caller_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  if char_length(v_message) > 1000 or (char_length(v_message) between 1 and 9) then
    raise exception 'INVALID_MESSAGE';
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = v_caller_id and p.performer_enabled = true
  ) then
    raise exception 'PERFORMER_PROFILE_REQUIRED';
  end if;

  update public.jobs
  set
    status = 'accepted',
    performer_id = v_caller_id,
    agreed_price_sek = budget_sek,
    accepted_at = now(),
    started_at = null,
    completed_at = null
  where id = p_job_id
    and status = 'open'
    and performer_id is null
    and user_id <> v_caller_id
    and price_type in ('fixed', 'hourly')
    and budget_sek is not null
  returning budget_sek into v_budget_sek;

  if not found then
    raise exception 'JOB_UNAVAILABLE';
  end if;

  if v_message = '' then
    v_message := 'Jag tar gärna jobbet för priset i annonsen.';
  end if;

  insert into public.job_applications (job_id, performer_id, message, proposed_price_sek, status)
  values (p_job_id, v_caller_id, v_message, v_budget_sek, 'accepted')
  on conflict (job_id, performer_id) do update
  set message = excluded.message,
      proposed_price_sek = excluded.proposed_price_sek,
      status = 'accepted';

  update public.job_applications
  set status = 'declined'
  where job_id = p_job_id
    and performer_id <> v_caller_id
    and status = 'pending';

  return true;
end;
$$;

revoke all on function public.claim_open_job(bigint, text) from public, anon;
grant execute on function public.claim_open_job(bigint, text) to authenticated;

create or replace function public.edit_my_open_job(
  p_job_id bigint,
  p_title text,
  p_description text,
  p_location text,
  p_timing text,
  p_budget_sek integer,
  p_price_type text,
  p_material_cost_type text,
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
    or p_price_type not in ('fixed', 'hourly', 'quote')
    or (p_price_type in ('fixed', 'hourly') and (p_budget_sek is null or p_budget_sek not between 1 and 10000000))
    or (p_price_type = 'quote' and p_budget_sek is not null and p_budget_sek not between 1 and 10000000)
    or (p_price_type = 'fixed' and coalesce(p_material_cost_type, '') not in ('included', 'extra', 'none'))
    or (p_price_type <> 'fixed' and p_material_cost_type is not null)
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
    material_cost_type = p_material_cost_type,
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

revoke all on function public.edit_my_open_job(bigint, text, text, text, text, integer, text, text, text, date, date, text[], numeric, numeric) from public, anon;
grant execute on function public.edit_my_open_job(bigint, text, text, text, text, integer, text, text, text, date, date, text[], numeric, numeric) to authenticated;
