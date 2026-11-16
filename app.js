// Metaxx — Ammora Launchpad UI on GIWA Sepolia (testnet only).
// Static page: all reads go live to the public RPC via viem + @ammora-protocol/sdk.
// All writes are sent ONLY through the visitor's own wallet (window.ethereum)
// after they click a button and confirm in the wallet. No private key, seed
// phrase or signer is ever created, stored or sent by this page.
import {
  createPublicClient, createWalletClient, custom, http, defineChain,
  parseUnits, formatUnits, erc20Abi, encodeFunctionData, getAddress, isAddress,
  keccak256, encodeAbiParameters, zeroAddress,
} from "viem";
import {
  giwaSepoliaAutoRouteDeployment, giwaSepoliaAutoRoute, giwaSepoliaAutoRoutePoolProfiles,
  resolveAmmoraFinalizedHead, verifyAmmoraV4CoreAtBlock,
  getAmmoraV4ConfigAtBlock, getAmmoraV4NextConfigId,
  AmmoraV4LaunchCurveClient, classifyAmmoraV4ExactInputFill,
  buildCreateAmmoraV4Config, buildCreateAmmoraV4Launch,
  parseAmmoraV4ConfigCreatedReceipt, parseAmmoraV4LaunchCreatedReceipt,
  parseAmmoraV4SwapReceipt, ammoraLaunchFactoryV4Abi, feeVaultAbi,
  buildSingleSegmentCurve, concentratedDepositQuote, assertAmmoraV4Config,
  AmmoraV4MigrationMode, buildClaimFeeVaultFor, AMMORA_FEE_POLICY_VERSION,
  AmmoraSwapClient,
} from "@ammora-protocol/sdk";

// ---------------------------------------------------------------- constants
const CHAIN_ID = 91342;
const RPC_URL = "https://sepolia-rpc.giwa.io";
const EXPLORER = "https://sepolia-explorer.giwa.io";
const DEPLOYMENT = giwaSepoliaAutoRouteDeployment;
const LAUNCH = DEPLOYMENT.contracts.launch;
const REGISTRY = LAUNCH.configRegistry;
const FACTORY = LAUNCH.factory;
const FEE_POLICY = LAUNCH.feePolicy;
const GRADUATION_ADAPTER = LAUNCH.graduationAdapter;
const WETH = DEPLOYMENT.contracts.tokens.wrappedNative;
const CORE = { configRegistry: REGISTRY, launchFactory: FACTORY, graduationAdapter: GRADUATION_ADAPTER, feePolicy: FEE_POLICY };
const CURVE_CORE = { launchFactory: FACTORY, feePolicy: FEE_POLICY };
const TEMPLATE_ID_DEFAULT = 6;
const TEMPLATE_HASH_DEFAULT = "0x6048908774397e0691bb0e19f72dabb790eb0d892d6081d3622b39e7f738e667";
// Live demo (verified on-chain, 5 Nov 2026 validation): Config #25 -> KGPT.
const DEMO = {
  configId: 25n,
  token: "0xeFD0b74cB733534D6554894c0FdF5931a711BCFB",
  tokenDecimals: 9,
  curve: "0xCc803Eb81b7Cf3a71dBF17d25E342e45F17be209",
  pool: "0xD912Fa18061E5665136AE5dBc002aDa0fc0D3c28",
  feeVault: "0x414Be4a093fDFd7292dCa95C4D6fdD3905Ee6800",
};
const STATUS_LABEL = ["Uninitialized", "Active", "ReadyToMigrate", "Migrated"];
const SLIPPAGE_DEFAULT_BPS = 50;

const chain = defineChain({
  id: CHAIN_ID,
  name: "GIWA Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "GIWA Sepolia Explorer", url: EXPLORER } },
});
const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });

// ---------------------------------------------------------------- state
let walletClient = null;
let account = null; // checksummed address string
let curveState = null; // { address, state, blockNumber }
let tradeMode = null; // "curve" | "pool" | null
let poolPrepared = null; // PreparedExactInputSwap (concentrated) from last quote
let pendingConfig = null; // { config, curve, data, reviewHash, configOwner }
let issueConfig = null; // { entry, poolCreationFee }
let feeVaultAddr = null;

// ---------------------------------------------------------------- helpers
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const txLink = (h) => `<a href="${EXPLORER}/tx/${h}" target="_blank" rel="noopener" class="mono">${short(h)}</a>`;
const addrLink = (a) => `<a href="${EXPLORER}/address/${a}" target="_blank" rel="noopener" class="mono">${a}</a>`;
const errText = (e) => (e && (e.shortMessage || e.message)) || String(e);
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function mustAddress(v, label) {
  if (!isAddress(v, { strict: false })) throw new Error(`${label} is not a valid address: ${v}`);
  return getAddress(v);
}
function mustAmount(v, decimals, label) {
  if (!/^\d+(\.\d+)?$/.test(v.trim())) throw new Error(`${label} must be a positive decimal number`);
  if ((v.split(".")[1]?.length ?? 0) > decimals) throw new Error(`${label} has more decimals than the token (${decimals})`);
  const raw = parseUnits(v.trim(), decimals);
  if (raw <= 0n) throw new Error(`${label} must be greater than zero`);
  return raw;
}
const metaCache = new Map();
async function tokenMeta(addr) {
  const key = addr.toLowerCase();
  if (!metaCache.has(key)) {
    const [decimals, symbol] = await Promise.all([
      publicClient.readContract({ address: addr, abi: erc20Abi, functionName: "decimals" }),
      publicClient.readContract({ address: addr, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
    ]);
    metaCache.set(key, { decimals: Number(decimals), symbol });
  }
  return metaCache.get(key);
}
async function latestBlock() { return publicClient.getBlockNumber(); }

// ---------------------------------------------------------------- wallet
function requireWallet() {
  if (!account || !walletClient) throw new Error("Connect your wallet first.");
  return { walletClient, account };
}
async function refreshBalances() {
  if (!account) return;
  try {
    const [eth, weth, wethDec] = await Promise.all([
      publicClient.getBalance({ address: account }),
      publicClient.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
      publicClient.readContract({ address: WETH, abi: erc20Abi, functionName: "decimals" }),
    ]);
    $("wallet-bal").textContent = `ETH ${formatUnits(eth, 18)} · WETH ${formatUnits(weth, Number(wethDec))}`;
  } catch (e) { $("wallet-bal").textContent = `Balance read failed: ${errText(e)}`; }
}
async function connectWallet() {
  if (!window.ethereum) throw new Error("No injected wallet found (window.ethereum). Install MetaMask or open this page in a wallet browser.");
  walletClient = createWalletClient({ chain, transport: custom(window.ethereum) });
  const addrs = await walletClient.requestAddresses();
  if (!addrs.length) throw new Error("Wallet returned no address.");
  account = getAddress(addrs[0]);
  const netId = await walletClient.getChainId();
  $("wallet-info").hidden = false;
  $("wallet-addr").textContent = account;
  $("btn-switch").hidden = netId === CHAIN_ID;
  if (netId !== CHAIN_ID) $("wallet-bal").textContent = `Wrong network (chain ${netId}) — switch to GIWA Sepolia (91342).`;
  else await refreshBalances();
  for (const id of ["cfg-owner", "cfg-partner", "cfg-lp", "cfg-leftover"]) {
    if (!$ (id).value) $(id).value = account;
  }
  if (!$("fee-beneficiary").value) $("fee-beneficiary").value = account;
}
async function switchNetwork() {
  if (!window.ethereum) throw new Error("No injected wallet found.");
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: `0x${CHAIN_ID.toString(16)}` }] });
  } catch (e) {
    if (e?.code === 4902) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId: `0x${CHAIN_ID.toString(16)}`, chainName: "GIWA Sepolia", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: [RPC_URL], blockExplorerUrls: [EXPLORER] }],
      });
    } else throw e;
  }
  await connectWallet();
}
$("btn-connect").addEventListener("click", async () => {
  try { await connectWallet(); $("btn-connect").textContent = "Connected ✓"; }
  catch (e) { alert(`Connect failed: ${errText(e)}`); }
});
$("btn-switch").addEventListener("click", async () => {
  try { await switchNetwork(); } catch (e) { alert(`Switch failed: ${errText(e)}`); }
});
if (window.ethereum) {
  window.ethereum.on?.("accountsChanged", () => location.reload());
  window.ethereum.on?.("chainChanged", () => location.reload());
}

