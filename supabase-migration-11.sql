-- Grannpojkarna: trygghetsfunktioner, jobbilder, datumintervall och bevakningar.
-- Kör efter supabase-migration-10.sql.

alter table public.jobs
  add column if not exists date_start date,
  add column if not exists date_end date,
  add column if not exists image_paths text[] not null default array[]::text[],
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid references auth.users(id) on delete set null,
  add column if not exists cancellation_reason text;

alter table public.jobs drop constraint if exists jobs_description_check;
alter table public.jobs
  add constraint jobs_description_check
  check (char_length(trim(description)) between 80 and 3000) not valid;

alter table public.jobs drop constraint if exists jobs_date_range_check;
alter table public.jobs
  add constraint jobs_date_range_check
  check (date_start is null or date_end is null or date_end >= date_start);

alter table public.jobs drop constraint if exists jobs_image_paths_check;
alter table public.jobs
  add constraint jobs_image_paths_check
  check (cardinality(image_paths) <= 5);

alter table public.jobs drop constraint if exists jobs_cancellation_reason_check;
alter table public.jobs
  add constraint jobs_cancellation_reason_check
  check (cancellation_reason is null or char_length(trim(cancellation_reason)) between 3 and 500);

create index if not exists jobs_date_range_idx
  on public.jobs (date_start, date_end)
  where status = 'open';

-- Den befintliga signaturen behålls under utrullningen. Webbplatsen använder
-- den nya varianten med datum och bilder.
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
  p_image_paths text[]
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
  then
    raise exception 'Invalid job data';
  end if;

  update public.jobs
  set
    title = trim(p_title),
    description = trim(p_description),
    location = trim(p_location),
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
    raise exception 'Only your own open jobs can be edited';
  end if;

  return true;
end;
$$;

revoke all on function public.edit_my_open_job(bigint, text, text, text, text, integer, text, text, date, date, text[]) from public, anon;
grant execute on function public.edit_my_open_job(bigint, text, text, text, text, integer, text, text, date, date, text[]) to authenticated;

