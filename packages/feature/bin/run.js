#!/usr/bin/env node
import { execute } from "@oclif/core";

// A reader that closed stdout early (`feat lint | head -1`) wants no more output: end as @oclif/core 4 did, with
// exit 0. On 5, execute() awaits a flush whose 'drain' a closed pipe never emits, leaving the await unsettled.
process.stdout.on("error", (err) => {
  if (err && err.code === "EPIPE") process.exit(0);
});

await execute({ dir: import.meta.url });