// ---------------------------------------------------------------- network status
async function initNetwork() {
  const el = $("net-status");
  try {
    const [chainId, block] = await Promise.all([publicClient.getChainId(), publicClient.getBlockNumber()]);
    if (chainId !== CHAIN_ID) throw new Error(`RPC reports chain ${chainId}, expected ${CHAIN_ID}`);
    el.innerHTML = `<span class="ok">● Live</span> — chain ${chainId}, latest block ${block}. Deployment slot <span class="mono">${esc(DEPLOYMENT.slot)}</span>, source commit <span class="mono">${esc(DEPLOYMENT.sourceCommit ?? "")}</span>.`;
  } catch (e) { el.innerHTML = `<span class="err">RPC error: ${esc(errText(e))}</span>`; }
}
$("btn-verify").addEventListener("click", async () => {
  $("verify-out").textContent = "verifying…";
  try {
    const block = await latestBlock();
    await verifyAmmoraV4CoreAtBlock(publicClient, CORE, block);
    $("verify-out").innerHTML = `<span class="ok">✓ Core verified at block ${block}</span>`;
  } catch (e) { $("verify-out").innerHTML = `<span class="err">✗ ${esc(errText(e))}</span>`; }
});

// ---------------------------------------------------------------- shared send helpers
async function sendAndWait({ to, data, value }) {
  const { walletClient: wc, account: acct } = requireWallet();
  const hash = await wc.sendTransaction({ account: acct, chain, to, data, value: value ?? 0n });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Transaction reverted: ${hash}`);
  return { hash, receipt };
}
// Exact-amount ERC-20 approval(s) to a spender; returns approval tx hashes.
async function ensureApproval(token, spender, amount, resetToZero) {
  const { walletClient: wc, account: acct } = requireWallet();
  const hashes = [];
  let allowance = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [acct, spender] });
  if (allowance < amount) {
    if (resetToZero && allowance > 0n) {
      const h0 = await wc.writeContract({ account: acct, chain, address: token, abi: erc20Abi, functionName: "approve", args: [spender, 0n] });
      hashes.push(h0);
      await publicClient.waitForTransactionReceipt({ hash: h0 });
    }
    const h = await wc.writeContract({ account: acct, chain, address: token, abi: erc20Abi, functionName: "approve", args: [spender, amount] });
    hashes.push(h);
    await publicClient.waitForTransactionReceipt({ hash: h });
  }
  return hashes;
}
const WETH_DEPOSIT_ABI = [{ type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] }];
$("btn-wrap").addEventListener("click", async () => {
  const out = $("wrap-status");
  try {
    const amount = mustAmount($("wrap-amount").value, 18, "Wrap amount");
    out.textContent = "Confirm the deposit in your wallet…";
    const { hash } = await sendAndWait({ to: WETH, data: encodeFunctionData({ abi: WETH_DEPOSIT_ABI, functionName: "deposit" }), value: amount });
    out.innerHTML = `<span class="ok">Wrapped ✓</span> ${txLink(hash)}`;
    await refreshBalances();
  } catch (e) { out.innerHTML = `<span class="err">${esc(errText(e))}</span>`; }
});

// ---------------------------------------------------------------- explore
function configRowHtml(entry) {
  return `<div class="cfg-row" data-id="${entry.configId}">
    <span><strong>#${entry.configId}</strong> · owner <span class="mono">${short(entry.identity.owner)}</span></span>
    <span class="mono">${short(entry.config.quoteToken)}</span>
    <span>${entry.enabled ? '<span class="ok">enabled</span>' : '<span class="err">disabled</span>'} · ${entry.segments.length} segment(s)</span>
  </div>`;
}
$("btn-list-configs").addEventListener("click", async () => {
  const status = $("cfg-status"), list = $("cfg-list");
  list.innerHTML = ""; $("cfg-detail").hidden = true;
  try {
    const limit = Math.min(100, Math.max(1, Number($("cfg-limit").value) || 30));
    status.textContent = "Reading finalized head…";
    const block = await resolveAmmoraFinalizedHead([publicClient], giwaSepoliaAutoRoute.finality);
    const nextId = await getAmmoraV4NextConfigId(publicClient, REGISTRY, block);
    const total = nextId > 1n ? nextId - 1n : 0n;
    const count = Number(total > BigInt(limit) ? BigInt(limit) : total);
    status.textContent = `${total} configs registered (next id ${nextId}). Loading newest ${count} at block ${block}…`;
    const rows = [];
    for (let i = 0; i < count; i++) {
      if (i > 0) await sleep(600); // pace reads: the public RPC is rate-limited
      const entry = await getAmmoraV4ConfigAtBlock(publicClient, REGISTRY, BigInt(Number(total) - i), block);
      rows.push(entry);
    }
    list.innerHTML = rows.map(configRowHtml).join("");
    status.textContent = `Showing ${rows.length} newest configs at finalized block ${block}. Click one for details.`;
    list.querySelectorAll(".cfg-row").forEach((row) => row.addEventListener("click", () => showConfigDetail(rows.find((r) => String(r.configId) === row.dataset.id))));
  } catch (e) { status.innerHTML = `<span class="err">${esc(errText(e))}</span>`; }
});
function showConfigDetail(entry) {
  const c = entry.config;
  $("cfg-detail").hidden = false;
  $("cfg-detail").innerHTML = `<h3>Config #${entry.configId}</h3>
  <table>
    <tr><td>Hash</td><td class="mono">${entry.configHash}</td></tr>
    <tr><td>Enabled</td><td>${entry.enabled}</td></tr>
    <tr><td>Owner</td><td>${addrLink(entry.identity.owner)}</td></tr>
    <tr><td>Fee claimer</td><td>${addrLink(entry.identity.feeClaimer)}</td></tr>
    <tr><td>Quote token</td><td>${addrLink(c.quoteToken)}</td></tr>
    <tr><td>Token decimals</td><td>${c.tokenDecimals}</td></tr>
    <tr><td>Migration quote threshold</td><td class="mono">${c.migrationQuoteThreshold} raw (${formatUnits(c.migrationQuoteThreshold, 18)} WETH)</td></tr>
    <tr><td>Migration base threshold</td><td class="mono">${c.migrationBaseThreshold} raw</td></tr>
    <tr><td>poolCreationFee</td><td class="mono">${c.poolCreationFee} wei (${formatUnits(c.poolCreationFee, 18)} ETH, paid in native ETH at issue)</td></tr>
    <tr><td>Creator share (non-protocol)</td><td>${c.creatorShareOfNonProtocolBps} bps</td></tr>
    <tr><td>Migration mode</td><td>${c.migrationMode} (0 = Concentrated Graduation)</td></tr>
    <tr><td>Segments</td><td>${entry.segments.length}</td></tr>
    <tr><td>Partner recipient</td><td>${addrLink(c.partnerRecipient)}</td></tr>
    <tr><td>Leftover receiver</td><td>${addrLink(c.leftoverReceiver)}</td></tr>
    <tr><td>Created at block</td><td>${entry.identity.createdAtBlock}</td></tr>
  </table>
  <div class="row"><button class="btn" id="btn-use-cfg-issue">Use #${entry.configId} for Issue Token</button>
  <button class="btn" id="btn-use-cfg-fee">Use #${entry.configId} for Fees</button></div>`;
  $("btn-use-cfg-issue").addEventListener("click", () => { $("iss-config").value = entry.configId; $("iss-decimals").value = c.tokenDecimals; document.getElementById("launch-card").scrollIntoView({ behavior: "smooth" }); });
  $("btn-use-cfg-fee").addEventListener("click", () => { $("fee-config").value = entry.configId; document.getElementById("fees-card").scrollIntoView({ behavior: "smooth" }); });
}

