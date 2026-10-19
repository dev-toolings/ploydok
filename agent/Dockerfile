FROM rust:1.88-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config \
        libssl-dev \
        protobuf-compiler \
        ca-certificates \
        git \
    && rm -rf /var/lib/apt/lists/*

RUN cargo install cargo-watch --locked

WORKDIR /workspace

ENV CARGO_TARGET_DIR=/workspace/target \
    CARGO_HOME=/usr/local/cargo \
    RUST_LOG=info \
    PLOYDOK_AGENT_SOCKET=/run/ploydok/agent.sock \
    PLOYDOK_AGENT_INSECURE=1 \
    PLOYDOK_VALIDATOR_CONFIG=/workspace/config/dev-validator.toml

# Builds every package binary (agent + ploydok-healthcheck) before running.
CMD ["cargo", "watch", "--why", "-w", "ploydok-agent/src", "-w", "crates", "-x", "build --release -p ploydok-agent --bins", "-x", "run --release -p ploydok-agent"]
