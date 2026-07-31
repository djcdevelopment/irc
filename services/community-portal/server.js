"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
const {DatabaseSync} = require("node:sqlite");

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9[\]{}\\`_^|-]{1,31}$/;
const AGENT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{1,23}$/;
const RESERVED_NAMES = new Set([
	"admin",
	"chanserv",
	"communityregistrar",
	"computebot",
	"dereksbotherder",
	"global",
	"hostserv",
	"nickserv",
	"operator",
	"operserv",
	"root",
]);
const MAX_BODY_BYTES = 16 * 1024;
const RENAMEABLE_FAILURES = new Set(["name_taken"]);
const APP_ROOT = path.resolve(__dirname);
const PUBLIC_ROOT = path.join(APP_ROOT, "public");
const PUBLIC_FILES = new Map([
	["/", ["index.html", "text/html; charset=utf-8"]],
	["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
	["/installer.js", ["installer.js", "text/javascript; charset=utf-8"]],
	["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
	["/guide", ["guide.html", "text/html; charset=utf-8"]],
	["/guide/", ["guide.html", "text/html; charset=utf-8"]],
	["/guide/styles.css", ["styles.css", "text/css; charset=utf-8"]],
	["/guide/guide.css", ["guide.css", "text/css; charset=utf-8"]],
	["/guide/AGENT-HANDOFF.md", ["AGENT-HANDOFF.md", "text/markdown; charset=utf-8"]],
	["/agent-kit/compose.yaml", ["../agent-kit/compose.yaml", "text/yaml; charset=utf-8"]],
	["/agent-kit/Dockerfile", ["../agent-kit/Dockerfile", "text/plain; charset=utf-8"]],
	["/agent-kit/agent_adapter.py", ["../agent-kit/agent_adapter.py", "text/x-python; charset=utf-8"]],
	["/agent-kit/requirements.txt", ["../agent-kit/requirements.txt", "text/plain; charset=utf-8"]],
	["/agent-kit/RUNBOOK.md", ["../agent-kit/RUNBOOK.md", "text/markdown; charset=utf-8"]],
]);

function requiredEnvironment(name) {
	const value = process.env[name];
	if (!value || /[\r\n\0]/.test(value)) {
		throw new Error(`required environment variable is absent or invalid: ${name}`);
	}
	return value;
}

const config = {
	host: process.env.COMMUNITY_PORTAL_HOST || "0.0.0.0",
	port: Number.parseInt(process.env.COMMUNITY_PORTAL_PORT || "9010", 10),
	stateDir: process.env.COMMUNITY_STATE_DIR || "/var/lib/community",
	herderMembersDir:
		process.env.BOT_HERDER_MEMBERS_DIR || "/var/lib/bot-herder/members",
	loungeHome: process.env.THELOUNGE_HOME || "/var/opt/thelounge",
	loungeCommand: (process.env.COMMUNITY_THELOUNGE_BIN || "/usr/local/bin/thelounge")
		.trim()
		.split(/\s+/),
	publicBase: requiredEnvironment("COMMUNITY_PUBLIC_BASE").replace(/\/+$/, ""),
	loungeUrl: requiredEnvironment("COMMUNITY_LOUNGE_URL").replace(/\/?$/, "/"),
	ircPublicHost: requiredEnvironment("COMMUNITY_IRC_PUBLIC_HOST"),
	ircPublicPort: Number.parseInt(
		process.env.COMMUNITY_IRC_PUBLIC_PORT || "8443",
		10
	),
	ircServer: process.env.COMMUNITY_IRC_SERVER || "ergo",
	ircPort: Number.parseInt(process.env.COMMUNITY_IRC_PORT || "6667", 10),
	registrarAccount: requiredEnvironment("COMMUNITY_REGISTRAR_ACCOUNT"),
	registrarPassword: requiredEnvironment("COMMUNITY_REGISTRAR_PASSWORD"),
	registrarOperName: requiredEnvironment("COMMUNITY_REGISTRAR_OPER_NAME"),
	registrarOperPassword: requiredEnvironment("COMMUNITY_REGISTRAR_OPER_PASSWORD"),
	adminToken: requiredEnvironment("COMMUNITY_ADMIN_TOKEN"),
	internalToken: requiredEnvironment("COMMUNITY_INTERNAL_TOKEN"),
	credentialKey: Buffer.from(
		requiredEnvironment("COMMUNITY_CREDENTIAL_KEY"),
		"base64url"
	),
};

if (
	!Number.isInteger(config.port) ||
	config.port < 1 ||
	config.port > 65535 ||
	!Number.isInteger(config.ircPort) ||
	config.ircPort < 1 ||
	config.ircPort > 65535 ||
	!Number.isInteger(config.ircPublicPort) ||
	config.ircPublicPort < 1 ||
	config.ircPublicPort > 65535
) {
	throw new Error("configured port is invalid");
}
if (config.credentialKey.length !== 32) {
	throw new Error("COMMUNITY_CREDENTIAL_KEY must decode to exactly 32 bytes");
}

for (const directory of [
	config.stateDir,
	path.join(config.stateDir, "tmp"),
	config.herderMembersDir,
	path.join(config.loungeHome, "users"),
]) {
	fs.mkdirSync(directory, {recursive: true, mode: 0o700});
}

const database = new DatabaseSync(path.join(config.stateDir, "community.sqlite"));
database.exec(`
	PRAGMA journal_mode = WAL;
	PRAGMA foreign_keys = ON;
	CREATE TABLE IF NOT EXISTS invites (
		id TEXT PRIMARY KEY,
		token_hash TEXT NOT NULL UNIQUE,
		kind TEXT NOT NULL CHECK (kind IN ('member', 'agent')),
		state TEXT NOT NULL CHECK (state IN ('pending', 'provisioning', 'redeemed', 'revoked', 'failed')),
		display_name TEXT NOT NULL,
		owner_account TEXT,
		herder_account TEXT,
		agent_name TEXT,
		agent_account TEXT,
		credential_cipher TEXT,
		created_at TEXT NOT NULL,
		expires_at TEXT NOT NULL,
		redeemed_at TEXT,
		failure_code TEXT
	);
	CREATE TABLE IF NOT EXISTS members (
		owner_account TEXT PRIMARY KEY COLLATE NOCASE,
		display_name TEXT NOT NULL,
		herder_account TEXT NOT NULL UNIQUE COLLATE NOCASE,
		created_at TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS agents (
		account TEXT PRIMARY KEY COLLATE NOCASE,
		owner_account TEXT NOT NULL COLLATE NOCASE,
		herder_account TEXT NOT NULL COLLATE NOCASE,
		display_name TEXT NOT NULL,
		state TEXT NOT NULL CHECK (state IN ('active', 'revoked')),
		created_at TEXT NOT NULL,
		revoked_at TEXT,
		FOREIGN KEY(owner_account) REFERENCES members(owner_account)
	);
	CREATE INDEX IF NOT EXISTS invites_token_hash ON invites(token_hash);
	CREATE INDEX IF NOT EXISTS agents_owner ON agents(owner_account, herder_account);
`);

const attempts = new Map();

function nowIso() {
	return new Date().toISOString();
}

function tokenHash(token) {
	return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function safeEqual(left, right) {
	const a = Buffer.from(left || "", "utf8");
	const b = Buffer.from(right || "", "utf8");
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function encryptCredentials(value) {
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv("aes-256-gcm", config.credentialKey, iv);
	const plaintext = Buffer.from(JSON.stringify(value), "utf8");
	const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

function decryptCredentials(value) {
	const payload = Buffer.from(value, "base64url");
	if (payload.length < 29) {
		throw new Error("credential envelope is invalid");
	}
	const decipher = crypto.createDecipheriv(
		"aes-256-gcm",
		config.credentialKey,
		payload.subarray(0, 12)
	);
	decipher.setAuthTag(payload.subarray(12, 28));
	return JSON.parse(
		Buffer.concat([
			decipher.update(payload.subarray(28)),
			decipher.final(),
		]).toString("utf8")
	);
}

function strongSecret() {
	return crypto.randomBytes(32).toString("base64url");
}

function normalizePath(urlValue) {
	const parsed = new URL(urlValue, "http://portal.invalid");
	let pathname = parsed.pathname.replace(/\/{2,}/g, "/");
	if (pathname === "/join") {
		pathname = "/";
	} else if (pathname.startsWith("/join/")) {
		pathname = pathname.slice(5) || "/";
	}
	return {pathname, searchParams: parsed.searchParams};
}

function securityHeaders(response, contentType = "application/json; charset=utf-8") {
	response.setHeader("Content-Type", contentType);
	response.setHeader("Cache-Control", "no-store, max-age=0");
	response.setHeader("Pragma", "no-cache");
	response.setHeader("Referrer-Policy", "no-referrer");
	response.setHeader("X-Content-Type-Options", "nosniff");
	response.setHeader("X-Frame-Options", "DENY");
	response.setHeader(
		"Content-Security-Policy",
		"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
	);
}

function jsonResponse(response, status, value) {
	securityHeaders(response);
	response.statusCode = status;
	response.end(JSON.stringify(value));
}

function textResponse(response, status, body, contentType) {
	securityHeaders(response, contentType);
	response.statusCode = status;
	response.end(body);
}

async function readJson(request) {
	let size = 0;
	const chunks = [];
	for await (const chunk of request) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) {
			throw Object.assign(new Error("request body is too large"), {status: 413});
		}
		chunks.push(chunk);
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
	} catch {
		throw Object.assign(new Error("request body is not valid JSON"), {status: 400});
	}
}

function bearerToken(request) {
	const value = String(request.headers.authorization || "");
	return value.startsWith("Bearer ") ? value.slice(7) : "";
}

function requireToken(request, expected) {
	if (!safeEqual(bearerToken(request), expected)) {
		throw Object.assign(new Error("unauthorized"), {status: 401});
	}
}

function clientAddress(request) {
	const forwarded = String(request.headers["x-forwarded-for"] || "")
		.split(",", 1)[0]
		.trim();
	return forwarded || request.socket.remoteAddress || "unknown";
}

function enforcePublicRateLimit(request) {
	const key = clientAddress(request);
	const cutoff = Date.now() - 60_000;
	const current = (attempts.get(key) || []).filter((value) => value > cutoff);
	if (current.length >= 20) {
		throw Object.assign(new Error("too many attempts; try again shortly"), {
			status: 429,
		});
	}
	current.push(Date.now());
	attempts.set(key, current);
}

function validAccount(value, label) {
	if (typeof value !== "string") {
		throw Object.assign(new Error(`${label} is required`), {status: 400});
	}
	const trimmed = value.trim();
	if (!NAME_PATTERN.test(trimmed) || RESERVED_NAMES.has(trimmed.toLowerCase())) {
		throw Object.assign(
			new Error(
				`${label} must be 2–32 IRC-safe characters and cannot be reserved`
			),
			{status: 400, code: "invalid_name"}
		);
	}
	return trimmed;
}

function validExistingAccount(value, label) {
	if (typeof value !== "string" || !NAME_PATTERN.test(value.trim())) {
		throw Object.assign(new Error(`${label} is invalid`), {
			status: 400,
			code: "invalid_name",
		});
	}
	return value.trim();
}

function validAgentName(value) {
	if (typeof value !== "string" || !AGENT_NAME_PATTERN.test(value.trim())) {
		throw Object.assign(
			new Error("agent name must be 2–24 letters, numbers, hyphens, or underscores"),
			{status: 400, code: "invalid_agent_name"}
		);
	}
	return value.trim();
}

function validDisplayName(value, fallback = "Community member") {
	const text = typeof value === "string" ? value.trim() : "";
	if (!text) {
		return fallback;
	}
	if (text.length > 80 || /[\r\n\0<>]/.test(text)) {
		throw Object.assign(new Error("display name is invalid"), {status: 400});
	}
	return text;
}

function validProvisioningPassword(value) {
	if (
		typeof value !== "string" ||
		value.length < 12 ||
		value.length > 128 ||
		/[\r\n\0]/.test(value)
	) {
		throw Object.assign(new Error("account password is invalid"), {
			status: 400,
			code: "invalid_password",
		});
	}
	return value;
}

function makeAgentAccount(owner, agentName) {
	const normalizedOwner = owner.replace(/[^A-Za-z0-9]/g, "").slice(0, 14);
	const normalizedAgent = agentName.replace(/[^A-Za-z0-9]/g, "").slice(0, 14);
	return `${normalizedOwner}-${normalizedAgent}`.slice(0, 32);
}

function createInviteRecord({
	kind,
	displayName,
	ownerAccount = null,
	herderAccount = null,
	agentName = null,
	agentAccount = null,
	expiresHours = 24,
}) {
	const token = strongSecret();
	const id = crypto.randomUUID();
	const created = new Date();
	const expires = new Date(created.getTime() + expiresHours * 60 * 60 * 1000);
	database
		.prepare(
			`INSERT INTO invites (
				id, token_hash, kind, state, display_name, owner_account,
				herder_account, agent_name, agent_account, created_at, expires_at
			) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			id,
			tokenHash(token),
			kind,
			displayName,
			ownerAccount,
			herderAccount,
			agentName,
			agentAccount,
			created.toISOString(),
			expires.toISOString()
		);
	return {
		id,
		url: `${config.publicBase}/#${token}`,
		expires_at: expires.toISOString(),
	};
}

