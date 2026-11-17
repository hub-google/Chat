-- Verified Drive archives are checkpoints, not a reason to erase moderation data.
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS backup_verified_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_tunnel_messages_pending_backup
ON public.messages(created_at,id) WHERE backup_verified_at IS NULL;
