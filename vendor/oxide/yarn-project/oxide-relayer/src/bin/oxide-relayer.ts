#!/usr/bin/env node
import { createCliProgram } from '../cli/command.js';
import { runRelayer } from '../main.js';
import { runExactOperation } from '../exact_operation/run.js';
import { authorizeGenericRestore } from '../exact_operation/generic_quarantine.js';


createCliProgram(runRelayer, runExactOperation, authorizeGenericRestore)
  .parseAsync()
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
