-- stepx 推送游标：worker 定时把新精选 POST 到 stepx 的 webhook。
-- 一个渠道一行；cursor 只在投递成功后前进，失败下一次重投同一批，靠 stepx 的 externalId 唯一键去重。
CREATE TABLE IF NOT EXISTS stepx_push_state (
  channel        text PRIMARY KEY,
  timeline_at    timestamptz,
  article_id     text,
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  last_status    integer,
  last_count     integer NOT NULL DEFAULT 0,
  last_error     text,
  pushed_total   bigint NOT NULL DEFAULT 0
)
