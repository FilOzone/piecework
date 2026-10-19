// The guests are NOT rebuilt by default: program/elf/ and program-flat/elf/ are committed and are what the
// host embeds. Rebuilding here would mean each machine's toolchain decided the verification key, which is
// the job's identity on chain.
//
// REBUILD_GUEST=1 regenerates both. Do that deliberately, commit the new ELFs, read the new keys with
// --vkey (once per --guest), and update every catalogue entry that names them. Both are rebuilt together
// even when only one changed, because they share piecework-lib and a stale pair is the harder bug: the
// catalogue would be right about one job and wrong about the other.
//
// --remap-path-prefix is what makes the output the same on two machines, and its absence was a real fault
// rather than a precaution. A guest ELF embeds the paths of its own sources, for panic messages: without
// remapping, this repository at /work and the same repository somewhere else compile to different bytes,
// and therefore to different verification keys. A provider rebuilding the same commit got ELFs 32 and 40
// bytes smaller than the committed ones -- exactly the difference in path length -- which is
// indistinguishable at a glance from having built the wrong source.
//
// Two prefixes have to go: this repository, and the cargo registry the dependencies are unpacked into.
// Both are absolute and neither is the same on any two machines.
use std::{env, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=REBUILD_GUEST");
    if env::var("REBUILD_GUEST").is_err() {
        return;
    }

    // .../zk/sp1/script -> the directory holding zk/, which is the root of everything the guests compile.
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let repo = manifest
        .ancestors()
        .nth(3)
        .expect("script crate should be three levels below the repository root")
        .to_path_buf();
    // The guest must be built with this repository mounted at exactly /work, and the build stops if it is
    // not. That is not fussiness: three builds at /work are byte-identical, and the same source built at
    // another path is not, even with every visible path remapped away. Cargo's per-crate metadata hash
    // incorporates the path of a path dependency -- piecework-lib is one -- and that hash reaches the
    // mangled symbol names, so the ELF differs without a single differing path string to show for it.
    //
    // A provider hit exactly this: same commit, same toolchain, ELFs 32 and 40 bytes from ours and two
    // verification keys that matched nothing. Silent and indistinguishable from having built the wrong
    // source. Refusing to build is the only honest response until the build is genuinely path independent.
    if repo != PathBuf::from("/work") {
        panic!(
            "the guest must be built with the repository mounted at /work, not {}.\n\n  \
             docker run --rm -v \"$PWD:/work\" -v piecework-cargo:/usr/local/cargo/registry \\\n    \
             -w /work/zk/sp1 piecework/sp1:v6 sh -c 'REBUILD_GUEST=1 cargo build --release'\n\n\
             Building elsewhere produces a different ELF, a different verification key, and proofs that \
             nothing on chain accepts.",
            repo.display()
        );
    }

    let cargo_home = env::var("CARGO_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(env::var("HOME").unwrap_or_default()).join(".cargo"));

    let args = sp1_build::BuildArgs {
        rustflags: vec![
            format!("--remap-path-prefix={}=/piecework", repo.display()),
            format!("--remap-path-prefix={}=/cargo", cargo_home.display()),
        ],
        ..Default::default()
    };
    println!("cargo:warning=remapping {} and {}", repo.display(), cargo_home.display());
    sp1_build::build_program_with_args("../program", args.clone());
    sp1_build::build_program_with_args("../program-flat", args);
    println!("cargo:warning=guests rebuilt — copy both into */elf/ and re-read --vkey for each");
}
