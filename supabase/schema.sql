-- RackGrid team workspaces — Supabase schema
-- Run this once in your Supabase project: Dashboard → SQL Editor → New query → paste → Run.
-- Safe to re-run: it creates what's missing and replaces functions and policies.

-- ─────────────────────────────────────────────────────────────
-- Tables
-- ─────────────────────────────────────────────────────────────
create table if not exists public.teams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 80),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

create table if not exists public.team_members (
  team_id      uuid not null references public.teams(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null check (role in ('owner','admin','member')),
  display_name text not null default '',
  email        text not null default '',
  joined_at    timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index if not exists team_members_user_idx on public.team_members(user_id);

create table if not exists public.team_invites (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references public.teams(id) on delete cascade,
  code        text not null unique,
  role        text not null default 'member' check (role in ('admin','member')),
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz,
  max_uses    int check (max_uses is null or max_uses > 0),
  uses        int not null default 0,
  revoked     boolean not null default false
);
create index if not exists team_invites_team_idx on public.team_invites(team_id);

-- Every rack and site is one JSON document, versioned for safe concurrent edits.
create table if not exists public.docs (
  team_id     uuid not null references public.teams(id) on delete cascade,
  collection  text not null check (collection in ('racks','sites')),
  id          text not null check (char_length(id) between 1 and 64),
  data        jsonb not null default '{}'::jsonb,
  version     int not null default 1,
  deleted     boolean not null default false,
  updated_by  uuid references auth.users(id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (team_id, collection, id)
);

create table if not exists public.activity (
  id           bigint generated always as identity primary key,
  team_id      uuid not null references public.teams(id) on delete cascade,
  user_id      uuid references auth.users(id) on delete set null default auth.uid(),
  user_name    text not null default '',
  target_type  text not null default '',
  target_id    text not null default '',
  site_id      text not null default '',
  rack_id      text not null default '',
  summary      text not null check (char_length(summary) <= 500),
  happened_at  timestamptz not null default now(),
  created_at   timestamptz not null default now()
);
create index if not exists activity_team_time_idx on public.activity(team_id, created_at desc);

-- ─────────────────────────────────────────────────────────────
-- Helpers (security definer so policies can look up membership)
-- ─────────────────────────────────────────────────────────────
create or replace function public.team_role(t uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from public.team_members where team_id = t and user_id = auth.uid()
$$;

create or replace function public.is_team_member(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.team_members where team_id = t and user_id = auth.uid())
$$;

create or replace function public.is_team_admin(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.team_members where team_id = t and user_id = auth.uid() and role in ('owner','admin'))
$$;

create or replace function public.try_uuid(v text) returns uuid
language plpgsql immutable as $$
begin return v::uuid; exception when others then return null; end $$;

-- ─────────────────────────────────────────────────────────────
-- Row level security
-- ─────────────────────────────────────────────────────────────
alter table public.teams        enable row level security;
alter table public.team_members enable row level security;
alter table public.team_invites enable row level security;
alter table public.docs         enable row level security;
alter table public.activity     enable row level security;

drop policy if exists "members read team"     on public.teams;
drop policy if exists "admins rename team"    on public.teams;
create policy "members read team"  on public.teams for select to authenticated using (public.is_team_member(id));
create policy "admins rename team" on public.teams for update to authenticated using (public.is_team_admin(id)) with check (public.is_team_admin(id));

drop policy if exists "members read members" on public.team_members;
create policy "members read members" on public.team_members for select to authenticated using (public.is_team_member(team_id));

drop policy if exists "admins read invites" on public.team_invites;
create policy "admins read invites" on public.team_invites for select to authenticated using (public.is_team_admin(team_id));

drop policy if exists "members read docs"   on public.docs;
drop policy if exists "members add docs"    on public.docs;
drop policy if exists "members change docs" on public.docs;
create policy "members read docs"   on public.docs for select to authenticated using (public.is_team_member(team_id));
create policy "members add docs"    on public.docs for insert to authenticated with check (public.is_team_member(team_id));
create policy "members change docs" on public.docs for update to authenticated using (public.is_team_member(team_id)) with check (public.is_team_member(team_id));

drop policy if exists "members read activity" on public.activity;
drop policy if exists "members log activity"  on public.activity;
create policy "members read activity" on public.activity for select to authenticated using (public.is_team_member(team_id));
create policy "members log activity"  on public.activity for insert to authenticated with check (public.is_team_member(team_id) and user_id = auth.uid());

-- ─────────────────────────────────────────────────────────────
-- Team management (called from the app with supabase.rpc)
-- Roles: owner — everything, incl. roles and deleting the team
--        admin — invite people, remove members, rename the team
--        member — view and edit racks, sites and floor plans
-- ─────────────────────────────────────────────────────────────
create or replace function public.create_team(p_name text, p_display_name text default '') returns uuid
language plpgsql security definer set search_path = public as $$
declare t uuid; em text;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if coalesce(trim(p_name),'') = '' then raise exception 'Give the team a name'; end if;
  select email into em from auth.users where id = auth.uid();
  insert into public.teams(name, created_by) values (left(trim(p_name),80), auth.uid()) returning id into t;
  insert into public.team_members(team_id, user_id, role, display_name, email)
    values (t, auth.uid(), 'owner', left(coalesce(nullif(trim(p_display_name),''), split_part(coalesce(em,''),'@',1)),60), coalesce(em,''));
  return t;
end $$;

create or replace function public.create_invite(p_team uuid, p_role text default 'member', p_days int default 7, p_max_uses int default null) returns text
language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if not public.is_team_admin(p_team) then raise exception 'Only owners and admins can invite people'; end if;
  if p_role not in ('admin','member') then raise exception 'Invites can be for admins or members'; end if;
  loop
    c := 'RG-' || upper(substr(md5(random()::text || clock_timestamp()::text),1,4)) || '-' || upper(substr(md5(random()::text || clock_timestamp()::text),1,4));
    exit when not exists(select 1 from public.team_invites where code = c);
  end loop;
  insert into public.team_invites(team_id, code, role, created_by, expires_at, max_uses)
    values (p_team, c, p_role, auth.uid(), case when p_days is null or p_days <= 0 then null else now() + make_interval(days => p_days) end, p_max_uses);
  return c;
end $$;

create or replace function public.invite_info(p_code text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare i public.team_invites; tn text;
begin
  select * into i from public.team_invites where code = upper(trim(p_code));
  if not found then return jsonb_build_object('valid', false, 'reason', 'That code doesn''t exist.'); end if;
  select name into tn from public.teams where id = i.team_id;
  if i.revoked then return jsonb_build_object('valid', false, 'reason', 'That invitation was cancelled.'); end if;
  if i.expires_at is not null and i.expires_at < now() then return jsonb_build_object('valid', false, 'reason', 'That invitation has expired.'); end if;
  if i.max_uses is not null and i.uses >= i.max_uses then return jsonb_build_object('valid', false, 'reason', 'That invitation has been used up.'); end if;
  return jsonb_build_object('valid', true, 'team_id', i.team_id, 'team_name', tn, 'role', i.role,
    'already_member', exists(select 1 from public.team_members where team_id = i.team_id and user_id = auth.uid()));
end $$;

create or replace function public.accept_invite(p_code text, p_display_name text default '') returns uuid
language plpgsql security definer set search_path = public as $$
declare i public.team_invites; em text;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  select * into i from public.team_invites where code = upper(trim(p_code)) for update;
  if not found or i.revoked then raise exception 'That invitation isn''t valid'; end if;
  if i.expires_at is not null and i.expires_at < now() then raise exception 'That invitation has expired'; end if;
  if exists(select 1 from public.team_members where team_id = i.team_id and user_id = auth.uid()) then return i.team_id; end if;
  if i.max_uses is not null and i.uses >= i.max_uses then raise exception 'That invitation has been used up'; end if;
  select email into em from auth.users where id = auth.uid();
  insert into public.team_members(team_id, user_id, role, display_name, email)
    values (i.team_id, auth.uid(), i.role, left(coalesce(nullif(trim(p_display_name),''), split_part(coalesce(em,''),'@',1)),60), coalesce(em,''));
  update public.team_invites set uses = uses + 1 where id = i.id;
  insert into public.activity(team_id, user_id, user_name, target_type, summary)
    values (i.team_id, auth.uid(), coalesce(nullif(trim(p_display_name),''), split_part(coalesce(em,''),'@',1)), 'team', 'joined the team as ' || i.role);
  return i.team_id;
end $$;

create or replace function public.revoke_invite(p_invite uuid) returns void
language plpgsql security definer set search_path = public as $$
declare t uuid;
begin
  select team_id into t from public.team_invites where id = p_invite;
  if t is null or not public.is_team_admin(t) then raise exception 'Only owners and admins can cancel invitations'; end if;
  update public.team_invites set revoked = true where id = p_invite;
end $$;

create or replace function public.set_member_role(p_team uuid, p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
declare cur text;
begin
  if public.team_role(p_team) is distinct from 'owner' then raise exception 'Only the owner can change roles'; end if;
  if p_role not in ('owner','admin','member') then raise exception 'Unknown role'; end if;
  select role into cur from public.team_members where team_id = p_team and user_id = p_user;
  if cur is null then raise exception 'That person isn''t in the team'; end if;
  if p_user = auth.uid() then raise exception 'Transfer ownership to someone else instead'; end if;
  if p_role = 'owner' then
    update public.team_members set role = 'admin' where team_id = p_team and user_id = auth.uid();
  end if;
  update public.team_members set role = p_role where team_id = p_team and user_id = p_user;
end $$;

create or replace function public.remove_member(p_team uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare me text; them text;
begin
  me := public.team_role(p_team);
  select role into them from public.team_members where team_id = p_team and user_id = p_user;
  if them is null then return; end if;
  if p_user = auth.uid() then
    if me = 'owner' then raise exception 'Transfer ownership before leaving the team'; end if;
  elsif me = 'owner' then null;
  elsif me = 'admin' and them = 'member' then null;
  else raise exception 'You can''t remove this person';
  end if;
  delete from public.team_members where team_id = p_team and user_id = p_user;
end $$;

create or replace function public.set_display_name(p_team uuid, p_name text) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.team_members set display_name = left(trim(p_name),60) where team_id = p_team and user_id = auth.uid();
end $$;

create or replace function public.delete_team(p_team uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.team_role(p_team) is distinct from 'owner' then raise exception 'Only the owner can delete the team'; end if;
  delete from public.teams where id = p_team;
end $$;

-- Save one rack or site. Fails softly with the server copy when someone else saved first,
-- so the app can merge both sets of changes and try again.
create or replace function public.save_doc(p_team uuid, p_collection text, p_id text, p_data jsonb, p_expected int, p_deleted boolean default false) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare v int; cur public.docs;
begin
  if not public.is_team_member(p_team) then raise exception 'Not a member of this team'; end if;
  if p_deleted then
    insert into public.docs(team_id, collection, id, data, version, deleted, updated_by)
      values (p_team, p_collection, p_id, coalesce(p_data,'{}'::jsonb), 1, true, auth.uid())
      on conflict (team_id, collection, id) do update set deleted = true, version = public.docs.version + 1, updated_by = auth.uid(), updated_at = now()
      returning version into v;
    return jsonb_build_object('version', v);
  end if;
  if p_expected is null or p_expected = 0 then
    insert into public.docs(team_id, collection, id, data, version, deleted, updated_by)
      values (p_team, p_collection, p_id, p_data, 1, false, auth.uid())
      on conflict (team_id, collection, id) do nothing
      returning version into v;
  else
    update public.docs set data = p_data, version = version + 1, deleted = false, updated_by = auth.uid(), updated_at = now()
      where team_id = p_team and collection = p_collection and id = p_id and version = p_expected
      returning version into v;
  end if;
  if v is not null then return jsonb_build_object('version', v); end if;
  select * into cur from public.docs where team_id = p_team and collection = p_collection and id = p_id;
  if not found then
    insert into public.docs(team_id, collection, id, data, version, deleted, updated_by)
      values (p_team, p_collection, p_id, p_data, 1, false, auth.uid()) returning version into v;
    return jsonb_build_object('version', v);
  end if;
  return jsonb_build_object('conflict', true, 'version', cur.version, 'data', cur.data, 'deleted', cur.deleted);
end $$;

revoke all on function public.create_team(text,text), public.create_invite(uuid,text,int,int), public.invite_info(text),
  public.accept_invite(text,text), public.revoke_invite(uuid), public.set_member_role(uuid,uuid,text),
  public.remove_member(uuid,uuid), public.set_display_name(uuid,text), public.delete_team(uuid),
  public.save_doc(uuid,text,text,jsonb,int,boolean) from public, anon;
grant execute on function public.create_team(text,text), public.create_invite(uuid,text,int,int), public.invite_info(text),
  public.accept_invite(text,text), public.revoke_invite(uuid), public.set_member_role(uuid,uuid,text),
  public.remove_member(uuid,uuid), public.set_display_name(uuid,text), public.delete_team(uuid),
  public.save_doc(uuid,text,text,jsonb,int,boolean) to authenticated;

-- ─────────────────────────────────────────────────────────────
-- Floor plan images: private bucket, one folder per team
-- ─────────────────────────────────────────────────────────────
insert into storage.buckets(id, name, public) values ('floorplans', 'floorplans', false) on conflict (id) do nothing;

drop policy if exists "rackgrid team reads plans"   on storage.objects;
drop policy if exists "rackgrid team adds plans"    on storage.objects;
drop policy if exists "rackgrid team removes plans" on storage.objects;
create policy "rackgrid team reads plans"   on storage.objects for select to authenticated
  using (bucket_id = 'floorplans' and public.is_team_member(public.try_uuid((storage.foldername(name))[1])));
create policy "rackgrid team adds plans"    on storage.objects for insert to authenticated
  with check (bucket_id = 'floorplans' and public.is_team_member(public.try_uuid((storage.foldername(name))[1])));
create policy "rackgrid team removes plans" on storage.objects for delete to authenticated
  using (bucket_id = 'floorplans' and public.is_team_member(public.try_uuid((storage.foldername(name))[1])));

-- ─────────────────────────────────────────────────────────────
-- Live updates
-- ─────────────────────────────────────────────────────────────
alter table public.team_members replica identity full;
do $$
declare t text;
begin
  foreach t in array array['docs','activity','team_members','teams'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
