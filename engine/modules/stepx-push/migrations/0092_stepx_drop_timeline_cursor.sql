-- 仅删除旧同步进度，内容与审核数据不受影响。
ALTER TABLE stepx_push_state DROP COLUMN IF EXISTS timeline_at;
