#!/usr/bin/env node

import process from "node:process";

import { cliUnhandledErrorExitCode, runCli } from "./run.js";

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = cliUnhandledErrorExitCode(error);
  },
);
