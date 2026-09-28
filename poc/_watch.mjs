import { createPublicClient, http, formatUnits, getAddress } from "viem";
import * as FOC from "./foc.mjs";
const ABI = Object.fromEntries(FOC.NAMES.map((n) => [n, FOC.artifact(n).abi]));
const c = createPublicClient({ transport: http("https://api.calibration.node.glif.io/rpc/v1") });
const WHO = getAddress("0x49756CCD0e91fC91D2d8B41F8eaF6a863dc5A720");
const PDP = "0x85e366Cf9DD2c0aE37E963d9556F5f4718d6417C";
const VIEW = "0x1B68d64f01bAa42014B9774605867BF4eDC0320f";
const CS = JSON.parse((await import("fs")).default.readFileSync("calibnet.json")).computeService;
const seen = new Set();
const t0 = Date.now();
while (Date.now() - t0 < 14 * 60_000) {
  const next = Number(await c.readContract({ address: PDP, abi: ABI.PDPVerifier, functionName: "getNextDataSetId" }));
  for (let id = next - 1; id >= next - 12 && id > 0; id--) {
    if (seen.has(id)) continue;
    const d = await c.readContract({ address: VIEW, abi: ABI.FilecoinWarmStorageServiceStateView, functionName: "getDataSet", args: [BigInt(id)] }).catch(() => null);
    if (!d?.payer || getAddress(d.payer) !== WHO) { seen.add(id); continue; }
    seen.add(id);
    const pieces = Number(await c.readContract({ address: PDP, abi: ABI.PDPVerifier, functionName: "getNextPieceId", args: [BigInt(id)] }).catch(() => 0n));
    const auth = await c.readContract({ address: VIEW, abi: ABI.FilecoinWarmStorageServiceStateView, functionName: "getDataSetAuthorizer", args: [BigInt(id)] }).catch(() => null);
    console.log(`DATA SET #${id} is yours — provider ${d.serviceProvider}, ${pieces} piece(s), authorizer ${auth === null ? "?" : (getAddress(auth) === getAddress(CS) ? "ComputeService ✓" : auth)}`);
  }
  const acct = await c.readContract({ address: "0x09a0fDc2723fAd1A7b8e3e00eE5DF73841df55a0", abi: ABI.FilecoinPayV1,
    functionName: "getAccountInfoIfSettled", args: ["0xb3042734b608a1B16e9e86B374A3f3e389B4cDf0", WHO] });
  process.stdout.write(`\r[${new Date().toISOString().slice(11,19)}] in Filecoin Pay: ${Number(formatUnits(acct[2], 18)).toFixed(3)} USDFC   `);
  await new Promise((r) => setTimeout(r, 15000));
}
