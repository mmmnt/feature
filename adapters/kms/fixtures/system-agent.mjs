// The system under test for SPEC-ADPKMS-002: a KMS client, the real SDK, that writes through the
// fault proxy. Part of the build, not shipped. It runs inside the Toxiproxy container's network
// namespace (the probe starts it there with this repository mounted read-only), because on Docker
// Desktop a client outside that namespace cannot reach a proxy's listen port, and a published port
// would hide a reset behind the runtime's own host proxy.
//
// Control protocol, one line in, one line out, on the port the probe publishes:
//   createkey <proxyPort> <namespace> <alias>   CreateKey then CreateAlias alias/<ns>/<alias>
//   -> "ok" | "transport" (no HTTP answer: refused, reset, timed out) | "error:<name>" (KMS answered)
import net from "node:net";
import { CreateAliasCommand, CreateKeyCommand, KMSClient } from "@aws-sdk/client-kms";

const CONTROL_PORT = Number(process.env.FEAT_KMS_CONTROL_PORT ?? 19002);
const DEADLINE_MS = 1500;

async function createKey(port, ns, alias) {
  const client = new KMSClient({
    endpoint: `http://127.0.0.1:${port}`,
    region: "eu-west-2",
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
    maxAttempts: 1,
    requestHandler: { requestTimeout: DEADLINE_MS, connectionTimeout: DEADLINE_MS, throwOnRequestTimeout: true },
  });
  try {
    const key = (await client.send(new CreateKeyCommand({}))).KeyMetadata.KeyId;
    await client.send(new CreateAliasCommand({ AliasName: `alias/${ns}/${alias}`, TargetKeyId: key }));
    return "ok";
  } catch (e) {
    return e.$metadata?.httpStatusCode === undefined ? "transport" : `error:${e.name}`;
  } finally {
    client.destroy();
  }
}

net
  .createServer((c) => {
    let buf = "";
    c.on("error", () => {});
    c.on("data", async (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const [cmd, port, ns, alias] = line.split(" ");
        if (cmd === "createkey") c.write(`${await createKey(port, ns, alias)}\n`);
        else c.write("error:unknown\n");
      }
    });
  })
  .listen(CONTROL_PORT, "0.0.0.0");
