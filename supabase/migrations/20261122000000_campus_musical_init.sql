-- 校园音乐剧演出汇总：站内点击、搜索与匿名评论
-- 在 Supabase 控制台 → SQL Editor 里整段运行一次即可。
-- 权限：访客（anon key）只能新增点击/搜索/评论，读取汇总统计和未隐藏的评论；不能修改、删除，也读不到原始点击记录。

create table if not exists clicks (
  id bigserial primary key,
  item text not null check (length(item) <= 16),
  url text check (length(url) <= 300),
  created_at timestamptz not null default now()
);
create table if not exists searches (
  id bigserial primary key,
  q text not null check (length(q) between 2 and 40),
  created_at timestamptz not null default now()
);
create table if not exists comments (
  id bigserial primary key,
  item text not null check (length(item) <= 16),
  url text check (length(url) <= 300),
  name text check (length(name) <= 20),
  body text not null check (length(body) between 1 and 500),
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists comments_item on comments (item, created_at desc);

alter table clicks enable row level security;
alter table searches enable row level security;
alter table comments enable row level security;

drop policy if exists anon_insert on clicks;
drop policy if exists anon_insert on searches;
drop policy if exists anon_insert on comments;
drop policy if exists anon_read on comments;
create policy anon_insert on clicks for insert to anon with check (true);
create policy anon_insert on searches for insert to anon with check (true);
create policy anon_insert on comments for insert to anon with check (hidden = false);
create policy anon_read on comments for select to anon using (hidden = false);

-- 汇总视图（以视图所有者权限执行，访客只能看到计数，看不到原始记录）
create or replace view click_counts as
  select item, count(*)::int as c from clicks group by item;
create or replace view search_counts as
  select lower(q) as q, count(*)::int as c from searches
  where created_at > now() - interval '30 days' group by lower(q) having count(*) >= 2;
grant select on click_counts, search_counts to anon;
grant insert on clicks, searches, comments to anon;
grant select (id, item, name, body, created_at) on comments to anon;
grant usage on sequence clicks_id_seq, searches_id_seq, comments_id_seq to anon;

-- 简单防刷：同一条内容 1 分钟内最多 5 条评论
create or replace function comments_rate_limit() returns trigger language plpgsql as $$
begin
  if (select count(*) from comments where item = new.item and created_at > now() - interval '1 minute') >= 5 then
    raise exception 'too many comments';
  end if;
  return new;
end $$;
drop trigger if exists comments_rate_limit on comments;
create trigger comments_rate_limit before insert on comments for each row execute function comments_rate_limit();
