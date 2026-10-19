-- migrations/0002_auth.sql
-- Introduce a unified users table with role-based auth, replacing the split
-- organizers/buyers design from 0001. Since 0001 was applied on a fresh
-- project with no production data, we migrate rows by id-preserving copy and
-- then drop the old tables. After this migration there is one table to look
-- up by JWT `sub`, which eliminates a whole class of "which table does this
-- id belong to?" bugs.

CREATE TYPE user_role AS ENUM ('organizer', 'attendee', 'staff');

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL UNIQUE,
  -- Argon2id encoded hash. The placeholder '!' for migrated rows means "no
  -- password set" — login for those rows is impossible until the owner
  -- re-registers. Password verification treats any malformed hash as a
  -- non-match (see auth/password.ts), never as a 500.
  password_hash text NOT NULL CHECK (length(password_hash) >= 1),
  role          user_role NOT NULL,
  display_name  text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  phone         text CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{6,14}$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_role_idx ON users (role);
CREATE TRIGGER users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Id-preserving copy so existing events.organizer_id / orders.buyer_id
-- references remain valid after the column is repointed below.
INSERT INTO users (id, email, password_hash, role, display_name, phone, created_at, updated_at)
SELECT id, email, '!', 'organizer', display_name, NULL, created_at, updated_at
FROM organizers;

INSERT INTO users (id, email, password_hash, role, display_name, phone, created_at, updated_at)
SELECT id, email, '!', 'attendee', split_part(email::text, '@', 1), phone, created_at, updated_at
FROM buyers;

-- Repoint events → users. Constraint name `events_organizer_id_fkey` is what
-- Postgres auto-generated in 0001 for the column-then-target naming rule.
ALTER TABLE events DROP CONSTRAINT events_organizer_id_fkey;
ALTER TABLE events RENAME COLUMN organizer_id TO organizer_user_id;
ALTER TABLE events ADD CONSTRAINT events_organizer_user_id_fkey
  FOREIGN KEY (organizer_user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER INDEX events_organizer_idx RENAME TO events_organizer_user_idx;

-- Repoint orders → users.
ALTER TABLE orders DROP CONSTRAINT orders_buyer_id_fkey;
ALTER TABLE orders RENAME COLUMN buyer_id TO buyer_user_id;
ALTER TABLE orders ADD CONSTRAINT orders_buyer_user_id_fkey
  FOREIGN KEY (buyer_user_id) REFERENCES users(id) ON DELETE RESTRICT;
ALTER INDEX orders_buyer_idx RENAME TO orders_buyer_user_idx;

-- Old profile tables are now dead weight; drop them so no code can silently
-- keep reading from a stale source of truth.
DROP TABLE organizers;
DROP TABLE buyers;