// ---------------------------------------------------------------- curve state
async function loadCurve(address) {
  const curve = mustAddress(address, "Curve address");
  const el = $("curve-state");
  el.innerHTML = `<p class="muted">Reading curve ${short(curve)}…</p>`;
  $("trade-route").hidden = true; $("migrate-box").hidden = true; tradeMode = null; curveState = null;
  try {
    const block = await latestBlock();
    const code = await publicClient.getCode({ address: curve, blockNumber: block });
    if (!code || code === "0x") throw new Error(`No contract code at ${curve} (block ${block}). Check the address.`);
    const sdk = new AmmoraV4LaunchCurveClient(publicClient, curve, CURVE_CORE);
    const state = await sdk.getStateAtBlock(block);
    if (state.asOfBlock !== block) throw new Error("Curve state is from a different block — re-read.");
    // Authenticate: curve must be bound to the reviewed factory + fee policy.
    const factoryToken = await publicClient.readContract({ address: FACTORY, abi: ammoraLaunchFactoryV4Abi, functionName: "tokenForCurve", args: [curve], blockNumber: block });
    if (factoryToken === zeroAddress || factoryToken.toLowerCase() !== state.baseToken.toLowerCase()
      || state.feePolicy.toLowerCase() !== FEE_POLICY.toLowerCase()
      || state.feePolicyVersion !== AMMORA_FEE_POLICY_VERSION) {
      throw new Error("Curve is not bound to the reviewed V4 factory and fee policy — refusing to display it as a trade target.");
    }
    curveState = { address: curve, state, blockNumber: block, sdk };
    renderCurveState();
  } catch (e) { el.innerHTML = `<p class="err">${esc(errText(e))}</p>`; }
}
function renderCurveState() {
  const { address, state } = curveState;
  const el = $("curve-state");
  const status = STATUS_LABEL[state.status] ?? `Unknown (${state.status})`;
  let route = "";
  if (state.status === 1) {
    tradeMode = "curve";
    route = `<p class="note">Status <strong>Active (1)</strong> — trade on the curve (model <span class="mono">dbc</span>). Quotes below are live curve quotes.</p>`;
    $("trade-route").hidden = false; $("migrate-box").hidden = true;
    $("trade-route-note").innerHTML = route;
  } else if (state.status === 2) {
    tradeMode = null;
    route = `<p class="note warn">Status <strong>ReadyToMigrate (2)</strong> — the curve is full. No more curve trades; migrate it to its pool first.</p>`;
    $("trade-route").hidden = true; $("migrate-box").hidden = false;
  } else if (state.status === 3) {
    tradeMode = "pool";
    route = `<p class="note">Status <strong>Migrated (3)</strong> — this curve no longer trades. Trade the token on its graduated pool instead (model <span class="mono">concentrated</span>).<br>
      Canonical pool: ${addrLink(state.canonicalPool)}</p>`;
    $("trade-route").hidden = false; $("migrate-box").hidden = true;
    $("trade-route-note").innerHTML = route;
  } else {
    tradeMode = null;
    route = `<p class="note warn">Status <strong>${esc(status)} (${state.status})</strong> — this curve is not trading yet.</p>`;
    $("trade-route").hidden = true; $("migrate-box").hidden = true;
  }
  el.innerHTML = `<h3>Curve ${addrLink(address)}</h3>
  <table>
    <tr><td>Status</td><td><strong>${esc(status)} (${state.status})</strong></td></tr>
    <tr><td>Config</td><td>#${state.configId}</td></tr>
    <tr><td>Base token</td><td>${addrLink(state.baseToken)}</td></tr>
    <tr><td>Quote token</td><td>${addrLink(state.quoteToken)}</td></tr>
    <tr><td>Creator</td><td>${addrLink(state.creator)}</td></tr>
    <tr><td>Base reserve</td><td class="mono">${state.baseReserve}</td></tr>
    <tr><td>Quote reserve</td><td class="mono">${state.quoteReserve}</td></tr>
    <tr><td>Migration quote threshold</td><td class="mono">${state.migrationQuoteThreshold}</td></tr>
    <tr><td>Migration base threshold</td><td class="mono">${state.migrationBaseThreshold}</td></tr>
    <tr><td>Canonical pool</td><td>${state.canonicalPool === zeroAddress ? "— (not migrated yet)" : addrLink(state.canonicalPool)}</td></tr>
    <tr><td>Fee vault</td><td>${addrLink(state.feeVault)}</td></tr>
    <tr><td>Current fee</td><td>${state.currentFeeBps} bps (dynamic ${state.currentDynamicFeeBps} bps)</td></tr>
    <tr><td>As of block</td><td>${curveState.blockNumber}</td></tr>
  </table>${route}`;
  if (state.status === 3) $("fee-base").value = state.baseToken;
}
$("btn-lookup-curve").addEventListener("click", () => loadCurve($("lookup-curve").value).catch((e) => { $("curve-state").innerHTML = `<p class="err">${esc(errText(e))}</p>`; }));
$("btn-load-kgpt").addEventListener("click", () => { $("lookup-curve").value = DEMO.curve; loadCurve(DEMO.curve); });

// ---------------------------------------------------------------- trade (curve dbc + graduated pool concentrated)
function tradeTokens() {
  if (!curveState) throw new Error("Load a curve first.");
  const dir = $("trade-dir").value;
  const { state } = curveState;
  if (dir === "buy") return { tokenIn: state.quoteToken, tokenOut: state.baseToken, baseForQuote: false, label: "Buy" };
  return { tokenIn: state.baseToken, tokenOut: state.quoteToken, baseForQuote: true, label: "Sell" };
}
async function quoteTrade() {
  const out = $("quote-out");
  out.hidden = false; out.innerHTML = `<p class="muted">Quoting…</p>`;
  $("btn-trade").disabled = true; poolPrepared = null;
  try {
    if (!curveState) throw new Error("Load a curve first.");
    const { tokenIn, tokenOut, baseForQuote, label } = tradeTokens();
    const inMeta = await tokenMeta(tokenIn);
    const amountIn = mustAmount($("trade-amount").value, inMeta.decimals, "Amount");
    const block = await latestBlock();
    if (tradeMode === "curve") {
      const { state, sdk } = curveState;
      if (state.status !== 1) throw new Error(`Curve is not active (status ${state.status}); no curve trade quoted.`);
      const quote = await sdk.quoteExactInputAtBlock(amountIn, baseForQuote, block);
      if (quote.asOfBlock !== block) throw new Error("Quote is from a different block — re-quote.");
      const fill = classifyAmmoraV4ExactInputFill(quote, baseForQuote);
      const outMeta = await tokenMeta(tokenOut);
      const minOut = quote.amountOut * BigInt(10_000 - Number($("trade-slippage").value || SLIPPAGE_DEFAULT_BPS)) / 10_000n;
      if (minOut === 0n) throw new Error("Minimum output rounds to zero — increase the amount.");
      out.innerHTML = `<h3>${label} quote — curve (dbc), block ${block}</h3>
      <table>
        <tr><td>You pay</td><td>${formatUnits(amountIn, inMeta.decimals)} ${esc(inMeta.symbol)}</td></tr>
        <tr><td>You receive (expected)</td><td>${formatUnits(quote.amountOut, outMeta.decimals)} ${esc(outMeta.symbol)}</td></tr>
        <tr><td>Minimum out (slippage ${$("trade-slippage").value} bps)</td><td>${formatUnits(minOut, outMeta.decimals)} ${esc(outMeta.symbol)}</td></tr>
        <tr><td>Fee</td><td class="mono">${quote.fee} raw</td></tr>
        <tr><td>Amount left (unfilled)</td><td class="mono">${quote.amountLeft} raw</td></tr>
        <tr><td>Fill</td><td><strong>${fill.kind}</strong>${fill.kind !== "full" ? " — ordinary orders must fill in full; only a graduation-boundary buy may partially fill." : ""}</td></tr>
      </table>
      <p class="muted">Read-only snapshot. Re-quote right before signing; the wallet preview is the final check.</p>`;
      $("btn-trade").disabled = fill.kind !== "full" && fill.kind !== "graduation-boundary";
      $("btn-trade").textContent = `${label} (sign in wallet)`;
    } else if (tradeMode === "pool") {
      const { state } = curveState;
      if (state.canonicalPool === zeroAddress) throw new Error("Curve is migrated but has no canonical pool on-chain.");
      const swaps = await AmmoraSwapClient.create(publicClient, { deploymentCatalog: { [CHAIN_ID]: DEPLOYMENT }, factoryProfiles: giwaSepoliaAutoRoutePoolProfiles });
      const slippageBps = Number($("trade-slippage").value || SLIPPAGE_DEFAULT_BPS);
      const prepared = await swaps.prepareExactIn({
        model: "concentrated", pool: state.canonicalPool, tokenIn,
        inputAsset: "erc20", amountIn, payer: account ?? zeroAddress, recipient: account ?? zeroAddress,
        slippageBps, executionMode: "direct-wallet",
      }, block);
      const q = prepared.quote;
      const outMeta = await tokenMeta(q.tokenOut);
      poolPrepared = prepared;
      out.innerHTML = `<h3>${label} quote — graduated pool (concentrated), block ${q.quoteBlockNumber}</h3>
      <table>
        <tr><td>Pool</td><td>${addrLink(state.canonicalPool)}</td></tr>
        <tr><td>You pay</td><td>${formatUnits(amountIn, inMeta.decimals)} ${esc(inMeta.symbol)}</td></tr>
        <tr><td>You receive (expected)</td><td>${formatUnits(q.expectedAmountOut, outMeta.decimals)} ${esc(outMeta.symbol)}</td></tr>
        <tr><td>Minimum out (slippage ${slippageBps} bps)</td><td>${formatUnits(q.minimumAmountOut, outMeta.decimals)} ${esc(outMeta.symbol)}</td></tr>
      </table>
      <p class="muted">Quote from the concentrated pool. The swap is planned fresh again when you click Buy/Sell.</p>`;
      $("btn-trade").disabled = !account;
      $("btn-trade").textContent = `${label} via pool (sign in wallet)`;
      if (!account) out.innerHTML += `<p class="warn-t">Connect your wallet to trade.</p>`;
    } else {
      throw new Error(`Curve status ${curveState.state.status} (${STATUS_LABEL[curveState.state.status]}) does not trade here. Status 2 needs migration; status 0 is not initialized.`);
    }
  } catch (e) { out.innerHTML = `<p class="err">${esc(errText(e))}</p>`; }
}
$("btn-quote").addEventListener("click", quoteTrade);
$("btn-trade").addEventListener("click", async () => {
  const status = $("trade-status");
  try {
    requireWallet();
    if (!curveState) throw new Error("Load a curve first.");
    const { tokenIn, tokenOut, baseForQuote, label } = tradeTokens();
    const inMeta = await tokenMeta(tokenIn);
    const amountIn = mustAmount($("trade-amount").value, inMeta.decimals, "Amount");
    const slippageBps = Number($("trade-slippage").value || SLIPPAGE_DEFAULT_BPS);
    status.textContent = "Planning (fresh quote)…";
    if (tradeMode === "curve") {
      const { address: curve, sdk } = curveState;
      const block = await publicClient.getBlock({ blockNumber: await latestBlock() });
      const quote = await sdk.quoteExactInputAtBlock(amountIn, baseForQuote, block.number);
      const fill = classifyAmmoraV4ExactInputFill(quote, baseForQuote);
      if (fill.kind !== "full" && fill.kind !== "graduation-boundary") throw new Error(`Unexpected fill ${fill.kind} — refusing to send a partial order.`);
      const plan = await sdk.planSwapExactInput({
        includedAmountIn: amountIn, baseForQuote, allowPartialFill: fill.allowPartialFill,
        slippageBps, recipient: account, deadline: block.timestamp + 1800n,
      });
      status.textContent = "Approval (exact amount) — confirm in wallet…";
      const appr = plan.approvalRequirement;
      const approvalHashes = await ensureApproval(appr.token, appr.spender, appr.amount, appr.resetToZero);
      status.textContent = `Approval sent (${approvalHashes.map(short).join(", ") || "already sufficient"}). Confirm the swap in your wallet…`;
      const { hash, receipt } = await sendAndWait({ to: plan.transaction.to, data: plan.transaction.data, value: plan.transaction.value ?? 0n });
      const parsed = parseAmmoraV4SwapReceipt(receipt, curve, { trader: account, recipient: account, baseForQuote, requestedAmountIn: amountIn, minimumAmountOut: plan.quote.minimumAmountOut });
      const outMeta = await tokenMeta(tokenOut);
      status.innerHTML = `<span class="ok">${label} ✓</span> ${txLink(hash)} — received ${formatUnits(parsed.amountOut, outMeta.decimals)} ${esc(outMeta.symbol)}, block ${receipt.blockNumber}.`;
      $("quote-out").innerHTML = `<p class="ok">Swap confirmed. Received ${formatUnits(parsed.amountOut, outMeta.decimals)} ${esc(outMeta.symbol)} (consumed ${formatUnits(parsed.consumedAmountIn, inMeta.decimals)} ${esc(inMeta.symbol)}, left ${formatUnits(parsed.amountLeft, inMeta.decimals)}).</p>`;
    } else if (tradeMode === "pool") {
      const { state } = curveState;
      const block = await latestBlock();
      const swaps = await AmmoraSwapClient.create(publicClient, { deploymentCatalog: { [CHAIN_ID]: DEPLOYMENT }, factoryProfiles: giwaSepoliaAutoRoutePoolProfiles });
      const prepared = await swaps.prepareExactIn({
        model: "concentrated", pool: state.canonicalPool, tokenIn,
        inputAsset: "erc20", amountIn, payer: account, recipient: account,
        slippageBps, executionMode: "direct-wallet",
      }, block);
      const q = prepared.quote;
      status.textContent = "Approval (exact amount) — confirm in wallet…";
      const approvalHashes = [];
      for (const req of prepared.approvalRequirements) approvalHashes.push(...await ensureApproval(req.token, req.spender, req.amount, req.resetToZero));
      status.textContent = `Approval sent (${approvalHashes.map(short).join(", ") || "already sufficient"}). Confirm the swap in your wallet…`;
      const { hash, receipt } = await sendAndWait({ to: prepared.transaction.to, data: prepared.transaction.data, value: prepared.transaction.value ?? 0n });
      const outMeta = await tokenMeta(q.tokenOut);
      status.innerHTML = `<span class="ok">${label} via pool ✓</span> ${txLink(hash)} — expected ${formatUnits(q.expectedAmountOut, outMeta.decimals)} ${esc(outMeta.symbol)} (min ${formatUnits(q.minimumAmountOut, outMeta.decimals)}), block ${receipt.blockNumber}. Verify the received amount in your wallet / explorer.`;
    } else throw new Error("This curve status cannot trade here.");
    await refreshBalances();
  } catch (e) { status.innerHTML = `<span class="err">${esc(errText(e))}</span>`; }
});
$("btn-migrate").addEventListener("click", async () => {
  const status = $("migrate-status");
  try {
    requireWallet();
    if (!curveState || curveState.state.status !== 2) throw new Error("Curve is not ReadyToMigrate.");
    status.textContent = "Planning migration…";
    const block = await latestBlock();
    const plan = await curveState.sdk.planMigrateAtBlock(block);
    status.textContent = "Confirm the migration in your wallet…";
    const { hash, receipt } = await sendAndWait({ to: plan.transaction.to, data: plan.transaction.data, value: plan.transaction.value ?? 0n });
    status.innerHTML = `<span class="ok">Migrated ✓</span> ${txLink(hash)} — block ${receipt.blockNumber}. Reload the curve to trade on the pool.`;
    await loadCurve(curveState.address);
  } catch (e) { status.innerHTML = `<span class="err">${esc(errText(e))}</span>`; }
});

