<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Accepted Compose subset for marketplace services

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
Ploydok never publishes a port on all host interfaces. A ports entry without
an IP is internal only (the first one can select the upstream when expose is
absent). An explicit 0.0.0.0 or :: is rejected. An IPv4 or IPv6 literal such
as 127.0.0.1 or ::1 is published on that address only, using Docker containers.
If any service port has an explicit IP, the whole marketplace service uses the
Docker runtime. Otherwise it uses the existing Swarm runtime. This runtime
choice is persisted in services.runtime_mode and is reused for creation,
resume, start, stop, delete and Caddy reconciliation.

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
The long port form accepts target, published, protocol and host_ip. host_ip
must be an IP literal. The short form accepts an IP prefix, including bracketed
IPv6. Docker receives only explicit-IP bindings, so an unbound ports entry
cannot widen into a host-wide publication. The agent keeps an empty host_ip
for legacy non-marketplace callers, while the marketplace API refuses wildcard
addresses before durable acceptance.
