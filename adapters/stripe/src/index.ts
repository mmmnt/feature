// @mmmnt/feat-adapter-stripe — service adapter observing a Stripe account
// through the Events API. startCapture pins a cursor at the newest event;
// stopCapture lists everything after it — every Stripe event in the window
// becomes a CapturedRecord {type: event.type, key: event.id, payload:
// event.data.object}, so an unpredicted charge, refund, or webhook-visible
// mutation fails the suite. Declare the service `eventual` with a
// convergenceTimeout — Stripe's event feed lags the API calls that cause it.
//
// The API key comes from an environment variable (options.apiKeyEnv, default
// STRIPE_SECRET_KEY) — never from config. Point it at TEST-MODE keys; reset()
// deliberately does not touch account state (isolate via test clocks or
// per-run fixtures). No SDK dependency: the surface used is plain REST.

import type { CapturedRecord, FeatServiceAdapter, SeedRecord } from "@mmmnt/feat-types";

interface StripeAdapterConfig {
  options?: {
    /** Env var holding the secret key (default STRIPE_SECRET_KEY). */
    apiKeyEnv?: string;
    /** Restrict capture to these event types (e.g. ["charge.succeeded"]); default: all. */
    types?: string[];
    /** API origin override — used by tests and stripe-mock. */
    baseUrl?: string;
  };
}

interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}

class StripeAdapter implements FeatServiceAdapter {
  private readonly key: string;
  private readonly baseUrl: string;
  private readonly types: string[] | undefined;
  private cursor: string | null = null;

  constructor(config: StripeAdapterConfig) {
    const envName = config.options?.apiKeyEnv ?? "STRIPE_SECRET_KEY";
    const key = process.env[envName];
    if (!key)
      throw new Error(`@mmmnt/feat-adapter-stripe: environment variable ${envName} is not set — configuration error.`);
    this.key = key;
    this.baseUrl = config.options?.baseUrl ?? "https://api.stripe.com";
    this.types = config.options?.types;
  }

  private async listEvents(params: Record<string, string>): Promise<StripeEvent[]> {
    const search = new URLSearchParams({ limit: "100", ...params });
    if (this.types) this.types.forEach((t, i) => search.set(`types[${i}]`, t));
    const out: StripeEvent[] = [];
    let startingAfter: string | undefined;
    for (;;) {
      if (startingAfter) search.set("starting_after", startingAfter);
      const res = await fetch(`${this.baseUrl}/v1/events?${search.toString()}`, {
        headers: { authorization: `Bearer ${this.key}` },
      });
      if (!res.ok) throw new Error(`Stripe Events API ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { data: StripeEvent[]; has_more: boolean };
      out.push(...body.data);
      if (!body.has_more || body.data.length === 0) return out;
      startingAfter = body.data[body.data.length - 1]!.id;
    }
  }

  async setup(): Promise<void> {}
  async teardown(): Promise<void> {}

  async reset(): Promise<void> {
    this.cursor = null;
  }

  async startCapture(): Promise<void> {
    const newest = await this.listEvents({ limit: "1" });
    this.cursor = newest[0]?.id ?? null;
  }

  async stopCapture(): Promise<CapturedRecord[]> {
    const params: Record<string, string> = {};
    if (this.cursor) params.ending_before = this.cursor;
    const events = await this.listEvents(params);
    this.cursor = null;
    // Stripe returns newest-first; capture order is oldest-first.
    return events.reverse().map((e) => ({
      type: e.type,
      key: e.id,
      payload: e.data.object,
      timestamp: e.created * 1000,
    }));
  }

  async read(): Promise<unknown | null> {
    const events = await this.listEvents({});
    return events.reverse().map((e) => ({
      type: e.type,
      key: e.id,
      payload: e.data.object,
      timestamp: e.created * 1000,
    }));
  }

  async seed(_records: SeedRecord[]): Promise<void> {
    throw new Error("@mmmnt/feat-adapter-stripe does not support seeding — arrange state via the Stripe API in given: execute steps.");
  }
}

export function createAdapter(config: Record<string, unknown>): FeatServiceAdapter {
  return new StripeAdapter(config as StripeAdapterConfig);
}