// ---------------------------------------------------------------- launch: Config
// Port of examples/src/launch/config-from-template.ts (SDK math, same formulas).
function deriveConfigFromTemplate(template, saleSupply, migrationQuoteThreshold) {
  if (saleSupply <= 0n || migrationQuoteThreshold <= 0n) throw new RangeError("Sale supply and quote threshold must be positive.");
  if (template.config.migrationMode !== AmmoraV4MigrationMode.Concentrated) {
    throw new RangeError("This helper supports concentrated graduation only (migrationMode 0).");
  }
  const curve = buildSingleSegmentCurve(template.config.startSqrtPrice, saleSupply, migrationQuoteThreshold);
  const segment = curve[0];
  if (!segment) throw new Error("Single-segment curve construction returned no segment.");
  const range = { sqrtPriceX64: segment.upperSqrtPrice, sqrtMinPriceX64: segment.lowerSqrtPrice, sqrtMaxPriceX64: segment.upperSqrtPrice * 2n };
  const quoteFee = migrationQuoteThreshold * BigInt(template.config.migrationQuoteFeeBps) / 10_000n;
  const quoteAfterFee = migrationQuoteThreshold - quoteFee;
  const destination = concentratedDepositQuote(range, { quoteAmount: quoteAfterFee });
  const vesting = template.config.lockedBaseVesting;
  const lockedBase = vesting.cliffUnlockAmount + vesting.amountPerPeriod * BigInt(vesting.numberOfPeriods);
  const config = {
    ...template.config,
    totalSupply: saleSupply + destination.baseAmount + lockedBase,
    migrationQuoteThreshold,
    migrationBaseThreshold: destination.baseAmount,
    postMigrationSqrtMinPrice: range.sqrtMinPriceX64,
    postMigrationSqrtMaxPrice: range.sqrtMaxPriceX64,
    postMigrationLiquidity: destination.liquidity,
  };
  assertAmmoraV4Config(config, curve);
  return { config, curve, economics: {
    saleAllocationRaw: saleSupply, grossMigrationBaseRaw: destination.baseAmount,
    grossMigrationQuoteRaw: destination.quoteAmount, migrationQuoteFeeRaw: quoteFee,
    quoteSurplusToProtocolRaw: quoteAfterFee - destination.quoteAmount,
    lockedBaseRaw: lockedBase, totalSupplyRaw: config.totalSupply,
  } };
}
// Port of examples/src/launch/team/policy.ts planTeamConfig (reviewHash binding).
function planTeamConfig(template, policy, saleSupply, quoteThreshold) {
  if (template.configId !== BigInt(policy.templateId) || template.configHash.toLowerCase() !== policy.templateHash.toLowerCase()) {
    throw new Error("Template identity/hash does not match the reviewed policy.");
  }
  if (!template.enabled) throw new Error(`Template Config #${policy.templateId} is disabled.`);
  const derived = deriveConfigFromTemplate(template, saleSupply, quoteThreshold);
  const config = {
    ...derived.config,
    partnerRecipient: policy.partnerRecipient,
    leftoverReceiver: policy.leftoverReceiver,
    creatorShareOfNonProtocolBps: policy.creatorShareBps,
    liquidityDistribution: { ...derived.config.liquidityDistribution, partner: policy.liquidityPartner },
  };
  assertAmmoraV4Config(config, derived.curve);
  const transaction = { to: policy.registry, ...buildCreateAmmoraV4Config(config, derived.curve, policy.configOwner) };
  const reviewHash = keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes" }],
    [BigInt(policy.chainId), transaction.to, 0n, transaction.data],
  ));
  return { ...derived, config, transaction, reviewHash };
}
function readConfigForm() {
  const owner = mustAddress($("cfg-owner").value || account, "Config owner");
  const bps = Number($("cfg-creator-bps").value);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) throw new Error("Creator share must be 0–10000 bps.");
  return {
    schemaVersion: 1, chainId: CHAIN_ID, registry: REGISTRY,
    templateId: String(Number($("cfg-template").value) || TEMPLATE_ID_DEFAULT),
    templateHash: $("cfg-template-hash").value.trim(),
    configOwner: owner,
    partnerRecipient: mustAddress($("cfg-partner").value || account, "Partner recipient"),
    liquidityPartner: mustAddress($("cfg-lp").value || account, "Liquidity partner"),
    leftoverReceiver: mustAddress($("cfg-leftover").value || account, "Leftover receiver"),
    creatorShareBps: bps,
  };
}
async function buildConfigPreview() {
  const policy = readConfigForm();
  const templateId = BigInt(policy.templateId);
  const block = await latestBlock();
  const template = await getAmmoraV4ConfigAtBlock(publicClient, REGISTRY, templateId, block);
  const tokenDecimals = template.config.tokenDecimals;
  const saleSupply = mustAmount($("cfg-supply").value, tokenDecimals, "Sale supply");
  const quoteThreshold = mustAmount($("cfg-threshold").value, 18, "Quote threshold");
  return planTeamConfig(template, policy, saleSupply, quoteThreshold);
}
$("btn-cfg-preview").addEventListener("click", async () => {
  const out = $("cfg-preview-out");
  out.hidden = false; out.innerHTML = `<p class="muted">Deriving Config from template… (read-only, no key, no funds)</p>`;
  $("btn-cfg-create").disabled = true; pendingConfig = null;
  try {
    const plan = await buildConfigPreview();
    pendingConfig = plan;
    const e = plan.economics;
    out.innerHTML = `<h3>Preview — review before creating</h3>
    <table>
      <tr><td>reviewHash</td><td class="mono">${plan.reviewHash}</td></tr>
      <tr><td>Config owner</td><td>${addrLink(getAddress($("cfg-owner").value || account))}</td></tr>
      <tr><td>Partner recipient</td><td>${addrLink(plan.config.partnerRecipient)}</td></tr>
      <tr><td>Liquidity partner</td><td>${addrLink(plan.config.liquidityDistribution.partner)}</td></tr>
      <tr><td>Leftover receiver</td><td>${addrLink(plan.config.leftoverReceiver)}</td></tr>
      <tr><td>Creator share</td><td>${plan.config.creatorShareOfNonProtocolBps} bps of non-protocol fees</td></tr>
      <tr><td>Sale allocation</td><td class="mono">${e.saleAllocationRaw} raw</td></tr>
      <tr><td>Migration base</td><td class="mono">${e.grossMigrationBaseRaw} raw</td></tr>
      <tr><td>Migration quote (gross)</td><td class="mono">${e.grossMigrationQuoteRaw} raw</td></tr>
      <tr><td>Migration quote fee</td><td class="mono">${e.migrationQuoteFeeRaw} raw</td></tr>
      <tr><td>Total supply</td><td class="mono">${e.totalSupplyRaw} raw</td></tr>
      <tr><td>Token decimals</td><td>${plan.config.tokenDecimals}</td></tr>
      <tr><td>Quote token</td><td>${addrLink(plan.config.quoteToken)}</td></tr>
      <tr><td>Registry (to)</td><td>${addrLink(plan.transaction.to)}</td></tr>
    </table>
    <p class="muted">This preview was verified live against the CLI flow (<span class="mono">launch:team-config preview</span>): same derivation, same reviewHash formula. Creating re-runs the preview and refuses on any hash mismatch.</p>`;
    $("btn-cfg-create").disabled = !account;
    if (!account) out.innerHTML += `<p class="warn-t">Connect your wallet to create (the Config owner pays gas).</p>`;
  } catch (e) { out.innerHTML = `<p class="err">${esc(errText(e))}</p>`; }
});
$("btn-cfg-create").addEventListener("click", async () => {
  const status = $("cfg-create-status");
  try {
    requireWallet();
    if (!pendingConfig) throw new Error("Run Preview first.");
    status.textContent = "Re-running preview to check the reviewHash…";
    const fresh = await buildConfigPreview();
    if (fresh.reviewHash.toLowerCase() !== pendingConfig.reviewHash.toLowerCase()) {
      throw new Error("reviewHash mismatch: inputs changed since the preview — run Preview again.");
    }
    status.textContent = "Confirm the creation in your wallet (gas only)…";
    const { hash, receipt } = await sendAndWait({ to: pendingConfig.transaction.to, data: pendingConfig.transaction.data });
    const created = parseAmmoraV4ConfigCreatedReceipt(receipt, REGISTRY);
    const confirmed = await getAmmoraV4ConfigAtBlock(publicClient, REGISTRY, created.configId, receipt.blockNumber);
    if (confirmed.configHash !== created.configHash) throw new Error("Receipt-bound Config identity does not match registry storage.");
    $("cfg-created-out").hidden = false;
    $("cfg-created-out").innerHTML = `<h3>Config created ✓</h3>
    <table>
      <tr><td>Config ID</td><td><strong>#${created.configId}</strong></td></tr>
      <tr><td>Config hash</td><td class="mono">${created.configHash}</td></tr>
      <tr><td>Owner</td><td>${addrLink(created.owner)}</td></tr>
      <tr><td>Fee claimer</td><td>${addrLink(created.feeClaimer)}</td></tr>
      <tr><td>Tx</td><td>${txLink(hash)}</td></tr>
      <tr><td>Block</td><td>${receipt.blockNumber}</td></tr>
    </table>`;
    status.innerHTML = `<span class="ok">Created #${created.configId} ✓</span>`;
    pendingConfig = null; $("btn-cfg-create").disabled = true;
  } catch (e) { status.innerHTML = `<span class="err">${esc(errText(e))}</span>`; }
});

