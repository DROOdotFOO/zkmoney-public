#!/usr/bin/env node
import { createCliProgram } from '../cli/command.js';
import { runRelayer } from '../main.js';
import { runExactOperation } from '../exact_operation/run.js';


createCliProgram(runRelayer, runExactOperation)
  .parseAsync()
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
