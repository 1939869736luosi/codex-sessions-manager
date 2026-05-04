#!/usr/bin/env node

import process from "node:process";

import { runCli } from "./run.js";

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exit(code);
  },
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  },
);