create or replace function public.cancel_job(p_job_id bigint, p_reason text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or char_length(trim(coalesce(p_reason, ''))) not between 3 and 500 then
    raise exception 'Invalid cancellation';
  end if;

  update public.jobs
  set
    status = 'cancelled',
    cancelled_at = now(),
    cancelled_by = auth.uid(),
    cancellation_reason = trim(p_reason)
  where id = p_job_id
    and status in ('accepted', 'in_progress')
    and (user_id = auth.uid() or performer_id = auth.uid());

  if not found then
    raise exception 'Job cannot be cancelled';
  end if;

  return true;
end;
$$;

revoke all on function public.cancel_job(bigint, text) from public, anon;
grant execute on function public.cancel_job(bigint, text) to authenticated;

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check
  check (type in (
    'job_match', 'application_sent', 'job_application', 'job_accepted',
    'application_declined', 'job_started', 'job_completed', 'job_cancelled',
    'payout_ready', 'new_message', 'direct_message'
  ));

create or replace function public.notify_job_cancelled()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_recipient uuid;
begin
  if old.status is distinct from 'cancelled' and new.status = 'cancelled' then
    v_recipient := case when new.cancelled_by = new.user_id then new.performer_id else new.user_id end;
    if v_recipient is not null then
      insert into public.notifications (user_id, type, title, body, job_id)
      values (v_recipient, 'job_cancelled', 'Jobbet har avbrutits', '”' || coalesce(new.title, 'Jobbet') || '” har avbrutits. Anledningen visas under Mina jobb.', new.id);
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.notify_job_cancelled() from public, anon, authenticated;

drop trigger if exists jobs_notify_cancelled on public.jobs;
create trigger jobs_notify_cancelled
after update of status on public.jobs
for each row execute function public.notify_job_cancelled();

-- En avslutad chatt ska fortfarande kunna läsas och få sina sista meddelanden
-- markerade som lästa. Nya meddelanden är även fortsättningsvis blockerade.
drop policy if exists "Job participants can read messages" on public.job_messages;
create policy "Job participants can read messages"
on public.job_messages for select
to authenticated
using (
  exists (
    select 1 from public.jobs
    where jobs.id = job_messages.job_id
      and (jobs.user_id = (select auth.uid()) or jobs.performer_id = (select auth.uid()))
      and jobs.status in ('accepted', 'in_progress', 'completed', 'cancelled')
  )
);

drop policy if exists "Job participants can mark received messages read" on public.job_messages;
create policy "Job participants can mark received messages read"
on public.job_messages for update
to authenticated
using (
  sender_id <> (select auth.uid())
  and exists (
    select 1 from public.jobs
    where jobs.id = job_messages.job_id
      and (jobs.user_id = (select auth.uid()) or jobs.performer_id = (select auth.uid()))
      and jobs.status in ('accepted', 'in_progress', 'completed', 'cancelled')
  )
)
with check (
  sender_id <> (select auth.uid())
  and read_at is not null
  and exists (
    select 1 from public.jobs
    where jobs.id = job_messages.job_id
      and (jobs.user_id = (select auth.uid()) or jobs.performer_id = (select auth.uid()))
      and jobs.status in ('accepted', 'in_progress', 'completed', 'cancelled')
  )
);

-- Jobbilder är offentliga på samma sätt som en publik jobbannons. Endast
-- inloggad ägare får lägga till och ta bort filer i sin egen mapp.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'profile-images',
  'profile-images',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'job-images',
  'job-images',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public job images are readable" on storage.objects;
create policy "Public job images are readable"
on storage.objects for select
to anon, authenticated
using (bucket_id = 'job-images');

drop policy if exists "Users can upload own job images" on storage.objects;
create policy "Users can upload own job images"
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'job-images'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

drop policy if exists "Users can delete own job images" on storage.objects;
create policy "Users can delete own job images"
on storage.objects for delete
to authenticated
using (
  bucket_id = 'job-images'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create table if not exists public.job_alerts (
  id bigint generated by default as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 2 and 100),
  search_term text check (search_term is null or char_length(trim(search_term)) <= 120),
  category text,
  location text check (location is null or char_length(trim(location)) <= 120),
  timing text check (timing is null or char_length(trim(timing)) <= 40),
  min_budget_sek integer check (min_budget_sek is null or min_budget_sek between 0 and 10000000),
  email_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists job_alerts_user_created_idx
  on public.job_alerts (user_id, created_at desc);

alter table public.job_alerts enable row level security;

drop policy if exists "Users can read own job alerts" on public.job_alerts;
create policy "Users can read own job alerts" on public.job_alerts for select
to authenticated using (user_id = (select auth.uid()));

drop policy if exists "Users can create own job alerts" on public.job_alerts;
create policy "Users can create own job alerts" on public.job_alerts for insert
to authenticated with check (user_id = (select auth.uid()));

drop policy if exists "Users can update own job alerts" on public.job_alerts;
create policy "Users can update own job alerts" on public.job_alerts for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists "Users can delete own job alerts" on public.job_alerts;
create policy "Users can delete own job alerts" on public.job_alerts for delete
to authenticated using (user_id = (select auth.uid()));

revoke all on public.job_alerts from anon, authenticated;
grant select, insert, update, delete on public.job_alerts to authenticated;
grant usage, select on sequence public.job_alerts_id_seq to authenticated;

drop trigger if exists job_alerts_set_updated_at on public.job_alerts;
create trigger job_alerts_set_updated_at
before update on public.job_alerts
for each row execute function public.set_updated_at();

-- Beprövad profil är skild från framtida BankID-verifiering. Märket ges efter
-- fem slutförda jobb och tas bort om en granskad anmärkning bekräftas.
create table if not exists public.profile_badges (
  user_id uuid primary key references auth.users(id) on delete cascade,
  badge text not null default 'established' check (badge = 'established'),
  active boolean not null default true,
  earned_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profile_badges enable row level security;

drop policy if exists "Active profile badges are public" on public.profile_badges;
create policy "Active profile badges are public" on public.profile_badges for select
to anon, authenticated using (active = true);

revoke all on public.profile_badges from anon, authenticated;
grant select on public.profile_badges to anon, authenticated;

create table if not exists public.safety_reports (
  id bigint generated by default as identity primary key,
  reporter_id uuid default auth.uid() references auth.users(id) on delete set null,
  target_job_id bigint references public.jobs(id) on delete set null,
  target_user_id uuid references auth.users(id) on delete set null,
  reason text not null check (reason in ('misleading', 'unsafe', 'spam', 'harassment', 'other')),
  details text not null check (char_length(trim(details)) between 10 and 1500),
  contact_email text check (contact_email is null or char_length(trim(contact_email)) between 5 and 254),
  status text not null default 'new' check (status in ('new', 'reviewing', 'dismissed', 'confirmed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((target_job_id is not null)::integer + (target_user_id is not null)::integer = 1)
);

create index if not exists safety_reports_status_created_idx
  on public.safety_reports (status, created_at desc);

alter table public.safety_reports enable row level security;

drop policy if exists "Anyone can submit a safety report" on public.safety_reports;
create policy "Anyone can submit a safety report" on public.safety_reports for insert
to anon, authenticated
with check (
  (reporter_id is null or reporter_id = (select auth.uid()))
  and ((select auth.uid()) is not null or contact_email is not null)
);

revoke all on public.safety_reports from anon, authenticated;
grant insert on public.safety_reports to anon, authenticated;
grant usage, select on sequence public.safety_reports_id_seq to anon, authenticated;

drop trigger if exists safety_reports_set_updated_at on public.safety_reports;
create trigger safety_reports_set_updated_at
before update on public.safety_reports
for each row execute function public.set_updated_at();

create or replace function public.refresh_established_profile_badge(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_eligible boolean;
begin
  select
    count(*) >= 5
    and not exists (
      select 1 from public.safety_reports sr
      where sr.target_user_id = p_user_id and sr.status = 'confirmed'
    )
  into v_eligible
  from public.jobs j
  where j.performer_id = p_user_id and j.status = 'completed';

  if v_eligible then
    insert into public.profile_badges (user_id, badge, active)
    values (p_user_id, 'established', true)
    on conflict (user_id) do update
      set active = true, updated_at = now();
  else
    update public.profile_badges
    set active = false, updated_at = now()
    where user_id = p_user_id;
  end if;
end;
$$;

revoke all on function public.refresh_established_profile_badge(uuid) from public, anon, authenticated;

create or replace function public.refresh_badge_after_job_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.performer_id is not null and (old.status is distinct from new.status or old.performer_id is distinct from new.performer_id) then
    perform public.refresh_established_profile_badge(new.performer_id);
  end if;
  if old.performer_id is not null and old.performer_id is distinct from new.performer_id then
    perform public.refresh_established_profile_badge(old.performer_id);
  end if;
  return new;
end;
$$;

revoke all on function public.refresh_badge_after_job_change() from public, anon, authenticated;

drop trigger if exists jobs_refresh_established_badge on public.jobs;
create trigger jobs_refresh_established_badge
after update of status, performer_id on public.jobs
for each row execute function public.refresh_badge_after_job_change();

create or replace function public.refresh_badge_after_report_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.target_user_id is not null and old.status is distinct from new.status then
    perform public.refresh_established_profile_badge(new.target_user_id);
  end if;
  return new;
end;
$$;

revoke all on function public.refresh_badge_after_report_change() from public, anon, authenticated;

drop trigger if exists safety_reports_refresh_badge on public.safety_reports;
create trigger safety_reports_refresh_badge
after update of status on public.safety_reports
for each row execute function public.refresh_badge_after_report_change();

insert into public.profile_badges (user_id, badge, active)
select j.performer_id, 'established', true
from public.jobs j
where j.status = 'completed' and j.performer_id is not null
group by j.performer_id
having count(*) >= 5
   and not exists (
     select 1 from public.safety_reports sr
     where sr.target_user_id = j.performer_id and sr.status = 'confirmed'
   )
on conflict (user_id) do update set active = excluded.active, updated_at = now();

create table if not exists public.privacy_requests (
  id bigint generated by default as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  request_type text not null check (request_type in ('export', 'delete')),
  status text not null default 'pending' check (status in ('pending', 'processing', 'completed', 'cancelled')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists privacy_requests_user_created_idx
  on public.privacy_requests (user_id, created_at desc);

alter table public.privacy_requests enable row level security;

drop policy if exists "Users can read own privacy requests" on public.privacy_requests;
create policy "Users can read own privacy requests" on public.privacy_requests for select
to authenticated using (user_id = (select auth.uid()));

drop policy if exists "Users can create own privacy requests" on public.privacy_requests;
create policy "Users can create own privacy requests" on public.privacy_requests for insert
to authenticated with check (user_id = (select auth.uid()));

revoke all on public.privacy_requests from anon, authenticated;
grant select, insert on public.privacy_requests to authenticated;
grant usage, select on sequence public.privacy_requests_id_seq to authenticated;
