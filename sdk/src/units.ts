// Agents reason in "2.5 USDC", the contract in base units. Keep the conversion exact
// (string/bigint only, never floats).

export function parseUnits(value: string, decimals: number): string {
  const v = value.trim();
  if (!/^\d+(\.\d+)?$/.test(v)) throw new Error(`invalid amount "${value}"`);
  const [whole, frac = ""] = v.split(".");
  if (frac.length > decimals) throw new Error(`"${value}" has more than ${decimals} decimals`);
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0")).toString();
}

export function formatUnits(raw: string, decimals: number): string {
  const n = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const frac = (n % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${n / base}.${frac}` : `${n / base}`;
}