function getInvite(token) {
	if (typeof token !== "string" || token.length < 32 || token.length > 128) {
		return null;
	}
	return database
		.prepare("SELECT * FROM invites WHERE token_hash = ?")
		.get(tokenHash(token));
}

function sameAccount(left, right) {
	return String(left).toLowerCase() === String(right).toLowerCase();
}

function lockedNamesOf(credentials) {
	const locked = {};
	if (credentials.ownerLocked) {
		locked.account = credentials.ownerAccount;
	}
	if (credentials.herderLocked) {
		locked.herder_account = credentials.herderAccount;
	}
	return locked;
}

function storedLockedNames(invite) {
	if (!invite.credential_cipher) {
		return {};
	}
	try {
		return lockedNamesOf(decryptCredentials(invite.credential_cipher));
	} catch {
		return {};
	}
}

function lockedNamesMessage(locked) {
	const created = [];
	if (locked.account) {
		created.push(`the IRC name "${locked.account}"`);
	}
	if (locked.herder_account) {
		created.push(`the BotHerder name "${locked.herder_account}"`);
	}
	return `an earlier attempt already created ${created.join(" and ")}; ${
		created.length > 1 ? "those names are" : "that name is"
	} fixed for this invitation`;
}

function publicInvite(invite) {
	if (!invite) {
		throw Object.assign(new Error("invitation not found"), {
			status: 404,
			code: "invite_invalid",
		});
	}
	if (invite.state === "revoked") {
		throw Object.assign(new Error("this invitation was revoked"), {
			status: 410,
			code: "invite_revoked",
		});
	}
	if (invite.state === "redeemed") {
		throw Object.assign(new Error("this invitation has already been used"), {
			status: 410,
			code: "invite_consumed",
		});
	}
	if (invite.state === "provisioning") {
		throw Object.assign(new Error("this invitation is already being processed"), {
			status: 409,
			code: "invite_busy",
		});
	}
	if (Date.parse(invite.expires_at) <= Date.now()) {
		throw Object.assign(new Error("this invitation has expired"), {
			status: 410,
			code: "invite_expired",
		});
	}
	const locked = storedLockedNames(invite);
	const preview = {
		kind: invite.kind,
		display_name: invite.display_name,
		owner_account: invite.owner_account,
		herder_account: invite.herder_account,
		agent_name: invite.agent_name,
		expires_utc: invite.expires_at,
	};
	if (Object.keys(locked).length > 0) {
		preview.locked_names = locked;
	}
	return preview;
}

