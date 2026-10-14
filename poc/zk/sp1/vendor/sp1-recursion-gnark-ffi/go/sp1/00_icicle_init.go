//go:build icicle

package sp1

import "os"

// This file is named "00_icicle_init.go" to ensure it initializes before other files in this package.
// Go initializes package-level variables in lexical file name order, so this runs before prove.go's
// groth16.NewProvingKey() which triggers ICICLE backend loading.
//
// We set ICICLE_BACKEND_INSTALL_DIR here so users don't need to set it manually.
var _ = func() struct{} {
	if os.Getenv("ICICLE_BACKEND_INSTALL_DIR") == "" {
		os.Setenv("ICICLE_BACKEND_INSTALL_DIR", "/usr/local/lib/backend")
	}
	return struct{}{}
}()
