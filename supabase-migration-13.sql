-- Grannpojkarna: direktbokning till annonspris och motbud som separat flöde.
-- Kör efter supabase-migration-12.sql.

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
    select 1
    from public.profiles p
    where p.id = v_caller_id
      and p.performer_enabled = true
  ) then
    raise exception 'PERFORMER_PROFILE_REQUIRED';
  end if;

  -- Uppdateringsvillkoret gör att endast den första samtidiga anroparen kan
  -- ändra jobbet från öppet till accepterat.
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
  returning budget_sek into v_budget_sek;

  if not found then
    raise exception 'JOB_UNAVAILABLE';
  end if;

  if v_message = '' then
    v_message := 'Jag tar gärna jobbet för priset i annonsen.';
  end if;

  insert into public.job_applications (
    job_id,
    performer_id,
    message,
    proposed_price_sek,
    status
  )
  values (
    p_job_id,
    v_caller_id,
    v_message,
    v_budget_sek,
    'accepted'
  )
  on conflict (job_id, performer_id) do update
  set
    message = excluded.message,
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

-- Beställarens godkännande av ett motbud använder samma atomära statusvillkor.
-- Därmed kan varken ett motbud eller en direktbokning skriva över den som hann
-- ta jobbet först.
create or replace function public.accept_job_application(
  p_application_id bigint,
  p_agreed_price_sek integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job_id bigint;
  v_performer_id uuid;
begin
  if p_agreed_price_sek is null or p_agreed_price_sek < 1 or p_agreed_price_sek > 10000000 then
    raise exception 'INVALID_AGREED_PRICE';
  end if;

  select ja.job_id, ja.performer_id
  into v_job_id, v_performer_id
  from public.job_applications ja
  join public.jobs j on j.id = ja.job_id
  where ja.id = p_application_id
    and ja.status = 'pending'
    and j.status = 'open'
    and j.user_id = auth.uid();

  if v_job_id is null then
    raise exception 'APPLICATION_UNAVAILABLE';
  end if;

  update public.jobs
  set
    status = 'accepted',
    performer_id = v_performer_id,
    agreed_price_sek = p_agreed_price_sek,
    accepted_at = now(),
    started_at = null,
    completed_at = null
  where id = v_job_id
    and status = 'open'
    and performer_id is null
    and user_id = auth.uid();

  if not found then
    raise exception 'JOB_UNAVAILABLE';
  end if;

  update public.job_applications
  set status = case when id = p_application_id then 'accepted' else 'declined' end
  where job_id = v_job_id
    and status = 'pending';

  return true;
end;
$$;

revoke all on function public.accept_job_application(bigint, integer) from public, anon;
grant execute on function public.accept_job_application(bigint, integer) to authenticated;

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

  if new.status = 'accepted' then
    insert into public.notifications (user_id, type, title, body, job_id)
    values (
      new.performer_id,
      'job_accepted',
      'Jobbet är ditt',
      'Du har tagit "' || coalesce(v_job_title, 'jobbet') || '". Chatten är nu öppen.',
      new.job_id
    );

    if v_owner_id is not null and v_owner_id <> new.performer_id then
      insert into public.notifications (user_id, type, title, body, job_id)
      values (
        v_owner_id,
        'job_accepted',
        'Jobbet är taget',
        coalesce(v_performer_name, 'En utförare') || ' har tagit "' || coalesce(v_job_title, 'ditt jobb') || '" till annonspriset.',
        new.job_id
      );
    end if;
  else
    insert into public.notifications (user_id, type, title, body, job_id)
    values (
      new.performer_id,
      'application_sent',
      'Motbud skickat',
      'Ditt motbud för "' || coalesce(v_job_title, 'jobbet') || '" har skickats till beställaren.',
      new.job_id
    );

    if v_owner_id is not null and v_owner_id <> new.performer_id then
      insert into public.notifications (user_id, type, title, body, job_id)
      values (
        v_owner_id,
        'job_application',
        'Nytt motbud',
        coalesce(v_performer_name, 'En utförare') || ' har lämnat ett motbud på "' || coalesce(v_job_title, 'ditt jobb') || '".',
        new.job_id
      );
    end if;
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
  v_owner_id uuid;
  v_job_title text;
  v_performer_name text;
begin
  if old.status is not distinct from new.status then
    return new;
  end if;

  select j.user_id, j.title
  into v_owner_id, v_job_title
  from public.jobs j
  where j.id = new.job_id;

  select coalesce(p.display_name, 'En utförare')
  into v_performer_name
  from public.profiles p
  where p.id = new.performer_id;

  if new.status = 'accepted' and auth.uid() = new.performer_id then
    insert into public.notifications (user_id, type, title, body, job_id)
    values (
      new.performer_id,
      'job_accepted',
      'Jobbet är ditt',
      'Du har tagit "' || coalesce(v_job_title, 'jobbet') || '". Chatten är nu öppen.',
      new.job_id
    );

    if v_owner_id is not null and v_owner_id <> new.performer_id then
      insert into public.notifications (user_id, type, title, body, job_id)
      values (
        v_owner_id,
        'job_accepted',
        'Jobbet är taget',
        coalesce(v_performer_name, 'En utförare') || ' har tagit "' || coalesce(v_job_title, 'ditt jobb') || '" till annonspriset.',
        new.job_id
      );
    end if;
  elsif new.status = 'accepted' then
    insert into public.notifications (user_id, type, title, body, job_id)
    values (
      new.performer_id,
      'job_accepted',
      'Ditt motbud är accepterat',
      'Beställaren har accepterat ditt motbud för "' || coalesce(v_job_title, 'jobbet') || '". Öppna jobbet för att planera vidare.',
      new.job_id
    );
  elsif new.status = 'declined' then
    insert into public.notifications (user_id, type, title, body, job_id)
    values (
      new.performer_id,
      'application_declined',
      'Jobbet gick till en annan utförare',
      '"' || coalesce(v_job_title, 'Jobbet') || '" är inte längre öppet.',
      new.job_id
    );
  end if;

  return new;
end;
$$;

-- Triggerfunktionerna ska bara köras av databastriggers, inte som publika RPC-anrop.
revoke execute on function public.notify_new_job_application() from public, anon, authenticated;
revoke execute on function public.notify_application_accepted() from public, anon, authenticated;
