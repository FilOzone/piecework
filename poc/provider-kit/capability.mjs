// What this machine can and cannot run, decided from hardware rather than hope.
//
// Separate from kit.mjs because kit.mjs is a daemon: importing it opens a chain connection and starts
// watching for jobs, so nothing inside it can be tested without all of that. These two functions are the
// whole of the decision and neither touches the network, the clock or a card.

/// Read `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`.
///
/// Returns { name, vramGb } for the first card, or null when there is nothing usable. Null is the honest
/// answer for an absent nvidia-smi too: `docker run --gpus` needs the NVIDIA container toolkit, which ships
/// with the driver that provides nvidia-smi, so a machine without it cannot run a GPU job however many
/// cards are physically installed.
export function parseGpu(stdout) {
  const line = String(stdout ?? "").trim().split("\n")[0];
  if (!line) return null;
  const [name, mib] = line.split(",").map((x) => x.trim());
  const mebibytes = Number(mib);
  if (!name || !Number.isFinite(mebibytes) || mebibytes <= 0) return null;
  // Gigabytes because that is the unit job specs are written in. Rounded down: a card reporting 16376 MiB
  // is a 16 GB card, and rounding it up to 16 would be fine but rounding 15.99 up to 16 would let a job
  // asking for 16 onto a card that has not got it.
  return { name, vramGb: Math.floor(mebibytes / 1024) };
}

/// Why this machine cannot run a job, as a sentence, or null if it can.
///
/// Called before accepting rather than after failing. A job marked gpu:true used to be accepted by any
/// provider and then die inside `docker run --gpus` with a daemon error, once the client had already
/// waited; one needing more VRAM than the card has died later still, somewhere inside the model.
///
/// This is also what makes "only a provider with a card can take this" a real category rather than a
/// label. Nothing a GPU computes is beyond a CPU — the difference is always throughput — so a GPU-only job
/// is one whose requirement is written down and checked. VRAM is the honest requirement to write down,
/// because a model that does not fit does not run at all, where merely being slower misses a deadline.
export function whyNotRunnable(spec, gpu) {
  if (!spec?.gpu && !spec?.minVramGb) return null;
  if (!gpu) {
    return "needs a GPU and this machine has none, so I am not taking it. Nothing is spent: the price "
      + "stays with the client until the deadline, and a provider with a card can take it meanwhile.";
  }
  if (spec.minVramGb && gpu.vramGb < spec.minVramGb) {
    return `needs ${spec.minVramGb} GB of VRAM and my ${gpu.name} has ${gpu.vramGb} GB, so I am not taking `
      + "it. Memory is the one requirement a faster run cannot substitute for.";
  }
  return null;
}

/// Why this provider's prover cannot be trusted to serve a job, as a sentence, or null if it can.
///
/// The catalogue says which verification key a proved job carries; the prover binary decides what key the
/// proof actually gets. Those are two different things and they drift: the binary is built once and the
/// catalogue is pulled, so a provider who pulls without rebuilding has a prover that proves the old guest
/// against the new catalogue entry.
///
/// Nothing catches that today until the chain does. The proof is produced correctly, takes ten minutes,
/// and `commitOutputs` answers ProofRejected because the key in the journal is not the key the job named —
/// which looks exactly like forgery and costs the provider the job. A provider reported precisely this
/// state: "its prover binary is still the one built at 51fd252, so it doesn't match the keys in the new
/// catalogue". He was right, and nothing in the kit would have told him.
export function whyProverMismatched(spec, actualVkey) {
  if (!spec?.prove || !spec?.vkey) return null;
  if (!actualVkey) {
    return "needs a proof, and I could not read my own prover's verification key to check it matches the "
      + "catalogue. Not taking the job: a proof under the wrong key is refused on chain after ten minutes "
      + "and looks like a forgery.";
  }
  if (actualVkey.toLowerCase() !== spec.vkey.toLowerCase()) {
    return `is listed under ${spec.vkey} and my prover produces ${actualVkey}. My binary is older than my `
      + "catalogue — a `git pull` without a rebuild does this. Not taking the job: the proof would be "
      + "correct, take ten minutes, and be refused on chain for carrying a key this job never named.";
  }
  return null;
}
