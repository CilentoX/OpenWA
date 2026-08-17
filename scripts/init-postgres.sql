-- OpenWA PostgreSQL Auto-Initialization Script
-- Ensures database and user privileges exist on container startup

SELECT 'CREATE DATABASE openwa'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'openwa')\gexec

GRANT ALL PRIVILEGES ON DATABASE openwa TO CURRENT_USER;
