-- Runs once on first container start (docker-entrypoint-initdb.d).
--
-- The app MUST connect as a non-superuser, non-owner role, otherwise
-- Postgres silently bypasses Row-Level Security (§7.2). Migrations run as
-- the owner `flow`; the running services connect as `flow_app`.
CREATE ROLE flow_app WITH LOGIN PASSWORD 'flow_app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- Let the app role use the schema. Table-level grants are issued by the
-- migration runner after each table is created (see migrate.ts).
GRANT CONNECT ON DATABASE flow TO flow_app;
GRANT USAGE ON SCHEMA public TO flow_app;

-- Default privileges so tables/sequences created later by `flow` are usable
-- by `flow_app` without a manual GRANT per object.
ALTER DEFAULT PRIVILEGES FOR ROLE flow IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flow_app;
ALTER DEFAULT PRIVILEGES FOR ROLE flow IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO flow_app;
