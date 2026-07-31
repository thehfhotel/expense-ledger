// Shared engine connection env for the operator-run scripts. Scripts run
// against the engine's loopback host-port mapping (127.0.0.1:4051) directly
// or over an SSH tunnel to it - see README "Migration runbook".

export interface EngineEnv {
  baseUrl: string;
  token: string;
}

/** Reads EBK_URL / EBK_TOKEN from the environment. Exits the process with a clear message if EBK_TOKEN is missing. */
export function requireEngineEnv(): EngineEnv {
  const baseUrl = process.env.EBK_URL || "http://127.0.0.1:4051";
  const token = process.env.EBK_TOKEN;

  if (!token) {
    console.error("EBK_TOKEN is not set. See README 'Migration runbook' for how to mint one.");
    process.exit(1);
  }

  return { baseUrl, token };
}
