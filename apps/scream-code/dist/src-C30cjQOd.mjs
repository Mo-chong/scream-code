#!/usr/bin/env node
import { fileURLToPath as __cjsShimFileURLToPath } from 'node:url';
import { dirname as __cjsShimDirname } from 'node:path';
const __filename = __cjsShimFileURLToPath(import.meta.url);
const __dirname = __cjsShimDirname(__filename);
import { mkdir, readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
//#region ../../node_modules/.pnpm/pathe@2.0.3/node_modules/pathe/dist/shared/pathe.M-eThtNZ.mjs
const _DRIVE_LETTER_START_RE = /^[A-Za-z]:\//;
function normalizeWindowsPath(input = "") {
	if (!input) return input;
	return input.replace(/\\/g, "/").replace(_DRIVE_LETTER_START_RE, (r) => r.toUpperCase());
}
const _UNC_REGEX = /^[/\\]{2}/;
const _IS_ABSOLUTE_RE = /^[/\\](?![/\\])|^[/\\]{2}(?!\.)|^[A-Za-z]:[/\\]/;
const _DRIVE_LETTER_RE = /^[A-Za-z]:$/;
const _ROOT_FOLDER_RE = /^\/([A-Za-z]:)?$/;
const _EXTNAME_RE = /.(\.[^./]+|\.)$/;
const _PATH_ROOT_RE = /^[/\\]|^[a-zA-Z]:[/\\]/;
const normalize = function(path) {
	if (path.length === 0) return ".";
	path = normalizeWindowsPath(path);
	const isUNCPath = path.match(_UNC_REGEX);
	const isPathAbsolute = isAbsolute(path);
	const trailingSeparator = path[path.length - 1] === "/";
	path = normalizeString(path, !isPathAbsolute);
	if (path.length === 0) {
		if (isPathAbsolute) return "/";
		return trailingSeparator ? "./" : ".";
	}
	if (trailingSeparator) path += "/";
	if (_DRIVE_LETTER_RE.test(path)) path += "/";
	if (isUNCPath) {
		if (!isPathAbsolute) return `//./${path}`;
		return `//${path}`;
	}
	return isPathAbsolute && !isAbsolute(path) ? `/${path}` : path;
};
const join = function(...segments) {
	let path = "";
	for (const seg of segments) {
		if (!seg) continue;
		if (path.length > 0) {
			const pathTrailing = path[path.length - 1] === "/";
			const segLeading = seg[0] === "/";
			if (pathTrailing && segLeading) path += seg.slice(1);
			else path += pathTrailing || segLeading ? seg : `/${seg}`;
		} else path += seg;
	}
	return normalize(path);
};
function cwd() {
	if (typeof process !== "undefined" && typeof process.cwd === "function") return process.cwd().replace(/\\/g, "/");
	return "/";
}
const resolve = function(...arguments_) {
	arguments_ = arguments_.map((argument) => normalizeWindowsPath(argument));
	let resolvedPath = "";
	let resolvedAbsolute = false;
	for (let index = arguments_.length - 1; index >= -1 && !resolvedAbsolute; index--) {
		const path = index >= 0 ? arguments_[index] : cwd();
		if (!path || path.length === 0) continue;
		resolvedPath = `${path}/${resolvedPath}`;
		resolvedAbsolute = isAbsolute(path);
	}
	resolvedPath = normalizeString(resolvedPath, !resolvedAbsolute);
	if (resolvedAbsolute && !isAbsolute(resolvedPath)) return `/${resolvedPath}`;
	return resolvedPath.length > 0 ? resolvedPath : ".";
};
function normalizeString(path, allowAboveRoot) {
	let res = "";
	let lastSegmentLength = 0;
	let lastSlash = -1;
	let dots = 0;
	let char = null;
	for (let index = 0; index <= path.length; ++index) {
		if (index < path.length) char = path[index];
		else if (char === "/") break;
		else char = "/";
		if (char === "/") {
			if (lastSlash === index - 1 || dots === 1);
			else if (dots === 2) {
				if (res.length < 2 || lastSegmentLength !== 2 || res[res.length - 1] !== "." || res[res.length - 2] !== ".") {
					if (res.length > 2) {
						const lastSlashIndex = res.lastIndexOf("/");
						if (lastSlashIndex === -1) {
							res = "";
							lastSegmentLength = 0;
						} else {
							res = res.slice(0, lastSlashIndex);
							lastSegmentLength = res.length - 1 - res.lastIndexOf("/");
						}
						lastSlash = index;
						dots = 0;
						continue;
					} else if (res.length > 0) {
						res = "";
						lastSegmentLength = 0;
						lastSlash = index;
						dots = 0;
						continue;
					}
				}
				if (allowAboveRoot) {
					res += res.length > 0 ? "/.." : "..";
					lastSegmentLength = 2;
				}
			} else {
				if (res.length > 0) res += `/${path.slice(lastSlash + 1, index)}`;
				else res = path.slice(lastSlash + 1, index);
				lastSegmentLength = index - lastSlash - 1;
			}
			lastSlash = index;
			dots = 0;
		} else if (char === "." && dots !== -1) ++dots;
		else dots = -1;
	}
	return res;
}
const isAbsolute = function(p) {
	return _IS_ABSOLUTE_RE.test(p);
};
const extname = function(p) {
	if (p === "..") return "";
	const match = _EXTNAME_RE.exec(normalizeWindowsPath(p));
	return match && match[1] || "";
};
const relative = function(from, to) {
	const _from = resolve(from).replace(_ROOT_FOLDER_RE, "$1").split("/");
	const _to = resolve(to).replace(_ROOT_FOLDER_RE, "$1").split("/");
	if (_to[0][1] === ":" && _from[0][1] === ":" && _from[0] !== _to[0]) return _to.join("/");
	const _fromCopy = [..._from];
	for (const segment of _fromCopy) {
		if (_to[0] !== segment) break;
		_from.shift();
		_to.shift();
	}
	return [..._from.map(() => ".."), ..._to].join("/");
};
const dirname = function(p) {
	const segments = normalizeWindowsPath(p).replace(/\/$/, "").split("/").slice(0, -1);
	if (segments.length === 1 && _DRIVE_LETTER_RE.test(segments[0])) segments[0] += "/";
	return segments.join("/") || (isAbsolute(p) ? "/" : ".");
};
const basename = function(p, extension) {
	const segments = normalizeWindowsPath(p).split("/");
	let lastSegment = "";
	for (let i = segments.length - 1; i >= 0; i--) {
		const val = segments[i];
		if (val) {
			lastSegment = val;
			break;
		}
	}
	return extension && lastSegment.endsWith(extension) ? lastSegment.slice(0, -extension.length) : lastSegment;
};
const parse = function(p) {
	const root = _PATH_ROOT_RE.exec(p)?.[0]?.replace(/\\/g, "/") || "";
	const base = basename(p);
	const extension = extname(base);
	return {
		root,
		dir: dirname(p),
		base,
		ext: extension,
		name: base.slice(0, base.length - extension.length)
	};
};
//#endregion
//#region ../../packages/knowledge/src/store.ts
const ENTITY_TYPES$1 = new Set([
	"person",
	"organization",
	"location",
	"time",
	"product",
	"metric",
	"action",
	"work",
	"group",
	"subject",
	"tags"
]);
function generateId(prefix) {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
function normalizeName(name) {
	return name.trim().toLowerCase().replaceAll(/\s+/g, " ");
}
function vectorToJson(vec) {
	if (vec === null) return null;
	return JSON.stringify(Array.from(vec));
}
function jsonToVector(json) {
	if (json === null) return null;
	try {
		const arr = JSON.parse(json);
		return new Float32Array(arr);
	} catch {
		return null;
	}
}
function isEntityType(value) {
	return ENTITY_TYPES$1.has(value);
}
var KnowledgeStore = class {
	dbPath;
	db;
	initialized = false;
	initPromise = null;
	embeddingEngine;
	constructor(projectDir) {
		this.dbPath = join(projectDir, "knowledge", "knowledge.db");
	}
	async init() {
		if (this.initPromise) return this.initPromise;
		this.initPromise = this._doInit();
		return this.initPromise;
	}
	async _doInit() {
		if (this.initialized) return;
		await mkdir(dirname(this.dbPath), { recursive: true });
		this.db = new DatabaseSync(this.dbPath);
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec("PRAGMA foreign_keys = ON;");
		this.db.exec("PRAGMA busy_timeout = 5000;");
		this.createSchema();
		this.initialized = true;
	}
	close() {
		if (this.db !== void 0) {
			this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
			this.db.close();
			this.db = void 0;
		}
		this.initialized = false;
		this.initPromise = null;
	}
	setEmbeddingEngine(engine) {
		this.embeddingEngine = engine;
	}
	getEmbeddingEngine() {
		return this.embeddingEngine;
	}
	/**
	* Begin a write transaction. Use commitTransaction / rollbackTransaction
	* to close it. Used by ingest to keep chunks/events/entities/edges atomic —
	* a mid-ingest failure leaves no partial rows.
	*/
	beginTransaction() {
		if (this.db === void 0) throw new Error("knowledge store not initialized");
		this.db.exec("BEGIN");
	}
	commitTransaction() {
		if (this.db === void 0) throw new Error("knowledge store not initialized");
		this.db.exec("COMMIT");
	}
	rollbackTransaction() {
		if (this.db === void 0) return;
		try {
			this.db.exec("ROLLBACK");
		} catch {}
	}
	createSchema() {
		if (this.db === void 0) return;
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        file_path TEXT,
        description TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS knowledge_documents (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        content TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        chunk_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_documents_source ON knowledge_documents(source_id);

      CREATE TABLE IF NOT EXISTS knowledge_chunks (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
        rank INTEGER NOT NULL,
        heading TEXT,
        content TEXT NOT NULL,
        raw_content TEXT,
        embedding_json TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_doc ON knowledge_chunks(document_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_chunks_source ON knowledge_chunks(source_id);

      CREATE TABLE IF NOT EXISTS knowledge_events (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
        document_id TEXT NOT NULL REFERENCES knowledge_documents(id) ON DELETE CASCADE,
        chunk_id TEXT NOT NULL REFERENCES knowledge_chunks(id) ON DELETE CASCADE,
        rank INTEGER NOT NULL,
        title TEXT NOT NULL,
        summary TEXT,
        content TEXT NOT NULL,
        category TEXT,
        keywords TEXT,
        title_embedding_json TEXT,
        content_embedding_json TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_events_chunk ON knowledge_events(chunk_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_events_doc ON knowledge_events(document_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_events_source ON knowledge_events(source_id);

      CREATE TABLE IF NOT EXISTS knowledge_entities (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        description TEXT,
        embedding_json TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(source_id, type, normalized_name)
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_entities_source ON knowledge_entities(source_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_entities_name ON knowledge_entities(normalized_name);

      CREATE TABLE IF NOT EXISTS knowledge_event_entities (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES knowledge_events(id) ON DELETE CASCADE,
        entity_id TEXT NOT NULL REFERENCES knowledge_entities(id) ON DELETE CASCADE,
        weight REAL DEFAULT 1.0,
        description TEXT,
        embedding_json TEXT,
        UNIQUE(event_id, entity_id)
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_event_entities_event ON knowledge_event_entities(event_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_event_entities_entity ON knowledge_event_entities(entity_id);

      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks_fts USING fts5(
        heading, content, content='knowledge_chunks', content_rowid='rowid'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_events_fts USING fts5(
        title, summary, content, content='knowledge_events', content_rowid='rowid'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_entities_fts USING fts5(
        name, description, content='knowledge_entities', content_rowid='rowid'
      );
    `);
	}
	async createSource(params) {
		await this.init();
		if (this.db === void 0) throw new Error("knowledge store not initialized");
		const id = generateId("src");
		const createdAt = Date.now();
		this.db.prepare("INSERT INTO knowledge_sources (id, name, file_path, description, created_at) VALUES (?, ?, ?, ?, ?)").run(id, params.name, params.filePath ?? null, params.description ?? null, createdAt);
		return {
			id,
			name: params.name,
			filePath: params.filePath ?? null,
			description: params.description ?? null,
			createdAt
		};
	}
	async findSourceByFilePath(filePath) {
		await this.init();
		if (this.db === void 0) return void 0;
		const row = this.db.prepare("SELECT * FROM knowledge_sources WHERE file_path = ?").get(filePath);
		return row === void 0 ? void 0 : rowToSource(row);
	}
	async listSources() {
		await this.init();
		if (this.db === void 0) return [];
		return this.db.prepare("SELECT * FROM knowledge_sources ORDER BY created_at DESC").all().map(rowToSource);
	}
	async getSource(id) {
		await this.init();
		if (this.db === void 0) return void 0;
		const row = this.db.prepare("SELECT * FROM knowledge_sources WHERE id = ?").get(id);
		return row === void 0 ? void 0 : rowToSource(row);
	}
	async deleteSource(id) {
		await this.init();
		if (this.db === void 0) return false;
		return this.db.prepare("DELETE FROM knowledge_sources WHERE id = ?").run(id).changes > 0;
	}
	async createDocument(params) {
		if (this.db === void 0) throw new Error("knowledge store not initialized");
		const id = generateId("doc");
		const createdAt = Date.now();
		this.db.prepare("INSERT INTO knowledge_documents (id, source_id, title, content, status, chunk_count, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(id, params.sourceId, params.title, params.content ?? null, "pending", 0, createdAt);
		return {
			id,
			sourceId: params.sourceId,
			title: params.title,
			content: params.content ?? null,
			status: "pending",
			chunkCount: 0,
			createdAt
		};
	}
	async updateDocumentStatus(documentId, status, chunkCount) {
		if (this.db === void 0) return;
		if (chunkCount !== void 0) this.db.prepare("UPDATE knowledge_documents SET status = ?, chunk_count = ? WHERE id = ?").run(status, chunkCount, documentId);
		else this.db.prepare("UPDATE knowledge_documents SET status = ? WHERE id = ?").run(status, documentId);
	}
	async listDocuments() {
		await this.init();
		if (this.db === void 0) return [];
		return this.db.prepare(`SELECT d.*, s.name AS source_name
         FROM knowledge_documents d
         JOIN knowledge_sources s ON s.id = d.source_id
         ORDER BY d.created_at DESC`).all().map((row) => ({
			...rowToDocument(row),
			sourceName: String(row["source_name"])
		}));
	}
	async getDocument(id) {
		await this.init();
		if (this.db === void 0) return void 0;
		const row = this.db.prepare("SELECT * FROM knowledge_documents WHERE id = ?").get(id);
		return row === void 0 ? void 0 : rowToDocument(row);
	}
	async insertChunk(params) {
		if (this.db === void 0) throw new Error("knowledge store not initialized");
		const id = generateId("chk");
		const createdAt = Date.now();
		const embeddingJson = vectorToJson(params.embedding);
		this.db.prepare(`INSERT INTO knowledge_chunks
         (id, source_id, document_id, rank, heading, content, raw_content, embedding_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, params.sourceId, params.documentId, params.rank, params.heading, params.content, params.rawContent, embeddingJson, createdAt);
		this.db.prepare(`INSERT INTO knowledge_chunks_fts (rowid, heading, content)
         VALUES ((SELECT rowid FROM knowledge_chunks WHERE id = ?), ?, ?)`).run(id, params.heading ?? "", params.content);
		return {
			id,
			sourceId: params.sourceId,
			documentId: params.documentId,
			rank: params.rank,
			heading: params.heading,
			content: params.content,
			rawContent: params.rawContent,
			embedding: params.embedding,
			createdAt
		};
	}
	async getChunk(id) {
		await this.init();
		if (this.db === void 0) return void 0;
		const row = this.db.prepare("SELECT * FROM knowledge_chunks WHERE id = ?").get(id);
		return row === void 0 ? void 0 : rowToChunk(row);
	}
	async listChunksByDocument(documentId) {
		await this.init();
		if (this.db === void 0) return [];
		return this.db.prepare("SELECT * FROM knowledge_chunks WHERE document_id = ? ORDER BY rank ASC").all(documentId).map(rowToChunk);
	}
	/** Load all chunk embeddings + ids for vector search. */
	async loadAllChunkEmbeddings() {
		await this.init();
		if (this.db === void 0) return [];
		const rows = this.db.prepare("SELECT id, embedding_json FROM knowledge_chunks WHERE embedding_json IS NOT NULL").all();
		const out = [];
		for (const row of rows) {
			const vec = jsonToVector(row.embedding_json);
			if (vec !== null) out.push({
				id: row.id,
				embedding: vec
			});
		}
		return out;
	}
	async insertEvent(params) {
		if (this.db === void 0) throw new Error("knowledge store not initialized");
		const id = generateId("evt");
		const createdAt = Date.now();
		this.db.prepare(`INSERT INTO knowledge_events
         (id, source_id, document_id, chunk_id, rank, title, summary, content, category, keywords,
          title_embedding_json, content_embedding_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, params.sourceId, params.documentId, params.chunkId, params.rank, params.title, params.summary, params.content, params.category, JSON.stringify(params.keywords), vectorToJson(params.titleEmbedding), vectorToJson(params.contentEmbedding), createdAt);
		this.db.prepare(`INSERT INTO knowledge_events_fts (rowid, title, summary, content)
         VALUES ((SELECT rowid FROM knowledge_events WHERE id = ?), ?, ?, ?)`).run(id, params.title, params.summary ?? "", params.content);
		return {
			id,
			sourceId: params.sourceId,
			documentId: params.documentId,
			chunkId: params.chunkId,
			rank: params.rank,
			title: params.title,
			summary: params.summary,
			content: params.content,
			category: params.category,
			keywords: params.keywords,
			titleEmbedding: params.titleEmbedding,
			contentEmbedding: params.contentEmbedding,
			createdAt
		};
	}
	async getEvent(id) {
		await this.init();
		if (this.db === void 0) return void 0;
		const row = this.db.prepare("SELECT * FROM knowledge_events WHERE id = ?").get(id);
		return row === void 0 ? void 0 : rowToEvent(row);
	}
	async listEventsByDocument(documentId) {
		await this.init();
		if (this.db === void 0) return [];
		return this.db.prepare("SELECT * FROM knowledge_events WHERE document_id = ? ORDER BY rank ASC").all(documentId).map(rowToEvent);
	}
	/** Find events by title vector similarity. */
	async findEventsByTitleVector(queryVec, options = {}) {
		await this.init();
		if (this.db === void 0) return [];
		const limit = options.limit ?? 20;
		const threshold = options.threshold ?? 0;
		const rows = this.db.prepare("SELECT id, title_embedding_json FROM knowledge_events WHERE title_embedding_json IS NOT NULL").all();
		const scored = [];
		for (const row of rows) {
			const vec = jsonToVector(row.title_embedding_json);
			if (vec === null) continue;
			const score = this.embeddingEngine?.cosineSimilarity(queryVec, vec) ?? 0;
			if (score >= threshold) scored.push({
				id: row.id,
				score
			});
		}
		scored.sort((a, b) => b.score - a.score);
		const top = scored.slice(0, limit);
		const out = [];
		for (const item of top) {
			const event = await this.getEvent(item.id);
			if (event !== void 0) out.push({
				event,
				score: item.score
			});
		}
		return out;
	}
	async upsertEntity(params) {
		if (this.db === void 0) throw new Error("knowledge store not initialized");
		if (!isEntityType(params.type)) throw new Error(`invalid entity type: ${params.type}`);
		const normalizedName = normalizeName(params.name);
		const existing = this.db.prepare("SELECT * FROM knowledge_entities WHERE source_id = ? AND type = ? AND normalized_name = ?").get(params.sourceId, params.type, normalizedName);
		if (existing !== void 0) {
			if (params.description !== null && existing["description"] === null) this.db.prepare("UPDATE knowledge_entities SET description = ? WHERE id = ?").run(params.description, String(existing["id"]));
			if (params.embedding !== null && existing["embedding_json"] === null) this.db.prepare("UPDATE knowledge_entities SET embedding_json = ? WHERE id = ?").run(vectorToJson(params.embedding), String(existing["id"]));
			return rowToEntity(existing);
		}
		const id = generateId("ent");
		const createdAt = Date.now();
		this.db.prepare(`INSERT INTO knowledge_entities
         (id, source_id, type, name, normalized_name, description, embedding_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, params.sourceId, params.type, params.name, normalizedName, params.description, vectorToJson(params.embedding), createdAt);
		this.db.prepare(`INSERT INTO knowledge_entities_fts (rowid, name, description)
         VALUES ((SELECT rowid FROM knowledge_entities WHERE id = ?), ?, ?)`).run(id, params.name, params.description ?? "");
		return {
			id,
			sourceId: params.sourceId,
			type: params.type,
			name: params.name,
			normalizedName,
			description: params.description,
			embedding: params.embedding,
			createdAt
		};
	}
	async findEntitiesByName(name, sourceId) {
		await this.init();
		if (this.db === void 0) return [];
		const normalized = normalizeName(name);
		return (sourceId === void 0 ? this.db.prepare("SELECT * FROM knowledge_entities WHERE normalized_name = ?").all(normalized) : this.db.prepare("SELECT * FROM knowledge_entities WHERE normalized_name = ? AND source_id = ?").all(normalized, sourceId)).map(rowToEntity);
	}
	/** Find entities by name vector similarity. */
	async findEntitiesByVector(queryVec, options = {}) {
		await this.init();
		if (this.db === void 0) return [];
		const limit = options.limit ?? 20;
		const threshold = options.threshold ?? 0;
		const rows = this.db.prepare("SELECT id, embedding_json FROM knowledge_entities WHERE embedding_json IS NOT NULL").all();
		const scored = [];
		for (const row of rows) {
			const vec = jsonToVector(row.embedding_json);
			if (vec === null) continue;
			const score = this.embeddingEngine?.cosineSimilarity(queryVec, vec) ?? 0;
			if (score >= threshold) scored.push({
				id: row.id,
				score
			});
		}
		scored.sort((a, b) => b.score - a.score);
		const top = scored.slice(0, limit);
		const out = [];
		for (const item of top) {
			const row = this.db.prepare("SELECT * FROM knowledge_entities WHERE id = ?").get(item.id);
			if (row !== void 0) out.push({
				entity: rowToEntity(row),
				score: item.score
			});
		}
		return out;
	}
	async insertEventEntity(params) {
		if (this.db === void 0) throw new Error("knowledge store not initialized");
		const id = generateId("ee");
		this.db.prepare(`INSERT OR IGNORE INTO knowledge_event_entities
         (id, event_id, entity_id, weight, description, embedding_json)
         VALUES (?, ?, ?, ?, ?, ?)`).run(id, params.eventId, params.entityId, params.weight ?? 1, params.description, vectorToJson(params.embedding));
		return {
			id,
			eventId: params.eventId,
			entityId: params.entityId,
			weight: params.weight ?? 1,
			description: params.description,
			embedding: params.embedding
		};
	}
	async findEventsByEntity(entityId) {
		await this.init();
		if (this.db === void 0) return [];
		return this.db.prepare(`SELECT e.* FROM knowledge_events e
         JOIN knowledge_event_entities ee ON ee.event_id = e.id
         WHERE ee.entity_id = ?`).all(entityId).map(rowToEvent);
	}
	async findEntitiesByEvent(eventId) {
		await this.init();
		if (this.db === void 0) return [];
		return this.db.prepare(`SELECT en.* FROM knowledge_entities en
         JOIN knowledge_event_entities ee ON ee.entity_id = en.id
         WHERE ee.event_id = ?`).all(eventId).map(rowToEntity);
	}
	async listEntities(sourceId) {
		await this.init();
		if (this.db === void 0) return [];
		const sql = sourceId ? `SELECT e.*, COUNT(ee.id) AS event_count
         FROM knowledge_entities e
         LEFT JOIN knowledge_event_entities ee ON ee.entity_id = e.id
         WHERE e.source_id = ?
         GROUP BY e.id
         ORDER BY event_count DESC` : `SELECT e.*, COUNT(ee.id) AS event_count
         FROM knowledge_entities e
         LEFT JOIN knowledge_event_entities ee ON ee.entity_id = e.id
         GROUP BY e.id
         ORDER BY event_count DESC`;
		return (sourceId ? this.db.prepare(sql).all(sourceId) : this.db.prepare(sql).all()).map((row) => ({
			...rowToEntity(row),
			eventCount: Number(row["event_count"] ?? 0)
		}));
	}
	async listEvents(sourceId) {
		await this.init();
		if (this.db === void 0) return [];
		const sql = sourceId ? "SELECT * FROM knowledge_events WHERE source_id = ? ORDER BY rank ASC" : "SELECT * FROM knowledge_events ORDER BY created_at DESC";
		return (sourceId ? this.db.prepare(sql).all(sourceId) : this.db.prepare(sql).all()).map(rowToEvent);
	}
	async listEventEntities(sourceId) {
		await this.init();
		if (this.db === void 0) return [];
		const sql = sourceId ? `SELECT ee.event_id, ee.entity_id
         FROM knowledge_event_entities ee
         JOIN knowledge_events e ON e.id = ee.event_id
         WHERE e.source_id = ?` : "SELECT event_id, entity_id FROM knowledge_event_entities";
		return (sourceId ? this.db.prepare(sql).all(sourceId) : this.db.prepare(sql).all()).map((row) => ({
			eventId: asString(row["event_id"]),
			entityId: asString(row["entity_id"])
		}));
	}
	async ftsSearchChunks(query, limit = 50) {
		await this.init();
		if (this.db === void 0) return [];
		const ftsQuery = buildFtsQuery(query);
		if (ftsQuery === void 0) return [];
		return this.db.prepare(`SELECT c.* FROM knowledge_chunks c
         JOIN knowledge_chunks_fts f ON c.rowid = f.rowid
         WHERE f.knowledge_chunks_fts MATCH ?
         LIMIT ?`).all(ftsQuery, limit).map(rowToChunk);
	}
	async searchChunksByVector(queryVec, options = {}) {
		await this.init();
		if (this.db === void 0) return [];
		const limit = options.limit ?? 50;
		const threshold = options.threshold ?? 0;
		const rows = this.db.prepare("SELECT id, embedding_json FROM knowledge_chunks WHERE embedding_json IS NOT NULL").all();
		const scored = [];
		for (const row of rows) {
			const vec = jsonToVector(row.embedding_json);
			if (vec === null) continue;
			const score = this.embeddingEngine?.cosineSimilarity(queryVec, vec) ?? 0;
			if (score >= threshold) scored.push({
				id: row.id,
				score
			});
		}
		scored.sort((a, b) => b.score - a.score);
		const top = scored.slice(0, limit);
		const out = [];
		for (const item of top) {
			const chunk = await this.getChunk(item.id);
			if (chunk !== void 0) out.push({
				chunk,
				score: item.score
			});
		}
		return out;
	}
	async stats() {
		await this.init();
		if (this.db === void 0) return {
			sources: 0,
			documents: 0,
			chunks: 0,
			events: 0,
			entities: 0
		};
		const count = (table) => {
			return this.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c ?? 0;
		};
		return {
			sources: count("knowledge_sources"),
			documents: count("knowledge_documents"),
			chunks: count("knowledge_chunks"),
			events: count("knowledge_events"),
			entities: count("knowledge_entities")
		};
	}
	async buildSearchResult(chunkId, score, eventId = null) {
		if (this.db === void 0) return void 0;
		const chunk = await this.getChunk(chunkId);
		if (chunk === void 0) return void 0;
		if (this.db.prepare("SELECT * FROM knowledge_documents WHERE id = ?").get(chunk.documentId) === void 0) return void 0;
		const sourceRow = this.db.prepare("SELECT * FROM knowledge_sources WHERE id = ?").get(chunk.sourceId);
		if (sourceRow === void 0) return void 0;
		let eventTitle = null;
		if (eventId !== null) eventTitle = (await this.getEvent(eventId))?.title ?? null;
		return {
			chunkId: chunk.id,
			documentId: chunk.documentId,
			sourceId: chunk.sourceId,
			sourceName: String(sourceRow["name"]),
			heading: chunk.heading,
			content: chunk.content,
			score,
			eventId,
			eventTitle,
			sourcePath: String(sourceRow["file_path"] ?? "")
		};
	}
};
function asString(value) {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
	return "";
}
function asNullableString(value) {
	if (value === null || value === void 0) return null;
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return String(value);
	return null;
}
function rowToSource(row) {
	return {
		id: asString(row["id"]),
		name: asString(row["name"]),
		filePath: asNullableString(row["file_path"]),
		description: asNullableString(row["description"]),
		createdAt: Number(row["created_at"])
	};
}
function rowToDocument(row) {
	return {
		id: asString(row["id"]),
		sourceId: asString(row["source_id"]),
		title: asString(row["title"]),
		content: asNullableString(row["content"]),
		status: asString(row["status"]),
		chunkCount: Number(row["chunk_count"] ?? 0),
		createdAt: Number(row["created_at"])
	};
}
function rowToChunk(row) {
	return {
		id: asString(row["id"]),
		sourceId: asString(row["source_id"]),
		documentId: asString(row["document_id"]),
		rank: Number(row["rank"]),
		heading: asNullableString(row["heading"]),
		content: asString(row["content"]),
		rawContent: asNullableString(row["raw_content"]),
		embedding: jsonToVector(asNullableString(row["embedding_json"])),
		createdAt: Number(row["created_at"])
	};
}
function rowToEvent(row) {
	let keywords = [];
	try {
		const parsed = JSON.parse(asString(row["keywords"] ?? "[]"));
		if (Array.isArray(parsed)) keywords = parsed.filter((k) => typeof k === "string");
	} catch {}
	return {
		id: asString(row["id"]),
		sourceId: asString(row["source_id"]),
		documentId: asString(row["document_id"]),
		chunkId: asString(row["chunk_id"]),
		rank: Number(row["rank"]),
		title: asString(row["title"]),
		summary: asNullableString(row["summary"]),
		content: asString(row["content"]),
		category: asNullableString(row["category"]),
		keywords,
		titleEmbedding: jsonToVector(asNullableString(row["title_embedding_json"])),
		contentEmbedding: jsonToVector(asNullableString(row["content_embedding_json"])),
		createdAt: Number(row["created_at"])
	};
}
function rowToEntity(row) {
	return {
		id: asString(row["id"]),
		sourceId: asString(row["source_id"]),
		type: asString(row["type"]),
		name: asString(row["name"]),
		normalizedName: asString(row["normalized_name"]),
		description: asNullableString(row["description"]),
		embedding: jsonToVector(asNullableString(row["embedding_json"])),
		createdAt: Number(row["created_at"])
	};
}
/**
* Tokenize text so FTS5's unicode61 tokenizer can index mixed CJK/ASCII text.
* Mirrors the memory package's `toFtsText`.
*/
function toFtsText(text) {
	const parts = text.toLowerCase().replaceAll(/([一-鿿㐀-䶿])([a-z0-9])/g, "$1 $2").replaceAll(/([a-z0-9])([一-鿿㐀-䶿])/g, "$1 $2").split(/[^a-z0-9一-鿿㐀-䶿]+/);
	const tokens = [];
	for (const part of parts) {
		if (part.length === 0) continue;
		if (/^[a-z0-9]+$/.test(part)) tokens.push(part);
		else for (const ch of part) if (ch.length > 0) tokens.push(ch);
	}
	return tokens.join(" ");
}
function buildFtsQuery(search) {
	const tokens = toFtsText(search).split(/\s+/).filter((t) => t.length > 0);
	if (tokens.length === 0) return void 0;
	return tokens.map((t) => `"${t.replaceAll("\"", "\"\"")}"`).join(" AND ");
}
//#endregion
//#region ../../packages/knowledge/src/chunking.ts
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const CODE_FENCE_RE = /^(\s*)(`{3,}|~{3,})/;
/**
* Soft cap on chunk token count. BGE-small-zh-v1.5 (the fastembed model used
* here) has a 512-token sequence limit; chunks longer than that get truncated
* at the embedding layer, hurting retrieval quality. We split at ~480 to leave
* headroom for the heading line that gets prepended at embed time.
*/
const MAX_CHUNK_TOKENS = 480;
/**
* Split a markdown document into sections using heading_strict strategy:
* each section begins at a heading and contains all body content until the
* next heading. Consecutive headings collapse to the lowest-level one as the
* main heading. Content before the first heading is grouped as "Introduction".
*
* Mirrors SAG's `buildHeadingStrictSections`.
*/
function chunkMarkdown(content) {
	const lines = content.split("\n");
	const sections = [];
	let buffer = [];
	let currentHeading = null;
	let currentLevel = null;
	let rank = 0;
	let inFence = false;
	const flush = () => {
		const raw = buffer.join("\n").trim();
		const heading = currentHeading;
		const level = currentLevel;
		buffer = [];
		if (raw.length === 0) return;
		const body = stripMarkdown(raw);
		if (body.length === 0 && heading === null) return;
		const subSections = splitLargeSection({
			heading,
			headingLevel: level,
			content: body,
			rawContent: raw,
			rank
		});
		for (const section of subSections) {
			sections.push({
				...section,
				rank
			});
			rank += 1;
		}
	};
	for (const line of lines) {
		if (CODE_FENCE_RE.exec(line)) {
			inFence = !inFence;
			buffer.push(line);
			continue;
		}
		if (inFence) {
			buffer.push(line);
			continue;
		}
		const headingMatch = HEADING_RE.exec(line);
		if (headingMatch) {
			flush();
			currentHeading = headingMatch[2].trim();
			currentLevel = headingMatch[1].length;
		} else buffer.push(line);
	}
	flush();
	return sections;
}
/**
* Strip markdown decorations that hurt embedding quality:
* code fences, inline code, images, links, emphasis markers.
*
* Mirrors SAG's `stripMarkdown`.
*/
function stripMarkdown(text) {
	return text.replaceAll(/^(\s*)```[^\n]*$\n?/gm, "$1").replaceAll(/^(\s*)```[^\n]*$/gm, "").replaceAll(/`([^`]+)`/g, "$1").replaceAll(/!\[([^\]]*)\]\([^)]+\)/g, "$1").replaceAll(/\[([^\]]+)\]\([^)]+\)/g, "$1").replaceAll(/\*\*([^*]+)\*\*/g, "$1").replaceAll(/__([^_]+)__/g, "$1").replaceAll(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, "$1").replaceAll(/(?<!\w)_([^_\n]+)_(?!\w)/g, "$1").replaceAll(/^#{1,6}\s+/gm, "").replaceAll(/\n{3,}/g, "\n\n").trim();
}
/**
* Split a plain text file into chunks by blank-line paragraphs.
* Each non-empty paragraph becomes one chunk with no heading.
* Long paragraphs are split at sentence boundaries to stay under the
* embedding model's token cap (same MAX_CHUNK_TOKENS as markdown).
*/
function chunkText(content) {
	const MAX_PARA_TOKENS = MAX_CHUNK_TOKENS;
	const MAX_PARA_CHARS = MAX_PARA_TOKENS * 4;
	const paragraphs = content.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
	const sections = [];
	let rank = 0;
	for (const para of paragraphs) {
		if (estimateTokens(para) <= MAX_PARA_TOKENS) {
			sections.push({
				heading: null,
				headingLevel: null,
				content: para,
				rawContent: para,
				rank: rank++
			});
			continue;
		}
		const sentences = para.match(/[^.!?。！？\n]+[.!?。！？\n]+|[^.!?。！？\n]+$/g) ?? [para];
		let buffer = "";
		const flushBuffer = () => {
			const text = buffer.trim();
			if (text.length === 0) return;
			sections.push({
				heading: null,
				headingLevel: null,
				content: text,
				rawContent: text,
				rank: rank++
			});
			buffer = "";
		};
		for (const sentence of sentences) {
			const candidate = (buffer + " " + sentence).trim();
			if (buffer.length > 0 && candidate.length > MAX_PARA_CHARS) flushBuffer();
			buffer = buffer.length === 0 ? sentence : `${buffer} ${sentence}`;
		}
		flushBuffer();
	}
	return sections;
}
/** Rough token estimate — chars / 4 (English-leaning; CJK underestimates). */
function estimateTokens(text) {
	return Math.ceil(text.length / 4);
}
/**
* Split a section that exceeds MAX_CHUNK_TOKENS into smaller sub-sections.
* Strategy (mirrors SAG's `splitLargeSection`):
*   1. Split into paragraphs by blank lines.
*   2. Greedily pack paragraphs into chunks under the token cap.
*   3. A paragraph that alone exceeds the cap is split at sentence boundaries;
*      a sentence that itself exceeds the cap is split by character limit.
*
* Sections under the cap are returned unchanged (single-element array).
* The heading is preserved across all sub-sections; rank is reassigned by the
* caller. rawContent is rebuilt from the sub-chunk's content paragraphs.
*/
function splitLargeSection(section) {
	if (estimateTokens(section.content) <= MAX_CHUNK_TOKENS) return [section];
	const paragraphs = section.rawContent.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);
	if (paragraphs.length <= 1) return splitBySentences(section, section.rawContent);
	const result = [];
	let buffer = [];
	let bufferTokens = 0;
	const flushBuffer = () => {
		if (buffer.length === 0) return;
		const raw = buffer.join("\n\n").trim();
		if (raw.length === 0) {
			buffer = [];
			bufferTokens = 0;
			return;
		}
		result.push({
			heading: section.heading,
			headingLevel: section.headingLevel,
			content: stripMarkdown(raw),
			rawContent: raw,
			rank: 0
		});
		buffer = [];
		bufferTokens = 0;
	};
	for (const para of paragraphs) {
		const paraTokens = estimateTokens(para);
		if (paraTokens > MAX_CHUNK_TOKENS) {
			flushBuffer();
			for (const frag of splitBySentences(section, para)) result.push(frag);
			continue;
		}
		if (buffer.length > 0 && bufferTokens + paraTokens > MAX_CHUNK_TOKENS) flushBuffer();
		buffer.push(para);
		bufferTokens += paraTokens;
	}
	flushBuffer();
	return result.length > 0 ? result : [section];
}
/**
* Split a long text into sub-sections at sentence boundaries.
* Falls back to a hard character cut when a single sentence exceeds the cap.
*/
function splitBySentences(section, text) {
	const sentences = splitSentences(text);
	const result = [];
	let buffer = "";
	let bufferTokens = 0;
	const flush = () => {
		const trimmed = buffer.trim();
		if (trimmed.length === 0) {
			buffer = "";
			bufferTokens = 0;
			return;
		}
		result.push({
			heading: section.heading,
			headingLevel: section.headingLevel,
			content: stripMarkdown(trimmed),
			rawContent: trimmed,
			rank: 0
		});
		buffer = "";
		bufferTokens = 0;
	};
	for (const sentence of sentences) {
		const sentTokens = estimateTokens(sentence);
		if (sentTokens > MAX_CHUNK_TOKENS) {
			flush();
			for (const frag of splitByCharLimit(sentence)) result.push({
				heading: section.heading,
				headingLevel: section.headingLevel,
				content: stripMarkdown(frag),
				rawContent: frag,
				rank: 0
			});
			continue;
		}
		if (buffer.length > 0 && bufferTokens + sentTokens > MAX_CHUNK_TOKENS) flush();
		buffer = buffer.length === 0 ? sentence : `${buffer} ${sentence}`;
		bufferTokens += sentTokens;
	}
	flush();
	return result.length > 0 ? result : [{
		heading: section.heading,
		headingLevel: section.headingLevel,
		content: section.content,
		rawContent: section.rawContent,
		rank: 0
	}];
}
/** Split text into sentences using CJK + ASCII punctuation. */
function splitSentences(text) {
	return text.match(/[^。！？!?.\n]+[。！？!?.\n]+|[^。！？!?.\n]+$/g) ?? [text];
}
/** Hard character cut for pathological single sentences longer than the cap. */
function splitByCharLimit(text) {
	const maxChars = MAX_CHUNK_TOKENS * 4;
	const chunks = [];
	let remaining = text.trim();
	while (remaining.length > maxChars) {
		chunks.push(remaining.slice(0, maxChars));
		remaining = remaining.slice(maxChars).trimStart();
	}
	if (remaining.length > 0) chunks.push(remaining);
	return chunks;
}
//#endregion
//#region ../../packages/knowledge/src/extractor.ts
/** Max LLM call attempts for extraction — fails fall back to a heading-derived event. */
const EXTRACTION_MAX_ATTEMPTS = 3;
/** Base delay (ms) for exponential backoff: 100, 200, 400. */
const EXTRACTION_BACKOFF_BASE_MS = 100;
function backoffDelay(attempt) {
	return EXTRACTION_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1);
}
async function callLlmWithBackoff(llm, systemPrompt, userPrompt) {
	let lastError;
	for (let attempt = 1; attempt <= EXTRACTION_MAX_ATTEMPTS; attempt += 1) try {
		return await llm.generate(systemPrompt, userPrompt);
	} catch (error) {
		lastError = error;
		if (attempt < EXTRACTION_MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, backoffDelay(attempt)));
	}
	throw lastError;
}
const ENTITY_TYPES = [
	"person",
	"organization",
	"location",
	"time",
	"product",
	"metric",
	"action",
	"work",
	"group",
	"subject",
	"tags"
];
const EXTRACTION_SYSTEM_PROMPT = `You are a professional knowledge content extractor for a SAG-style event-centric knowledge graph.

Your task: given a markdown section (one chunk), extract exactly ONE fused event that captures the section's core informational content, plus the entities mentioned.

# Output Format

Return a JSON object with this exact shape:

{
  "items": [
    {
      "title": "short event title (≤80 chars, noun phrase or short sentence)",
      "summary": "one-sentence summary of what this section is about",
      "content": "the full informational content of this section, rephrased as a self-contained event description (1-4 sentences)",
      "category": "one of: definition, process, comparison, decision, history, reference, other",
      "keywords": ["3-5 short keywords or phrases"],
      "entities": [
        { "type": "one of ENTITY_TYPES below", "name": "entity name", "description": "one-line context for the entity" }
      ]
    }
  ]
}

# Entity Types

Use only these types:
- person — named individuals
- organization — companies, teams, institutions
- location — places, geographic regions
- time — dates, time periods, eras
- product — products, services, software, tools
- metric — numbers, statistics, measurements
- action — processes, operations, activities
- work — books, papers, projects, artworks
- group — categories, classes, groups of things
- subject — abstract topics, concepts, fields
- tags — use sparingly for cross-cutting labels

# Rules

1. Produce EXACTLY ONE item in the "items" array.
2. The event title should be specific enough to disambiguate from sibling sections.
3. The content must be self-contained — a reader should understand it without the surrounding context.
4. Extract 2-6 entities per chunk. Only include entities that are clearly referenced in the text.
5. Use the entity's most specific name (e.g. "Anthropic" rather than "the company").
6. Output language must follow the main input language. Chinese input requires Chinese title, summary, content, category, keywords, and entity descriptions. English input requires English fields.
7. Output ONLY the JSON object — no prose, no markdown fences, no commentary.

# Example

Input section:
"""
## Model Context Protocol

The Model Context Protocol (MCP) is an open standard introduced by Anthropic in 2024. It defines a JSON-RPC interface between AI assistants and external tools. MCP servers expose resources, prompts, and tools that clients like Claude Desktop can consume.
"""

Output:
{
  "items": [
    {
      "title": "Model Context Protocol introduction",
      "summary": "MCP is an open standard for AI assistant / tool integration introduced by Anthropic in 2024.",
      "content": "The Model Context Protocol (MCP) is an open standard introduced by Anthropic in 2024 that defines a JSON-RPC interface between AI assistants and external tools. MCP servers expose resources, prompts, and tools that clients like Claude Desktop can consume.",
      "category": "definition",
      "keywords": ["MCP", "JSON-RPC", "Anthropic", "AI tools"],
      "entities": [
        { "type": "product", "name": "Model Context Protocol", "description": "Open standard for AI assistant / tool integration" },
        { "type": "organization", "name": "Anthropic", "description": "Company that introduced MCP in 2024" },
        { "type": "time", "name": "2024", "description": "Year MCP was introduced" },
        { "type": "product", "name": "Claude Desktop", "description": "An MCP client application" }
      ]
    }
  ]
}`;
/**
* Build the user prompt for extracting events/entities from a chunk.
* Includes a one-shot example to anchor the expected output shape.
*/
function buildExtractionUserPrompt(chunk) {
	return [
		"Extract the fused event and entities from the following markdown section.",
		"",
		`Section heading: ${chunk.heading ?? "(no heading)"}`,
		"",
		"Section content:",
		"\"\"\"",
		chunk.content,
		"\"\"\"",
		"",
		"Return only the JSON object per the schema."
	].join("\n");
}
/** Extract the first {...} JSON block from a text response. */
function extractJsonFromText(text) {
	const match = text.match(/\{[\s\S]*\}/);
	return match === null ? null : match[0];
}
/** Parse LLM extraction output into structured events. Returns at most 1 event. */
function parseExtractionResponse(text, fallbackChunk) {
	const jsonText = extractJsonFromText(text);
	if (jsonText === null) return fallbackEvent(fallbackChunk);
	try {
		const items = JSON.parse(jsonText)["items"];
		if (!Array.isArray(items) || items.length === 0) return fallbackEvent(fallbackChunk);
		const first = items[0];
		if (first === null || typeof first !== "object") return fallbackEvent(fallbackChunk);
		const obj = first;
		return {
			title: typeof obj["title"] === "string" && obj["title"].trim().length > 0 ? obj["title"].trim() : fallbackChunk.heading ?? "Untitled",
			summary: typeof obj["summary"] === "string" ? obj["summary"].trim() : "",
			content: typeof obj["content"] === "string" && obj["content"].trim().length > 0 ? obj["content"].trim() : fallbackChunk.content,
			category: typeof obj["category"] === "string" ? obj["category"].trim() : "other",
			keywords: parseKeywords(obj["keywords"]),
			entities: parseEntities(obj["entities"])
		};
	} catch {
		return fallbackEvent(fallbackChunk);
	}
}
function parseKeywords(value) {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const item of value) if (typeof item === "string" && item.trim().length > 0) out.push(item.trim());
	return out.slice(0, 10);
}
function parseEntities(value) {
	if (!Array.isArray(value)) return [];
	const out = [];
	const seen = /* @__PURE__ */ new Set();
	for (const item of value) {
		if (item === null || typeof item !== "object") continue;
		const obj = item;
		const type = typeof obj["type"] === "string" ? obj["type"] : "";
		const name = typeof obj["name"] === "string" ? obj["name"].trim() : "";
		const description = typeof obj["description"] === "string" ? obj["description"].trim() : "";
		if (name.length === 0) continue;
		if (!ENTITY_TYPES.includes(type)) continue;
		const key = `${type}|${name.toLowerCase()}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({
			type,
			name,
			description
		});
	}
	return out.slice(0, 20);
}
function fallbackEvent(chunk) {
	return {
		title: chunk.heading ?? "Untitled section",
		summary: "",
		content: chunk.content,
		category: "other",
		keywords: [],
		entities: []
	};
}
/**
* Run extraction on a single chunk via the LLM caller.
* Retries with exponential backoff on transient failures; falls back to a
* heading-derived event only after all attempts fail.
*/
async function extractEventFromChunk(llm, chunk) {
	try {
		return parseExtractionResponse(await callLlmWithBackoff(llm, EXTRACTION_SYSTEM_PROMPT, buildExtractionUserPrompt(chunk)), chunk);
	} catch {
		return fallbackEvent(chunk);
	}
}
/**
* Ask the LLM to rerank candidate events by relevance to a query.
* Returns the candidate ids in reranked order (most relevant first).
*
* If the LLM fails or returns unparseable output, returns the input order.
*/
async function rerankEventsWithLlm(llm, query, candidates, topK) {
	if (candidates.length === 0) return [];
	if (candidates.length <= topK) return candidates.map((c) => c.id);
	const candidateList = candidates.map((c, i) => `[${i}] id=${c.id}\n    title: ${c.title}\n    summary: ${c.summary}`).join("\n");
	const system = `You are a precise relevance judge for a knowledge base retrieval system.

Given a user query and a list of candidate events, select the ${topK} event ids most useful for answering the query.

Return ONLY a JSON object: {"ids": ["id1", "id2", ...]}

The ids must come from the candidate list. Output at most ${topK} ids, most relevant first. No prose, no markdown.`;
	const user = `Query: ${query}

Candidates:
${candidateList}

Return the JSON object now.`;
	try {
		const jsonText = extractJsonFromText(await llm.generate(system, user));
		if (jsonText === null) return candidates.slice(0, topK).map((c) => c.id);
		const parsed = JSON.parse(jsonText);
		if (!Array.isArray(parsed["ids"])) return candidates.slice(0, topK).map((c) => c.id);
		const validIds = new Set(candidates.map((c) => c.id));
		const result = [];
		for (const id of parsed["ids"]) {
			if (typeof id === "string" && validIds.has(id) && !result.includes(id)) result.push(id);
			if (result.length >= topK) break;
		}
		if (result.length === 0) return candidates.slice(0, topK).map((c) => c.id);
		return result;
	} catch {
		return candidates.slice(0, topK).map((c) => c.id);
	}
}
/**
* Extract named entities from a query for entity-recall retrieval.
* Returns a list of {type, name} pairs. Best-effort — falls back to empty.
*/
async function extractQueryEntities(llm, query) {
	const system = `Extract named entities from the user query. Return ONLY a JSON object: {"entities": [{"type": "...", "name": "..."}]}

Use these entity types: ${ENTITY_TYPES.join(", ")}.

Only include entities that explicitly appear in the query. If no clear entities, return an empty array.`;
	try {
		const jsonText = extractJsonFromText(await llm.generate(system, `Query: ${query}`));
		if (jsonText === null) return [];
		const parsed = JSON.parse(jsonText);
		if (!Array.isArray(parsed["entities"])) return [];
		const out = [];
		for (const item of parsed["entities"]) {
			if (item === null || typeof item !== "object") continue;
			const obj = item;
			const type = typeof obj["type"] === "string" ? obj["type"] : "";
			const name = typeof obj["name"] === "string" ? obj["name"].trim() : "";
			if (name.length === 0) continue;
			if (!ENTITY_TYPES.includes(type)) continue;
			out.push({
				type,
				name
			});
		}
		return out;
	} catch {
		return [];
	}
}
//#endregion
//#region ../../packages/knowledge/src/ingest.ts
/**
* Embed texts, returning null-array if embeddings are skipped or on failure.
* Caller should set skipEmbedding=true when the model didn't load in time,
* so the entire ingestion is consistent (all or nothing for embeddings).
* Search falls back to FTS5 keyword match for chunks without embeddings.
*/
async function embedOrNulls(engine, texts, skipEmbedding) {
	if (engine === void 0 || texts.length === 0 || skipEmbedding) return texts.map(() => null);
	if (!engine.available) return texts.map(() => null);
	const vectors = await engine.embedBatch(texts);
	if (vectors === null || vectors.length !== texts.length) return texts.map(() => null);
	return vectors;
}
/** LLM concurrency for extraction — kept low to avoid rate-limit bursts. */
const LLM_CONCURRENCY = 20;
const SUPPORTED_EXTENSIONS = new Set([
	".md",
	".markdown",
	".txt"
]);
/** Read a file and return its content. */
async function readFileContent(filePath) {
	return readFile(filePath, "utf-8");
}
function getFileExtension(filePath) {
	const lastDot = filePath.lastIndexOf(".");
	return lastDot > 0 ? filePath.slice(lastDot).toLowerCase() : "";
}
function chunkContent(content, ext) {
	return ext === ".txt" ? chunkText(content) : chunkMarkdown(content);
}
function isSupportedFile(filePath) {
	return SUPPORTED_EXTENSIONS.has(getFileExtension(filePath));
}
/** Map async iterator values with a concurrency limit. */
async function mapWithConcurrency(items, limit, fn, onProgress) {
	const results = Array.from({ length: items.length });
	let cursor = 0;
	let completed = 0;
	const total = items.length;
	async function worker() {
		while (cursor < items.length) {
			const idx = cursor;
			cursor += 1;
			const item = items[idx];
			const result = await fn(item, idx);
			results[idx] = result;
			completed += 1;
			onProgress?.(completed, total, result);
		}
	}
	const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
	await Promise.all(workers);
	return results;
}
/**
* Ingest a markdown file into the knowledge base.
*
* Steps:
* 1. Dedupe by file_path — if a source already exists for this file, error.
* 2. Read file → chunkMarkdown (heading_strict).
* 3. Embed chunks ("{heading}\n{content}") → store knowledge_chunks.
* 4. For each chunk (concurrency 3): LLM extract 1 event + N entities.
* 5. Embed event title + content ("{title}\n\n{content}") → store knowledge_events.
* 6. Upsert entities (dedupe by source_id+type+normalizedName) + embed entity name → store.
* 7. For each (event, entity) pair: embed relation (entity.description || "{eventTitle} {entityName}") → store knowledge_event_entities.
* 8. Update document status = 'completed'.
*
* All writes run inside a single transaction — a mid-ingest failure rolls back
* every partial row (source/document/chunks/events/entities/edges).
*
* Reports progress via callback.
*/
async function ingestFile(store, llm, filePath, onProgress) {
	const engine = store.getEmbeddingEngine();
	const skipEmbed = engine === void 0 || !engine.available;
	if (skipEmbed) onProgress?.({
		stage: "embedding-check",
		message: "向量模型未就绪，本次摄入跳过向量嵌入"
	});
	const existing = await store.findSourceByFilePath(filePath);
	if (existing !== void 0) {
		onProgress?.({
			stage: "error",
			message: `文件已摄入：${existing.name}（source id=${existing.id}）`
		});
		throw new Error(`文件已摄入过: ${filePath} (source ${existing.id})`);
	}
	onProgress?.({
		stage: "chunking",
		message: `读取并切分文件: ${basename(filePath)}`
	});
	const content = await readFileContent(filePath);
	const sections = chunkContent(content, getFileExtension(filePath));
	if (sections.length === 0) {
		onProgress?.({
			stage: "error",
			message: "文件无有效内容"
		});
		throw new Error("文件无有效内容可摄入");
	}
	store.beginTransaction();
	try {
		const fileName = basename(filePath);
		const source = await store.createSource({
			name: fileName,
			filePath,
			description: null
		});
		const document = await store.createDocument({
			sourceId: source.id,
			title: fileName,
			content
		});
		onProgress?.({
			stage: "embedding-chunks",
			chunkIndex: 0,
			totalChunks: sections.length,
			message: `嵌入 chunks: 0/${sections.length}`
		});
		const chunkEmbeddings = await embedOrNulls(engine, sections.map((s) => s.heading !== null ? `${s.heading}\n${s.content}` : s.content), skipEmbed);
		const chunks = [];
		for (let i = 0; i < sections.length; i++) {
			const section = sections[i];
			const embedding = chunkEmbeddings[i] ?? null;
			const chunk = await store.insertChunk({
				sourceId: source.id,
				documentId: document.id,
				rank: section.rank,
				heading: section.heading,
				content: section.content,
				rawContent: section.rawContent,
				embedding
			});
			chunks.push(chunk);
			onProgress?.({
				stage: "embedding-chunks",
				chunkIndex: i + 1,
				totalChunks: sections.length,
				message: `嵌入 chunks: ${i + 1}/${sections.length}`
			});
		}
		onProgress?.({
			stage: "extracting",
			chunkIndex: 0,
			totalChunks: sections.length,
			message: `抽取事件: 0/${sections.length}`
		});
		const extractedEvents = await mapWithConcurrency(sections, LLM_CONCURRENCY, (section) => extractEventFromChunk(llm, section), (completed, total) => {
			onProgress?.({
				stage: "extracting",
				chunkIndex: completed,
				totalChunks: total,
				message: `抽取事件: ${completed}/${total}`
			});
		});
		onProgress?.({
			stage: "embedding-events",
			chunkIndex: 0,
			totalChunks: sections.length,
			message: `嵌入 events: 0/${sections.length}`
		});
		const titleTexts = extractedEvents.map((e) => e.title);
		const contentTexts = extractedEvents.map((e) => `${e.title}\n\n${e.content}`);
		const [titleEmbeddings, contentEmbeddings] = await Promise.all([embedOrNulls(engine, titleTexts, skipEmbed), embedOrNulls(engine, contentTexts, skipEmbed)]);
		const events = [];
		for (let i = 0; i < extractedEvents.length; i++) {
			const extracted = extractedEvents[i];
			const chunk = chunks[i];
			const event = await store.insertEvent({
				sourceId: source.id,
				documentId: document.id,
				chunkId: chunk.id,
				rank: i,
				title: extracted.title,
				summary: extracted.summary.length > 0 ? extracted.summary : null,
				content: extracted.content,
				category: extracted.category.length > 0 ? extracted.category : null,
				keywords: extracted.keywords,
				titleEmbedding: titleEmbeddings[i] ?? null,
				contentEmbedding: contentEmbeddings[i] ?? null
			});
			events.push(event);
			onProgress?.({
				stage: "embedding-events",
				chunkIndex: i + 1,
				totalChunks: sections.length,
				message: `嵌入 events: ${i + 1}/${sections.length}`
			});
		}
		onProgress?.({
			stage: "embedding-entities",
			message: "嵌入 entities..."
		});
		const entityMap = /* @__PURE__ */ new Map();
		for (const extracted of extractedEvents) for (const entity of extracted.entities) {
			const key = `${entity.type}|${entity.name.toLowerCase()}`;
			if (!entityMap.has(key)) entityMap.set(key, entity);
		}
		const uniqueEntities = Array.from(entityMap.values());
		const entityEmbeddings = uniqueEntities.length > 0 ? await embedOrNulls(engine, uniqueEntities.map((e) => e.name), skipEmbed) : [];
		const entityIdByEntityKey = /* @__PURE__ */ new Map();
		for (let i = 0; i < uniqueEntities.length; i++) {
			const entity = uniqueEntities[i];
			const embedding = entityEmbeddings[i] ?? null;
			const stored = await store.upsertEntity({
				sourceId: source.id,
				type: entity.type,
				name: entity.name,
				description: entity.description.length > 0 ? entity.description : null,
				embedding
			});
			entityIdByEntityKey.set(`${entity.type}|${entity.name.toLowerCase()}`, stored.id);
		}
		onProgress?.({
			stage: "embedding-relations",
			message: "嵌入关系..."
		});
		const relationPairs = [];
		for (let i = 0; i < extractedEvents.length; i++) {
			const extracted = extractedEvents[i];
			for (const entity of extracted.entities) relationPairs.push({
				eventIndex: i,
				entity
			});
		}
		const relationTexts = relationPairs.map(({ eventIndex, entity }) => {
			const event = events[eventIndex];
			return entity.description.length > 0 ? entity.description : `${event.title} ${entity.name}`;
		});
		const relationEmbeddings = relationPairs.length > 0 ? await embedOrNulls(engine, relationTexts, skipEmbed) : [];
		for (let i = 0; i < relationPairs.length; i++) {
			const pair = relationPairs[i];
			const event = events[pair.eventIndex];
			const entityKey = `${pair.entity.type}|${pair.entity.name.toLowerCase()}`;
			const entityId = entityIdByEntityKey.get(entityKey);
			if (entityId === void 0) continue;
			const embedding = relationEmbeddings?.[i] ?? null;
			await store.insertEventEntity({
				eventId: event.id,
				entityId,
				weight: 1,
				description: pair.entity.description.length > 0 ? pair.entity.description : null,
				embedding
			});
		}
		await store.updateDocumentStatus(document.id, "completed", chunks.length);
		store.commitTransaction();
		onProgress?.({
			stage: "completed",
			message: `摄入完成：${chunks.length} chunks, ${events.length} events, ${uniqueEntities.length} entities`
		});
		return {
			documentId: document.id,
			chunkCount: chunks.length,
			eventCount: events.length,
			entityCount: uniqueEntities.length
		};
	} catch (error) {
		store.rollbackTransaction();
		throw error;
	}
}
async function collectSupportedFiles(dirPath) {
	const files = [];
	const entries = await readdir(dirPath, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = join(dirPath, entry.name);
		if (entry.isDirectory()) files.push(...await collectSupportedFiles(fullPath));
		else if (entry.isFile() && isSupportedFile(fullPath)) files.push(fullPath);
	}
	return files.sort();
}
async function ingestDirectory(store, llm, dirPath, onProgress) {
	const files = await collectSupportedFiles(dirPath);
	if (files.length === 0) throw new Error(`目录下没有支持的文件 (.md, .markdown, .txt): ${dirPath}`);
	const errors = [];
	let succeeded = 0;
	let totalChunks = 0;
	let totalEvents = 0;
	let totalEntities = 0;
	for (let i = 0; i < files.length; i++) {
		const filePath = files[i];
		const fileProgress = (progress) => {
			const prefix = `批量摄入 ${i + 1}/${files.length}: ${basename(filePath)}`;
			onProgress?.({
				...progress,
				message: `${prefix} · ${progress.message}`
			});
		};
		try {
			const result = await ingestFile(store, llm, filePath, fileProgress);
			succeeded += 1;
			totalChunks += result.chunkCount;
			totalEvents += result.eventCount;
			totalEntities += result.entityCount;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			errors.push({
				filePath,
				message
			});
			onProgress?.({
				stage: "error",
				message: `批量摄入 ${i + 1}/${files.length}: ${basename(filePath)} · 失败: ${message}`
			});
		}
	}
	onProgress?.({
		stage: "completed",
		message: `批量摄入完成：${succeeded}/${files.length} 个文件成功，${totalChunks} chunks, ${totalEvents} events, ${totalEntities} entities`
	});
	return {
		succeeded,
		failed: errors.length,
		totalChunks,
		totalEvents,
		totalEntities,
		errors
	};
}
//#endregion
//#region ../../packages/knowledge/src/search.ts
const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 20;
const SEED_EVENT_LIMIT = 30;
const EXPANDED_EVENT_LIMIT = 100;
const COARSE_RANK_LIMIT = 50;
const ENTITY_VECTOR_THRESHOLD = .7;
const TITLE_VECTOR_THRESHOLD = .4;
async function timed(onStep, step, detail, fn, payload) {
	const start = performance.now();
	try {
		const result = await fn();
		const traceStep = {
			step,
			detail,
			durationMs: Math.round((performance.now() - start) * 100) / 100,
			...payload !== void 0 ? { payload: payload(result) } : {}
		};
		onStep?.(traceStep);
		return result;
	} catch (error) {
		const durationMs = Math.round((performance.now() - start) * 100) / 100;
		onStep?.({
			step,
			detail: `${detail} 失败：${error instanceof Error ? error.message : String(error)}`,
			durationMs
		});
		throw error;
	}
}
/**
* Multi-hop retrieval:
* 1. Vectorize query.
* 2. Entity recall — LLM extracts entities from query → match by name + vector.
* 3. Seed events — events linked to recalled entities + events by title vector similarity.
* 4. BFS expand (1 hop) — from seed events, walk to entities, then to other events.
* 5. Coarse rank — score graph-reachable events by content embedding similarity.
*    Graph associativity is the gate; content vector orders within it.
* 6. LLM rerank — pick top-K most relevant.
* 7. Return corresponding chunks (deduped by chunk_id) with scores and provenance.
*    If rerank yields fewer than topK chunks, backfill by direct chunk vector search.
*
* Optional `onStep` callback receives a trace step at each phase — used by the
* KnowledgeLookup tool to expose retrieval diagnostics to the agent.
*/
async function multiSearch(store, llm, query, options = {}) {
	return (await multiSearchWithTrace(store, llm, query, options)).results;
}
/** Like multiSearch but also returns the retrieval trace for diagnostics. */
async function multiSearchWithTrace(store, llm, query, options = {}) {
	const topK = Math.min(options.topK ?? DEFAULT_TOP_K, MAX_TOP_K);
	const steps = [];
	const onStep = (step) => steps.push(step);
	const rerankedEventTitles = [];
	let fallbackReason = null;
	const engine = store.getEmbeddingEngine();
	if (engine === void 0 || !engine.available) {
		fallbackReason = "embedding engine unavailable; used FTS5 keyword fallback";
		return {
			results: await ftsFallback(store, query, topK),
			trace: {
				steps,
				rerankedEventTitles,
				fallbackReason
			}
		};
	}
	const queryEmbeddings = await timed(onStep, "queryEmbedding", "把用户问题转成向量，用于召回相关事件和切片。", async () => engine.embedBatch([query]));
	if (queryEmbeddings === null || queryEmbeddings.length === 0) {
		fallbackReason = "query embedding returned null; used FTS5 fallback";
		return {
			results: await ftsFallback(store, query, topK),
			trace: {
				steps,
				rerankedEventTitles,
				fallbackReason
			}
		};
	}
	const queryVec = queryEmbeddings[0];
	const recalledEntities = await timed(onStep, "entityRecall", "LLM 抽 query 实体 + 名字精确匹配 + 向量召回。", () => recallEntities(store, llm, query, queryVec), (entities) => ({ count: entities.length }));
	const seedEventIds = /* @__PURE__ */ new Set();
	for (const entity of recalledEntities) {
		const events = await store.findEventsByEntity(entity.id);
		for (const event of events) seedEventIds.add(event.id);
	}
	const titleMatches = await timed(onStep, "seedEventsByTitle", "按查询向量在事件标题向量上召回 seed events。", () => store.findEventsByTitleVector(queryVec, {
		limit: SEED_EVENT_LIMIT,
		threshold: TITLE_VECTOR_THRESHOLD
	}), (matches) => ({ count: matches.length }));
	for (const { event } of titleMatches) seedEventIds.add(event.id);
	if (seedEventIds.size === 0) {
		fallbackReason = "no seed events; used direct chunk vector search";
		return {
			results: await chunkVectorFallback(store, queryVec, topK),
			trace: {
				steps,
				rerankedEventTitles,
				fallbackReason
			}
		};
	}
	const expandedEventIds = await timed(onStep, "bfsExpand", "从 seed events 沿实体关系 1 跳扩展候选事件。", async () => {
		const ids = new Set(seedEventIds);
		let capped = false;
		for (const eventId of seedEventIds) {
			const entities = await store.findEntitiesByEvent(eventId);
			for (const entity of entities) {
				const neighborEvents = await store.findEventsByEntity(entity.id);
				for (const neighbor of neighborEvents) {
					ids.add(neighbor.id);
					if (ids.size >= EXPANDED_EVENT_LIMIT) {
						capped = true;
						break;
					}
				}
				if (ids.size >= EXPANDED_EVENT_LIMIT) break;
			}
			if (ids.size >= EXPANDED_EVENT_LIMIT) break;
		}
		return {
			ids,
			capped
		};
	}, (result) => ({
		expandedCount: result.ids.size,
		capped: result.capped
	}));
	const { candidates, topCandidates } = await timed(onStep, "coarseRank", "按 content 向量相似度对候选事件排序，取前 COARSE_RANK_LIMIT 个。", async () => {
		const cands = [];
		for (const eventId of expandedEventIds.ids) {
			const event = await store.getEvent(eventId);
			if (event === void 0) continue;
			const vec = event.contentEmbedding;
			const score = vec === null ? 0 : engine.cosineSimilarity(queryVec, vec);
			cands.push({
				id: event.id,
				title: event.title,
				summary: event.summary ?? "",
				score,
				chunkId: event.chunkId
			});
		}
		cands.sort((a, b) => b.score - a.score);
		return {
			candidates: cands,
			topCandidates: cands.slice(0, COARSE_RANK_LIMIT)
		};
	}, (result) => ({
		totalCandidates: result.candidates.length,
		kept: result.topCandidates.length,
		topScore: result.topCandidates[0]?.score ?? 0
	}));
	if (candidates.length === 0) {
		fallbackReason = "no graph-reachable events with content; used chunk vector fallback";
		return {
			results: await chunkVectorFallback(store, queryVec, topK),
			trace: {
				steps,
				rerankedEventTitles,
				fallbackReason
			}
		};
	}
	let rankedIds;
	if (options.skipRerank === true) {
		rankedIds = topCandidates.map((c) => c.id);
		onStep({
			step: "rerank",
			detail: "跳过 LLM rerank（skipRerank=true），直接用 coarse rank 顺序。",
			durationMs: 0,
			payload: { count: rankedIds.length }
		});
	} else if (topCandidates.length <= topK) {
		rankedIds = topCandidates.map((c) => c.id);
		onStep({
			step: "rerank",
			detail: `候选数 ${topCandidates.length} ≤ topK ${topK}，无需 LLM rerank。`,
			durationMs: 0,
			payload: { count: rankedIds.length }
		});
	} else rankedIds = await timed(onStep, "rerank", `LLM 从 ${topCandidates.length} 个候选中选最相关的 ${topK} 个。`, () => rerankEventsWithLlm(llm, query, topCandidates.map((c) => ({
		id: c.id,
		title: c.title,
		summary: c.summary
	})), topK), (ids) => ({ count: ids.length }));
	for (const id of rankedIds) {
		const c = topCandidates.find((x) => x.id === id);
		if (c !== void 0) rerankedEventTitles.push(c.title);
	}
	const seen = /* @__PURE__ */ new Set();
	const results = [];
	for (const eventId of rankedIds) {
		const candidate = topCandidates.find((c) => c.id === eventId);
		if (candidate === void 0) continue;
		if (seen.has(candidate.chunkId)) continue;
		seen.add(candidate.chunkId);
		const result = await store.buildSearchResult(candidate.chunkId, candidate.score, eventId);
		if (result !== void 0) results.push(result);
		if (results.length >= topK) break;
	}
	if (results.length < topK) {
		let supplemented = 0;
		for (const candidate of topCandidates) {
			if (results.length >= topK) break;
			if (rankedIds.includes(candidate.id)) continue;
			if (seen.has(candidate.chunkId)) continue;
			seen.add(candidate.chunkId);
			const result = await store.buildSearchResult(candidate.chunkId, candidate.score, candidate.id);
			if (result !== void 0) {
				results.push(result);
				supplemented += 1;
			}
		}
		if (supplemented > 0) onStep({
			step: "supplementFromCoarse",
			detail: `rerank 结果不足，从 coarse rank 残余补 ${supplemented} 个。`,
			durationMs: 0,
			payload: { supplemented }
		});
	}
	if (results.length < topK) {
		const remaining = topK - results.length;
		const backfill = await timed(onStep, "backfill", `rerank 结果不足，回退到 chunk 向量搜索补 ${remaining} 个。`, () => store.searchChunksByVector(queryVec, { limit: remaining * 2 }), (matches) => ({ backfillCandidates: matches.length }));
		for (const { chunk, score } of backfill) {
			if (results.length >= topK) break;
			if (seen.has(chunk.id)) continue;
			seen.add(chunk.id);
			const result = await store.buildSearchResult(chunk.id, score);
			if (result !== void 0) results.push(result);
		}
	}
	return {
		results,
		trace: {
			steps,
			rerankedEventTitles,
			fallbackReason
		}
	};
}
/** Recall entities by name (LLM-extracted) and by vector similarity. */
async function recallEntities(store, llm, query, queryVec) {
	const out = /* @__PURE__ */ new Map();
	const queryEntities = await extractQueryEntities(llm, query);
	for (const { name } of queryEntities) {
		const matches = await store.findEntitiesByName(name);
		for (const entity of matches) out.set(entity.id, { id: entity.id });
	}
	const vectorMatches = await store.findEntitiesByVector(queryVec, {
		limit: 20,
		threshold: ENTITY_VECTOR_THRESHOLD
	});
	for (const { entity } of vectorMatches) out.set(entity.id, { id: entity.id });
	return Array.from(out.values());
}
/** FTS5 keyword fallback when embeddings are unavailable. */
async function ftsFallback(store, query, topK) {
	const chunks = await store.ftsSearchChunks(query, topK * 2);
	const results = [];
	for (const chunk of chunks) {
		const result = await store.buildSearchResult(chunk.id, 0);
		if (result !== void 0) results.push(result);
		if (results.length >= topK) break;
	}
	return results;
}
/** Direct chunk vector search fallback. */
async function chunkVectorFallback(store, queryVec, topK) {
	const matches = await store.searchChunksByVector(queryVec, { limit: topK * 2 });
	const results = [];
	for (const { chunk, score } of matches) {
		const result = await store.buildSearchResult(chunk.id, score);
		if (result !== void 0) results.push(result);
		if (results.length >= topK) break;
	}
	return results;
}
//#endregion
export { join as C, resolve as D, relative as E, isAbsolute as S, parse as T, splitLargeSection as _, isSupportedFile as a, basename as b, buildExtractionUserPrompt as c, extractQueryEntities as d, parseExtractionResponse as f, estimateTokens as g, chunkText as h, ingestFile as i, extractEventFromChunk as l, chunkMarkdown as m, multiSearchWithTrace as n, ENTITY_TYPES as o, rerankEventsWithLlm as p, ingestDirectory as r, EXTRACTION_SYSTEM_PROMPT as s, multiSearch as t, extractJsonFromText as u, stripMarkdown as v, normalize as w, dirname as x, KnowledgeStore as y };
