-- Xyro Market - contrat relationnel initial
-- Snowflakes Discord (guild_id, discord_id, role_id, thread_id, message_id) sont
-- stockés en TEXT : l'application ne doit jamais les faire transiter en number.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Rôle applicatif dédié : permet aux GRANT ci-dessous (notamment le
-- append-only de audit_log) de constituer une garantie réelle plutôt qu'une
-- simple convention. En production, DATABASE_URL doit authentifier sous ce
-- rôle (ou un rôle qui lui est accordé) — hors scope de cette migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'xyro_app') THEN
    CREATE ROLE xyro_app NOLOGIN;
  END IF;
END
$$;

-- ==================== ENUMS ====================

CREATE TYPE listing_mode AS ENUM ('don', 'echange');
CREATE TYPE listing_status AS ENUM ('active', 'matched', 'hidden', 'removed', 'fulfilled');
CREATE TYPE match_proposal_kind AS ENUM ('queue', 'cycle');
CREATE TYPE match_proposal_status AS ENUM ('open', 'accepted', 'refused', 'expired');
CREATE TYPE transaction_status AS ENUM (
  'PROPOSED', 'ACCEPTED', 'TRIAL', 'TRIAL_VALIDATED', 'TRANSFERRED',
  'CLOSED', 'CANCELLED', 'EXPIRED', 'DISPUTED'
);
CREATE TYPE sanction_kind AS ENUM ('ban_temp', 'ban_perm', 'suspend', 'warn');
CREATE TYPE report_target_type AS ENUM ('user', 'listing', 'review', 'message');
CREATE TYPE report_status AS ENUM ('open', 'assigned', 'resolved', 'stale');
CREATE TYPE dispute_status AS ENUM ('open', 'awaiting_return', 'resolved');
CREATE TYPE dispute_outcome AS ENUM ('return_expected', 'rejected', 'settled');
CREATE TYPE ownership_source AS ENUM ('gateway', 'sweep', 'oauth', 'audit_log');

-- ==================== CORE ====================

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  discord_id TEXT NOT NULL UNIQUE,
  username TEXT NOT NULL,
  avatar_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  banned_until TIMESTAMPTZ,
  banned_permanently BOOLEAN NOT NULL DEFAULT false,
  is_verified BOOLEAN NOT NULL DEFAULT false,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE oauth_tokens (
  user_id UUID PRIMARY KEY REFERENCES users (id) ON DELETE RESTRICT,
  access_token_enc TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  csrf_secret TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX idx_sessions_user ON sessions (user_id);

CREATE TABLE guilds (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon_hash TEXT,
  member_count_cached INTEGER,
  owner_discord_id TEXT NOT NULL,
  bot_present BOOLEAN NOT NULL DEFAULT false,
  bot_role_position INTEGER,
  audit_blind BOOLEAN NOT NULL DEFAULT false,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  guild_id TEXT NOT NULL REFERENCES guilds (id) ON DELETE RESTRICT,
  mode listing_mode NOT NULL,
  description TEXT NOT NULL,
  tags TEXT[] NOT NULL DEFAULT '{}',
  seeking_tags TEXT[] NOT NULL DEFAULT '{}',
  status listing_status NOT NULL DEFAULT 'active',
  search_tsv tsvector GENERATED ALWAYS AS (to_tsvector('french', description)) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Une guilde ne porte jamais deux annonces actives simultanément.
CREATE UNIQUE INDEX uniq_listings_active_guild ON listings (guild_id) WHERE status = 'active';

-- Index de recherche (contrat : zéro Seq Scan toléré sur listPublic).
CREATE INDEX idx_listings_tags_gin ON listings USING GIN (tags);
CREATE INDEX idx_listings_seeking_tags_gin ON listings USING GIN (seeking_tags);
CREATE INDEX idx_listings_search_tsv_gin ON listings USING GIN (search_tsv);
CREATE INDEX idx_listings_status_mode_created ON listings (status, mode, created_at DESC);

CREATE TABLE match_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind match_proposal_kind NOT NULL,
  status match_proposal_status NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE match_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES match_proposals (id) ON DELETE RESTRICT,
  listing_id UUID NOT NULL REFERENCES listings (id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  gives_to_listing_id UUID REFERENCES listings (id) ON DELETE RESTRICT,
  accepted_at TIMESTAMPTZ,
  refused_at TIMESTAMPTZ
);
CREATE INDEX idx_match_participants_proposal ON match_participants (proposal_id);
CREATE UNIQUE INDEX uniq_match_participants_proposal_user ON match_participants (proposal_id, user_id);

CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id UUID NOT NULL REFERENCES match_proposals (id) ON DELETE RESTRICT,
  from_user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  to_user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  guild_id TEXT NOT NULL REFERENCES guilds (id) ON DELETE RESTRICT,
  status transaction_status NOT NULL DEFAULT 'PROPOSED',
  trial_started_at TIMESTAMPTZ,
  trial_ends_at TIMESTAMPTZ,
  trial_role_id TEXT,
  validated_by_from_at TIMESTAMPTZ,
  validated_by_to_at TIMESTAMPTZ,
  transferred_at TIMESTAMPTZ,
  announced_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  hub_thread_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Un seul essai (ou transaction non terminale) en cours par guilde.
CREATE UNIQUE INDEX uniq_transactions_open_guild ON transactions (guild_id)
  WHERE status NOT IN ('CANCELLED', 'EXPIRED', 'CLOSED');
CREATE INDEX idx_transactions_status_trial_ends ON transactions (status, trial_ends_at);

CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES transactions (id) ON DELETE RESTRICT,
  author_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  target_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  rating SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  hidden_at TIMESTAMPTZ,
  hidden_by UUID REFERENCES users (id) ON DELETE RESTRICT,
  CHECK (author_id <> target_id),
  UNIQUE (transaction_id, author_id)
);
CREATE INDEX idx_reviews_target ON reviews (target_id) WHERE hidden_at IS NULL;

CREATE TABLE reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  target_type report_target_type NOT NULL,
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  status report_status NOT NULL DEFAULT 'open',
  assignee_id UUID REFERENCES users (id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX idx_reports_status ON reports (status);

CREATE TABLE sanctions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  kind sanction_kind NOT NULL,
  reason TEXT NOT NULL,
  actor_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by UUID REFERENCES users (id) ON DELETE RESTRICT
);
CREATE INDEX idx_sanctions_user_active ON sanctions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES transactions (id) ON DELETE RESTRICT,
  opened_by UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  reason TEXT NOT NULL,
  status dispute_status NOT NULL DEFAULT 'open',
  outcome dispute_outcome,
  resolution TEXT,
  resolved_by UUID REFERENCES users (id) ON DELETE RESTRICT,
  timeline JSONB NOT NULL DEFAULT '[]',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX uniq_disputes_open_transaction ON disputes (transaction_id) WHERE status <> 'resolved';

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by UUID REFERENCES users (id) ON DELETE RESTRICT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pending_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ
);
CREATE INDEX idx_pending_notifications_undelivered ON pending_notifications (user_id) WHERE delivered_at IS NULL;

