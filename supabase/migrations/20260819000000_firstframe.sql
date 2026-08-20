create extension if not exists pgcrypto;

create table if not exists public.batches (
  id uuid primary key default gen_random_uuid(),
  guest_session_id text not null,
  status text not null default 'uploading'
    check (status in ('uploading', 'queued', 'processing', 'complete', 'failed')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists batches_guest_session_idx
  on public.batches (guest_session_id, created_at desc);
create index if not exists batches_expiry_idx
  on public.batches (expires_at);

create table if not exists public.frame_jobs (
  id uuid primary key,
  batch_id uuid not null references public.batches(id) on delete cascade,
  position smallint not null check (position >= 0 and position < 10),
  original_name text not null check (char_length(original_name) between 1 and 255),
  source_storage_key text not null unique,
  output_storage_key text not null unique,
  source_size_bytes bigint not null check (source_size_bytes > 0),
  mime_type text not null,
  status text not null default 'uploading'
    check (status in ('uploading', 'queued', 'processing', 'ready', 'failed', 'cancelled')),
  progress smallint not null default 0 check (progress between 0 and 100),
  width integer,
  height integer,
  output_size_bytes bigint,
  error_message text,
  worker_id text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  unique (batch_id, position)
);

create index if not exists frame_jobs_queue_idx
  on public.frame_jobs (status, created_at) where status = 'queued';
create index if not exists frame_jobs_batch_idx
  on public.frame_jobs (batch_id, position);

create table if not exists public.job_rate_events (
  id bigint generated always as identity primary key,
  subject_kind text not null check (subject_kind in ('session', 'ip')),
  subject_hash text not null,
  created_at timestamptz not null default now()
);

create index if not exists job_rate_events_lookup_idx
  on public.job_rate_events (subject_kind, subject_hash, created_at desc);

alter table public.batches enable row level security;
alter table public.frame_jobs enable row level security;
alter table public.job_rate_events enable row level security;

-- The browser never queries these tables directly. With RLS enabled and no
-- anon/authenticated policies, only the API/worker service role can access them.
revoke all on public.batches from anon, authenticated;
revoke all on public.frame_jobs from anon, authenticated;
revoke all on public.job_rate_events from anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'source-videos',
  'source-videos',
  false,
  536870912,
  array['video/mp4', 'application/mp4', 'video/quicktime', 'video/x-m4v', 'video/webm']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public)
values ('output-frames', 'output-frames', false)
on conflict (id) do update set public = excluded.public;

create or replace function public.reserve_job_capacity(
  p_session_hash text,
  p_ip_hash text,
  p_count integer,
  p_max_per_session integer,
  p_max_per_ip integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session_count integer;
  v_ip_count integer;
begin
  if p_count < 1 or p_count > 10 then return false; end if;

  perform pg_advisory_xact_lock(hashtextextended('session:' || p_session_hash, 0));
  perform pg_advisory_xact_lock(hashtextextended('ip:' || p_ip_hash, 0));

  select count(*) into v_session_count
    from public.job_rate_events
    where subject_kind = 'session'
      and subject_hash = p_session_hash
      and created_at > now() - interval '24 hours';
  select count(*) into v_ip_count
    from public.job_rate_events
    where subject_kind = 'ip'
      and subject_hash = p_ip_hash
      and created_at > now() - interval '24 hours';

  if v_session_count + p_count > p_max_per_session
     or v_ip_count + p_count > p_max_per_ip then
    return false;
  end if;

  insert into public.job_rate_events (subject_kind, subject_hash)
    select 'session', p_session_hash from generate_series(1, p_count);
  insert into public.job_rate_events (subject_kind, subject_hash)
    select 'ip', p_ip_hash from generate_series(1, p_count);
  return true;
end;
$$;

create or replace function public.refresh_batch_status(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select case
    when count(*) = 0 then 'uploading'
    when bool_or(status = 'processing') then 'processing'
    when bool_or(status = 'queued') then 'queued'
    when bool_or(status = 'uploading') then 'uploading'
    when bool_and(status in ('ready', 'cancelled')) and bool_or(status = 'ready') then 'complete'
    when bool_or(status = 'failed') then 'failed'
    else 'failed'
  end into v_status
  from public.frame_jobs
  where batch_id = p_batch_id;

  update public.batches set status = v_status where id = p_batch_id;
end;
$$;

create or replace function public.claim_frame_job(p_worker_id text)
returns setof public.frame_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with next_job as (
    select id
    from public.frame_jobs
    where status = 'queued'
    order by created_at, position
    for update skip locked
    limit 1
  ), claimed as (
    update public.frame_jobs jobs
      set status = 'processing', progress = 10, worker_id = p_worker_id, started_at = now()
      from next_job
      where jobs.id = next_job.id
      returning jobs.*
  )
  select * from claimed;
end;
$$;

revoke all on function public.reserve_job_capacity(text, text, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.refresh_batch_status(uuid) from public, anon, authenticated;
revoke all on function public.claim_frame_job(text) from public, anon, authenticated;
grant execute on function public.reserve_job_capacity(text, text, integer, integer, integer) to service_role;
grant execute on function public.refresh_batch_status(uuid) to service_role;
grant execute on function public.claim_frame_job(text) to service_role;
