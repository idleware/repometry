#!/usr/bin/env node
import { runCli } from '@repometry/cli/internal/cli';
import distribution from '../distribution.js';

await runCli(distribution);
