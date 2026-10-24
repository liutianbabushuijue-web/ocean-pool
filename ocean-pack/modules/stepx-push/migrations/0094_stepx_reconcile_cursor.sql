-- 周期全量重核独立于增量高水位，避免快照期间的更正和撤回被跳过。
ALTER TABLE stepx_push_state ADD COLUMN reconcile_cursor text;
