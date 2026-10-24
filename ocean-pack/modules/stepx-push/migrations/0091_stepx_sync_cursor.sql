-- 新增不透明账本游标。旧 timeline 游标不能表达更正和撤回，升级后重新发一次快照。
ALTER TABLE stepx_push_state ADD COLUMN sync_cursor text;
