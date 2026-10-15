// The guest is NOT rebuilt by default: program/elf/piecework-program is committed and is what the host
// embeds. Rebuilding it here would mean each machine's toolchain decided the verification key, which is the
// job's identity on chain, and two machines produced two different keys.
//
// REBUILD_GUEST=1 regenerates it. Do that deliberately, commit the new ELF, read the new key with --vkey,
// and update every catalogue entry that names it.
fn main() {
    println!("cargo:rerun-if-env-changed=REBUILD_GUEST");
    if std::env::var("REBUILD_GUEST").is_ok() {
        sp1_build::build_program_with_args("../program", Default::default());
        println!("cargo:warning=guest rebuilt — copy it into program/elf/ and re-read --vkey");
    }
}
