// Run with: node --test provider-kit/capability.test.mjs
// (not `node --test provider-kit/` — that sweeps up test-client.mjs, which is a client, not a test)
import test from "node:test";
import assert from "node:assert/strict";
import { parseGpu, whyNotRunnable, whyProverMismatched } from "./capability.mjs";

test("reads a real nvidia-smi line", () => {
  assert.deepEqual(parseGpu("NVIDIA RTX A4000, 16376\n"), { name: "NVIDIA RTX A4000", vramGb: 15 });
  assert.deepEqual(parseGpu("Tesla V100-SXM2-32GB, 32768"), { name: "Tesla V100-SXM2-32GB", vramGb: 32 });
});

test("takes the first card when there are several", () => {
  assert.equal(parseGpu("Tesla V100, 32768\nTesla V100, 32768\n").name, "Tesla V100");
});

test("no card is null, not a card with no memory", () => {
  // nvidia-smi missing, erroring, or printing something unexpected all mean the same thing to a provider:
  // `docker run --gpus` will not work here. Returning a truthy object for any of these would let a GPU job
  // be accepted on a machine that cannot run it, which is the fault this whole module exists to prevent.
  for (const bad of ["", "   ", "\n", undefined, null, "No devices were found", "GPU, notanumber", "GPU, 0"]) {
    assert.equal(parseGpu(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("a CPU job runs anywhere, with or without a card", () => {
  assert.equal(whyNotRunnable({ name: "ocr" }, null), null);
  assert.equal(whyNotRunnable({ name: "ocr" }, { name: "A4000", vramGb: 16 }), null);
});

test("a GPU job is declined on a machine with no card", () => {
  const why = whyNotRunnable({ name: "transcribe-gpu", gpu: true }, null);
  assert.match(why, /needs a GPU and this machine has none/);
  // The client must not be left thinking it has paid for something.
  assert.match(why, /Nothing is spent/);
});

test("a GPU job is taken when the card is there", () => {
  assert.equal(whyNotRunnable({ gpu: true }, { name: "RTX A4000", vramGb: 15 }), null);
});

/// The case that is easy to get wrong, and the one the SP1 CUDA prover actually hits: there IS a card, it
/// works, and it is too small. 24 GB is SP1's stated floor for a core proof and an A4000 reports 15.
test("a card that is present but too small is declined, naming both numbers", () => {
  const why = whyNotRunnable({ minVramGb: 24 }, { name: "RTX A4000", vramGb: 15 });
  assert.match(why, /needs 24 GB of VRAM/);
  assert.match(why, /RTX A4000 has 15 GB/);
});

test("exactly enough VRAM is enough", () => {
  assert.equal(whyNotRunnable({ minVramGb: 24 }, { name: "Tesla V100", vramGb: 32 }), null);
  assert.equal(whyNotRunnable({ minVramGb: 32 }, { name: "Tesla V100", vramGb: 32 }), null);
  assert.ok(whyNotRunnable({ minVramGb: 33 }, { name: "Tesla V100", vramGb: 32 }));
});

test("minVramGb implies a card is needed even without gpu:true", () => {
  assert.match(whyNotRunnable({ minVramGb: 10 }, null), /needs a GPU/);
});

// ---------------------------------------------------------------------------------------------------
// The prover's key against the catalogue's. This is the state a provider actually reported being in:
// binary built at one commit, catalogue pulled from a later one.
// ---------------------------------------------------------------------------------------------------

const BOUND = "0x002faeef6f22ecb5f451643ff42c37ec420eb37f4e535ddcf14f72d0c6942d47";
const OLD = "0x0038c8f3827c1ba3c9396591d54c84aec5c15f8c24a39f7258734a2f8e9ad45e";

test("an unproved job never consults the prover", () => {
  // Most of the catalogue is not proved, and those jobs must not be blocked by a prover that cannot even
  // be read -- a provider with no prover built should still serve OCR.
  assert.equal(whyProverMismatched({ name: "ocr" }, null), null);
  assert.equal(whyProverMismatched({ name: "ocr" }, OLD), null);
});

test("a matching key is accepted", () => {
  assert.equal(whyProverMismatched({ prove: true, vkey: BOUND }, BOUND), null);
});

test("case does not decide whether a proof is refused", () => {
  // Keys travel through JSON, logs and a Rust println. A capitalisation difference refusing a job would be
  // a maddening fault to find.
  assert.equal(whyProverMismatched({ prove: true, vkey: BOUND.toUpperCase() }, BOUND), null);
  assert.equal(whyProverMismatched({ prove: true, vkey: BOUND }, BOUND.toUpperCase()), null);
});

test("a stale prover is declined, naming both keys", () => {
  const why = whyProverMismatched({ prove: true, vkey: BOUND }, OLD);
  assert.match(why, new RegExp(BOUND));
  assert.match(why, new RegExp(OLD));
  // The provider has to be told what to do, not just that something is wrong.
  assert.match(why, /rebuild/);
});

test("an unreadable prover is declined rather than assumed good", () => {
  // The dangerous default: if the key cannot be read, proving anyway spends ten minutes to be refused.
  const why = whyProverMismatched({ prove: true, vkey: BOUND }, null);
  assert.match(why, /could not read/);
});

test("a proved job with no key in the catalogue is not blocked", () => {
  // Nothing to compare against, so nothing to contradict -- this guards the check from refusing jobs it
  // has no opinion about.
  assert.equal(whyProverMismatched({ prove: true }, OLD), null);
});