-- File d'attente FIFO du mode don (domain/matching/queue.js) — table non
-- nommée dans le contrat migrations, nécessaire pour M4 ("file d'attente
-- simple"). Les positions ne sont jamais renumérotées (garantie explicite).
CREATE TABLE listing_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES listings (id) ON DELETE RESTRICT,
  candidate_user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  position INTEGER NOT NULL,
  skipped_at TIMESTAMPTZ,
  withdrawn_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (listing_id, candidate_user_id)
);
CREATE INDEX idx_listing_queue_head ON listing_queue (listing_id, position)
  WHERE skipped_at IS NULL AND withdrawn_at IS NULL;

-- Cooldown entre les mêmes parties après dissolution d'un cycle/proposition
-- (A18) — table non nommée dans le contrat, nécessaire pour implémenter la
-- garantie "un cycle dissous n'est pas reproposé à l'identique au tour
-- suivant" (domain/matching/engine.js).
CREATE TABLE match_cooldowns (
  user_id_a UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  user_id_b UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  until TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id_a, user_id_b),
  CHECK (user_id_a < user_id_b)
);
CREATE INDEX idx_match_cooldowns_until ON match_cooldowns (until);

-- ==================== RBAC ====================

CREATE TABLE roles (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  revocable BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE permissions (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL
);

CREATE TABLE role_permissions (
  role_key TEXT NOT NULL REFERENCES roles (key) ON DELETE RESTRICT,
  permission_key TEXT NOT NULL REFERENCES permissions (key) ON DELETE RESTRICT,
  PRIMARY KEY (role_key, permission_key)
);

CREATE TABLE user_roles (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  role_key TEXT NOT NULL REFERENCES roles (key) ON DELETE RESTRICT,
  granted_by UUID REFERENCES users (id) ON DELETE RESTRICT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_key)
);

-- Permissions accordées/révoquées directement à un utilisateur, en plus des
-- rôles (rbac.js Process, étapes 3-4) : nécessaires pour un RBAC réellement
-- granulaire par fonction et non par seul rôle fixe.
CREATE TABLE user_permission_grants (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  permission_key TEXT NOT NULL REFERENCES permissions (key) ON DELETE RESTRICT,
  granted_by UUID REFERENCES users (id) ON DELETE RESTRICT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission_key)
);

CREATE TABLE user_permission_revocations (
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  permission_key TEXT NOT NULL REFERENCES permissions (key) ON DELETE RESTRICT,
  revoked_by UUID REFERENCES users (id) ON DELETE RESTRICT,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, permission_key)
);

-- ==================== AUDIT / OWNERSHIP / BUS ====================

CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id TEXT NOT NULL, -- id utilisateur, ou 'system' / 'bot'
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  before JSONB NOT NULL DEFAULT '{}',
  after JSONB NOT NULL DEFAULT '{}',
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_hash TEXT
);
CREATE INDEX idx_audit_log_actor ON audit_log (actor_id);
CREATE INDEX idx_audit_log_action ON audit_log (action);
CREATE INDEX idx_audit_log_at ON audit_log (at);
CREATE INDEX idx_audit_log_before_gin ON audit_log USING GIN (before jsonb_path_ops);
CREATE INDEX idx_audit_log_after_gin ON audit_log USING GIN (after jsonb_path_ops);

CREATE TABLE ownership_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id TEXT NOT NULL REFERENCES guilds (id) ON DELETE RESTRICT,
  previous_owner_id TEXT,
  new_owner_id TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  source ownership_source NOT NULL
);
CREATE INDEX idx_ownership_events_guild ON ownership_events (guild_id, observed_at DESC);

CREATE TABLE outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel TEXT NOT NULL,
  payload JSONB NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consumed_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX idx_outbox_unconsumed ON outbox (consumed_at, published_at) WHERE consumed_at IS NULL;

-- pg_notify(channel, id) déclenché après commit, cf. bus/events.js.
CREATE OR REPLACE FUNCTION outbox_notify() RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify(NEW.channel, NEW.id::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outbox_notify_trigger
  AFTER INSERT ON outbox
  FOR EACH ROW
  EXECUTE FUNCTION outbox_notify();

-- ==================== SEED ====================

-- Well-known system actor for automated reports (reports.reporter_id is a
-- NOT NULL FK — audit_log's actor_id, by contrast, is plain TEXT and uses
-- the literal 'system'/'bot' directly, no FK, no seed row needed there).
INSERT INTO users (id, discord_id, username)
VALUES ('00000000-0000-0000-0000-000000000000', 'system', 'Xyro Market (système)')
ON CONFLICT (id) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('trial_duration_days', '7'),
  ('dispute_window_days', '14'),
  ('match_proposal_ttl_hours', '24'),
  ('verified_rules', '{"minTransactions": 3, "minAverage": 4, "minAccountAgeDays": 30, "noActiveSanction": true}');

INSERT INTO roles (key, label, revocable) VALUES
  ('proprietaire', 'Propriétaire', false),
  ('administrateur', 'Administrateur', true),
  ('moderateur', 'Modérateur', true),
  ('support', 'Support', true),
  ('gestionnaire', 'Gestionnaire', true);

INSERT INTO permissions (key, label) VALUES
  ('users.read', 'Consulter les utilisateurs'),
  ('users.ban', 'Bannir/suspendre un utilisateur'),
  ('users.manage_roles', 'Gérer les rôles RBAC des utilisateurs'),
  ('listings.read', 'Consulter les annonces'),
  ('listings.hide', 'Masquer/supprimer/restaurer une annonce'),
  ('listings.moderate', 'Valider/refuser/marquer vérifiée une annonce'),
  ('reports.read', 'Consulter les signalements'),
  ('reports.assign', 'Assigner/traiter un signalement'),
  ('moderation.sanction', 'Prononcer une sanction plateforme'),
  ('reviews.read', 'Consulter les avis'),
  ('reviews.delete', 'Supprimer un avis frauduleux'),
  ('reputation.manage_verified', 'Gérer le statut Vérifié'),
  ('rbac.read', 'Consulter les rôles et permissions'),
  ('rbac.grant', 'Accorder une permission ou un rôle'),
  ('transactions.read', 'Consulter les transactions'),
  ('transactions.resolve', 'Résoudre un litige/retour'),
  ('settings.read', 'Consulter la configuration site'),
  ('settings.write', 'Modifier la configuration site'),
  ('stats.read', 'Consulter les statistiques'),
  ('audit.read', 'Consulter le journal d''audit');

INSERT INTO role_permissions (role_key, permission_key)
  SELECT 'proprietaire', key FROM permissions
  UNION ALL
  SELECT 'administrateur', key FROM permissions
  UNION ALL
  SELECT 'moderateur', key FROM permissions
    WHERE key IN (
      'users.read', 'users.ban', 'listings.read', 'listings.hide', 'listings.moderate',
      'reports.read', 'reports.assign', 'moderation.sanction', 'reviews.read', 'reviews.delete'
    )
  UNION ALL
  SELECT 'support', key FROM permissions
    WHERE key IN ('users.read', 'reports.read', 'reports.assign', 'transactions.read')
  UNION ALL
  SELECT 'gestionnaire', key FROM permissions
    WHERE key IN ('listings.read', 'listings.moderate', 'settings.read', 'settings.write', 'stats.read');

-- Append-only : le rôle applicatif ne reçoit jamais UPDATE/DELETE sur
-- audit_log, y compris s'il possède par ailleurs le rôle 'proprietaire'
-- côté RBAC applicatif (RBAC plateforme et GRANT SQL sont deux couches
-- distinctes).
GRANT SELECT, INSERT ON audit_log TO xyro_app;
REVOKE UPDATE, DELETE ON audit_log FROM xyro_app;
REVOKE UPDATE, DELETE ON audit_log FROM PUBLIC;