class IRCSession {
	constructor() {
		this.socket = null;
		this.buffer = "";
		this.lines = [];
		this.waiters = [];
	}

	async connect() {
		this.socket = net.createConnection({
			host: config.ircServer,
			port: config.ircPort,
		});
		this.socket.setEncoding("utf8");
		this.socket.on("data", (data) => this.onData(data));
		this.socket.on("error", (error) => this.rejectAll(error));
		this.socket.on("close", () =>
			this.rejectAll(new Error("IRC registrar connection closed"))
		);
		await new Promise((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error("IRC registrar connect timed out")),
				10_000
			);
			this.socket.once("connect", () => {
				clearTimeout(timeout);
				resolve();
			});
			this.socket.once("error", (error) => {
				clearTimeout(timeout);
				reject(error);
			});
		});
	}

	onData(data) {
		this.buffer += data;
		for (;;) {
			const index = this.buffer.indexOf("\n");
			if (index < 0) {
				break;
			}
			const line = this.buffer.slice(0, index).replace(/\r$/, "");
			this.buffer = this.buffer.slice(index + 1);
			if (line.startsWith("PING ")) {
				this.send(`PONG ${line.slice(5)}`);
				continue;
			}
			const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate(line));
			if (waiterIndex >= 0) {
				const [waiter] = this.waiters.splice(waiterIndex, 1);
				clearTimeout(waiter.timeout);
				waiter.resolve(line);
			} else {
				this.lines.push(line);
				if (this.lines.length > 200) {
					this.lines.shift();
				}
			}
		}
	}

	rejectAll(error) {
		for (const waiter of this.waiters.splice(0)) {
			clearTimeout(waiter.timeout);
			waiter.reject(error);
		}
	}

	send(line) {
		if (!this.socket || this.socket.destroyed || /[\r\n\0]/.test(line)) {
			throw new Error("unsafe or unavailable IRC registrar connection");
		}
		const payload = Buffer.from(`${line}\r\n`, "utf8");
		if (payload.length > 512) {
			throw new Error("IRC registrar command exceeds the protocol limit");
		}
		this.socket.write(payload);
	}

	waitFor(predicate, timeoutMilliseconds = 10_000) {
		const existing = this.lines.findIndex(predicate);
		if (existing >= 0) {
			const [line] = this.lines.splice(existing, 1);
			return Promise.resolve(line);
		}
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.waiters = this.waiters.filter((value) => value.resolve !== resolve);
				reject(new Error("IRC registrar response timed out"));
			}, timeoutMilliseconds);
			this.waiters.push({predicate, resolve, reject, timeout});
		});
	}

	async authenticateRegistrar() {
		await this.connect();
		this.send("CAP LS 302");
		this.send(`NICK ${config.registrarAccount}`);
		this.send(
			`USER ${config.registrarAccount} 0 * :Private community account registrar`
		);
		await this.waitFor((line) => line.includes(" CAP ") && line.includes(" LS "));
		this.send("CAP REQ :sasl");
		await this.waitFor((line) => line.includes(" CAP ") && line.includes(" ACK "));
		this.send("AUTHENTICATE PLAIN");
		await this.waitFor(
			(line) => line === "AUTHENTICATE +" || line.includes(" AUTHENTICATE +")
		);
		const payload = Buffer.from(
			`\0${config.registrarAccount}\0${config.registrarPassword}`,
			"utf8"
		).toString("base64");
		this.send(`AUTHENTICATE ${payload}`);
		await this.waitFor((line) => / 903 /.test(line));
		this.send("CAP END");
		await this.waitFor((line) => / 001 /.test(line));
		this.send(
			`OPER ${config.registrarOperName} ${config.registrarOperPassword}`
		);
		await this.waitFor(
			(line) =>
				/ 381 /.test(line) ||
				(/ 400 /.test(line) && /already opered/i.test(line))
		);
	}

	async registerAccount(account, password) {
		this.send(`PRIVMSG NickServ :SAREGISTER ${account} ${password}`);
		const line = await this.waitFor(
			(value) =>
				value.includes("NickServ") &&
				/(Successfully registered account|already exists|already registered|name reserved|invalid)/i.test(
					value
				)
		);
		if (/Successfully registered account/i.test(line)) {
			return "created";
		}
		if (/already exists|already registered|name reserved/i.test(line)) {
			return "exists";
		}
		throw Object.assign(new Error("Ergo rejected the requested account name"), {
			code: "account_rejected",
		});
	}

	async suspendAccount(account) {
		this.send(
			`PRIVMSG NickServ :SUSPEND ADD ${account} revoked-by-owner`
		);
		await this.waitFor(
			(value) =>
				value.includes("NickServ") &&
				/(suspend|already suspended|success)/i.test(value)
		);
	}

	close() {
		if (this.socket && !this.socket.destroyed) {
			try {
				this.send("QUIT :Community provisioning complete");
			} catch {
				// The connection is already gone.
			}
			this.socket.destroy();
		}
		this.rejectAll(new Error("IRC registrar session ended"));
	}
}

