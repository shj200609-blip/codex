import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

export interface SharedIdeRegistration {
  version: 1;
  endpoint: string;
  forkExecutable: string;
  utilityExecutable: string;
  wrapperPath: string;
  previousCliExecutable?: string;
}

export function validateEndpoint(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "ws:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error("Use an unauthenticated loopback ws:// shared server.");
  return url.href;
}

export function sharedIdeWrapper(registration: SharedIdeRegistration): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return `#!/bin/sh
set -eu
fork=${quote(registration.forkExecutable)}
utility=${quote(registration.utilityExecutable)}
subcommand=
server_utility=false
skip_value=false
for arg in "$@"; do
  if [ "$subcommand" = app-server ]; then
    case "$arg" in
      daemon|proxy|generate-ts|generate-json-schema|generate-internal-json-schema) server_utility=true ;;
    esac
    continue
  fi
  if [ "$skip_value" = true ]; then skip_value=false; continue; fi
  case "$arg" in
    -c|--config|--enable|--disable) skip_value=true ;;
    -*) ;;
    *) subcommand=$arg; if [ "$arg" != app-server ]; then break; fi ;;
  esac
done
if [ "$subcommand" = app-server ] && [ "$server_utility" = false ]; then
  exec "$fork" --remote ${quote(registration.endpoint)} app-server proxy
fi
unset CODEX_APP_SERVER_URL
exec "$utility" "$@"
`;
}

export async function writeRegistration(
  registration: SharedIdeRegistration,
): Promise<void> {
  validateEndpoint(registration.endpoint);
  for (const path of [
    registration.forkExecutable,
    registration.utilityExecutable,
  ]) {
    if (!isAbsolute(path))
      throw new Error("Select an absolute Codex executable path.");
    await access(path, constants.X_OK);
  }
  await mkdir(dirname(registration.wrapperPath), { recursive: true });
  const script = `${registration.wrapperPath}.tmp`;
  await writeFile(script, sharedIdeWrapper(registration), { mode: 0o700 });
  await rename(script, registration.wrapperPath);
  const manifest = join(dirname(registration.wrapperPath), "connection.json");
  await writeFile(
    `${manifest}.tmp`,
    JSON.stringify(registration, null, 2) + "\n",
    { mode: 0o600 },
  );
  await rename(`${manifest}.tmp`, manifest);
}

// The IDE executable is the source of truth. A workspace's legacy review URL
// cannot override the endpoint of an explicitly configured shared IDE producer.
export async function readRegistration(
  cliExecutable: string | undefined,
): Promise<SharedIdeRegistration | undefined> {
  if (
    !cliExecutable ||
    !isAbsolute(cliExecutable) ||
    basename(cliExecutable) !== "codex-shared-ide"
  )
    return;
  try {
    const value = JSON.parse(
      await readFile(join(dirname(cliExecutable), "connection.json"), "utf8"),
    ) as Partial<SharedIdeRegistration>;
    if (
      value.version !== 1 ||
      value.wrapperPath !== cliExecutable ||
      typeof value.endpoint !== "string" ||
      typeof value.forkExecutable !== "string" ||
      typeof value.utilityExecutable !== "string"
    )
      throw new Error("Invalid shared IDE connection registration.");
    validateEndpoint(value.endpoint);
    return value as SharedIdeRegistration;
  } catch (error) {
    throw new Error(
      `Unable to read shared IDE connection. Reconfigure with Codex Changes: Connect Codex IDE to Shared Server. ${error}`,
    );
  }
}
