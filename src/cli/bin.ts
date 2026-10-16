#!/usr/bin/env node
import { main } from './main.js';

main(process.argv).then((code) => {
  process.exitCode = code;
});
