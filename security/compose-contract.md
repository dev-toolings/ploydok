<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Accepted Compose subset for Swarm

The executable contract is ACCEPTED_COMPOSE_SUBSET in
apps/api/src/marketplace/compose-to-containers.ts. Validation precedes service,
saga, network or Docker creation for marketplace installs. This is deliberately
a subset; full Compose requires a separate native-engine decision.

Accepted root fields: services, volumes (empty local declarations), version
(metadata). x-* extension metadata is accepted. Service fields: image,
environment (explicit map or KEY=value list), labels, user, command, volumes,
healthcheck and expose. User is sent unchanged as a string through the existing
agent field. Commands accept string lists or shell-like quoting/escaping without
shell expansion; explicit empty overrides are rejected because the agent cannot
distinguish clearing a command from inheriting the image command.

expose declares internal TCP ports; the first selects the Caddy ingress upstream.
Marketplace services are never published on the host: ingress goes through
Caddy. ports entries without an address are therefore kept as internal ports
only (the first one can select the upstream when expose is absent); this is a
documented rule of the product, not a silent loss. An address-specific binding
(127.0.0.1:8080:80, host_ip) is refused, so a restriction is never widened.

restart: Swarm restarts a task on any exit. always and unless-stopped keep that
meaning and are accepted; no and on-failure would change it and are refused.
depends_on keeps creation order only (list form, or condition service_started);
service_healthy and service_completed_successfully cannot be awaited and are
refused before any resource exists.
Unknown service/root/nested fields are rejected (including resource limits,
entrypoint, external network/volume definitions, build, secrets and configs).
Healthcheck supports test, interval, timeout, retries, start_period with whole
seconds. Volumes retain the existing local storage mapping under
/var/lib/ploydok/volumes; options beyond source/target/type/read_only or ro/rw
are refused. Existing templates using rejected fields need explicit adaptation.
Legacy Docker parsing retains its documented ports/restart/dependency support;
address-specific ports and readiness conditions are refused there too.