// ---------------------------------------------------------------- launch: issue token
$("btn-iss-load").addEventListener("click", async () => {
  const out = $("iss-out");
  out.hidden = false; out.innerHTML = `<p class="muted">Reading Config…</p>`;
  $("btn-iss-issue").disabled = true; issueConfig = null;
  try {
    const configId = BigInt(Number($("iss-config").value));
    if (configId <= 0n) throw new Error("Config ID must be positive.");
    const block = await latestBlock();
    const entry = await getAmmoraV4ConfigAtBlock(publicClient, REGISTRY, configId, block);
    if (!entry.enabled) throw new Error(`Config #${configId} is disabled, so it cannot be launched on.`);
    issueConfig = { entry, poolCreationFee: entry.config.poolCreationFee };
    $("iss-decimals").value = entry.config.tokenDecimals;
    out.innerHTML = `<h3>Config #${configId} — ready to issue</h3>
    <table>
      <tr><td>Hash</td><td class="mono">${entry.configHash}</td></tr>
      <tr><td>Token decimals</td><td>${entry.config.tokenDecimals} (issue must match)</td></tr>
      <tr><td>poolCreationFee</td><td><strong>${formatUnits(entry.config.poolCreationFee, 18)} ETH</strong> (${entry.config.poolCreationFee} wei, native ETH value)</td></tr>
      <tr><td>Quote token</td><td>${addrLink(entry.config.quoteToken)}</td></tr>
      <tr><td>Owner</td><td>${addrLink(entry.identity.owner)}</td></tr>
    </table>`;
    $("btn-iss-issue").disabled = !account;
    if (!account) out.innerHTML += `<p class="warn-t">Connect your wallet to issue (the Creator pays gas + poolCreationFee).</p>`;
  } catch (e) { out.innerHTML = `<p class="err">${esc(errText(e))}</p>`; }
});
$("btn-iss-issue").addEventListener("click", async () => {
  const status = $("iss-status");
  try {
    requireWallet();
    if (!issueConfig) throw new Error("Load the Config first.");
    const { entry } = issueConfig;
    const configId = entry.configId;
    const name = $("iss-name").value.trim();
    const symbol = $("iss-symbol").value.trim();
    const metadataURI = $("iss-uri").value.trim();
    if (!name || !symbol || !metadataURI) throw new Error("Name, symbol and metadata URI are all required.");
    const tokenDecimals = Number($("iss-decimals").value);
    if (tokenDecimals !== entry.config.tokenDecimals) throw new Error("Decimals must match the selected immutable Config.");
    status.textContent = "Building launch (unsigned)…";
    const tx = buildCreateAmmoraV4Launch({ name, symbol, metadataURI, creatorMetadataURI: metadataURI, tokenDecimals }, configId, entry.config.poolCreationFee);
    status.textContent = `Confirm in your wallet — value ${formatUnits(tx.value ?? 0n, 18)} ETH (poolCreationFee) + gas…`;
    const { hash, receipt } = await sendAndWait({ to: FACTORY, data: tx.data, value: tx.value ?? 0n });
    const created = parseAmmoraV4LaunchCreatedReceipt(receipt, FACTORY);
    if (created.configId !== configId || created.configHash !== entry.configHash) throw new Error("Launch receipt does not match the selected Config.");
    $("iss-out").innerHTML = `<h3>Token issued ✓</h3>
    <table>
      <tr><td>Token</td><td>${addrLink(created.token)}</td></tr>
      <tr><td>Curve</td><td>${addrLink(created.curve)}</td></tr>
      <tr><td>Creator</td><td>${addrLink(created.creator)}</td></tr>
      <tr><td>Config</td><td>#${created.configId}</td></tr>
      <tr><td>Tx</td><td>${txLink(hash)}</td></tr>
      <tr><td>Block</td><td>${receipt.blockNumber}</td></tr>
    </table>
    <div class="row"><button class="btn" id="btn-trade-new">Trade this curve</button></div>`;
    status.innerHTML = `<span class="ok">Issued ✓</span>`;
    $("btn-trade-new").addEventListener("click", () => { $("lookup-curve").value = created.curve; loadCurve(created.curve); document.getElementById("trade-card").scrollIntoView({ behavior: "smooth" }); });
    issueConfig = null; $("btn-iss-issue").disabled = true;
  } catch (e) { status.innerHTML = `<span class="err">${esc(errText(e))}</span>`; }
});

