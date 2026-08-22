-- Local-only frames never reach these tables. This migration protects only the
-- higher-cost compatibility fallback path.

update storage.buckets
set file_size_limit = 524288000
where id = 'source-videos';

create index if not exists frame_jobs_batch_status_idx
  on public.frame_jobs (batch_id, status);
create index if not exists frame_jobs_processing_idx
  on public.frame_jobs (status, batch_id)
  where status = 'processing';

drop function if exists public.reserve_job_capacity(
  text, text, integer, integer, integer
);

create or replace function public.reserve_fallback_capacity(
  p_session_hash text,
  p_ip_hash text,
  p_count integer,
  p_max_per_session_day integer,
  p_max_per_ip_hour integer,
  p_max_per_ip_day integer,
  p_captcha_threshold_ip_hour integer,
  p_captcha_threshold_ip_day integer,
  p_max_concurrent_per_session integer,
  p_require_captcha boolean,
  p_captcha_verified boolean
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_day integer;
  v_ip_hour integer;
  v_ip_day integer;
  v_active integer;
begin
  if p_count < 1 or p_count > 10 then return 'rate_limited'; end if;

  perform pg_advisory_xact_lock(hashtextextended('session:' || p_session_hash, 0));
  perform pg_advisory_xact_lock(hashtextextended('ip:' || p_ip_hash, 0));

  select count(*) into v_active
  from public.frame_jobs jobs
  join public.batches batches on batches.id = jobs.batch_id
  where batches.guest_session_id = p_session_hash
    and jobs.status = 'processing';

  if v_active >= p_max_concurrent_per_session then
    return 'concurrent_limit';
  end if;

  select count(*) into v_session_day
  from public.job_rate_events
  where subject_kind = 'session'
    and subject_hash = p_session_hash
    and created_at > now() - interval '24 hours';

  select count(*) into v_ip_hour
  from public.job_rate_events
  where subject_kind = 'ip'
    and subject_hash = p_ip_hash
    and created_at > now() - interval '1 hour';

  select count(*) into v_ip_day
  from public.job_rate_events
  where subject_kind = 'ip'
    and subject_hash = p_ip_hash
    and created_at > now() - interval '24 hours';

  if v_session_day + p_count > p_max_per_session_day
     or v_ip_hour + p_count > p_max_per_ip_hour
     or v_ip_day + p_count > p_max_per_ip_day then
    return 'rate_limited';
  end if;

  if p_require_captcha and not p_captcha_verified
     and (v_ip_hour + p_count > p_captcha_threshold_ip_hour
       or v_ip_day + p_count > p_captcha_threshold_ip_day) then
    return 'captcha_required';
  end if;

  insert into public.job_rate_events (subject_kind, subject_hash)
    select 'session', p_session_hash from generate_series(1, p_count);
  insert into public.job_rate_events (subject_kind, subject_hash)
    select 'ip', p_ip_hash from generate_series(1, p_count);
  return 'reserved';
end;
$$;

drop function if exists public.claim_frame_job(text);

create or replace function public.claim_frame_job(
  p_worker_id text,
  p_max_concurrent_per_session integer
) returns setof public.frame_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Claim transactions are tiny. Serializing only this decision prevents
  -- multiple workers from racing past the same per-session active count.
  perform pg_advisory_xact_lock(
    hashtextextended('firstframe:claim-fallback-job', 0)
  );

  return query
  with next_job as (
    select jobs.id
    from public.frame_jobs jobs
    join public.batches batch on batch.id = jobs.batch_id
    where jobs.status = 'queued'
      and (
        select count(*)
        from public.frame_jobs active
        join public.batches active_batch on active_batch.id = active.batch_id
        where active.status = 'processing'
          and active_batch.guest_session_id = batch.guest_session_id
      ) < p_max_concurrent_per_session
    order by jobs.created_at, jobs.position
    for update of jobs skip locked
    limit 1
  ), claimed as (
    update public.frame_jobs jobs
      set status = 'processing', progress = 10,
          worker_id = p_worker_id, started_at = now()
      from next_job
      where jobs.id = next_job.id
      returning jobs.*
  )
  select * from claimed;
end;
$$;

revoke all on function public.reserve_fallback_capacity(
  text, text, integer, integer, integer, integer, integer, integer,
  integer, boolean, boolean
) from public, anon, authenticated;
revoke all on function public.claim_frame_job(text, integer)
  from public, anon, authenticated;
grant execute on function public.reserve_fallback_capacity(
  text, text, integer, integer, integer, integer, integer, integer,
  integer, boolean, boolean
) to service_role;
grant execute on function public.claim_frame_job(text, integer) to service_role;
