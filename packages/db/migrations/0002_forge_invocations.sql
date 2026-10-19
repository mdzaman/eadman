-- DocOps 0002: calls from the Jira Forge app (Forge Invocation Tokens; docs/06 §3, docs/08 T04).
-- Expand only: the previous release keeps working against this schema (docs/03 §6).

-- The tracker_app role: what the Jira app's per-installation service account may do (docs/08 §3).
-- Roles are a CHECK constraint on role_bindings, so the constraint is replaced.
ALTER TABLE role_bindings DROP CONSTRAINT role_bindings_role_check;
ALTER TABLE role_bindings ADD CONSTRAINT role_bindings_role_check
  CHECK (role IN ('org_owner', 'org_admin', 'space_admin', 'maintainer', 'editor', 'commenter',
                  'viewer', 'auditor', 'billing_admin', 'ci_publisher', 'tracker_app'));

-- [P] IDs (jti) of accepted signed tokens, kept until the token expires, so that a token is accepted
-- once across every API replica (the FIT replay cache). No tenant and no content.
CREATE TABLE token_replay_cache (
  issuer      text NOT NULL,
  token_id    text NOT NULL,
  expires_at  timestamptz NOT NULL,
  PRIMARY KEY (issuer, token_id)
);
CREATE INDEX token_replay_cache_expiry_idx ON token_replay_cache (expires_at);

GRANT SELECT, INSERT, DELETE ON token_replay_cache TO docops_app;
