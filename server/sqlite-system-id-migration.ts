import type Database from 'better-sqlite3';

type SchemaRow = { sql: string | null };
type ColumnRow = { name: string };

function quoted(identifier: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQLite identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

const LEGACY_SYSTEM_ID_CHECK = /\('letta'\s*,\s*'hermes'(?:\s*,\s*'claude')?\)/g;
const CANONICAL_SYSTEM_ID_CHECK = "('openclaw', 'hermes', 'claude')";

/**
 * Migrate legacy persisted `letta` system identity into canonical `openclaw`.
 *
 * This function intentionally keeps its historical export name because several
 * schema owners call it during startup. It now performs both operations needed
 * by the retirement migration:
 *   1. rebuild legacy CHECK constraints so only canonical live system IDs are
 *      accepted for new rows; and
 *   2. translate any persisted `*_system_id = 'letta'` values to `openclaw`
 *      while copying the table.
 *
 * Tables already using canonical constraints are left untouched.
 */
export function widenSystemIdCheckConstraints(db: Database.Database, table: string) {
  const schema = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as SchemaRow | undefined;
  const sql = schema?.sql ?? '';
  if (!sql) return false;

  const hasLegacyIdentity = sql.includes("'letta'");
  const hasCanonicalIdentity = sql.includes("'openclaw'");
  if (!hasLegacyIdentity && hasCanonicalIdentity) return false;
  if (!hasLegacyIdentity) return false;
  if (db.inTransaction) throw new Error(`Cannot migrate ${table} system IDs inside an active transaction`);

  const tableName = quoted(table);
  const temp = `${table}__system_id_v4`;
  const tempName = quoted(temp);
  const columns = (db.prepare(`PRAGMA table_info(${tableName})`).all() as ColumnRow[]).map((row) => row.name);
  if (!columns.length) throw new Error(`Cannot migrate ${table}: no columns found`);
  const systemColumns = new Set(columns.filter((name) => name === 'system_id' || name.endsWith('_system_id')));
  if (!systemColumns.size) throw new Error(`Cannot migrate ${table}: no system-id columns found`);

  const columnList = columns.map(quoted).join(', ');
  const selectList = columns.map((name) => {
    const identifier = quoted(name);
    return systemColumns.has(name)
      ? `CASE WHEN ${identifier} = 'letta' THEN 'openclaw' ELSE ${identifier} END`
      : identifier;
  }).join(', ');
  const objects = db.prepare(`
    SELECT type, name, sql FROM sqlite_master
    WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL
    ORDER BY type, name
  `).all(table) as Array<{ type: string; name: string; sql: string }>;

  const renamedCreateSql = sql.replace(
    /^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\S+)/i,
    `CREATE TABLE ${tempName}`,
  );
  const createSql = renamedCreateSql.replace(LEGACY_SYSTEM_ID_CHECK, CANONICAL_SYSTEM_ID_CHECK);
  if (createSql === renamedCreateSql) {
    throw new Error(`Cannot migrate ${table}: expected legacy SystemId CHECK was not found`);
  }

  const foreignKeysEnabled = Number(db.pragma('foreign_keys', { simple: true })) !== 0;
  if (foreignKeysEnabled) db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(`DROP TABLE IF EXISTS ${tempName}`);
    db.exec(createSql);
    db.exec(`INSERT INTO ${tempName} (${columnList}) SELECT ${selectList} FROM ${tableName}`);
    db.exec(`DROP TABLE ${tableName}`);
    db.exec(`ALTER TABLE ${tempName} RENAME TO ${tableName}`);
    for (const object of objects) db.exec(object.sql);
    db.exec('COMMIT');
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  } finally {
    if (foreignKeysEnabled) db.pragma('foreign_keys = ON');
  }

  const violations = db.pragma('foreign_key_check') as unknown[];
  if (violations.length) throw new Error(`Foreign key check failed after migrating ${table}`);
  return true;
}
