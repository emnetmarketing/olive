-- Run once in the Supabase SQL editor.
create extension if not exists pgcrypto;

create type public.app_role as enum ('master', 'editor', 'operator');
create type public.account_status as enum ('pending', 'approved', 'rejected', 'disabled');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  display_name text not null default '',
  role public.app_role not null default 'operator',
  status public.account_status not null default 'pending',
  requested_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index profiles_email_lower_idx on public.profiles (lower(email));

create table public.app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null references public.profiles(id)
);

create table public.analysis_results (
  id bigint generated always as identity primary key,
  run_id uuid not null default gen_random_uuid(),
  result_data jsonb not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now()
);

create index analysis_results_created_at_idx on public.analysis_results(created_at desc);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_user_id uuid references public.profiles(id),
  action text not null,
  target_user_id uuid references public.profiles(id),
  details jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.current_profile()
returns public.profiles language sql stable security definer set search_path = public
as $$ select * from public.profiles where id = auth.uid() $$;

create or replace function public.is_approved()
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce((select status = 'approved' from public.profiles where id = auth.uid()), false) $$;

create or replace function public.is_editor()
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce((select status = 'approved' and role in ('master','editor') from public.profiles where id = auth.uid()), false) $$;

create or replace function public.is_master()
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce((select status = 'approved' and role = 'master' from public.profiles where id = auth.uid()), false) $$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles(id, email, display_name)
  values(new.id, coalesce(new.email, ''), coalesce(new.raw_user_meta_data->>'display_name', split_part(coalesce(new.email,''), '@', 1)));
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();

-- DB-level invariants: at most two approved masters; the last approved master cannot be removed/demoted.
create or replace function public.enforce_master_limits()
returns trigger language plpgsql set search_path = public
as $$
declare master_count integer;
begin
  select count(*) into master_count from public.profiles where role='master' and status='approved';
  if tg_op in ('INSERT','UPDATE') and new.role='master' and new.status='approved'
     and not (tg_op='UPDATE' and old.role='master' and old.status='approved')
     and master_count >= 2 then
    raise exception 'Maximum of two approved masters is allowed';
  end if;
  if tg_op='UPDATE' and old.role='master' and old.status='approved'
     and not (new.role='master' and new.status='approved') and master_count <= 1 then
    raise exception 'The last approved master cannot be demoted or disabled';
  end if;
  return new;
end $$;

drop trigger if exists profiles_master_limits_update on public.profiles;
create trigger profiles_master_limits_update before insert or update on public.profiles
for each row execute procedure public.enforce_master_limits();

create or replace function public.prevent_last_master_delete()
returns trigger language plpgsql set search_path = public
as $$
begin
  if old.role='master' and old.status='approved' and
     (select count(*) from public.profiles where role='master' and status='approved') <= 1 then
    raise exception 'The last approved master cannot be deleted';
  end if;
  return old;
end $$;

drop trigger if exists profiles_last_master_delete on public.profiles;
create trigger profiles_last_master_delete before delete on public.profiles
for each row execute procedure public.prevent_last_master_delete();

alter table public.profiles enable row level security;
alter table public.app_settings enable row level security;
alter table public.analysis_results enable row level security;
alter table public.audit_logs enable row level security;

create policy profiles_read_self on public.profiles for select to authenticated using (id = auth.uid());
create policy profiles_master_read_all on public.profiles for select to authenticated using (public.is_master());
create policy settings_approved_read on public.app_settings for select to authenticated using (public.is_approved());
create policy settings_editor_insert on public.app_settings for insert to authenticated with check (public.is_editor() and updated_by=auth.uid());
create policy settings_editor_update on public.app_settings for update to authenticated using (public.is_editor()) with check (public.is_editor() and updated_by=auth.uid());
create policy results_approved_read on public.analysis_results for select to authenticated using (public.is_approved());
create policy results_approved_insert on public.analysis_results for insert to authenticated with check (public.is_approved() and created_by=auth.uid());
create policy results_editor_delete on public.analysis_results for delete to authenticated using (public.is_editor());
create policy audit_master_read on public.audit_logs for select to authenticated using (public.is_master());

-- Defaults: editable in the app. Retention cleanup runs when a new result is saved.
insert into public.app_settings(key,value,updated_by)
select 'retention', '{"days":90,"max_records":1000}'::jsonb, id
from public.profiles where role='master' and status='approved' limit 1
on conflict (key) do nothing;

create or replace function public.cleanup_analysis_results()
returns void language plpgsql security definer set search_path = public
as $$
declare retention_days integer := 90; max_records integer := 1000;
begin
  if not public.is_approved() then raise exception 'Not authorized'; end if;
  select coalesce((value->>'days')::integer,90), coalesce((value->>'max_records')::integer,1000)
    into retention_days,max_records from public.app_settings where key='retention';
  retention_days := coalesce(retention_days, 90);
  max_records := coalesce(max_records, 1000);
  retention_days := greatest(1, least(retention_days, 3650));
  max_records := greatest(10, least(max_records, 100000));
  delete from public.analysis_results where created_at < now() - make_interval(days => retention_days);
  delete from public.analysis_results where id in (
    select id from public.analysis_results order by created_at desc offset max_records
  );
end $$;

grant execute on function public.cleanup_analysis_results() to authenticated;

-- Bootstrap after the designated user has signed up (replace UUID):
-- update public.profiles set role='master', status='approved', approved_at=now() where id='USER_UUID';
