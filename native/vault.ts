import * as SQLite from 'expo-sqlite';
import * as Crypto from 'expo-crypto';

type RecordData = Record<string, unknown>;
const DATABASE = 'heritage-surveys.db';
let database: SQLite.SQLiteDatabase | null = null;
export const MAX_FILE = 10 * 1024 * 1024;
export function text(value: unknown, max = 1000): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f]/.test(value)) {
    throw new Error('Invalid text value.');
  }
  return value;
}
export function safeFilename(value: unknown): string {
  const name = text(value, 240);
  if (/[\\/]/.test(name) || name === '.' || name === '..') throw new Error('Invalid file name.');
  return name;
}
function object(value: unknown): RecordData {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid record.');
  return value as RecordData;
}
export async function openVault() {
  if (database) return;
  const db = await SQLite.openDatabaseAsync(DATABASE);
  try {
    const version = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
    if ((version?.user_version ?? 0) > 1) throw new Error('This data requires a newer app. Install the latest APK without uninstalling.');
    await db.execAsync('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA temp_store = MEMORY; PRAGMA secure_delete = ON;');
    await db.withTransactionAsync(async () => {
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS buildings (ref TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS attachments (
          id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT NOT NULL REFERENCES buildings(ref) ON DELETE CASCADE,
          json TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS attachments_ref ON attachments(ref);
        PRAGMA user_version = 1;
      `);
      // Establish durable identity before reference editing is ever available.
      // The original reference keys, database version/path and evidence IDs stay.
      const records = await db.getAllAsync<{ ref: string; json: string }>('SELECT ref,json FROM buildings');
      for (const row of records) {
        const record = JSON.parse(row.json);
        if (record.internalId === null || record.internalId === undefined) {
          record.internalId = record.id ?? Crypto.randomUUID();
          await db.runAsync('UPDATE buildings SET json=? WHERE ref=?', JSON.stringify(record), row.ref);
        }
      }
    });
    database = db;
  } catch (error) {
    await db.closeAsync();
    throw error;
  }
}
export async function vaultCall(method: string, args: unknown[]): Promise<unknown> {
  if (!database) throw new Error('Local storage is not ready.');
  const db = database;
  switch (method) {
    case 'init': return true;
    case 'saveBuilding': {
      const record = object(args[0]);
      const ref = text(record.buildingReferenceNumber);
      const previous = args.length > 1 ? (args[1] === null ? null : text(args[1])) : ref;
      await db.withExclusiveTransactionAsync(async tx => {
        const original = previous ? await tx.getFirstAsync<{ json: string }>('SELECT json FROM buildings WHERE ref=?', previous) : null;
        if (previous && previous !== ref && !original) throw new Error('Original building no longer exists. Reopen before saving.');
        const duplicate = await tx.getFirstAsync<{ ref: string }>('SELECT ref FROM buildings WHERE lower(ref)=lower(?) AND ref<>?', ref, previous ?? '');
        if (duplicate) throw new Error('That building reference already exists.');
        const old = original ? JSON.parse(original.json) : null;
        record.internalId = old?.internalId ?? old?.id ?? record.internalId ?? Crypto.randomUUID();
        const json = JSON.stringify(record);
        if (json.length > 512 * 1024) throw new Error('Survey metadata is too large.');
        // Insert the new label first to satisfy the existing foreign key; remove
        // the old label only after moving every evidence row in this transaction.
        await tx.runAsync('INSERT INTO buildings(ref,json) VALUES(?,?) ON CONFLICT(ref) DO UPDATE SET json=excluded.json', ref, json);
        if (previous && previous !== ref) {
          const attachments = await tx.getAllAsync<{ id: number; json: string }>('SELECT id,json FROM attachments WHERE ref=?', previous);
          for (const item of attachments) {
            const attachment = { ...JSON.parse(item.json), buildingReferenceNumber: ref };
            await tx.runAsync('UPDATE attachments SET ref=?,json=? WHERE id=?', ref, JSON.stringify(attachment), item.id);
          }
          await tx.runAsync('DELETE FROM buildings WHERE ref=?', previous);
        }
      });
      return ref;
    }
    case 'getBuilding': {
      const row = await db.getFirstAsync<{ json: string }>('SELECT json FROM buildings WHERE ref=?', text(args[0]));
      return row ? JSON.parse(row.json) : null;
    }
    case 'getAllBuildings': {
      const rows = await db.getAllAsync<{ json: string }>('SELECT json FROM buildings');
      return rows.map(row => JSON.parse(row.json)).sort((a, b) => a.buildingReferenceNumber.localeCompare(b.buildingReferenceNumber));
    }
    case 'deleteBuilding':
      await db.runAsync('DELETE FROM buildings WHERE ref=?', text(args[0]));
      return true;
    case 'saveAttachment': {
      const record = object(args[0]);
      const ref = text(record.buildingReferenceNumber);
      text(record.section); text(record.question); safeFilename(record.fileName);
      if (typeof record.fileSize !== 'number' || record.fileSize < 0 || record.fileSize > MAX_FILE ||
        typeof record.fileData !== 'string' || record.fileData.length > MAX_FILE * 1.4 ||
        !/^data:[^,]*;base64,[A-Za-z0-9+/]*={0,2}$/.test(record.fileData)) {
        throw new Error('Invalid evidence file, or file exceeds 10 MB.');
      }
      const total = await db.getFirstAsync<{ size: number }>(
        'SELECT COALESCE(SUM(length(json)),0) AS size FROM attachments WHERE ref=?', ref);
      if ((total?.size ?? 0) + record.fileData.length > 80 * 1024 * 1024) {
        throw new Error('Evidence for this building exceeds the mobile memory safety limit (about 60 MB).');
      }
      const result = await db.runAsync('INSERT INTO attachments(ref,json) VALUES(?,?)', ref, JSON.stringify(record));
      return result.lastInsertRowId;
    }
    case 'getAttachmentsFlat': {
      const rows = await db.getAllAsync<{ id: number; json: string }>('SELECT id,json FROM attachments WHERE ref=? ORDER BY id', text(args[0]));
      return rows.map(row => ({ ...JSON.parse(row.json), id: row.id }));
    }
    default: throw new Error('Unsupported storage operation.');
  }
}