async function probeAccountPassword(account, password) {
	const session = new IRCSession();
	try {
		await session.connect();
		session.send("CAP LS 302");
		session.send(`NICK ${account}`);
		session.send(`USER ${account} 0 * :Provisioning idempotency check`);
		await session.waitFor((line) => line.includes(" CAP ") && line.includes(" LS "));
		session.send("CAP REQ :sasl");
		await session.waitFor((line) => line.includes(" CAP ") && line.includes(" ACK "));
		session.send("AUTHENTICATE PLAIN");
		await session.waitFor(
			(line) => line === "AUTHENTICATE +" || line.includes(" AUTHENTICATE +")
		);
		const payload = Buffer.from(`\0${account}\0${password}`, "utf8").toString(
			"base64"
		);
		session.send(`AUTHENTICATE ${payload}`);
		const result = await session.waitFor((line) => / 90[34] /.test(line));
		return / 903 /.test(result) ? "owned" : "rejected";
	} catch {
		return "unreachable";
	} finally {
		session.close();
	}
}

async function verifyAccountPassword(account, password) {
	return (await probeAccountPassword(account, password)) === "owned";
}

async function ensureAccounts(accounts) {
	const registrar = new IRCSession();
	const locked = {};
	try {
		await registrar.authenticateRegistrar();
		for (const account of accounts) {
			const result = await registrar.registerAccount(
				account.name,
				account.password
			);
			if (
				result === "exists" &&
				!(await verifyAccountPassword(account.name, account.password))
			) {
				throw Object.assign(
					new Error(`${account.label} is already in use; choose another name`),
					{status: 409, code: "name_taken", locked_names: locked}
				);
			}
			if (account.field) {
				locked[account.field] = account.name;
			}
		}
	} finally {
		registrar.close();
	}
}

