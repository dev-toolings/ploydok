ALTER TABLE resource_creation_sagas DROP CONSTRAINT IF EXISTS resource_creation_sagas_resource_type_check;
--> statement-breakpoint
ALTER TABLE resource_creation_sagas ADD CONSTRAINT resource_creation_sagas_resource_type_check CHECK (resource_type IN ('application', 'database', 'service'));
