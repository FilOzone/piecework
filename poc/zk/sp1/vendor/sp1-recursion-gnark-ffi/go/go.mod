module github.com/succinctlabs/sp1-recursion-gnark

go 1.24.0

require (
	github.com/consensys/gnark v0.14.0
	github.com/consensys/gnark-crypto v0.19.3-0.20251115174214-022ec58e8c19
)

require github.com/ingonyama-zk/icicle-gnark/v3 v3.2.2 // indirect

require (
	github.com/bits-and-blooms/bitset v1.24.0 // indirect
	github.com/blang/semver/v4 v4.0.0 // indirect
	github.com/consensys/gnark-ignition-verifier v0.0.0-20230527014722-10693546ab33
	github.com/davecgh/go-spew v1.1.1 // indirect
	github.com/fxamacker/cbor/v2 v2.9.0 // indirect
	github.com/google/pprof v0.0.0-20250820193118-f64d9cf942d6 // indirect
	github.com/mattn/go-colorable v0.1.14 // indirect
	github.com/mattn/go-isatty v0.0.20 // indirect
	github.com/pmezard/go-difflib v1.0.0 // indirect
	github.com/ronanh/intcomp v1.1.1 // indirect
	github.com/rs/zerolog v1.34.0 // indirect
	github.com/stretchr/testify v1.11.1 // indirect
	github.com/x448/float16 v0.8.4 // indirect
	golang.org/x/crypto v0.45.0 // indirect
	golang.org/x/sync v0.16.0 // indirect
	golang.org/x/sys v0.38.0 // indirect
	gopkg.in/yaml.v3 v3.0.1 // indirect
)

replace github.com/consensys/gnark => github.com/p4u/gnark v0.0.0-20251217225531-cd7874155e26

// github.com/consensys/gnark-ignition-verifier was deleted from GitHub: the repo 404s and the Go proxy
// has no cached copy of the pseudo-version above, so resolving it falls back to git and fails. Nothing
// about Groth16 needs it — it is only reached on the PLONK branch of build.go, for the Aztec Ignition
// SRS — but Go still has to resolve the import to compile the package.
//
// polytope-labs/gnark-ignition-verifier is a mirror whose HEAD is commit 10693546ab33a54bff6d02cebb46
// fba538559748 at 2023-05-27T01:47:22Z, which is exactly the commit and timestamp the pseudo-version
// names. So this is the same code, not a divergent fork, and it keeps the module path unchanged.
replace github.com/consensys/gnark-ignition-verifier => github.com/polytope-labs/gnark-ignition-verifier v0.0.0-20230527014722-10693546ab33
