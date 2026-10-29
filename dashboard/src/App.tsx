import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { getConnector, getVaultsOf, prefetchVault, type Network } from "./near";
import { registerWebMcpTools } from "./webmcp";
import { Icon } from "./icons";
import { Landing } from "./landing";
import { useRoute } from "./ui";
import { Footer, Header } from "./chrome";
import type { Toast } from "./vault";

// Loaded when first opened, so the landing page ships only what it shows.
const Docs = lazy(() => import("./docs").then((m) => ({ default: m.Docs })));
const Onboarding = lazy(() => import("./onboarding").then((m) => ({ default: m.Onboarding })));
const AppPage = lazy(() => import("./vault").then((m) => ({ default: m.AppPage })));

const params = new URLSearchParams(location.search);
const DEFAULT_CONTRACT = params.get("contract") ?? "guard.cm-agentguard.testnet";
const DEFAULT_NETWORK: Network = params.get("network") === "mainnet" ? "mainnet" : "testnet";
const DEFAULT_VAULT = params.get("vault");
// Opening a vault link: fetch the vault while the dashboard code downloads, not after.
if (DEFAULT_VAULT && /^\d+$/.test(DEFAULT_VAULT) && (location.hash.startsWith("#/app") || !location.hash)) {
  prefetchVault(DEFAULT_NETWORK, DEFAULT_CONTRACT, Number(DEFAULT_VAULT));
}
const DEMO = { network: "testnet" as Network, contract: "guard.cm-agentguard.testnet", vault: 6 };
export function App() {
  const [network, setNetwork] = useState<Network>(DEFAULT_NETWORK);
  const [contract, setContract] = useState(DEFAULT_CONTRACT);
  const [account, setAccount] = useState<string | null>(null);
  const [vaultId, setVaultId] = useState<number | null>(DEFAULT_VAULT && /^\d+$/.test(DEFAULT_VAULT) ? Number(DEFAULT_VAULT) : null);
  const [myVaults, setMyVaults] = useState<number[]>([]);
  const [toast, setToast] = useState<Toast>(null);
  const [route, go] = useRoute();

  // Wallet: restore a previous session, then follow sign-in and sign-out. Only the app and the
  // setup guide use a wallet, so the landing page and docs never load the wallet library.
  const inApp = route === "app" || route === "start";
  useEffect(() => {
    if (!inApp) return;
    const onIn = (t: { accounts: { accountId: string }[] }) => setAccount(t.accounts[0]?.accountId ?? null);
    const onOut = () => setAccount(null);
    let live = true;
    const ready = getConnector(network);
    ready
      .then((c) => {
        if (!live) return;
        c.on("wallet:signIn", onIn);
        c.on("wallet:signOut", onOut);
        return c.getConnectedWallet().then((w) => live && setAccount(w.accounts[0]?.accountId ?? null));
      })
      .catch(() => live && setAccount(null));
    return () => {
      live = false;
      ready.then((c) => (c.off?.("wallet:signIn", onIn), c.off?.("wallet:signOut", onOut))).catch(() => {});
    };
  }, [network, inApp]);

  useEffect(() => {
    if (!account) return setMyVaults([]);
    getVaultsOf(network, contract, account).then(setMyVaults).catch(() => setMyVaults([]));
  }, [account, network, contract]);

  useEffect(() => {
    const q = new URLSearchParams({ contract, network, ...(vaultId !== null && route === "app" ? { vault: String(vaultId) } : {}) });
    history.replaceState(null, "", `?${q}${location.hash}`);
  }, [contract, network, vaultId, route]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === "ok" ? 5000 : 10000);
    return () => clearTimeout(t);
  }, [toast]);

  const walletError = (e: unknown) => setToast({ kind: "err", text: `Wallet: ${(e as Error).message}` });
  const connect = () => getConnector(network).then((c) => c.connect()).catch(walletError);
  const disconnect = () => getConnector(network).then((c) => c.disconnect()).then(() => setAccount(null)).catch(walletError);
  const open = (c: string, v: number) => (setContract(c), setVaultId(v), route !== "app" && go("app"));
  const openDemo = () => (setNetwork(DEMO.network), open(DEMO.contract, DEMO.vault));

  // Read-only tools for AI agents browsing the site, in browsers that support WebMCP.
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => registerWebMcpTools({ network, contract, openVault: (c, v) => openRef.current(c, v) }), [network, contract]);

  const skip = (e: React.MouseEvent) => (e.preventDefault(), document.querySelector<HTMLElement>("main")?.focus());

  return (
    <>
      <a className="skip" href="#main" onClick={skip}>Skip to content</a>
      <Header
        route={route}
        go={go}
        walletArea={
          <>
            <div className="seg hide-sm" role="group" aria-label="Network">
              {(["testnet", "mainnet"] as const).map((n) => (
                <button key={n} aria-pressed={network === n} onClick={() => setNetwork(n)}>
                  {n === "testnet" ? "Testnet" : "Mainnet"}
                </button>
              ))}
            </div>
            {account ? (
              <div className="account">
                <span className="dot" aria-hidden />
                <span className="mono" title={account}>{account}</span>
                <button className="btn ghost icon-only sm" onClick={disconnect} aria-label="Sign out" title="Sign out">
                  <Icon name="logOut" size={15} />
                </button>
              </div>
            ) : (
              <button className="btn" onClick={connect}>
                <Icon name="wallet" />
                <span>Connect<span className="hide-sm"> wallet</span></span>
              </button>
            )}
          </>
        }
      />

      {route === "home" && <Landing onStart={() => go("start")} onDocs={() => go("docs")} onDemo={openDemo} />}
      <Suspense fallback={<div className="route-loading" aria-busy="true" />}>
      {route === "docs" && (
        <div className="page wide">
          <Docs contract={contract} onStart={() => go("start")} />
        </div>
      )}
      {route === "start" && (
        <div className="page">
          <Onboarding
            network={network}
            contract={contract}
            account={account}
            onConnect={connect}
            onOpenVault={(v) => open(contract, v)}
            onToast={setToast}
            onDocs={() => go("docs")}
          />
        </div>
      )}
      </Suspense>
      {route === "app" && (
        <div className="page">
          <Suspense fallback={<div className="route-loading" aria-busy="true" />}>
            <AppPage
              network={network}
              contract={contract}
              vaultId={vaultId}
              account={account}
              myVaults={myVaults}
              onOpen={open}
              onDemo={openDemo}
              onStart={() => go("start")}
              onToast={setToast}
              onConnect={connect}
              onDocs={() => go("docs")}
            />
          </Suspense>
        </div>
      )}

      <Footer route={route} go={go} onDemo={openDemo} contract={contract} network={network} />

      {toast && (
        <div className={`toast ${toast.kind}`} role={toast.kind === "err" ? "alert" : "status"}>
          <Icon name={toast.kind === "ok" ? "check" : "alert"} size={18} />
          <p>{toast.text}</p>
          <button type="button" className="btn ghost icon-only sm" aria-label="Dismiss" onClick={() => setToast(null)}>
            <Icon name="x" size={15} />
          </button>
        </div>
      )}
    </>
  );
}
