# Building and proving happen in here because the host kills freshly built binaries that have a build.rs.
FROM rust:1.90-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends curl git ca-certificates build-essential pkg-config libssl-dev protobuf-compiler libprotobuf-dev \
 && rm -rf /var/lib/apt/lists/*
# SP1's Groth16 wrapper is gnark, which is Go: without a Go toolchain the sp1-recursion-gnark-ffi build script
# fails with a bare "No such file or directory" that says nothing about Go.
ENV GO_VERSION=1.23.4
RUN ARCH=$(dpkg --print-architecture) && curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${ARCH}.tar.gz" | tar -C /usr/local -xz
ENV PATH="/usr/local/go/bin:${PATH}"
# Without an explicit proxy, resolving gnark's pseudo-versioned dependency falls back to git ls-remote,
# which prompts for GitHub credentials in a container and fails as "could not read Username" — an error
# that says nothing about Go modules.
ENV GOPROXY=https://proxy.golang.org,direct GOSUMDB=sum.golang.org GOFLAGS=-mod=mod
RUN curl -L https://sp1up.succinct.xyz | bash && /root/.sp1/bin/sp1up
ENV PATH="/root/.sp1/bin:${PATH}"
WORKDIR /work