// ---------------------------------------------------------------- fees
async function readFeeVault() {
  if (feeVaultAddr) return feeVaultAddr;
  const block = await latestBlock();
  feeVaultAddr = await publicClient.readContract({ address: FACTORY, abi: ammoraLaunchFactoryV4Abi, functionName: "feeVault", blockNumber: block });
  return feeVaultAddr;
}
$("btn-fee-load").addEventListener("click", async () => {
  const out = $("fee-out");
  out.hidden = false; out.innerHTML = `<p class="muted">Reading claimable fees…</p>`;
  try {
    const configId = BigInt(Number($("fee-config").value));
    if (configId <= 0n) throw new Error("Config ID must be positive.");
    const beneficiary = mustAddress($("fee-beneficiary").value || account, "Beneficiary");
    const baseToken = mustAddress($("fee-base").value, "Base token");
    const block = await latestBlock();
    const entry = await getAmmoraV4ConfigAtBlock(publicClient, REGISTRY, configId, block);
    const vault = await readFeeVault();
    const quoteToken = entry.config.quoteToken;
    const [claimQuote, claimBase] = await Promise.all([
      publicClient.readContract({ address: vault, abi: feeVaultAbi, functionName: "claimable", args: [quoteToken, beneficiary], blockNumber: block }),
      publicClient.readContract({ address: vault, abi: feeVaultAbi, functionName: "claimable", args: [baseToken, beneficiary], blockNumber: block }),
    ]);
    const quoteMeta = await tokenMeta(quoteToken);
    const baseMeta = await tokenMeta(baseToken);
    out.innerHTML = `<h3>Claimable for ${short(beneficiary)} — Config #${configId}</h3>
    <table>
      <tr><td>Fee vault</td><td>${addrLink(vault)}</td></tr>
      <tr><td>Quote (${esc(quoteMeta.symbol)})</td><td><strong>${formatUnits(claimQuote, quoteMeta.decimals)} ${esc(quoteMeta.symbol)}</strong> <span class="mono">(${claimQuote} raw)</span></td></tr>
      <tr><td>Base (${esc(baseMeta.symbol)})</td><td><strong>${formatUnits(claimBase, baseMeta.decimals)} ${esc(baseMeta.symbol)}</strong> <span class="mono">(${claimBase} raw)</span></td></tr>
    </table>
    <div class="row">
      <button class="btn primary" id="btn-claim-quote" ${claimQuote === 0n ? "disabled" : ""}>Claim quote (${esc(quoteMeta.symbol)})</button>
      <button class="btn primary" id="btn-claim-base" ${claimBase === 0n ? "disabled" : ""}>Claim base (${esc(baseMeta.symbol)})</button>
      <span id="claim-status" class="muted">${claimQuote === 0n && claimBase === 0n ? "Nothing owed — no transaction will be sent." : ""}</span>
    </div>
    <p class="muted">Quote and base are claimed separately. Claim pays to the beneficiary (payout = beneficiary here); claiming one asset never claims the other.</p>`;
    const claim = async (token, label) => {
      const st = $("claim-status");
      try {
        requireWallet();
        if (account.toLowerCase() !== beneficiary.toLowerCase()) throw new Error("The connected wallet must be the beneficiary to claim its fees.");
        const owed = await publicClient.readContract({ address: vault, abi: feeVaultAbi, functionName: "claimable", args: [token, beneficiary] });
        if (owed === 0n) throw new Error("Nothing owed for this token — no transaction sent.");
        st.textContent = "Confirm the claim in your wallet…";
        const { data } = buildClaimFeeVaultFor(token, beneficiary, beneficiary);
        const { hash, receipt } = await sendAndWait({ to: vault, data });
        st.innerHTML = `<span class="ok">${label} claimed ✓</span> ${txLink(hash)} — block ${receipt.blockNumber}.`;
        $("btn-fee-load").click();
      } catch (e) { st.innerHTML = `<span class="err">${esc(errText(e))}</span>`; }
    };
    $("btn-claim-quote").addEventListener("click", () => claim(quoteToken, quoteMeta.symbol));
    $("btn-claim-base").addEventListener("click", () => claim(baseToken, baseMeta.symbol));
  } catch (e) { out.innerHTML = `<p class="err">${esc(errText(e))}</p>`; }
});

// ---------------------------------------------------------------- Quick Launch (guided: preview -> Config -> token -> wrap -> buy)
// Same SDK calls as the manual sections above, chained into one guided flow.
// Every write is still a separate wallet confirmation: no transaction is sent
// until the user clicks that step's button and confirms in their own wallet.
const QL_SUPPLY_TOKENS = "1000000";
const QL_CREATOR_BPS = 7000;
let ql = { plan: null, name: "", symbol: "", capitalRaw: 0n, tokenDecimals: 9, configId: null, configHash: null, token: null, curve: null, logoDataUri: null, symbolDirty: false };

