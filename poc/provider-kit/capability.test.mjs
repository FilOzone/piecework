// Run with: node --test provider-kit/capability.test.mjs
// (not `node --test provider-kit/` — that sweeps up test-client.mjs, which is a client, not a test)
import test from "node:test";
import assert from "node:assert/strict";
import { parseGpu, whyNotRunnable } from "./capability.mjs";

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
