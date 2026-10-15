<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Marketplace network trust

Marketplace Swarm services join only the project overlay. Compose network overrides
are rejected. They do not join ploydok-public or another project network. Services
within a project intentionally trust each other; a project is the isolation boundary.

Caddy is trusted infrastructure with access to project upstream networks and its
ingress/control networks. Marketplace creation attaches it only when a public domain
exists. Startup reconciliation includes public marketplace services, including
projects without applications. Project deletion detaches the corresponding networks.
Attachments retained during stop/restart preserve ingress continuity; they are not
evidence of cross-project workload connectivity.

The proxy, API, agent and Docker host remain privileged trust boundaries. Overlay
separation does not protect against their compromise or a host administrator. Legacy
containers already deployed on shared networks require an operator-controlled
redeployment; this change does not mutate live infrastructure. A live two-project
connectivity and ingress drill remains necessary to verify deployed topology.
