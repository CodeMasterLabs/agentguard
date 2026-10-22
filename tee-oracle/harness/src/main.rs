//! Runs the oracle component the way an OutLayer worker would, on the same wasmtime (28),
//! with stand-ins for the two OutLayer host interfaces it imports:
//!   - outlayer:signing-keys: a fixed test key (the real one lives in the TEE keystore)
//!   - near:rpc view: answers `get_vault` with a canned owner
//!
//!   cargo run --release -- <component.wasm> '<input json>'

use anyhow::{Context, Result};
use ed25519_dalek::{Signer, SigningKey};
use wasmtime::component::{Component, Linker, ResourceTable};
use wasmtime::{Config, Engine, Store};
use wasmtime_wasi::pipe::{MemoryInputPipe, MemoryOutputPipe};
use wasmtime_wasi::{WasiCtx, WasiCtxBuilder, WasiView};

mod keys {
    wasmtime::component::bindgen!({ path: "../wit-signing", world: "signing-keys-host" });
}
mod rpc {
    wasmtime::component::bindgen!({ path: "../wit-rpc", world: "rpc-host" });
}

struct State {
    table: ResourceTable,
    wasi: WasiCtx,
    key: SigningKey,
    owner: String,
}

impl WasiView for State {
    fn table(&mut self) -> &mut ResourceTable {
        &mut self.table
    }
    fn ctx(&mut self) -> &mut WasiCtx {
        &mut self.wasi
    }
}

impl keys::outlayer::signing_keys::api::Host for State {
    fn public_key(&mut self, path: String, vault: Option<String>) -> Result<Vec<u8>, String> {
        if path != "verdicts" || vault.is_some() {
            return Err(format!("undeclared key {path}"));
        }
        Ok(self.key.verifying_key().to_bytes().to_vec())
    }
    fn sign(&mut self, path: String, vault: Option<String>, message: Vec<u8>) -> Result<Vec<u8>, String> {
        self.public_key(path, vault)?;
        Ok(self.key.sign(&message).to_bytes().to_vec())
    }
    fn sign_nep413(
        &mut self,
        _: String,
        _: Option<String>,
        _: String,
        _: String,
        _: Vec<u8>,
        _: Option<String>,
    ) -> Result<keys::outlayer::signing_keys::api::Nep413Signature, String> {
        Err("not used by the oracle".into())
    }
}

impl rpc::near::rpc::api::Host for State {
    fn view(&mut self, contract: String, method: String, args: String, _finality: String) -> (String, String) {
        eprintln!("[harness] view {contract}.{method}({args})");
        (serde_json::json!({ "owner": self.owner }).to_string(), String::new())
    }
}

fn main() -> Result<()> {
    let mut a = std::env::args().skip(1);
    let wasm = a.next().context("usage: harness <component.wasm> '<input json>'")?;
    let input = a.next().unwrap_or_else(|| r#"{"op":"public_key"}"#.into());

    let mut config = Config::new();
    config.wasm_component_model(true);
    let engine = Engine::new(&config)?;
    let component = Component::from_file(&engine, &wasm)?;

    let mut linker: Linker<State> = Linker::new(&engine);
    wasmtime_wasi::add_to_linker_sync(&mut linker)?;
    keys::SigningKeysHost::add_to_linker(&mut linker, |s: &mut State| s)?;
    rpc::RpcHost::add_to_linker(&mut linker, |s: &mut State| s)?;

    let stdout = MemoryOutputPipe::new(1 << 20);
    let wasi = WasiCtxBuilder::new()
        .stdin(MemoryInputPipe::new(input.into_bytes()))
        .stdout(stdout.clone())
        .inherit_stderr()
        .env("NEAR_NETWORK_ID", "testnet")
        .build();
    let state = State {
        table: ResourceTable::new(),
        wasi,
        key: SigningKey::from_bytes(&[7u8; 32]),
        owner: "cm-agentguard.testnet".into(),
    };
    let mut store = Store::new(&engine, state);
    let cmd = wasmtime_wasi::bindings::sync::Command::instantiate(&mut store, &component, &linker)?;
    let ok = cmd.wasi_cli_run().call_run(&mut store)?;
    println!("{}", String::from_utf8_lossy(&stdout.contents()));
    eprintln!("[harness] run returned {ok:?}");
    Ok(())
}
