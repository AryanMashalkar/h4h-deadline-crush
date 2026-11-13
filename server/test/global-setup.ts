import { createPool, migrate } from '../src/db.js';
import { TEST_DB } from './helpers.js';

export default async function setup() {
  const pool = createPool(TEST_DB, 2);
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(pool);
  await pool.end();
}
