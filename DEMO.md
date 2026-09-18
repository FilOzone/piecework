# Demo script (about 5 minutes)

## Before the call (2 minutes)

1. In Finder, open `foc-compute/poc` and double-click **`Start demo.command`**. A Terminal window opens; leave it open.
   It starts Docker if needed, starts a fresh local chain, installs the contracts, and opens the page at http://localhost:8080.
2. Wait until the page shows "local chain · block …" at the top right.
3. Share your screen (the browser window).

To stop afterwards: close the Terminal window. Every start is a fresh chain: balances back to 5 luca_usdfc, no jobs.

## What to say and click

**0 · The setup (15 s).** "Everything here runs on a local blockchain on my laptop, with the real Filecoin Pay contract and our ComputeService contract. The money is a test token, luca_usdfc. The storage provider on the right already holds my PDP data set: four files. It's a real program that runs jobs in containers next to my files."

**1 · Put money in (20 s).** Click **Deposit 2 luca_usdfc**.
"Three transactions: allow, deposit, and let ComputeService open payments for me, within limits I set. Look at the log at the bottom: every line is a transaction."

**2 · Pay for time (1 min).** Tab **Pay for time** → **Start the search assistant**.
"The provider starts a service next to my data; billing starts only when it's ready. The safety margin is on hold, not spent."
Type `revenue` in the box → **Ask**. "This ran inside the provider's container, over my files."
Wait ~10 s, then **Stop**. "Payment stopped at that second. I paid exactly the seconds I used; the margin came back."

**3 · Pay per job (1 min).** Tab **Pay per job** → **Build a search index of my files** → **Order**.
"The price is on hold. The provider runs the program, adds the result to *my* data set as a new piece, and only then gets paid."
When it says *delivered and paid*, click **search-index.txt** (it's green on the right). "That's the output, stored as a PDP piece."

**4 · What if the provider is late? (40 s).** Choose **… (provider will be late)** → **Order**. Wait ~15 s until **Get my money back** appears, click it.
"Deadline passed on-chain, no result, so the price comes back to me. Nobody has to trust anybody for that."

**5 · What's real (20 s).** Point at the footer.
"Real: Filecoin Pay, ComputeService, the containers, every transaction. Simulated: PDP proofs (we assume an honest provider that proves), piece IDs, the token, and time runs fast: 1 second here is 30 seconds on Filecoin."

## Likely questions

| Question | Answer |
|---|---|
| Is this on Filecoin? | Not yet: a local chain with the real contracts. Next step is calibnet (the public test network), where ComputeService is the only new contract. |
| Who checks the result is correct? | Nobody, by design, like GPU clouds. Verification (e.g. Zen's zk proofs) can be added later as a job type. |
| How does the provider put results in my data set? | I attach ComputeService as my data set's authorizer in FWSS; it lets the provider add pieces only while I have a job open with it. Tested against the real FWSS v1.4.0. |
| What if my money runs out during a session? | Deposit only 0.08 and start a session: when money runs out, the provider stops and collects the safety margin, never more. |
| Relation to Rod's Compute over FOC? | Same architecture (compute where the data is, paid via Filecoin Pay); PieceWork drops redundant execution, so any workload runs, and adds pay-for-time sessions. |

## If something goes wrong

- Page says *The demo is not running*: the Terminal window was closed; double-click `Start demo.command` again.
- Terminal says *Docker is not running*: open the Docker app, wait until it says running, start again.
- Terminal says *port 8545 is already in use*: an old demo is still running; close its Terminal window, or restart the Mac.