function networkConfig(account, password, displayName) {
	return {
		uuid: crypto.randomUUID(),
		awayMessage: "",
		nick: account,
		name: "Omen Community IRC",
		host: "ergo",
		port: 6667,
		tls: false,
		userDisconnected: false,
		rejectUnauthorized: true,
		password: "",
		username: account,
		realname: displayName,
		leaveMessage: "",
		sasl: "plain",
		saslAccount: account,
		saslPassword: password,
		commands: [],
		ignoreList: [],
		proxyHost: "",
		proxyPort: 1080,
		proxyUsername: "",
		proxyEnabled: false,
		proxyPassword: "",
		channels: [
			{name: "#general", muted: false, key: ""},
			{name: "#ops", muted: false, key: ""},
		],
	};
}

function atomicWriteJson(destination, value, mode = 0o640) {
	fs.mkdirSync(path.dirname(destination), {recursive: true, mode: 0o700});
	const temporary = path.join(
		path.dirname(destination),
		`.${path.basename(destination)}.${crypto.randomUUID()}.tmp`
	);
	fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: "utf8",
		mode,
		flag: "wx",
	});
	fs.renameSync(temporary, destination);
	fs.chmodSync(destination, mode);
}

function ensureLoungeUser(account, password, displayName) {
	const destination = path.join(config.loungeHome, "users", `${account}.json`);
	if (fs.existsSync(destination)) {
		const existing = JSON.parse(fs.readFileSync(destination, "utf8"));
		const network = Array.isArray(existing.networks) ? existing.networks[0] : null;
		if (
			network &&
			network.saslAccount.toLowerCase() === account.toLowerCase() &&
			safeEqual(network.saslPassword, password)
		) {
			return;
		}
		throw Object.assign(new Error("The Lounge username is already in use"), {
			status: 409,
			code: "name_taken",
		});
	}

	const temporaryHome = path.join(config.stateDir, "tmp", crypto.randomUUID());
	fs.mkdirSync(path.join(temporaryHome, "users"), {
		recursive: true,
		mode: 0o700,
	});
	try {
		const [executable, ...leading] = config.loungeCommand;
		const result = spawnSync(
			executable,
			[...leading, "add", "--password", password, "--save-logs", account],
			{
				env: {...process.env, THELOUNGE_HOME: temporaryHome},
				encoding: "utf8",
				timeout: 30_000,
			}
		);
		if (result.status !== 0) {
			throw new Error("The Lounge account creation failed");
		}
		const generatedPath = path.join(temporaryHome, "users", `${account}.json`);
		const generated = JSON.parse(fs.readFileSync(generatedPath, "utf8"));
		generated.networks = [networkConfig(account, password, displayName)];
		atomicWriteJson(destination, generated, 0o600);
	} finally {
		fs.rmSync(temporaryHome, {recursive: true, force: true});
	}
}

function ensureHerderMember({
	ownerAccount,
	displayName,
	herderAccount,
	herderPassword,
}) {
	const destination = path.join(
		config.herderMembersDir,
		`${herderAccount}.json`
	);
	const member = {
		schema_version: 1,
		owner_account: ownerAccount,
		display_name: displayName,
		account: herderAccount,
		nick: herderAccount,
		irc_password: herderPassword,
		channels: ["#general", "#ops"],
		access_mode: "owner",
		created_utc: nowIso(),
	};
	if (fs.existsSync(destination)) {
		const existing = JSON.parse(fs.readFileSync(destination, "utf8"));
		if (
			existing.owner_account.toLowerCase() === ownerAccount.toLowerCase() &&
			safeEqual(existing.irc_password, herderPassword)
		) {
			return;
		}
		throw Object.assign(new Error("BotHerder name is already in use"), {
			status: 409,
			code: "name_taken",
		});
	}
	atomicWriteJson(destination, member);
}

function claimInvite(invite, cipher) {
	const updated = database
		.prepare(
			`UPDATE invites
			 SET state = 'provisioning', credential_cipher = ?, failure_code = NULL
			 WHERE id = ? AND state IN ('pending', 'failed')`
		)
		.run(cipher, invite.id);
	if (updated.changes !== 1) {
		throw Object.assign(new Error("invitation is already being processed"), {
			status: 409,
			code: "invite_busy",
		});
	}
}

function submittedMemberNames(invite, submitted) {
	const ownerAccount = validAccount(submitted.account, "IRC name");
	const herderAccount = validAccount(
		submitted.herder_account,
		"BotHerder name"
	);
	if (sameAccount(ownerAccount, herderAccount)) {
		throw Object.assign(
			new Error("your IRC name and BotHerder name must be different"),
			{status: 400, code: "names_match"}
		);
	}
	return {
		ownerAccount,
		herderAccount,
		displayName: validDisplayName(submitted.display_name, invite.display_name),
	};
}

function registrarUnreachable() {
	return Object.assign(
		new Error(
			"the IRC service could not be reached to check the earlier attempt; please try again in a moment"
		),
		{status: 503, code: "registrar_unreachable"}
	);
}

