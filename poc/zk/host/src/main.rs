//! The host: runs the prover and produces the single `bytes` argument commitOutputs expects.
//!
//! NEVER COMPILED, NEVER RUN. See ../../README.md.
//!
//!   host prove --term swap --out proof.json <input files...>
//!   host verify --proof proof.json
//!
//! The provider kit would call `prove` after running the job, and pass `proofArg` straight into
//! commitOutputs. `verify` exists so a proof can be checked without a chain, which is how to tell a broken
//! prover apart from a broken contract.

use clap::{Parser, Subcommand};
use sp1_sdk::{ProverClient, SP1Stdin};
use std::{fs, path::PathBuf};

pub const GUEST_ELF: &[u8] = include_bytes!("../../guest/elf/riscv32im-succinct-zkvm-elf");

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    Prove {
        /// The pieces, in the order the client listed them when posting the job. Order is part of the
        /// commitment, so getting it wrong produces a proof that is valid and useless.
        inputs: Vec<PathBuf>,
        #[arg(long)]
        term: String,
        #[arg(long, default_value = "proof.json")]
        out: PathBuf,
    },
    Verify {
        #[arg(long)]
        proof: PathBuf,
    },
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let client = ProverClient::from_env();

    match cli.cmd {
        Cmd::Prove { inputs, term, out } => {
            let mut stdin = SP1Stdin::new();
            stdin.write(&(inputs.len() as u32));
            for p in &inputs {
                stdin.write_vec(fs::read(p)?);
            }
            stdin.write_vec(term.as_bytes().to_vec());

            let (pk, vk) = client.setup(GUEST_ELF);

            // Groth16 rather than the default: it is the only shape the on-chain verifier takes, and it is
            // a few hundred bytes instead of a megabyte. It also costs an extra wrapping step, which is
            // most of the difference between a proof you can hold and one you can post.
            let proof = client.prove(&pk, &stdin).groth16().run()?;

            let public_values = proof.public_values.to_vec();
            let proof_bytes = proof.bytes();

            // What ComputeService takes: abi.encode(publicValues, proofBytes), which SP1ComputeVerifier
            // splits before checking the journal against the chain's own commitments.
            let proof_arg = ethers_core::abi::encode(&[
                ethers_core::abi::Token::Bytes(public_values.clone()),
                ethers_core::abi::Token::Bytes(proof_bytes.clone()),
            ]);

            fs::write(
                &out,
                serde_json::to_string_pretty(&serde_json::json!({
                    "vkey": vk.bytes32(),
                    "publicValues": format!("0x{}", hex::encode(&public_values)),
                    "proofBytes": format!("0x{}", hex::encode(&proof_bytes)),
                    "proofArg": format!("0x{}", hex::encode(&proof_arg)),
                }))?,
            )?;

            // The vkey is the job's imageDigest. A client ordering this program puts this value on chain,
            // which is what makes "which program ran" a fact rather than a label.
            println!("vkey (use as imageDigest): {}", vk.bytes32());
            println!("wrote {}", out.display());
            Ok(())
        }
        Cmd::Verify { proof } => {
            let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(&proof)?)?;
            let (_, vk) = client.setup(GUEST_ELF);
            println!("vkey from this ELF: {}", vk.bytes32());
            println!("vkey in the proof : {}", v["vkey"].as_str().unwrap_or("?"));
            println!("they must match, or the proof is of a different program");
            Ok(())
        }
    }
}
