//! The host: runs the guest, and either just executes it or produces a proof.
//!
//!   cargo run --release -- --execute --term sealing <files...>
//!   cargo run --release -- --prove   --term sealing <files...>
//!
//! Execute is the cheap one: no proof, but it reports the cycle count, which is what decides whether proving
//! the thing is affordable at all.
use clap::Parser;
use sp1_sdk::{prover::{ProveRequest, ProvingKey}, HashableKey, Prover, ProverClient, SP1Stdin};
use std::{fs, path::PathBuf};

// The guest, as bytes, committed to the repository rather than rebuilt here.
//
// The verification key is a hash of this ELF, and it is the job's identity on chain: a client orders a
// proved job by naming it, and the chain checks the proof against it. So it has to be the same number for
// everyone. It was not. Building the guest from source on two machines produced two different keys —
// 0x006ea169… here and 0x00b7d5ba… on a provider's box — because `sp1up` installs whatever toolchain is
// current, and a different toolchain compiles a different ELF.
//
// That quietly undid the thing the proved path is for. A catalogue job's digest is keccak256 of its name, a
// label the provider can change what runs behind; the proved job's digest was supposed to be the code
// itself. It only is if everyone can agree what the code compiles to, and they could not.
//
// So the artifact ships, not the recipe — the same reasoning as a client handing a provider its program as
// a piece rather than a repository to build from. Regenerate with REBUILD_GUEST=1 and commit the result;
// the vkey changes when it does, and every catalogue entry naming it has to change too.
pub const ELF: sp1_sdk::Elf = sp1_sdk::Elf::Static(include_bytes!("../../../program/elf/piecework-program"));

// The attested guest: the same job with a flat sha256 over the inputs instead of their piece CIDs. A
// separate program, so a separate key and a separate catalogue entry — the two make different claims and
// a client picks between them by naming a different verifier when it posts the job.
pub const ELF_FLAT: sp1_sdk::Elf =
    sp1_sdk::Elf::Static(include_bytes!("../../../program-flat/elf/piecework-program-flat"));

#[derive(Parser)]
struct Cli {
    #[arg(long)] execute: bool,
    #[arg(long)] prove: bool,
    /// Print the verification key and stop. The client has to know this before it orders — it goes on
    /// chain as the job's imageDigest, and SP1ComputeVerifier uses it as the key the proof is checked
    /// against. Change the guest and it changes, after which nothing verifies, so a catalogue entry for a
    /// proved job should carry a value read from here rather than copied out of a log.
    #[arg(long)] vkey: bool,
    /// Groth16 is the only mode a contract can check, and the only one that needs a wrapping step large
    /// enough to run a laptop out of memory. core proves the same execution and is for showing the pipeline
    /// works when the machine cannot hold the wrap.
    #[arg(long, default_value = "groth16")] mode: String,
    /// Which guest: `bound` derives the pieces' Filecoin CIDs and the chain checks them against PDP;
    /// `attested` hashes the inputs flat, which is eight times cheaper to prove and binds to nothing the
    /// chain can verify. Different programs, so different verification keys — read each with --vkey.
    #[arg(long, default_value = "bound")] guest: String,
    #[arg(long, default_value = "sealing")] term: String,
    /// Where to write the job's output. The provider stores whatever lands here as a piece, and the
    /// contract checks keccak(cid(that piece)) against the outputCommitment in the journal — so these
    /// bytes have to be the ones the guest hashed, not a re-derivation that happens to look the same.
    /// Both come from piecework_lib::report, which is why they cannot drift.
    #[arg(long)] out: Option<PathBuf>,
    /// Where to write the proof. Per-job rather than the working directory, so two jobs proving at once
    /// cannot overwrite each other's artifact — ten minutes of work each.
    #[arg(long, default_value = "proof.json")] proof: PathBuf,
    /// The pieces, in the order the client listed them. Order is part of the commitment.
    inputs: Vec<PathBuf>,
}

fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    sp1_sdk::utils::setup_logger();
    let cli = Cli::parse();
    if !cli.vkey && cli.execute == cli.prove {
        anyhow::bail!("pass exactly one of --execute, --prove or --vkey");
    }
    // Named rather than numbered, and rejected rather than defaulted: silently proving the wrong guest
    // produces a valid proof under a key no catalogue entry names, which is indistinguishable from forgery
    // at the point it is refused.
    let elf = match cli.guest.as_str() {
        "bound" => ELF,
        "attested" => ELF_FLAT,
        other => anyhow::bail!("--guest must be `bound` or `attested`, not `{other}`"),
    };
    if cli.vkey {
        let client = ProverClient::from_env().await;
        println!("{}", client.setup(elf).await?.verifying_key().bytes32());
        return Ok(());
    }

    let mut stdin = SP1Stdin::new();
    stdin.write(&(cli.inputs.len() as u32));
    stdin.write_vec(cli.term.as_bytes().to_vec());
    let mut total = 0usize;
    let mut occurrences = 0u64;
    for p in &cli.inputs {
        let b = fs::read(p)?;
        total += b.len();
        occurrences += piecework_lib::count_occurrences(&b, cli.term.as_bytes());
        stdin.write_vec(b);
    }
    println!("{} piece(s), {total} bytes, term {:?}", cli.inputs.len(), cli.term);

    // Written before proving rather than after, so a run that dies in the wrap still leaves the provider
    // the outputs it could deliver. Delivery without a proof earns nothing, but it is recoverable: the
    // proof can be retried against pieces already on chain, where re-running the job would change nothing
    // and cost another ten minutes.
    if let Some(dir) = &cli.out {
        fs::create_dir_all(dir)?;
        let body = piecework_lib::report(&cli.term, occurrences, cli.inputs.len());
        let path = dir.join("term-count.txt");
        fs::write(&path, &body)?;
        println!("wrote {} ({} bytes)", path.display(), body.len());
    }

    // from_env is async in v6: it may reach for a network prover before deciding to run locally.
    let client = ProverClient::from_env().await;
    if cli.execute {
        let (public_values, report) = client.execute(elf, stdin.clone()).await?;
        let pv = public_values.as_slice();
        println!("cycles            : {}", report.total_instruction_count());
        println!("inputCommitment   : 0x{}", hex(&pv[..32]));
        println!("outputCommitment  : 0x{}", hex(&pv[32..64]));
        // Deriving the piece CID is a sha256 merkle tree, so nearly every cycle here is hashing. That
        // only costs what it should if sha2 resolves from sp1-patches and the compressions become
        // SHA_EXTEND/SHA_COMPRESS syscalls. Zero of those means the tree is running in software, and
        // the cycle count is an artefact of the build rather than the price of the binding.
        let mut calls: Vec<_> = report.syscall_counts.iter().filter(|(_, n)| **n > 0).collect();
        calls.sort_by_key(|(_, n)| std::cmp::Reverse(**n));
        println!("syscalls          : {}", if calls.is_empty() { "none".into() } else {
            calls.iter().map(|(s, n)| format!("{s:?}={n}")).collect::<Vec<_>>().join(" ")
        });
        return Ok(());
    }

    // setup yields the proving key; the verifying key hangs off it, and its bytes32 is what goes on
    // chain as the job's imageDigest.
    let pk = client.setup(elf).await?;
    let proof = match cli.mode.as_str() {
        "core" => client.prove(&pk, stdin).core().await?,
        "compressed" => client.prove(&pk, stdin).compressed().await?,
        _ => client.prove(&pk, stdin).groth16().await?,
    };
    let pv = proof.public_values.to_vec();
    println!("vkey              : {}", pk.verifying_key().bytes32());
    println!("publicValues      : 0x{}", hex(&pv));
    println!("proofBytes        : 0x{}", hex(&proof.bytes()));
    if let Some(d) = cli.proof.parent() { if !d.as_os_str().is_empty() { fs::create_dir_all(d)?; } }
    fs::write(&cli.proof, serde_json::to_string_pretty(&serde_json::json!({
        "vkey": pk.verifying_key().bytes32(),
        "publicValues": format!("0x{}", hex(&pv)),
        "proofBytes": format!("0x{}", hex(&proof.bytes())),
    }))?)?;
    println!("wrote {}", cli.proof.display());
    Ok(())
}
