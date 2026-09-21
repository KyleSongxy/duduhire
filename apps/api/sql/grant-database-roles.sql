\set ON_ERROR_STOP on

\if :{?database_name}
\else
  \echo 'database_name is required'
  \quit 3
\endif
\if :{?runtime_role}
\else
  \echo 'runtime_role is required'
  \quit 3
\endif
\if :{?maintenance_role}
\else
  \echo 'maintenance_role is required'
  \quit 3
\endif

SELECT :'database_name' = current_database() AS database_name_matches \gset
\if :database_name_matches
\else
  \echo 'database_name does not match the current connection'
  \quit 4
\endif

BEGIN;

REVOKE CONNECT, TEMPORARY ON DATABASE :"database_name" FROM PUBLIC;
REVOKE TEMPORARY ON DATABASE :"database_name" FROM :"runtime_role", :"maintenance_role";
GRANT CONNECT ON DATABASE :"database_name" TO :"runtime_role", :"maintenance_role";
GRANT USAGE ON SCHEMA public TO :"runtime_role", :"maintenance_role";
REVOKE CREATE ON SCHEMA public FROM PUBLIC, :"runtime_role", :"maintenance_role";

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM :"runtime_role", :"maintenance_role";
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM :"runtime_role", :"maintenance_role";
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM :"runtime_role", :"maintenance_role";
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

GRANT SELECT
  ON TABLE users, email_challenges, phone_challenges, sessions, profiles,
           intake_drafts, discovery_threads, discovery_artifacts
  TO :"runtime_role";
GRANT INSERT
  ON TABLE users, email_challenges, phone_challenges, sessions, profiles,
           intake_drafts, discovery_threads, discovery_artifacts
  TO :"runtime_role";
GRANT UPDATE (email_verified_at, phone_verified_at, updated_at) ON TABLE users TO :"runtime_role";
GRANT UPDATE (consumed_at) ON TABLE email_challenges TO :"runtime_role";
GRANT UPDATE (code_hash, sent_at, invalidated_at, consumed_at, verification_attempts,
              verification_lease_id, verification_lease_expires_at)
  ON TABLE phone_challenges TO :"runtime_role";
GRANT UPDATE (revoked_at, active_role, password_setup_expires_at) ON TABLE sessions TO :"runtime_role";
GRANT SELECT, INSERT ON TABLE user_passwords, password_login_limits TO :"runtime_role";
GRANT UPDATE (password_hash, updated_at) ON TABLE user_passwords TO :"runtime_role";
GRANT UPDATE (window_start, attempts) ON TABLE password_login_limits TO :"runtime_role";
GRANT UPDATE (display_name, country_code, contact, organization, job_title,
              professional_title, bio, version, updated_at)
  ON TABLE profiles TO :"runtime_role";
GRANT UPDATE (invalidated_at, claimed_by_user_id, claimed_at)
  ON TABLE intake_drafts TO :"runtime_role";
GRANT UPDATE (status, version, updated_at)
  ON TABLE discovery_threads TO :"runtime_role";
GRANT UPDATE (draft, version, updated_at)
  ON TABLE discovery_artifacts TO :"runtime_role";
GRANT SELECT, INSERT
  ON TABLE discovery_turns
  TO :"runtime_role";
GRANT SELECT, INSERT ON TABLE matching_listings TO :"runtime_role";
GRANT SELECT ON TABLE matching_examples TO :"runtime_role";
GRANT UPDATE (source_thread_id, source_thread_version, source_artifact_version,
              status, version, title, summary, skills, required_skills,
              work_mode, engagement, location, notes, constraints, consented_at, updated_at)
  ON TABLE matching_listings TO :"runtime_role";
GRANT INSERT ON TABLE enterprise_inquiries TO :"runtime_role";
GRANT SELECT (id, contact_method, source, status, consented_at, created_at)
  ON TABLE enterprise_inquiries TO :"runtime_role";
GRANT INSERT ON TABLE outbox_events TO :"runtime_role";
GRANT SELECT ON TABLE schema_migrations TO :"runtime_role";
GRANT SELECT ON public.enterprise_inquiry_admin_list TO :"runtime_role";
GRANT EXECUTE ON FUNCTION public.admin_update_inquiry_status(uuid, uuid, uuid, text, integer),
  public.admin_reveal_inquiry_contact(uuid, uuid, uuid, text) TO :"runtime_role";

GRANT EXECUTE
  ON FUNCTION public.run_data_retention_cleanup()
  TO :"maintenance_role";

\if :{?notification_role}
REVOKE TEMPORARY ON DATABASE :"database_name" FROM :"notification_role";
GRANT CONNECT ON DATABASE :"database_name" TO :"notification_role";
GRANT USAGE ON SCHEMA public TO :"notification_role";
REVOKE CREATE ON SCHEMA public FROM :"notification_role";
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM :"notification_role";
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM :"notification_role";
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM :"notification_role";
GRANT EXECUTE ON FUNCTION public.claim_inquiry_notification(uuid),
  public.finish_inquiry_notification(uuid, uuid, boolean) TO :"notification_role";
\endif

COMMIT;