async function rebuildMemberEnvelope(invite, stored, submitted) {
	const requested = submittedMemberNames(invite, submitted);
	const ownerProbe = await probeAccountPassword(
		stored.ownerAccount,
		stored.humanPassword
	);
	if (ownerProbe === "unreachable") {
		throw registrarUnreachable();
	}
	const herderProbe = await probeAccountPassword(
		stored.herderAccount,
		stored.herderPassword
	);
	if (herderProbe === "unreachable") {
		throw registrarUnreachable();
	}
	const ownerLocked = ownerProbe === "owned";
	const herderLocked = herderProbe === "owned";
	if (
		(ownerLocked && !sameAccount(requested.ownerAccount, stored.ownerAccount)) ||
		(herderLocked && !sameAccount(requested.herderAccount, stored.herderAccount))
	) {
		const locked = {...stored, ownerLocked, herderLocked};
		database
			.prepare(
				`UPDATE invites SET credential_cipher = ?
				 WHERE id = ? AND state = 'failed'`
			)
			.run(encryptCredentials(locked), invite.id);
		const lockedNames = lockedNamesOf(locked);
		throw Object.assign(new Error(lockedNamesMessage(lockedNames)), {
			status: 409,
			code: "name_locked",
			locked_names: lockedNames,
		});
	}
	const credentials = {
		ownerAccount: ownerLocked ? stored.ownerAccount : requested.ownerAccount,
		displayName: requested.displayName,
		humanPassword: ownerLocked ? stored.humanPassword : strongSecret(),
		herderAccount: herderLocked
			? stored.herderAccount
			: requested.herderAccount,
		herderPassword: herderLocked ? stored.herderPassword : strongSecret(),
		ownerLocked,
		herderLocked,
	};
	claimInvite(invite, encryptCredentials(credentials));
	return credentials;
}

async function prepareCredentialEnvelope(invite, submitted) {
	// A stored envelope carries the passwords of accounts an earlier attempt may
	// already have created, so it is only rebuilt from a new submission for the
	// names IRC confirms that envelope never claimed.
	if (invite.credential_cipher) {
		const stored = decryptCredentials(invite.credential_cipher);
		if (
			invite.kind === "member" &&
			RENAMEABLE_FAILURES.has(invite.failure_code)
		) {
			return rebuildMemberEnvelope(invite, stored, submitted);
		}
		const reused =
			invite.kind === "member"
				? {...stored, ownerLocked: true, herderLocked: true}
				: stored;
		claimInvite(invite, encryptCredentials(reused));
		return reused;
	}
	let credentials;
	if (invite.kind === "member") {
		const requested = submittedMemberNames(invite, submitted);
		credentials = {
			ownerAccount: requested.ownerAccount,
			displayName: requested.displayName,
			humanPassword: strongSecret(),
			herderAccount: requested.herderAccount,
			herderPassword: strongSecret(),
		};
	} else {
		credentials = {
			ownerAccount: invite.owner_account,
			herderAccount: invite.herder_account,
			agentName: invite.agent_name,
			agentAccount: invite.agent_account,
			agentPassword: strongSecret(),
		};
	}
	claimInvite(invite, encryptCredentials(credentials));
	return credentials;
}

async function redeemMember(invite, submitted) {
	const credentials = await prepareCredentialEnvelope(invite, submitted);
	await ensureAccounts([
		{
			name: credentials.ownerAccount,
			password: credentials.humanPassword,
			label: "IRC name",
			field: "account",
		},
		{
			name: credentials.herderAccount,
			password: credentials.herderPassword,
			label: "BotHerder name",
			field: "herder_account",
		},
	]);
	ensureLoungeUser(
		credentials.ownerAccount,
		credentials.humanPassword,
		credentials.displayName
	);
	ensureHerderMember(credentials);
	const created = nowIso();
	database
		.prepare(
			`INSERT INTO members (
				owner_account, display_name, herder_account, created_at
			) VALUES (?, ?, ?, ?)
			ON CONFLICT(owner_account) DO UPDATE SET
				display_name = excluded.display_name,
				herder_account = excluded.herder_account`
		)
		.run(
			credentials.ownerAccount,
			credentials.displayName,
			credentials.herderAccount,
			created
		);
	database
		.prepare(
			`UPDATE invites SET state = 'redeemed', redeemed_at = ?,
			 owner_account = ?, herder_account = ?, credential_cipher = NULL
			 WHERE id = ?`
		)
		.run(
			created,
			credentials.ownerAccount,
			credentials.herderAccount,
			invite.id
		);
	return {
		kind: "member",
		account: credentials.ownerAccount,
		password: credentials.humanPassword,
		display_name: credentials.displayName,
		herder_account: credentials.herderAccount,
		lounge_url: config.loungeUrl,
		irc_host: config.ircPublicHost,
		irc_port: config.ircPublicPort,
		channels: ["#general", "#ops"],
		message:
			"Your account and BotHerder are ready. This password is shown once.",
	};
}

async function redeemAgent(invite, submitted) {
	const credentials = await prepareCredentialEnvelope(invite, submitted);
	await ensureAccounts([
		{
			name: credentials.agentAccount,
			password: credentials.agentPassword,
			label: "Agent name",
		},
	]);
	const created = nowIso();
	database
		.prepare(
			`INSERT INTO agents (
				account, owner_account, herder_account, display_name, state, created_at
			) VALUES (?, ?, ?, ?, 'active', ?)
			ON CONFLICT(account) DO UPDATE SET state = 'active', revoked_at = NULL`
		)
		.run(
			credentials.agentAccount,
			credentials.ownerAccount,
			credentials.herderAccount,
			credentials.agentName,
			created
		);
	database
		.prepare(
			`UPDATE invites SET state = 'redeemed', redeemed_at = ?,
			 credential_cipher = NULL WHERE id = ?`
		)
		.run(created, invite.id);
	return {
		kind: "agent",
		account: credentials.agentAccount,
		password: credentials.agentPassword,
		agent_name: credentials.agentName,
		owner_account: credentials.ownerAccount,
		herder_account: credentials.herderAccount,
		irc_host: config.ircPublicHost,
		irc_port: config.ircPublicPort,
		channels: ["#general"],
		agent_kit_base: `${config.publicBase}/agent-kit`,
		message:
			"The remote agent identity is ready. Download its .env before leaving this page.",
	};
}

