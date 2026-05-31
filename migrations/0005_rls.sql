-- ════════════════════════════════════════════════════════════════
-- 0005 — Row-Level Security (§7.2)
--
-- Defence-in-depth backstop to the repository-layer tenant predicate. The app
-- connects as the non-owner role `flow_app`, so these policies apply. The
-- control plane sets app.bypass=on for trusted cross-tenant reads (and still
-- filters by tenant_id in SQL). Owner (migrations) bypasses RLS by default.
--
-- current_setting(..., true) returns NULL when unset → default-deny.
-- ════════════════════════════════════════════════════════════════
DO $$
DECLARE
    t TEXT;
    tenant_tables TEXT[] := ARRAY[
        'tenants','users','tenant_keys','refresh_families',
        'workflows','workflow_versions','triggers',
        'runs','run_events','node_attempts',
        'secrets','connector_configs','audit_log'
    ];
    -- `tenants` keys on id, everything else on tenant_id
    col TEXT;
BEGIN
    FOREACH t IN ARRAY tenant_tables LOOP
        col := CASE WHEN t = 'tenants' THEN 'id' ELSE 'tenant_id' END;
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        -- NULLIF is critical: after any SET LOCAL app.tenant_id in this
        -- session, an UNSET read returns '' (custom GUCs default to '') and
        -- ''::uuid raises 22P02. NULLIF maps '' -> NULL so the cast is safe.
        EXECUTE format($f$
            CREATE POLICY tenant_isolation ON %I
            USING (
                current_setting('app.bypass', true) = 'on'
                OR %I = NULLIF(current_setting('app.tenant_id', true), '')::uuid
            )
            WITH CHECK (
                current_setting('app.bypass', true) = 'on'
                OR %I = NULLIF(current_setting('app.tenant_id', true), '')::uuid
            )
        $f$, t, col, col);
    END LOOP;
END $$;

-- Grants: the app role needs DML on every table + sequence. Default privileges
-- (set at role creation) cover future objects, but issue explicit grants now so
-- this works even when ALTER DEFAULT PRIVILEGES wasn't pre-seeded (e.g. tests).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flow_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO flow_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO flow_app;
    END IF;
END $$;
