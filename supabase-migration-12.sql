-- Grannpojkarna: begränsa privata RPC-funktioner och komplettera FK-index.
-- Kör efter supabase-migration-11.sql.

-- Dessa funktioner kontrollerar auth.uid() internt och används bara av
-- inloggade användare. Tidigare explicita anon-rättigheter tas bort.
revoke execute on function public.accept_job_application(bigint, integer) from public, anon;
revoke execute on function public.cancel_job(bigint, text) from public, anon;
revoke execute on function public.complete_job(bigint) from public, anon;
revoke execute on function public.edit_my_open_job(bigint, text, text, text, text, integer, text, text) from public, anon;
revoke execute on function public.edit_my_open_job(bigint, text, text, text, text, integer, text, text, date, date, text[]) from public, anon;
revoke execute on function public.get_job_applications(bigint) from public, anon;
revoke execute on function public.send_direct_message(uuid, text) from public, anon;
revoke execute on function public.set_my_availability(text) from public, anon;
revoke execute on function public.start_job(bigint) from public, anon;

grant execute on function public.accept_job_application(bigint, integer) to authenticated;
grant execute on function public.cancel_job(bigint, text) to authenticated;
grant execute on function public.complete_job(bigint) to authenticated;
grant execute on function public.edit_my_open_job(bigint, text, text, text, text, integer, text, text) to authenticated;
grant execute on function public.edit_my_open_job(bigint, text, text, text, text, integer, text, text, date, date, text[]) to authenticated;
grant execute on function public.get_job_applications(bigint) to authenticated;
grant execute on function public.send_direct_message(uuid, text) to authenticated;
grant execute on function public.set_my_availability(text) to authenticated;
grant execute on function public.start_job(bigint) to authenticated;

-- Index som stödjer relationer i chatt, notiser, omdömen och trygghetsärenden.
create index if not exists job_messages_sender_id_idx on public.job_messages (sender_id);
create index if not exists jobs_cancelled_by_idx on public.jobs (cancelled_by) where cancelled_by is not null;
create index if not exists notifications_job_id_idx on public.notifications (job_id) where job_id is not null;
create index if not exists notifications_related_user_id_idx on public.notifications (related_user_id) where related_user_id is not null;
create index if not exists reviews_reviewer_id_idx on public.reviews (reviewer_id);
create index if not exists safety_reports_reporter_id_idx on public.safety_reports (reporter_id) where reporter_id is not null;
create index if not exists safety_reports_target_job_id_idx on public.safety_reports (target_job_id) where target_job_id is not null;
create index if not exists safety_reports_target_user_status_idx on public.safety_reports (target_user_id, status) where target_user_id is not null;
