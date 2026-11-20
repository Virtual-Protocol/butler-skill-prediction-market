#!/usr/bin/env node
// SIGNS WITH THE MAIN WALLET. Create (or rotate) the trading key and approve it
// on Hyperliquid with an ApproveAgent signature from the main wallet.
//
//   node setup_agent.mjs [--rotate] [--idempotency-key <key>]
//   node setup_agent.mjs --resume <key>      (after pending_owner_signature)
//
// status: done | needs_deposit | needs_agent | pending_owner_signature
// Safety: only a key created in THIS run (or the one a --resume completes) is
// ever approved. An existing key that Hyperliquid no longer lists is treated as
// pruned: it needs --rotate, never a re-approval of the old address.
// Resumable: {nonce, agentAddress, agentName, typedData} is saved under the key;
// --resume rebuilds the identical typed data and repeats the signer call with the
// same idempotency key, which returns the owner's signature, then submits it.

import {
  runScript,
  parseArgs,
  okEnvelope,
  loadSigner,
  fetchExtraAgents,
  agentApproval,
  agentHealth,
  agentNameFor,
  hlInfo,
  sleep,
  idempotencyKeyFrom,
  scriptDeadline,
  stepBudgetMs,
  savePending,
  loadPending,
  clearPending,
  rethrowWithResume,
  SkillError,
  RESUME_FLAGS,
  AGENT_KEY_LABEL,
} from "./lib/common.mjs";

const SCRIPT = "setup_agent";
const CONFIRM_WAIT_CAP_MS = 30_000;

runScript(async () => {
  const args = parseArgs(process.argv.slice(2), { ...RESUME_FLAGS, rotate: { type: "boolean" } });
  if (args.resume && args.rotate) throw new SkillError("BAD_ARGS", "--resume and --rotate cannot be combined");
  const signerMod = await loadSigner();
  const key = idempotencyKeyFrom(args, SCRIPT, { isDev: Boolean(signerMod.isDev) });
  const signer = await signerMod.mainSigner({ idempotencyKey: key, deadline: scriptDeadline() });
  const main = signer.address;

  // Hyperliquid refuses approveAgent on an address that never deposited.
  const role = await hlInfo({ type: "userRole", user: main });
  if (role?.role === "missing") {
    throw new SkillError("NEEDS_DEPOSIT", "This wallet has never deposited to Hyperliquid, so it cannot approve a trading key yet.", {
      hint: "Run deposit.mjs --amount 5 (or more) first.",
      status: "needs_deposit",
    });
  }

  const { getAgentApprovalTypedData, submitAgentApproval, nextNonce } = await import("@outcome.xyz/hip4");
  let agent;
  let rec;
  if (args.resume) {
    rec = loadPending(key, SCRIPT);
    agent = await signerMod.agentKey({ label: AGENT_KEY_LABEL, rotate: false, create: false, idempotencyKey: key, deadline: scriptDeadline() });
    if (!agent || agent.address.toLowerCase() !== rec.agentAddress.toLowerCase()) {
      clearPending(key);
      throw new SkillError("RESUME_MISMATCH", "The trading key changed since this approval was requested.", {
        hint: "Run status.mjs, then setup_agent.mjs --rotate if a key is still needed.",
        status: "needs_agent",
      });
    }
  } else {
    agent = await signerMod.agentKey({ label: AGENT_KEY_LABEL, rotate: args.rotate, idempotencyKey: key, deadline: scriptDeadline() });
    const before = await agentHealth(main, agent.address);
    if (before.valid && !args.rotate) {
      if (!agent.approved) await agent.markApproved();
      return okEnvelope("done", {
        alreadyApproved: true,
        mainWallet: main,
        agentAddress: agent.address,
        agentName: before.name,
        validUntilIso: before.validUntilIso ?? null,
        daysLeft: before.daysLeft,
        expiringSoon: before.expiringSoon,
        mustRotate: before.mustRotate,
        health: before.code,
      });
    }
    if (!agent.generated) {
      throw new SkillError(
        "AGENT_INVALID",
        "The stored trading key is not approved on Hyperliquid (it was replaced, pruned or never completed). For safety it will not be re-approved.",
        { hint: "Run setup_agent.mjs --rotate to create and approve a fresh key.", status: "needs_agent", data: { agentAddress: agent.address } },
      );
    }
    rec = { script: SCRIPT, mainWallet: main, nonce: nextNonce(), agentAddress: agent.address, agentName: agentNameFor(signerMod) };
    rec.typedData = getAgentApprovalTypedData(rec.agentAddress, rec.agentName, rec.nonce, true);
    savePending(key, rec);
  }

  // Rebuilt from the saved fields so a resume signs/fetches exactly the same payload.
  const typedData = getAgentApprovalTypedData(rec.agentAddress, rec.agentName, rec.nonce, true);
  let signature;
  try {
    signature = await signer.signTypedData(typedData);
  } catch (err) {
    rethrowWithResume(err, key);
  }

  const res = await submitAgentApproval(signature, rec.agentAddress, rec.agentName, rec.nonce, true);
  clearPending(key);
  if (!res.success) {
    // No auto-retry: report the raw Hyperliquid text.
    throw new SkillError("APPROVE_FAILED", `Hyperliquid refused the approval: ${res.error ?? "unknown error"}`, {
      hint: /deposit/i.test(res.error ?? "")
        ? "Run deposit.mjs --amount 5 (or more) first."
        : "Run status.mjs first. If all named agent slots are used, approving an existing name replaces it (locally: DEV_AGENT_NAME).",
      data: { agentAddress: rec.agentAddress, agentName: rec.agentName, raw: res.error ?? null },
    });
  }

  const after = await waitUntilListed(main, rec.agentAddress);
  if (!after) {
    throw new SkillError("AGENT_APPROVAL_UNCONFIRMED", "Hyperliquid accepted the approval but does not list the key yet.", {
      hint: "Run status.mjs in a minute; if the key is listed, run setup_agent.mjs again (it will just confirm).",
      data: { agentAddress: rec.agentAddress, agentName: rec.agentName },
    });
  }
  await agent.markApproved();
  return okEnvelope("done", {
    alreadyApproved: false,
    generated: agent.generated === true,
    resumed: Boolean(args.resume),
    mainWallet: main,
    agentAddress: rec.agentAddress,
    agentName: after.name,
    validUntilIso: after.validUntilIso ?? null,
    daysLeft: after.daysLeft,
    expiringSoon: after.expiringSoon,
    mustRotate: after.mustRotate,
  });
});

// Only once extraAgents lists the new address do we markApproved().
async function waitUntilListed(main, agentAddress) {
  const deadline = Date.now() + stepBudgetMs(CONFIRM_WAIT_CAP_MS);
  do {
    const st = agentApproval(await fetchExtraAgents(main).catch(() => []), agentAddress);
    if (st.approved) return st;
    if (Date.now() + 2_000 >= deadline) break;
    await sleep(2_000);
  } while (Date.now() < deadline);
  return null;
}
