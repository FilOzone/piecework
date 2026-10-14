//! The host: runs the guest, and either just executes it or produces a proof.
//!
//!   cargo run --release -- --execute --term sealing <files...>
//!   cargo run --release -- --prove   --term sealing <files...>
//!
//! Execute is the cheap one: no proof, but it reports the cycle count, which is what decides whether proving
//! the thing is affordable at all.
use clap::Parser;
use sp1_sdk::{include_elf, prover::{ProveRequest, ProvingKey}, HashableKey, Prover, ProverClient, SP1Stdin};
use std::{fs, path::PathBuf};

// include_elf! yields an Elf wrapper in SP1 v6; the prover takes it directly.
pub const ELF: sp1_sdk::Elf = include_elf!("piecework-program");

#[derive(Parser)]
struct Cli {
    #[arg(long)] execute: bool,
    #[arg(long)] prove: bool,
    /// Groth16 is the only mode a contract can check, and the only one that needs a wrapping step large
    /// enough to run a laptop out of memory. core proves the same execution and is for showing the pipeline
    /// works when the machine cannot hold the wrap.
    #[arg(long, default_value = "groth16")] mode: String,
    #[arg(long, default_value = "sealing")] term: String,
    /// The pieces, in the order the client listed them. Order is part of the commitment.
    inputs: Vec<PathBuf>,
}

fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{x:02x}")).collect() }

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    sp1_sdk::utils::setup_logger();
    let cli = Cli::parse();
    if cli.execute == cli.prove { anyhow::bail!("pass exactly one of --execute or --prove"); }

    let mut stdin = SP1Stdin::new();
    stdin.write(&(cli.inputs.len() as u32));
    stdin.write_vec(cli.term.as_bytes().to_vec());
    let mut total = 0usize;
    for p in &cli.inputs {
        let b = fs::read(p)?;
        total += b.len();
        stdin.write_vec(b);
    }
    println!("{} piece(s), {total} bytes, term {:?}", cli.inputs.len(), cli.term);

    // from_env is async in v6: it may reach for a network prover before deciding to run locally.
    let client = ProverClient::from_env().await;
    if cli.execute {
        let (public_values, report) = client.execute(ELF, stdin.clone()).await?;
        let pv = public_values.as_slice();
        println!("cycles            : {}", report.total_instruction_count());
        println!("inputCommitment   : 0x{}", hex(&pv[..32]));
        println!("outputCommitment  : 0x{}", hex(&pv[32..64]));
        return Ok(());
    }

    // setup yields the proving key; the verifying key hangs off it, and its bytes32 is what goes on
    // chain as the job's imageDigest.
    let pk = client.setup(ELF).await?;
    let proof = match cli.mode.as_str() {
        "core" => client.prove(&pk, stdin).core().await?,
        "compressed" => client.prove(&pk, stdin).compressed().await?,
        _ => client.prove(&pk, stdin).groth16().await?,
    };
    let pv = proof.public_values.to_vec();
    println!("vkey              : {}", pk.verifying_key().bytes32());
    println!("publicValues      : 0x{}", hex(&pv));
    println!("proofBytes        : 0x{}", hex(&proof.bytes()));
    fs::write("proof.json", serde_json::to_string_pretty(&serde_json::json!({
        "vkey": pk.verifying_key().bytes32(),
        "publicValues": format!("0x{}", hex(&pv)),
        "proofBytes": format!("0x{}", hex(&proof.bytes())),
    }))?)?;
    println!("wrote proof.json");
    Ok(())
}
