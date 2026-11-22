import dotenv from 'dotenv';
import path from 'node:path';

/**
 * Loads .env with override enabled.
 *
 * dotenv does NOT override variables that already exist in the process
 * environment by default. That silently broke local configuration: shells
 * (proxy clients, IDE terminals, sandbox runners) often export HTTPS_PROXY,
 * so the value written in .env was ignored and the app quietly used a
 * different proxy. .env is the documented single source of truth for this
 * project, so it must win.
 *
 * Import this module FIRST, before any module that reads process.env.
 */
const result = dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: true });

if (result.error) {
  console.warn('No .env file loaded; falling back to process environment.');
}
