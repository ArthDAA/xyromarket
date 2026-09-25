-- Bouton "Kick" du panel admin : déconnecte un compte de toutes ses sessions
-- (il peut se reconnecter). Accordé aux mêmes rôles que `users.ban`.
INSERT INTO permissions (key, label) VALUES
  ('users.kick', 'Expulser un utilisateur (déconnexion forcée)')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_key, permission_key)
  SELECT role_key, 'users.kick' FROM role_permissions WHERE permission_key = 'users.ban'
ON CONFLICT DO NOTHING;
