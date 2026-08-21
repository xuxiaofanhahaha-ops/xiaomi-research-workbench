-- 科研工作台免费版同步结构。
-- 实际内容在设备端用 AES-GCM 加密后才写入此表。
create table if not exists public.workspace_state (
  id text primary key,
  payload text not null,
  updated_at timestamptz not null default now()
);

alter table public.workspace_state enable row level security;

create policy "encrypted state read"
on public.workspace_state for select to anon using (true);

create policy "encrypted state insert"
on public.workspace_state for insert to anon with check (true);

create policy "encrypted state update"
on public.workspace_state for update to anon using (true) with check (true);

insert into storage.buckets (id, name, public)
values ('workbench-files', 'workbench-files', false)
on conflict (id) do update set public = false;

create policy "encrypted files read"
on storage.objects for select to anon
using (bucket_id = 'workbench-files');

create policy "encrypted files insert"
on storage.objects for insert to anon
with check (bucket_id = 'workbench-files');

create policy "encrypted files update"
on storage.objects for update to anon
using (bucket_id = 'workbench-files')
with check (bucket_id = 'workbench-files');
