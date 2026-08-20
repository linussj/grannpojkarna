-- Grannpojkarna: fler notishändelser och matchning mot utförarprofil.
-- Kör efter supabase-migration-6.sql.

alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check
  check (type in (
    'job_match',
    'application_sent',
    'job_application',
    'job_accepted',
    'application_declined',
    'job_started',
    'job_completed',
    'payout_ready',
    'new_message'
  ));

create or replace function public.notify_new_job_application()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid;
  v_job_title text;
  v_performer_name text;
begin
  select j.user_id, j.title
  into v_owner_id, v_job_title
  from public.jobs j
  where j.id = new.job_id;

  select coalesce(p.display_name, 'En utförare')
  into v_performer_name
  from public.profiles p
  where p.id = new.performer_id;

  insert into public.notifications (user_id, type, title, body, job_id)
  values (
    new.performer_id,
    'application_sent',
    'Intresseanmälan skickad',
    'Din intresseanmälan för "' || coalesce(v_job_title, 'jobbet') || '" har skickats till beställaren.',
    new.job_id
  );

  if v_owner_id is not null and v_owner_id <> new.performer_id then
    insert into public.notifications (user_id, type, title, body, job_id)
    values (
      v_owner_id,
      'job_application',
      'Ny intresseanmälan',
      coalesce(v_performer_name, 'En utförare') || ' är intresserad av "' || coalesce(v_job_title, 'ditt jobb') || '".',
      new.job_id
    );
  end if;

  return new;
end;
$$;

create or replace function public.notify_application_accepted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job_title text;
begin
  if old.status is not distinct from new.status then
    return new;
  end if;

  select j.title into v_job_title
  from public.jobs j
  where j.id = new.job_id;

  if new.status = 'accepted' then
    insert into public.notifications (user_id, type, title, body, job_id)
    values (
      new.performer_id,
      'job_accepted',
      'Du har blivit vald',
      'Beställaren har valt dig för "' || coalesce(v_job_title, 'jobbet') || '". Öppna jobbet för att planera vidare.',
      new.job_id
    );
  elsif new.status = 'declined' then
    insert into public.notifications (user_id, type, title, body, job_id)
    values (
      new.performer_id,
      'application_declined',
      'En annan utförare valdes',
      'Beställaren har gått vidare med en annan utförare för "' || coalesce(v_job_title, 'jobbet') || '".',
      new.job_id
    );
  end if;

  return new;
end;
$$;

create or replace function public.notify_matching_performers()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status <> 'open' then
    return new;
  end if;

  insert into public.notifications (user_id, type, title, body, job_id)
  select
    p.id,
    'job_match',
    'Nytt jobb som kan passa dig',
    '"' || coalesce(new.title, new.category, 'Ett nytt jobb') || '" i ' || coalesce(new.location, 'ditt område') || ' matchar din utförarprofil.',
    new.id
  from public.profiles p
  where p.performer_enabled = true
    and p.id <> new.user_id
    and exists (
      select 1
      from unnest(coalesce(p.skills, array[]::text[])) as skill
      where char_length(trim(skill)) >= 3
        and concat_ws(' ', new.title, new.description, new.category) ilike '%' || trim(skill) || '%'
    )
    and (
      p.service_area is null
      or trim(p.service_area) = ''
      or new.location ilike '%' || trim(p.service_area) || '%'
      or p.service_area ilike '%' || trim(new.location) || '%'
    );

  return new;
end;
$$;

drop trigger if exists jobs_notify_matching_performers on public.jobs;
create trigger jobs_notify_matching_performers
after insert on public.jobs
for each row execute function public.notify_matching_performers();

create or replace function public.notify_job_status_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_amount integer;
begin
  if old.status is not distinct from new.status then
    return new;
  end if;

  if new.status = 'in_progress' then
    if new.user_id is distinct from v_actor_id then
      insert into public.notifications (user_id, type, title, body, job_id)
      values (new.user_id, 'job_started', 'Jobbet har startat', '"' || coalesce(new.title, 'Jobbet') || '" är nu markerat som pågående.', new.id);
    end if;
    if new.performer_id is not null and new.performer_id is distinct from v_actor_id then
      insert into public.notifications (user_id, type, title, body, job_id)
      values (new.performer_id, 'job_started', 'Jobbet har startat', '"' || coalesce(new.title, 'Jobbet') || '" är nu markerat som pågående.', new.id);
    end if;
  elsif new.status = 'completed' and new.performer_id is not null then
    v_amount := coalesce(new.agreed_price_sek, new.budget_sek, 0);

    insert into public.notifications (user_id, type, title, body, job_id)
    values (
      new.performer_id,
      'job_completed',
      'Jobbet är slutfört',
      'Beställaren har bekräftat att "' || coalesce(new.title, 'jobbet') || '" är klart.',
      new.id
    );

    insert into public.notifications (user_id, type, title, body, job_id)
    values (
      new.performer_id,
      'payout_ready',
      'Ersättning klar för utbetalning',
      v_amount::text || ' kr för "' || coalesce(new.title, 'jobbet') || '" är markerat som klart för utbetalning.',
      new.id
    );
  end if;

  return new;
end;
$$;

