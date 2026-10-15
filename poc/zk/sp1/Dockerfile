# Building and proving happen in here because the host kills freshly built binaries that have a build.rs.
FROM rust:1.90-bookworm
# libclang-dev is for bindgen, which the native-gnark feature pulls in to generate the Rust bindings for
# the Go static library. Its absence shows up as a bindgen panic about libclang, well after the Go library
# has built successfully, so it reads like a gnark problem and is not one.
RUN apt-get update && apt-get install -y --no-install-recommends curl git ca-certificates build-essential pkg-config libssl-dev protobuf-compiler libprotobuf-dev libclang-dev \
 && rm -rf /var/lib/apt/lists/*
# SP1's Groth16 wrapper is gnark, which is Go: without a Go toolchain the sp1-recursion-gnark-ffi build script
# fails with a bare "No such file or directory" that says nothing about Go.
# 1.24 or newer: sp1-recursion-gnark-ffi's Go module declares `go 1.24.0`, and an older toolchain refuses
# it outright. 1.23.4 built nothing and reported only that the module needed a newer Go.
ENV GO_VERSION=1.24.8
RUN ARCH=$(dpkg --print-architecture) && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" | tar -C /usr/local -xz
ENV PATH="/usr/local/go/bin:${PATH}"
# Without an explicit proxy, resolving gnark's pseudo-versioned dependency falls back to git ls-remote,
# which prompts for GitHub credentials in a container and fails as "could not read Username" — an error
# that says nothing about Go modules.
ENV GOPROXY=https://proxy.golang.org,direct GOSUMDB=sum.golang.org GOFLAGS=-mod=mod
# Pinned. Unpinned, sp1up installs whatever toolchain is current, and a different toolchain compiles a
# different guest ELF — which is a different verification key, which is a different job as far as the chain
# is concerned. Two machines building the same commit a week apart produced 0x006ea169… and 0x00b7d5ba…,
# and a proof made under one key is rejected under the other in a way indistinguishable from forgery.
#
# The committed ELF in program/elf/ is what the host actually embeds, so this pin only matters when
# regenerating the guest. Belt and braces, deliberately: the failure it prevents is silent.
# v6.9.0, matching the sp1-sdk version the host depends on. No `|| sp1up` fallback: a pin that silently
# falls back to unpinned reads as pinned and is not, which is worse than leaving it off.
ARG SP1_VERSION=v6.9.0
RUN curl -L https://sp1up.succinct.xyz | bash && /root/.sp1/bin/sp1up --version "${SP1_VERSION}"
ENV PATH="/root/.sp1/bin:${PATH}"
WORKDIR /work