async function redeemInvite(token, submitted) {
	const invite = getInvite(token);
	publicInvite(invite);
	if (!["pending", "failed", "provisioning"].includes(invite.state)) {
		throw Object.assign(new Error("invitation cannot be redeemed"), {
			status: 409,
		});
	}
	try {
		return invite.kind === "member"
			? await redeemMember(invite, submitted)
			: await redeemAgent(invite, submitted);
	} catch (error) {
		// An invite_busy error comes from a request that never owned this
		// invitation, so it must not describe the outcome of the one that does.
		if (error.code !== "invite_busy") {
			database
				.prepare(
					`UPDATE invites SET state = 'failed', failure_code = ?
					 WHERE id = ? AND state = 'provisioning'`
				)
				.run(error.code || "provisioning_failed", invite.id);
		}
		throw error;
	}
}

async function revokeAgent(account, ownerAccount, herderAccount) {
	const agent = database
		.prepare(
			`SELECT * FROM agents WHERE account = ? COLLATE NOCASE
			 AND owner_account = ? COLLATE NOCASE
			 AND herder_account = ? COLLATE NOCASE`
		)
		.get(account, ownerAccount, herderAccount);
	if (!agent) {
		throw Object.assign(new Error("agent is not registered to this BotHerder"), {
			status: 404,
			code: "agent_unknown",
		});
	}
	if (agent.state !== "revoked") {
		const registrar = new IRCSession();
		try {
			await registrar.authenticateRegistrar();
			await registrar.suspendAccount(agent.account);
		} finally {
			registrar.close();
		}
		database
			.prepare(
				"UPDATE agents SET state = 'revoked', revoked_at = ? WHERE account = ?"
			)
			.run(nowIso(), agent.account);
	}
	return {ok: true, account: agent.account, state: "revoked"};
}

async function offboardMember(ownerAccount, herderAccount) {
	if (
		ownerAccount.toLowerCase() === "admin" ||
		herderAccount.toLowerCase() === "dereksbotherder"
	) {
		throw Object.assign(
			new Error("the primary administrator cannot be offboarded here"),
			{status: 403, code: "protected_member"}
		);
	}
	const member = database
		.prepare(
			`SELECT * FROM members WHERE owner_account = ? COLLATE NOCASE
			 AND herder_account = ? COLLATE NOCASE`
		)
		.get(ownerAccount, herderAccount);
	if (!member) {
		throw Object.assign(new Error("community member was not found"), {
			status: 404,
			code: "member_unknown",
		});
	}
	const agents = database
		.prepare(
			`SELECT account FROM agents WHERE owner_account = ? COLLATE NOCASE
			 AND herder_account = ? COLLATE NOCASE AND state = 'active'`
		)
		.all(ownerAccount, herderAccount);
	const registrar = new IRCSession();
	try {
		await registrar.authenticateRegistrar();
		for (const account of [
			...agents.map((agent) => agent.account),
			herderAccount,
			ownerAccount,
		]) {
			await registrar.suspendAccount(account);
		}
	} finally {
		registrar.close();
	}
	database.exec("BEGIN IMMEDIATE");
	try {
		database
			.prepare(
				`DELETE FROM invites WHERE owner_account = ? COLLATE NOCASE
				 OR herder_account = ? COLLATE NOCASE`
			)
			.run(ownerAccount, herderAccount);
		database
			.prepare(
				`DELETE FROM agents WHERE owner_account = ? COLLATE NOCASE
				 AND herder_account = ? COLLATE NOCASE`
			)
			.run(ownerAccount, herderAccount);
		database
			.prepare(
				`DELETE FROM members WHERE owner_account = ? COLLATE NOCASE
				 AND herder_account = ? COLLATE NOCASE`
			)
			.run(ownerAccount, herderAccount);
		database.exec("COMMIT");
	} catch (error) {
		database.exec("ROLLBACK");
		throw error;
	}
	for (const destination of [
		path.join(config.herderMembersDir, `${herderAccount}.json`),
		path.join(config.loungeHome, "users", `${ownerAccount}.json`),
		path.join(config.loungeHome, "logs", `${ownerAccount}.sqlite3`),
	]) {
		try {
			fs.unlinkSync(destination);
		} catch (error) {
			if (error.code !== "ENOENT") {
				throw error;
			}
		}
	}
	return {
		ok: true,
		owner_account: ownerAccount,
		herder_account: herderAccount,
		suspended_agents: agents.length,
	};
}

