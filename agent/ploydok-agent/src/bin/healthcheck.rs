// SPDX-License-Identifier: AGPL-3.0-only
//
// ploydok-healthcheck — exits 0 when the agent listener accepts connections.

fn main() -> anyhow::Result<()> {
    ploydok_agent::healthcheck::run()
}