function b64encodeUnicode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(bin);
}
function qlMetadataURI(name, symbol) {
  const meta = { name, symbol };
  if (ql.logoDataUri) meta.image = ql.logoDataUri;
  else {
    const url = $("ql-logo-url").value.trim();
    if (url) {
      if (!/^(https?:\/\/|ipfs:\/\/)/i.test(url)) throw new Error("Logo URL harus diawali https:// atau ipfs://");
      meta.image = url;
    }
  }
  return "data:application/json;base64," + b64encodeUnicode(JSON.stringify(meta));
}
function qlSetStep(step, state, note) {
  const el = $(`ql-st-${step}`);
  el.textContent = note ?? state;
  el.className = `step-state ${state}`;
}
$("ql-name").addEventListener("input", () => {
  if (ql.symbolDirty) return;
  $("ql-symbol").value = $("ql-name").value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
});
$("ql-symbol").addEventListener("input", () => { ql.symbolDirty = true; });
$("ql-logo-file").addEventListener("change", () => {
  const f = $("ql-logo-file").files?.[0];
  const note = $("ql-logo-note"), prev = $("ql-logo-preview");
  ql.logoDataUri = null; prev.hidden = true; prev.src = "";
  if (!f) { note.textContent = ""; return; }
  if (!f.type.startsWith("image/")) { note.innerHTML = `<span class="err">File harus gambar.</span>`; return; }
  if (f.size > 1024 * 1024) { note.innerHTML = `<span class="err">Logo terlalu besar (&gt;1 MB) — metadata on-chain jadi mahal. Pakai gambar lebih kecil atau URL.</span>`; return; }
  note.innerHTML = f.size > 100 * 1024 ? `<span class="warn-t">Logo ${Math.round(f.size / 1024)} KB — akan masuk ke metadata on-chain, gas lebih besar dari biasanya.</span>` : "";
  const reader = new FileReader();
  reader.onload = () => { ql.logoDataUri = String(reader.result); prev.src = ql.logoDataUri; prev.hidden = false; };
  reader.onerror = () => { note.innerHTML = `<span class="err">Gagal membaca file logo.</span>`; };
  reader.readAsDataURL(f);
});
async function buildQLPlan() {
  requireWallet();
  const name = $("ql-name").value.trim();
  const symbol = $("ql-symbol").value.trim().toUpperCase();
  if (!name) throw new Error("Isi nama token dulu.");
  if (!symbol) throw new Error("Isi symbol token dulu.");
  const capital = mustAmount($("ql-capital").value, 18, "Modal awal");
  const block = await latestBlock();
  const template = await getAmmoraV4ConfigAtBlock(publicClient, REGISTRY, BigInt(TEMPLATE_ID_DEFAULT), block);
  const tokenDecimals = template.config.tokenDecimals;
  const saleSupply = mustAmount(QL_SUPPLY_TOKENS, tokenDecimals, "Sale supply");
  const policy = { schemaVersion: 1, chainId: CHAIN_ID, registry: REGISTRY, templateId: String(TEMPLATE_ID_DEFAULT), templateHash: TEMPLATE_HASH_DEFAULT, configOwner: account, partnerRecipient: account, liquidityPartner: account, leftoverReceiver: account, creatorShareBps: QL_CREATOR_BPS };
  const plan = planTeamConfig(template, policy, saleSupply, capital);
  return { plan, name, symbol, capital, tokenDecimals };
}
$("btn-ql-start").addEventListener("click", async () => {
  const status = $("ql-status");
  try {
    requireWallet();
    qlSetStep("preview", "running", "membuat preview…");
    const { plan, name, symbol, capital, tokenDecimals } = await buildQLPlan();
    ql.plan = plan; ql.capitalRaw = capital; ql.name = name; ql.symbol = symbol; ql.tokenDecimals = tokenDecimals;
    const e = plan.economics;
    $("ql-out-preview").innerHTML = `<table>
      <tr><td>Token</td><td><strong>${esc(name)} (${esc(symbol)})</strong>, ${tokenDecimals} decimals</td></tr>
      <tr><td>Modal (threshold)</td><td>${formatUnits(capital, 18)} WETH (${capital} raw)</td></tr>
      <tr><td>Sale supply</td><td class="mono">${e.saleAllocationRaw} raw (1.000.000 token)</td></tr>
      <tr><td>Creator share</td><td>${QL_CREATOR_BPS} bps dari fee non-protocol</td></tr>
      <tr><td>reviewHash</td><td class="mono">${plan.reviewHash}</td></tr>
      <tr><td>Config owner</td><td>${addrLink(account)}</td></tr>
    </table>`;
    qlSetStep("preview", "done", "preview siap ✓");
    $("btn-ql-create").disabled = false;
    status.textContent = "Preview siap — cek angkanya, lalu klik Create Config.";
  } catch (e) { qlSetStep("preview", "error", "gagal"); $("ql-out-preview").innerHTML = `<p class="err">${esc(errText(e))}</p>`; status.textContent = ""; }
});
$("btn-ql-create").addEventListener("click", async () => {
  try {
    requireWallet();
    if (!ql.plan) throw new Error("Jalankan preview dulu.");
    qlSetStep("create", "running", "cek ulang preview…");
    const fresh = await buildQLPlan();
    if (fresh.plan.reviewHash.toLowerCase() !== ql.plan.reviewHash.toLowerCase()) throw new Error("reviewHash berubah — input berubah sejak preview. Mulai lagi dari preview.");
    qlSetStep("create", "running", "konfirmasi di wallet…");
    const { hash, receipt } = await sendAndWait({ to: ql.plan.transaction.to, data: ql.plan.transaction.data });
    const created = parseAmmoraV4ConfigCreatedReceipt(receipt, REGISTRY);
    ql.configId = created.configId; ql.configHash = created.configHash;
    $("ql-out-create").innerHTML = `<table><tr><td>Config ID</td><td><strong>#${created.configId}</strong></td></tr><tr><td>Config hash</td><td class="mono">${created.configHash}</td></tr><tr><td>Tx</td><td>${txLink(hash)}</td></tr><tr><td>Block</td><td>${receipt.blockNumber}</td></tr></table>`;
    qlSetStep("create", "done", "Config dibuat ✓");
    $("btn-ql-create").disabled = true; $("btn-ql-issue").disabled = false;
    qlSetStep("issue", "pending", "siap");
  } catch (e) { qlSetStep("create", "error", "gagal"); $("ql-out-create").innerHTML = `<p class="err">${esc(errText(e))}</p>`; }
});
$("btn-ql-issue").addEventListener("click", async () => {
  try {
    requireWallet();
    if (!ql.configId) throw new Error("Buat Config dulu.");
    qlSetStep("issue", "running", "membaca Config…");
    const block = await latestBlock();
    const entry = await getAmmoraV4ConfigAtBlock(publicClient, REGISTRY, ql.configId, block);
    const metadataURI = qlMetadataURI(ql.name, ql.symbol);
    qlSetStep("issue", "running", `konfirmasi di wallet — poolCreationFee ${formatUnits(entry.config.poolCreationFee, 18)} ETH…`);
    const tx = buildCreateAmmoraV4Launch({ name: ql.name, symbol: ql.symbol, metadataURI, creatorMetadataURI: metadataURI, tokenDecimals: ql.tokenDecimals }, ql.configId, entry.config.poolCreationFee);
    const { hash, receipt } = await sendAndWait({ to: FACTORY, data: tx.data, value: tx.value ?? 0n });
    const created = parseAmmoraV4LaunchCreatedReceipt(receipt, FACTORY);
    if (created.configId !== ql.configId) throw new Error("Receipt token tidak cocok dengan Config.");
    ql.token = created.token; ql.curve = created.curve;
    $("ql-out-issue").innerHTML = `<table><tr><td>Token</td><td>${addrLink(created.token)}</td></tr><tr><td>Curve</td><td>${addrLink(created.curve)}</td></tr><tr><td>Tx</td><td>${txLink(hash)}</td></tr><tr><td>Block</td><td>${receipt.blockNumber}</td></tr></table>`;
    qlSetStep("issue", "done", "token diterbitkan ✓");
    $("btn-ql-issue").disabled = true; $("btn-ql-wrap").disabled = false;
    qlSetStep("wrap", "pending", "siap");
  } catch (e) { qlSetStep("issue", "error", "gagal"); $("ql-out-issue").innerHTML = `<p class="err">${esc(errText(e))}</p>`; }
});
$("btn-ql-wrap").addEventListener("click", async () => {
  try {
    requireWallet();
    qlSetStep("wrap", "running", `konfirmasi di wallet — wrap ${formatUnits(ql.capitalRaw, 18)} ETH…`);
    const { hash, receipt } = await sendAndWait({ to: WETH, data: encodeFunctionData({ abi: WETH_DEPOSIT_ABI, functionName: "deposit" }), value: ql.capitalRaw });
    $("ql-out-wrap").innerHTML = `<p>Wrapped ${formatUnits(ql.capitalRaw, 18)} ETH → WETH. ${txLink(hash)} — blok ${receipt.blockNumber}.</p>`;
    qlSetStep("wrap", "done", "wrapped ✓");
    $("btn-ql-wrap").disabled = true; $("btn-ql-buy").disabled = false;
    qlSetStep("buy", "pending", "siap");
    await refreshBalances();
  } catch (e) { qlSetStep("wrap", "error", "gagal"); $("ql-out-wrap").innerHTML = `<p class="err">${esc(errText(e))}</p>`; }
});
$("btn-ql-buy").addEventListener("click", async () => {
  try {
    requireWallet();
    if (!ql.curve) throw new Error("Terbitkan token dulu.");
    qlSetStep("buy", "running", "quote buy…");
    const curve = ql.curve;
    const block = await latestBlock();
    const sdk = new AmmoraV4LaunchCurveClient(publicClient, curve, CURVE_CORE);
    const state = await sdk.getStateAtBlock(block);
    if (state.status !== 1) throw new Error(`Curve belum aktif (status ${state.status}).`);
    const amountIn = ql.capitalRaw;
    const quote = await sdk.quoteExactInputAtBlock(amountIn, false, block);
    const fill = classifyAmmoraV4ExactInputFill(quote, false);
    if (fill.kind !== "full" && fill.kind !== "graduation-boundary") throw new Error(`Fill ${fill.kind} — buy dibatalkan.`);
    const minOut = quote.amountOut * BigInt(10000 - SLIPPAGE_DEFAULT_BPS) / 10000n;
    if (minOut === 0n) throw new Error("Minimum output nol.");
    const blockNow = await publicClient.getBlock({ blockNumber: await latestBlock() });
    const plan = await sdk.planSwapExactInput({ includedAmountIn: amountIn, baseForQuote: false, allowPartialFill: fill.allowPartialFill, slippageBps: SLIPPAGE_DEFAULT_BPS, recipient: account, deadline: blockNow.timestamp + 1800n });
    qlSetStep("buy", "running", `quote: terima ~${formatUnits(quote.amountOut, ql.tokenDecimals)} ${esc(ql.symbol)} (min ${formatUnits(minOut, ql.tokenDecimals)}) — approval dulu, konfirmasi di wallet…`);
    const appr = plan.approvalRequirement;
    const approvalHashes = await ensureApproval(appr.token, appr.spender, appr.amount, appr.resetToZero);
    qlSetStep("buy", "running", "approval ok — konfirmasi swap di wallet…");
    const { hash, receipt } = await sendAndWait({ to: plan.transaction.to, data: plan.transaction.data, value: plan.transaction.value ?? 0n });
    const parsed = parseAmmoraV4SwapReceipt(receipt, curve, { trader: account, recipient: account, baseForQuote: false, requestedAmountIn: amountIn, minimumAmountOut: plan.quote.minimumAmountOut });
    $("ql-out-buy").innerHTML = `<table><tr><td>Dibayar</td><td>${formatUnits(amountIn, 18)} WETH</td></tr><tr><td>Diterima</td><td><strong>${formatUnits(parsed.amountOut, ql.tokenDecimals)} ${esc(ql.symbol)}</strong></td></tr><tr><td>Tx</td><td>${txLink(hash)}</td></tr><tr><td>Block</td><td>${receipt.blockNumber}</td></tr></table>`;
    qlSetStep("buy", "done", "buy selesai ✓");
    $("btn-ql-buy").disabled = true;
    const done = $("ql-done");
    done.hidden = false;
    done.innerHTML = `<h3>🎉 Token kamu sudah live!</h3>
    <table>
      <tr><td>Token</td><td>${addrLink(ql.token)}</td></tr>
      <tr><td>Curve</td><td>${addrLink(ql.curve)}</td></tr>
      <tr><td>Config</td><td>#${ql.configId}</td></tr>
      <tr><td>Nama / symbol</td><td>${esc(ql.name)} (${esc(ql.symbol)})</td></tr>
      <tr><td>Token kamu</td><td>${formatUnits(parsed.amountOut, ql.tokenDecimals)} ${esc(ql.symbol)}</td></tr>
    </table>
    <div class="row"><button class="btn" id="btn-ql-trade">Trade / Boost curve ini</button>
    <button class="btn" id="btn-ql-explore">Lihat di explorer</button></div>`;
    $("btn-ql-trade").addEventListener("click", () => { $("lookup-curve").value = ql.curve; loadCurve(ql.curve); document.getElementById("trade-card").scrollIntoView({ behavior: "smooth" }); });
    $("btn-ql-explore").addEventListener("click", () => window.open(`${EXPLORER}/address/${ql.token}`, "_blank"));
    await refreshBalances();
  } catch (e) { qlSetStep("buy", "error", "gagal"); $("ql-out-buy").innerHTML = `<p class="err">${esc(errText(e))}</p>`; }
});
$("btn-ql-reset").addEventListener("click", () => location.reload());