async function route(request, response) {
	const {pathname} = normalizePath(request.url || "/");

	if (request.method === "GET" && pathname === "/health") {
		return jsonResponse(response, 200, {ok: true});
	}
	if (request.method === "GET" && PUBLIC_FILES.has(pathname)) {
		const [relative, contentType] = PUBLIC_FILES.get(pathname);
		const filePath = path.resolve(PUBLIC_ROOT, relative);
		const allowedRoot = APP_ROOT;
		if (!filePath.startsWith(`${allowedRoot}${path.sep}`)) {
			return jsonResponse(response, 404, {error: "not_found"});
		}
		return textResponse(response, 200, fs.readFileSync(filePath), contentType);
	}
	if (request.method === "POST" && pathname === "/api/invites/preview") {
		enforcePublicRateLimit(request);
		const body = await readJson(request);
		return jsonResponse(response, 200, publicInvite(getInvite(body.token)));
	}
	if (request.method === "POST" && pathname === "/api/invites/redeem") {
		enforcePublicRateLimit(request);
		const body = await readJson(request);
		const result = await redeemInvite(body.token, body);
		return jsonResponse(response, 200, result);
	}
	if (request.method === "POST" && pathname === "/api/admin/invites") {
		requireToken(request, config.adminToken);
		const body = await readJson(request);
		const hours = Number.isInteger(body.expires_hours)
			? Math.min(Math.max(body.expires_hours, 1), 168)
			: 24;
		const invite = createInviteRecord({
			kind: "member",
			displayName: validDisplayName(body.display_name, "Friend"),
			expiresHours: hours,
		});
		return jsonResponse(response, 201, invite);
	}
	if (request.method === "POST" && pathname === "/api/admin/invites/revoke") {
		requireToken(request, config.adminToken);
		const body = await readJson(request);
		const updated = database
			.prepare(
				`UPDATE invites SET state = 'revoked', credential_cipher = NULL
				 WHERE id = ? AND state NOT IN ('redeemed', 'revoked')`
			)
			.run(String(body.id || ""));
		return jsonResponse(response, updated.changes ? 200 : 404, {
			ok: updated.changes === 1,
		});
	}
	if (request.method === "POST" && pathname === "/api/admin/members") {
		requireToken(request, config.adminToken);
		const body = await readJson(request);
		const ownerAccount = validExistingAccount(
			body.owner_account,
			"Owner account"
		);
		const herderAccount = validExistingAccount(
			body.herder_account,
			"BotHerder account"
		);
		const displayName = validDisplayName(body.display_name, ownerAccount);
		if (body.account_password !== undefined) {
			const password = validProvisioningPassword(body.account_password);
			if (!(await verifyAccountPassword(ownerAccount, password))) {
				throw Object.assign(
					new Error("the supplied password does not authenticate this IRC account"),
					{status: 403, code: "account_auth_failed"}
				);
			}
			ensureLoungeUser(ownerAccount, password, displayName);
		}
		database
			.prepare(
				`INSERT INTO members (
					owner_account, display_name, herder_account, created_at
				) VALUES (?, ?, ?, ?)
				ON CONFLICT(owner_account) DO UPDATE SET
					display_name = excluded.display_name,
					herder_account = excluded.herder_account`
			)
			.run(ownerAccount, displayName, herderAccount, nowIso());
		return jsonResponse(response, 200, {
			ok: true,
			owner_account: ownerAccount,
			herder_account: herderAccount,
		});
	}
	if (
		request.method === "POST" &&
		pathname === "/api/admin/members/offboard"
	) {
		requireToken(request, config.adminToken);
		const body = await readJson(request);
		const result = await offboardMember(
			validExistingAccount(body.owner_account, "Owner account"),
			validExistingAccount(body.herder_account, "BotHerder account")
		);
		return jsonResponse(response, 200, result);
	}
	if (
		request.method === "POST" &&
		pathname === "/api/internal/agent-invites"
	) {
		requireToken(request, config.internalToken);
		const body = await readJson(request);
		const ownerAccount = validExistingAccount(
			body.owner_account,
			"Owner account"
		);
		const herderAccount = validExistingAccount(
			body.herder_account,
			"BotHerder account"
		);
		const agentName = validAgentName(body.agent_name);
		const member = database
			.prepare(
				`SELECT * FROM members WHERE owner_account = ? COLLATE NOCASE
				 AND herder_account = ? COLLATE NOCASE`
			)
			.get(ownerAccount, herderAccount);
		if (!member) {
			throw Object.assign(new Error("BotHerder membership is unknown"), {
				status: 403,
				code: "member_unknown",
			});
		}
		const agentAccount = makeAgentAccount(ownerAccount, agentName);
		const existing = database
			.prepare("SELECT account FROM agents WHERE account = ? COLLATE NOCASE")
			.get(agentAccount);
		if (existing) {
			throw Object.assign(new Error("agent name is already registered"), {
				status: 409,
				code: "agent_exists",
			});
		}
		const invite = createInviteRecord({
			kind: "agent",
			displayName: agentName,
			ownerAccount,
			herderAccount,
			agentName,
			agentAccount,
			expiresHours: 24,
		});
		return jsonResponse(response, 201, {
			...invite,
			agent_account: agentAccount,
		});
	}
	if (request.method === "GET" && pathname === "/api/internal/agents") {
		requireToken(request, config.internalToken);
		const parsed = new URL(request.url, "http://portal.invalid");
		const owner = parsed.searchParams.get("owner") || "";
		const herder = parsed.searchParams.get("herder") || "";
		const agents = database
			.prepare(
				`SELECT account, display_name, state, created_at, revoked_at
				 FROM agents WHERE owner_account = ? COLLATE NOCASE
				 AND herder_account = ? COLLATE NOCASE ORDER BY display_name`
			)
			.all(owner, herder);
		return jsonResponse(response, 200, {agents});
	}
	if (request.method === "POST" && pathname === "/api/internal/agents/revoke") {
		requireToken(request, config.internalToken);
		const body = await readJson(request);
		const result = await revokeAgent(
			validAccount(body.account, "Agent account"),
			validExistingAccount(body.owner_account, "Owner account"),
			validExistingAccount(body.herder_account, "BotHerder account")
		);
		return jsonResponse(response, 200, result);
	}
	return jsonResponse(response, 404, {error: "not_found"});
}

const server = http.createServer((request, response) => {
	route(request, response).catch((error) => {
		const status = Number.isInteger(error.status) ? error.status : 500;
		const code = error.code || (status === 500 ? "internal_error" : "request_failed");
		if (status >= 500) {
			console.error(
				`portal_request_failed path=${normalizePath(request.url || "/").pathname} error_type=${error.constructor.name}`
			);
		}
		const payload = {
			error: code,
			message:
				status >= 500
					? "Provisioning could not be completed. The invitation is still recoverable."
					: error.message,
		};
		if (error.locked_names && Object.keys(error.locked_names).length > 0) {
			payload.locked_names = error.locked_names;
		}
		jsonResponse(response, status, payload);
	});
});

server.requestTimeout = 45_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.listen(config.port, config.host, () => {
	console.log(`community_portal_ready port=${config.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(1), 10_000).unref();
	});
}
