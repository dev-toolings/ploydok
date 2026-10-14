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
Swarm published ports are not carried by the existing agent contract, so ports
is rejected, including host_ip and address-specific short forms. Replace ports
with expose only when internal access/Caddy is actually the intended behavior.
No requested publication is silently widened or silently discarded.

restart and depends_on are rejected in Swarm: its fixed restart policy and
asynchronous scheduling cannot preserve Compose startup/readiness semantics.
Unknown service/root/nested fields are rejected (including resource limits,
entrypoint, external network/volume definitions, build, secrets and configs).
Healthcheck supports test, interval, timeout, retries, start_period with whole
seconds. Volumes retain the existing local storage mapping under
/var/lib/ploydok/volumes; options beyond source/target/type/read_only or ro/rw
are refused. Existing templates using rejected fields need explicit adaptation.
Legacy Docker parsing retains its documented ports/restart/list-dependency
support; address-specific ports and readiness conditions are still refused.
