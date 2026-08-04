/**
 * Build the template database every test file's is copied from (`#296`).
 *
 * Registered as vitest's `globalSetup`, so it runs once in the main process
 * before any worker starts — which is the only place that can be true of. Sixty
 * of the seventy-eight files here used to drop `public` and replay all 107
 * migrations to reach a schema that is the same every time: 811 ms each,
 * measured on CLAUDE002 on 2026-08-04. Migrating once costs 656 ms and copying
 * costs 63 ms.
 *
 * ## Why `globalSetup` is right here and was wrong for the worker databases
 *
 * `#284` rejected it for those, and the reason was specific: it would have needed
 * the number of databases created here to equal `maxWorkers` set in a different
 * file, with nothing to keep the two in step. There is one template and its name
 * is fixed, so there is no pair to disagree.
 *
 * ## Why it is silent without a database
 *
 * The same rule `test-worker-setup.ts` follows. `#224` made a missing
 * `DATABASE_URL` a hard failure that *explains itself*, and that message lives in
 * `databaseTestTarget`, where a test file meets it. A setup file that threw first
 * would replace it with a worse one before any test ran.
 */
import process from 'node:process'
import { DATABASE_URL_VAR } from './client.js'
import { buildTemplateDatabase } from './testing.js'

export default async function setup(): Promise<void> {
  const url = process.env[DATABASE_URL_VAR]
  if (url === undefined || url.trim() === '') return

  await buildTemplateDatabase(url)
}