// ---------------------------------------------------------------- Boost volume (buy -> sell loop on the loaded curve)
// Testnet only. Each leg is previewed (fresh quote + fill check) and sent only
// after the user confirms that transaction in their own wallet. Approvals are
// exact-amount per trade. Total spend per run is capped at 0.05 WETH.
const BOOST_MAX_TOTAL_WETH = parseUnits("0.05", 18);
let boost = { running: false, stop: false };
async function boostCurveSwap(curve, tokenIn, amountIn, baseForQuote, label) {
  const block = await latestBlock();
  const sdk = new AmmoraV4LaunchCurveClient(publicClient, curve, CURVE_CORE);
  const state = await sdk.getStateAtBlock(block);
  if (state.status !== 1) throw new Error(`Curve tidak aktif (status ${state.status}).`);
  const quote = await sdk.quoteExactInputAtBlock(amountIn, baseForQuote, block);
  const fill = classifyAmmoraV4ExactInputFill(quote, baseForQuote);
  if (fill.kind !== "full") throw new Error(`Fill ${fill.kind} — ${label} dibatalkan (boost hanya jalan kalau fill penuh).`);
  const minOut = quote.amountOut * BigInt(10000 - SLIPPAGE_DEFAULT_BPS) / 10000n;
  if (minOut === 0n) throw new Error("Minimum output nol.");
  const blockNow = await publicClient.getBlock({ blockNumber: await latestBlock() });
  const plan = await sdk.planSwapExactInput({ includedAmountIn: amountIn, baseForQuote, allowPartialFill: false, slippageBps: SLIPPAGE_DEFAULT_BPS, recipient: account, deadline: blockNow.timestamp + 1800n });
  const appr = plan.approvalRequirement;
  const approvalHashes = await ensureApproval(appr.token, appr.spender, appr.amount, appr.resetToZero);
  const { hash, receipt } = await sendAndWait({ to: plan.transaction.to, data: plan.transaction.data, value: plan.transaction.value ?? 0n });
  const parsed = parseAmmoraV4SwapReceipt(receipt, curve, { trader: account, recipient: account, baseForQuote, requestedAmountIn: amountIn, minimumAmountOut: plan.quote.minimumAmountOut });
  return { hash, receipt, amountOut: parsed.amountOut, approvalHashes };
}
$("btn-boost-start").addEventListener("click", async () => {
  const status = $("boost-status"), log = $("boost-log");
  if (boost.running) return;
  try {
    requireWallet();
    const curve = curveState?.address;
    if (!curve) throw new Error("Muat dulu sebuah curve (lewat Quick Launch, Explore, atau Trade di bawah).");
    if (curveState.state.status !== 1) throw new Error(`Curve ${short(curve)} tidak aktif (status ${curveState.state.status}). Boost hanya jalan di curve Active.`);
    const amount = mustAmount($("boost-amount").value, 18, "Jumlah per trade");
    const cycles = Number($("boost-cycles").value);
    if (!Number.isInteger(cycles) || cycles < 1 || cycles > 50) throw new Error("Siklus harus 1–50.");
    const total = amount * BigInt(cycles);
    if (total > BOOST_MAX_TOTAL_WETH) throw new Error(`Total belanja ${formatUnits(total, 18)} WETH melebihi batas 0,05 WETH per run — turunkan jumlah per trade atau siklus.`);
    const wethBal = await publicClient.readContract({ address: WETH, abi: erc20Abi, functionName: "balanceOf", args: [account] });
    if (wethBal < amount) throw new Error(`Saldo WETH ${formatUnits(wethBal, 18)} kurang dari ${formatUnits(amount, 18)} per trade — wrap dulu di seksi Trade.`);
    const { state } = curveState;
    const baseMeta = await tokenMeta(state.baseToken);
    boost.running = true; boost.stop = false;
    $("btn-boost-start").disabled = true; $("btn-boost-stop").disabled = false;
    log.hidden = false;
    log.innerHTML = `<h3>Boost ${short(curve)} — ${cycles} siklus × ${formatUnits(amount, 18)} WETH</h3>`;
    let volume = 0n, spent = 0n, gotBack = 0n, doneCycles = 0;
    for (let i = 1; i <= cycles; i++) {
      if (boost.stop) { log.innerHTML += `<p class="warn-t">Dihentikan user setelah siklus ${doneCycles}.</p>`; break; }
      status.textContent = `Siklus ${i}/${cycles}: quote buy…`;
      const buy = await boostCurveSwap(curve, state.quoteToken, amount, false, `Buy siklus ${i}`);
      status.textContent = `Siklus ${i}/${cycles}: buy ok — quote sell ${formatUnits(buy.amountOut, baseMeta.decimals)} ${esc(baseMeta.symbol)}…`;
      const sell = await boostCurveSwap(curve, state.baseToken, buy.amountOut, true, `Sell siklus ${i}`);
      volume += amount + sell.amountOut; spent += amount; gotBack += sell.amountOut; doneCycles = i;
      log.innerHTML += `<p><strong>Siklus ${i} ✓</strong> — buy ${formatUnits(amount, 18)} WETH → ${formatUnits(buy.amountOut, baseMeta.decimals)} ${esc(baseMeta.symbol)} ${txLink(buy.hash)} · sell → ${formatUnits(sell.amountOut, 18)} WETH ${txLink(sell.hash)} · volume siklus ${formatUnits(amount + sell.amountOut, 18)} WETH</p>`;
      status.textContent = `Siklus ${i}/${cycles} selesai — volume sejauh ini ${formatUnits(volume, 18)} WETH.`;
      await refreshBalances();
    }
    log.innerHTML += `<p><strong>Total volume: ${formatUnits(volume, 18)} WETH</strong> — dibelanjakan ${formatUnits(spent, 18)} WETH, kembali ${formatUnits(gotBack, 18)} WETH, selisih (fee/slippage) ${formatUnits(spent - gotBack, 18)} WETH.</p>`;
    status.innerHTML = `<span class="ok">Boost selesai ✓</span> — total volume ${formatUnits(volume, 18)} WETH (${doneCycles} siklus).`;
  } catch (e) { status.innerHTML = `<span class="err">${esc(errText(e))}</span>`; }
  finally { boost.running = false; $("btn-boost-start").disabled = false; $("btn-boost-stop").disabled = true; }
});
$("btn-boost-stop").addEventListener("click", () => { boost.stop = true; $("boost-status").textContent = "Stop diminta — berhenti setelah transaksi yang sedang berjalan selesai."; });

// ---------------------------------------------------------------- init
initNetwork();
loadCurve(DEMO.curve);
