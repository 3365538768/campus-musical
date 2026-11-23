-- 本地面板用 secret key（service_role）管理评论：隐藏/恢复/删除，以及查看统计。
grant select, insert, update, delete on clicks, searches, comments to service_role;
grant usage, select on sequence clicks_id_seq, searches_id_seq, comments_id_seq to service_role;
grant select on click_counts, search_counts to service_role;
-- 网页上显示每条内容的评论数
create or replace view comment_counts as select item, count(*)::int as c from comments where not hidden group by item;
grant select on comment_counts to anon, service_role;
