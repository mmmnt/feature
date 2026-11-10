// The system under test's Kafka client, as the fixture drives it (part of the build, inside touches, not shipped).
// One module for both places the system runs: in the probe's process (the observe-mode system, on the direct listener)
// and in the peer container (the transport-mode system, in the Toxiproxy network namespace, on the proxy listener).
// `makeClient(kafka)` takes the client library already loaded, because the peer's copy is the linux build.
//
// produce({ bootstrap, topic, partition?, key, value, messageTimeoutMs }) resolves { ok: true } or
// { err: <NAME>, code }: MESSAGE_TOO_LARGE and NOT_ENOUGH_REPLICAS are the brokers' answers; a deadline, a refused or reset
// connection and an unreachable cluster are TRANSPORT_FAILURE (the spec's name for "the client could not get an answer").
"use strict";

// The librdkafka error codes by name the spec names or the transport class includes.
const MESSAGE_TOO_LARGE = new Set([10]);
const NOT_ENOUGH_REPLICAS = new Set([19, 20]);
// _MSG_TIMED_OUT, _TRANSPORT, _ALL_BROKERS_DOWN, _TIMED_OUT, _TIMED_OUT_QUEUE, _RESOLVE
const TRANSPORT = new Set([-192, -195, -187, -185, -166, -193]);

function classify(e, kafka) {
  const code = e && e.code;
  if (MESSAGE_TOO_LARGE.has(code)) return { err: "MESSAGE_TOO_LARGE", code };
  if (NOT_ENOUGH_REPLICAS.has(code)) return { err: "NOT_ENOUGH_REPLICAS", code };
  if (TRANSPORT.has(code)) return { err: "TRANSPORT_FAILURE", code };
  const name = Object.entries(kafka.CODES.ERRORS).find(([, v]) => v === code);
  return { err: name ? name[0].replace(/^ERR_+/, "") : "UNKNOWN", code, message: String((e && e.message) || "") };
}

function makeClient(kafka) {
  const { Producer } = kafka;

  function connect(producer, timeoutMs) {
    return new Promise((resolve, reject) => {
      // The deadline is ours: a client that cannot reach a broker may not call back at all.
      const timer = setTimeout(() => reject({ code: -185, message: "connect timed out" }), timeoutMs);
      producer.connect({ timeout: timeoutMs }, (err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async function produce(req) {
    const timeoutMs = req.messageTimeoutMs || 5000;
    const producer = new Producer({
      "bootstrap.servers": req.bootstrap,
      acks: "all",
      "enable.idempotence": false,
      "message.send.max.retries": 0,
      "message.timeout.ms": timeoutMs,
      "socket.timeout.ms": Math.max(timeoutMs, 1000),
      dr_cb: true,
    });
    producer.setPollInterval(10);
    // A client error event with no listener would throw and take the process down; the answer is the delivery report or the deadline.
    producer.on("event.error", () => {});
    producer.on("error", () => {});
    try {
      try {
        await connect(producer, timeoutMs);
      } catch (e) {
        return classify(e, kafka);
      }
      const report = new Promise((resolve) => {
        producer.once("delivery-report", (err) => resolve(err ? classify(err, kafka) : { ok: true }));
      });
      try {
        producer.produce(req.topic, req.partition === undefined ? null : req.partition, Buffer.from(req.value), req.key);
      } catch (e) {
        return classify(e, kafka);
      }
      return await Promise.race([
        report,
        new Promise((resolve) => setTimeout(() => resolve({ err: "TRANSPORT_FAILURE", code: -192 }), timeoutMs + 2000)),
      ]);
    } finally {
      // A producer whose connect failed throws "Producer not connected" here, which would replace the answer.
      try {
        producer.disconnect(() => {});
      } catch {
        /* nothing to close */
      }
    }
  }

  return { produce };
}

module.exports = { makeClient };
