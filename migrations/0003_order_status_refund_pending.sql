-- migrations/0003_order_status_refund_pending.sql
-- migrate:no-transaction
--
-- ALTER TYPE ... ADD VALUE must run outside a transaction block. The runner
-- detects the `-- migrate:no-transaction` directive above and executes this
-- file without wrapping it in BEGIN/COMMIT. Subsequent migrations (0004) can
-- then reference the new enum value.

ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'refund_pending' BEFORE 'refunded';