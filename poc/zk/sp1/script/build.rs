// The guests are NOT rebuilt by default: program/elf/ and program-flat/elf/ are committed and are what the
// host embeds. Rebuilding here would mean each machine's toolchain decided the verification key, which is
// the job's identity on chain, and two machines produced two different keys.
//
// REBUILD_GUEST=1 regenerates both. Do that deliberately, commit the new ELFs, read the new keys with
// --vkey (once per --guest), and update every catalogue entry that names them. Both are rebuilt together
// even when only one changed, because they share piecework-lib and a stale pair is the harder bug: the
// catalogue would be right about one job and wrong about the other.
fn main() {
    println!("cargo:rerun-if-env-changed=REBUILD_GUEST");
    if std::env::var("REBUILD_GUEST").is_ok() {
        sp1_build::build_program_with_args("../program", Default::default());
        sp1_build::build_program_with_args("../program-flat", Default::default());
        println!("cargo:warning=guests rebuilt — copy both into */elf/ and re-read --vkey for each");
    }
}
