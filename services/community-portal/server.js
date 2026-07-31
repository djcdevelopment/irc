"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const {spawnSync} = require("node:child_process");
const {DatabaseSync} = require("node:sqlite");
const lab = require("./lab.js");

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
const LAB_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,30}$/;
const RESERVED_LAB_SLUGS = new Set([
	"admin",
	"agent-kit",
	"api",
	"assets",
	"edit",
	"guide",
	"health",
	"internal",
	"join",
	"lab",
	"static",
]);
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
	["/lab/lab.css", ["lab.css", "text/css; charset=utf-8"]],
	["/lab/edit", ["lab-edit.html", "text/html; charset=utf-8"]],
	["/lab/edit/", ["lab-edit.html", "text/html; charset=utf-8"]],
	["/lab/lab-edit.js", ["lab-edit.js", "text/javascript; charset=utf-8"]],
	["/lab/lab-edit.css", ["lab-edit.css", "text/css; charset=utf-8"]],
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
	labBase: (
		process.env.COMMUNITY_LAB_BASE ||
		`${requiredEnvironment("COMMUNITY_PUBLIC_BASE")
			.replace(/\/+$/, "")
			.replace(/\/join$/, "")}/lab`
	).replace(/\/+$/, ""),
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
	primaryHerder: process.env.COMMUNITY_PRIMARY_HERDER || "DereksBotHerder",
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
RESERVED_NAMES.add(config.primaryHerder.toLowerCase());

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
	CREATE TABLE IF NOT EXISTS storefront_profiles (
		owner_account TEXT PRIMARY KEY COLLATE NOCASE REFERENCES members(owner_account),
		lab_name TEXT NOT NULL,
		lab_slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
		channel TEXT NOT NULL,
		tagline TEXT NOT NULL DEFAULT '',
		bio TEXT NOT NULL DEFAULT '',
		experiments TEXT NOT NULL DEFAULT '[]',
		links TEXT NOT NULL DEFAULT '[]',
		marquee TEXT NOT NULL DEFAULT '',
		ascii_banner TEXT NOT NULL DEFAULT '',
		theme TEXT NOT NULL DEFAULT '{}',
		html_fragment TEXT NOT NULL DEFAULT '',
		visitors INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS lab_edit_tokens (
		token_hash TEXT PRIMARY KEY,
		owner_account TEXT NOT NULL COLLATE NOCASE,
		created_at TEXT NOT NULL,
		expires_at TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS hearth_snapshots (
		herder_account TEXT PRIMARY KEY COLLATE NOCASE,
		snapshot TEXT NOT NULL,
		fetched_at TEXT NOT NULL
	);
`);
backfillStorefrontProfiles();

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

// Legacy channel derivation. New channels come from the storefront profile;
// this survives only to seed profiles for members provisioned before profiles
// existed and to default the channel of a brand-new member.
function storefrontChannel(displayName) {
	const slug = displayName
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 56);
	return `#herder-${slug || "member"}`;
}

function labSlugCandidate(displayName) {
	const base = String(displayName || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 31);
	return LAB_SLUG_PATTERN.test(base) && !RESERVED_LAB_SLUGS.has(base)
		? base
		: "";
}

function availableLabSlug(candidate, ownerAccount) {
	const base = candidate || "member";
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
		const slug = `${base.slice(0, 31 - suffix.length)}${suffix}`;
		const existing = database
			.prepare(
				"SELECT owner_account FROM storefront_profiles WHERE lab_slug = ?"
			)
			.get(slug);
		if (!existing || sameAccount(existing.owner_account, ownerAccount)) {
			return slug;
		}
	}
	throw new Error("no lab slug is available for this member");
}

function getProfile(ownerAccount) {
	return database
		.prepare("SELECT * FROM storefront_profiles WHERE owner_account = ?")
		.get(ownerAccount);
}

function getProfileBySlug(slug) {
	return database
		.prepare("SELECT * FROM storefront_profiles WHERE lab_slug = ?")
		.get(slug);
}

function ensureStorefrontProfile({
	ownerAccount,
	displayName,
	channel,
	labName = "",
	labSlug = "",
}) {
	const existing = getProfile(ownerAccount);
	if (existing) {
		return existing;
	}
	const name = labName || displayName;
	const created = nowIso();
	database
		.prepare(
			`INSERT INTO storefront_profiles (
				owner_account, lab_name, lab_slug, channel, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?)`
		)
		.run(
			ownerAccount,
			name,
			labSlug || availableLabSlug(labSlugCandidate(name), ownerAccount),
			channel,
			created,
			created
		);
	return getProfile(ownerAccount);
}

// An optional owner-chosen lab name. Presentation text: it seeds the lab
// slug, the #lab-<slug> channel, and the storefront page title.
function validLabName(value) {
	if (typeof value !== "string") {
		return "";
	}
	const text = value.trim();
	if (!text) {
		return "";
	}
	if (text.length < 2 || text.length > 48 || /[\x00-\x1f\x7f<>]/.test(text)) {
		throw Object.assign(
			new Error("lab name must be 2–48 characters without angle brackets"),
			{status: 400, code: "invalid_lab_name"}
		);
	}
	return text;
}

function backfillStorefrontProfiles() {
	const members = database
		.prepare("SELECT owner_account, display_name FROM members")
		.all();
	for (const member of members) {
		ensureStorefrontProfile({
			ownerAccount: member.owner_account,
			displayName: member.display_name,
			channel: storefrontChannel(member.display_name),
		});
	}
}

function memberChannel(ownerAccount, displayName) {
	const profile = getProfile(ownerAccount);
	return profile ? profile.channel : storefrontChannel(displayName);
}

function labUrl(slug) {
	return `${config.labBase}/${slug}`;
}

const labVisits = new Map();

function mintEditToken(ownerAccount) {
	const token = strongSecret();
	const created = new Date();
	const expires = new Date(created.getTime() + 60 * 60 * 1000);
	database
		.prepare("DELETE FROM lab_edit_tokens WHERE owner_account = ? COLLATE NOCASE")
		.run(ownerAccount);
	database
		.prepare(
			`INSERT INTO lab_edit_tokens (token_hash, owner_account, created_at, expires_at)
			 VALUES (?, ?, ?, ?)`
		)
		.run(tokenHash(token), ownerAccount, created.toISOString(), expires.toISOString());
	return {token, expires_at: expires.toISOString()};
}

async function setRedirectTopic(channel, newChannel, url) {
	// Best effort: the registrar founded member channels, so it can leave a
	// forwarding topic; a channel it does not control just keeps its topic.
	const registrar = new IRCSession();
	try {
		await registrar.authenticateRegistrar();
		registrar.send(`JOIN ${channel}`);
		await registrar.waitFor(
			(value) =>
				(value.includes(" JOIN ") || value.includes(" 403 ")) &&
				value.includes(channel)
		);
		registrar.send(`TOPIC ${channel} :moved → ${newChannel} · ${url}`);
		await registrar.waitFor(
			(value) =>
				(value.includes(" TOPIC ") && value.includes(channel)) ||
				/ 482 /.test(value),
			5_000
		);
		return true;
	} catch {
		return false;
	} finally {
		registrar.close();
	}
}

function rewriteMemberChannel(herderAccount, oldChannel, newChannel) {
	const destination = path.join(
		config.herderMembersDir,
		`${herderAccount}.json`
	);
	if (!fs.existsSync(destination)) {
		return [
			"the companion is not portal-managed; update its configuration manually",
		];
	}
	const member = JSON.parse(fs.readFileSync(destination, "utf8"));
	member.channels = (member.channels || []).filter(
		(channel) =>
			channel.toLowerCase() !== oldChannel.toLowerCase() &&
			channel.toLowerCase() !== newChannel.toLowerCase()
	);
	member.channels.push(newChannel);
	member.storefront_channel = newChannel;
	atomicWriteJson(destination, member);
	return [];
}

function rewriteLoungeChannel(ownerAccount, oldChannel, newChannel) {
	const destination = path.join(
		config.loungeHome,
		"users",
		`${ownerAccount}.json`
	);
	if (!fs.existsSync(destination)) {
		return ["The Lounge profile was not found; join the new channel manually"];
	}
	const user = JSON.parse(fs.readFileSync(destination, "utf8"));
	const network = Array.isArray(user.networks) ? user.networks[0] : null;
	if (!network) {
		return ["The Lounge network entry was not found; join the new channel manually"];
	}
	network.channels = (network.channels || []).filter(
		(channel) =>
			channel.name.toLowerCase() !== oldChannel.toLowerCase() &&
			channel.name.toLowerCase() !== newChannel.toLowerCase()
	);
	network.channels.push({name: newChannel, muted: false, key: ""});
	atomicWriteJson(destination, user, 0o600);
	return [];
}

function publicProfile(profile) {
	return {
		owner_account: profile.owner_account,
		lab_name: profile.lab_name,
		lab_slug: profile.lab_slug,
		channel: profile.channel,
		tagline: profile.tagline,
		bio: profile.bio,
		experiments: profile.experiments,
		links: profile.links,
		marquee: profile.marquee,
		ascii_banner: profile.ascii_banner,
		theme: profile.theme,
		visitors: profile.visitors,
		web_url: labUrl(profile.lab_slug),
		created_at: profile.created_at,
		updated_at: profile.updated_at,
	};
}

function requireEditToken(request) {
	const token = bearerToken(request);
	if (typeof token !== "string" || token.length < 32 || token.length > 128) {
		throw Object.assign(new Error("unauthorized"), {status: 401});
	}
	database
		.prepare("DELETE FROM lab_edit_tokens WHERE expires_at <= ?")
		.run(nowIso());
	const row = database
		.prepare("SELECT owner_account FROM lab_edit_tokens WHERE token_hash = ?")
		.get(tokenHash(token));
	if (!row) {
		throw Object.assign(new Error("unauthorized"), {status: 401});
	}
	return row.owner_account;
}

function recordLabVisit(slug, address) {
	const key = `${slug}\0${address}`;
	const now = Date.now();
	if (now - (labVisits.get(key) || 0) < 3_600_000) {
		return;
	}
	if (labVisits.size >= 10_000) {
		for (const [visitKey, seen] of labVisits) {
			if (now - seen >= 3_600_000) {
				labVisits.delete(visitKey);
			}
		}
		if (labVisits.size >= 10_000) {
			return;
		}
	}
	labVisits.set(key, now);
	database
		.prepare(
			"UPDATE storefront_profiles SET visitors = visitors + 1 WHERE lab_slug = ?"
		)
		.run(slug);
}

function labSecurityHeaders(response, nonce) {
	response.setHeader("Content-Type", "text/html; charset=utf-8");
	response.setHeader("Cache-Control", "no-store, max-age=0");
	response.setHeader("Referrer-Policy", "no-referrer");
	response.setHeader("X-Content-Type-Options", "nosniff");
	response.setHeader("X-Frame-Options", "DENY");
	response.setHeader(
		"Content-Security-Policy",
		`default-src 'none'; style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`
	);
}

function serveLabPage(response, slug, address) {
	let profile = getProfileBySlug(slug);
	if (!profile) {
		return jsonResponse(response, 404, {error: "not_found"});
	}
	// Count the visit before rendering so the visitor sees themselves.
	recordLabVisit(slug, address);
	profile = getProfileBySlug(slug);
	const member = database
		.prepare("SELECT herder_account FROM members WHERE owner_account = ?")
		.get(profile.owner_account);
	const snapshotRow = member
		? database
				.prepare("SELECT * FROM hearth_snapshots WHERE herder_account = ?")
				.get(member.herder_account)
		: undefined;
	const nonce = crypto.randomBytes(16).toString("base64url");
	labSecurityHeaders(response, nonce);
	response.statusCode = 200;
	response.end(lab.renderLabPage(profile, snapshotRow, {nonce}));
}

function ircAccentOf(profile) {
	try {
		const theme = JSON.parse(profile.theme);
		if (Number.isInteger(theme.irc_accent) && theme.irc_accent >= 0 && theme.irc_accent <= 15) {
			return theme.irc_accent;
		}
	} catch {
		// An unreadable theme falls back to the default accent.
	}
	return 11;
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

	async registerChannel(channel, herderAccount = "") {
		if (!/^#[^\x00\x07\r\n ,:]{1,63}$/.test(channel)) {
			throw new Error("invalid storefront channel");
		}
		// Ergo persistence can leave the registrar resident in a channel it
		// touched before, and a repeated JOIN is then acknowledged with
		// nothing at all — so nothing waits on the JOIN echo. ChanServ's
		// REGISTER reply is the gate; TCP ordering lands the join first.
		this.send(`JOIN ${channel}`);
		this.send(`PRIVMSG ChanServ :REGISTER ${channel}`);
		const line = await this.waitFor(
			(value) =>
				value.includes("ChanServ") &&
				/(successfully registered|already registered|already exists|registered|must be an oper on the channel)/i.test(
					value
				)
		);
		if (/must be an oper on the channel/i.test(line)) {
			// The channel is already registered, typically to its owner (the
			// administrator's own storefront). Managing it is not this
			// registrar's job; its existence is all provisioning needs.
			return "registered";
		}
		if (herderAccount) {
			// Channel-operator status lets the Herder keep the storefront
			// topic current. Best effort: a missing grant only degrades the
			// welcome topic, never provisioning.
			try {
				this.send(
					`PRIVMSG ChanServ :AMODE ${channel} +o ${herderAccount}`
				);
				await this.waitFor(
					(value) =>
						value.includes("ChanServ") &&
						/(amode|persistent mode|already|not authorized|insufficient)/i.test(
							value
						),
					5_000
				);
			} catch {
				console.error(
					`storefront_amode_unconfirmed channel=${channel}`
				);
			}
		}
		return "registered";
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

async function ensureStorefrontChannel(channel, herderAccount = "") {
	const registrar = new IRCSession();
	try {
		await registrar.authenticateRegistrar();
		return await registrar.registerChannel(channel, herderAccount);
	} finally {
		registrar.close();
	}
}

function networkConfig(account, password, displayName, storefront) {
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
			{name: storefront, muted: false, key: ""},
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

function ensureLoungeUser(account, password, displayName, storefront) {
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
		generated.networks = [
			networkConfig(account, password, displayName, storefront),
		];
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
	storefront,
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
		channels: ["#general", "#ops", storefront],
		storefront_channel: storefront,
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
	// An existing profile keeps its channel; a brand-new member gets a
	// #lab-<slug> channel named after their lab (default: display name).
	const priorProfile = getProfile(credentials.ownerAccount);
	let storefront;
	let labName = "";
	let labSlug = "";
	if (priorProfile) {
		storefront = priorProfile.channel;
	} else {
		labName = validLabName(submitted.lab_name) || credentials.displayName;
		labSlug = availableLabSlug(
			labSlugCandidate(labName),
			credentials.ownerAccount
		);
		storefront = `#lab-${labSlug}`;
	}
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
	await ensureStorefrontChannel(storefront, credentials.herderAccount);
	ensureLoungeUser(
		credentials.ownerAccount,
		credentials.humanPassword,
		credentials.displayName,
		storefront
	);
	ensureHerderMember({...credentials, storefront});
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
	const profile = ensureStorefrontProfile({
		ownerAccount: credentials.ownerAccount,
		displayName: credentials.displayName,
		channel: storefront,
		labName,
		labSlug,
	});
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
		channels: ["#general", "#ops", storefront],
		lab_name: profile.lab_name,
		lab_slug: profile.lab_slug,
		web_url: labUrl(profile.lab_slug),
		message:
			"Your account and companion are ready. This password is shown once.",
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
		sameAccount(herderAccount, config.primaryHerder)
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
			.prepare("DELETE FROM lab_edit_tokens WHERE owner_account = ? COLLATE NOCASE")
			.run(ownerAccount);
		database
			.prepare("DELETE FROM hearth_snapshots WHERE herder_account = ? COLLATE NOCASE")
			.run(herderAccount);
		database
			.prepare("DELETE FROM storefront_profiles WHERE owner_account = ? COLLATE NOCASE")
			.run(ownerAccount);
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
	if (pathname === "/lab/api/profile") {
		const ownerAccount = requireEditToken(request);
		const profile = getProfile(ownerAccount);
		if (!profile) {
			throw Object.assign(new Error("storefront profile is missing"), {
				status: 404,
				code: "profile_unknown",
			});
		}
		if (request.method === "GET") {
			return jsonResponse(response, 200, publicProfile(profile));
		}
		if (request.method === "PUT") {
			const body = await readJson(request);
			const patch = lab.validateProfilePatch(body);
			const fields = Object.keys(patch);
			if (fields.length === 0) {
				throw Object.assign(new Error("no editable fields were provided"), {
					status: 400,
				});
			}
			const assignments = fields.map((field) => `${field} = ?`).join(", ");
			database
				.prepare(
					`UPDATE storefront_profiles SET ${assignments}, updated_at = ?
					 WHERE owner_account = ?`
				)
				.run(...fields.map((field) => patch[field]), nowIso(), ownerAccount);
			return jsonResponse(response, 200, publicProfile(getProfile(ownerAccount)));
		}
		return jsonResponse(response, 405, {error: "method_not_allowed"});
	}
	if (request.method === "POST" && pathname === "/lab/api/rename-channel") {
		const ownerAccount = requireEditToken(request);
		const body = await readJson(request);
		const profile = getProfile(ownerAccount);
		const member = database
			.prepare("SELECT * FROM members WHERE owner_account = ? COLLATE NOCASE")
			.get(ownerAccount);
		if (!profile || !member) {
			throw Object.assign(new Error("storefront profile is missing"), {
				status: 404,
				code: "profile_unknown",
			});
		}
		const slug =
			typeof body.lab_slug === "string" ? body.lab_slug.trim().toLowerCase() : "";
		if (!LAB_SLUG_PATTERN.test(slug) || RESERVED_LAB_SLUGS.has(slug)) {
			throw Object.assign(
				new Error(
					"lab slug must be 2–31 lowercase letters, digits, or hyphens"
				),
				{status: 400, code: "invalid_lab_slug"}
			);
		}
		const holder = getProfileBySlug(slug);
		if (holder && !sameAccount(holder.owner_account, ownerAccount)) {
			throw Object.assign(new Error("that lab slug is already taken"), {
				status: 409,
				code: "slug_taken",
			});
		}
		const newChannel = `#lab-${slug}`;
		const oldChannel = profile.channel;
		if (
			profile.lab_slug.toLowerCase() === slug &&
			oldChannel.toLowerCase() === newChannel.toLowerCase()
		) {
			return jsonResponse(response, 200, {
				...publicProfile(profile),
				notes: [],
			});
		}
		await ensureStorefrontChannel(newChannel, member.herder_account);
		const notes = [];
		if (oldChannel && oldChannel.toLowerCase() !== newChannel.toLowerCase()) {
			if (!(await setRedirectTopic(oldChannel, newChannel, labUrl(slug)))) {
				notes.push(
					`the old channel ${oldChannel} could not be given a forwarding topic`
				);
			}
		}
		database
			.prepare(
				`UPDATE storefront_profiles SET lab_slug = ?, channel = ?, updated_at = ?
				 WHERE owner_account = ?`
			)
			.run(slug, newChannel, nowIso(), ownerAccount);
		notes.push(...rewriteMemberChannel(member.herder_account, oldChannel, newChannel));
		notes.push(...rewriteLoungeChannel(member.owner_account, oldChannel, newChannel));
		return jsonResponse(response, 200, {
			...publicProfile(getProfile(ownerAccount)),
			notes,
		});
	}
	if (request.method === "POST" && pathname === "/lab/api/rename-companion") {
		const ownerAccount = requireEditToken(request);
		const body = await readJson(request);
		const member = database
			.prepare("SELECT * FROM members WHERE owner_account = ? COLLATE NOCASE")
			.get(ownerAccount);
		if (!member) {
			throw Object.assign(new Error("membership was not found"), {
				status: 404,
				code: "member_unknown",
			});
		}
		const oldHerder = member.herder_account;
		if (sameAccount(oldHerder, config.primaryHerder)) {
			throw Object.assign(
				new Error("the primary companion cannot be renamed here"),
				{status: 403, code: "protected_member"}
			);
		}
		const newName = validAccount(body.companion, "Companion name");
		if (sameAccount(newName, member.owner_account)) {
			throw Object.assign(
				new Error("your companion needs a name different from yours"),
				{status: 400, code: "names_match"}
			);
		}
		if (sameAccount(newName, oldHerder)) {
			return jsonResponse(response, 200, {
				ok: true,
				companion: oldHerder,
				notes: [],
			});
		}
		const clash =
			database
				.prepare(
					`SELECT owner_account FROM members
					 WHERE herder_account = ? COLLATE NOCASE
					 OR owner_account = ? COLLATE NOCASE`
				)
				.get(newName, newName) ||
			database
				.prepare("SELECT account FROM agents WHERE account = ? COLLATE NOCASE")
				.get(newName);
		if (clash) {
			throw Object.assign(new Error("that name is already in use"), {
				status: 409,
				code: "name_taken",
			});
		}
		const memberPath = path.join(config.herderMembersDir, `${oldHerder}.json`);
		if (!fs.existsSync(memberPath)) {
			throw Object.assign(
				new Error("the companion is not portal-managed; rename it manually"),
				{status: 409, code: "companion_unmanaged"}
			);
		}
		const memberJson = JSON.parse(fs.readFileSync(memberPath, "utf8"));
		await ensureAccounts([
			{
				name: newName,
				password: memberJson.irc_password,
				label: "Companion name",
			},
		]);
		const profile = getProfile(ownerAccount);
		if (profile) {
			await ensureStorefrontChannel(profile.channel, newName);
		}
		database.exec("BEGIN IMMEDIATE");
		try {
			database
				.prepare(
					`UPDATE members SET herder_account = ?
					 WHERE owner_account = ? COLLATE NOCASE`
				)
				.run(newName, ownerAccount);
			database
				.prepare(
					`UPDATE agents SET herder_account = ?
					 WHERE herder_account = ? COLLATE NOCASE`
				)
				.run(newName, oldHerder);
			database
				.prepare(
					"DELETE FROM hearth_snapshots WHERE herder_account = ? COLLATE NOCASE"
				)
				.run(oldHerder);
			database.exec("COMMIT");
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		}
		memberJson.account = newName;
		memberJson.nick = newName;
		atomicWriteJson(
			path.join(config.herderMembersDir, `${newName}.json`),
			memberJson
		);
		fs.unlinkSync(memberPath);
		const registrar = new IRCSession();
		try {
			await registrar.authenticateRegistrar();
			await registrar.suspendAccount(oldHerder);
		} finally {
			registrar.close();
		}
		const activeAgents = database
			.prepare(
				`SELECT COUNT(*) AS total FROM agents
				 WHERE herder_account = ? COLLATE NOCASE AND state = 'active'`
			)
			.get(newName).total;
		const notes = [];
		if (activeAgents > 0) {
			notes.push(
				`${activeAgents} deployed remote agent(s) still target ${oldHerder}; ` +
					"update HERDER_ACCOUNT in each agent.env and restart them"
			);
		}
		return jsonResponse(response, 200, {
			ok: true,
			companion: newName,
			previous: oldHerder,
			notes,
		});
	}
	if (request.method === "GET" && pathname.startsWith("/lab/")) {
		const slug = pathname.slice(5).replace(/\/+$/, "").toLowerCase();
		if (!LAB_SLUG_PATTERN.test(slug) || RESERVED_LAB_SLUGS.has(slug)) {
			return jsonResponse(response, 404, {error: "not_found"});
		}
		return serveLabPage(response, slug, clientAddress(request));
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
		const storefront = memberChannel(ownerAccount, displayName);
		await ensureStorefrontChannel(storefront, herderAccount);
		if (body.account_password !== undefined) {
			const password = validProvisioningPassword(body.account_password);
			if (!(await verifyAccountPassword(ownerAccount, password))) {
				throw Object.assign(
					new Error("the supplied password does not authenticate this IRC account"),
					{status: 403, code: "account_auth_failed"}
				);
			}
			ensureLoungeUser(ownerAccount, password, displayName, storefront);
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
		ensureStorefrontProfile({
			ownerAccount,
			displayName,
			channel: storefront,
		});
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
	if (request.method === "GET" && pathname === "/api/internal/storefronts") {
		requireToken(request, config.internalToken);
		const members = database
			.prepare(
				`SELECT owner_account, display_name, herder_account, created_at
				 FROM members ORDER BY display_name COLLATE NOCASE`
			)
			.all();
		const agents = database
			.prepare(
				`SELECT owner_account, herder_account, account, display_name, state
				 FROM agents WHERE state = 'active' ORDER BY display_name COLLATE NOCASE`
			)
			.all();
		const agentsByHerder = new Map();
		for (const agent of agents) {
			const key = `${agent.owner_account}\0${agent.herder_account}`.toLowerCase();
			const list = agentsByHerder.get(key) || [];
			list.push({
				account: agent.account,
				display_name: agent.display_name,
				state: agent.state,
			});
			agentsByHerder.set(key, list);
		}
		return jsonResponse(response, 200, {
			storefronts: members.map((member) => {
				const profile = ensureStorefrontProfile({
					ownerAccount: member.owner_account,
					displayName: member.display_name,
					channel: storefrontChannel(member.display_name),
				});
				return {
					owner_account: member.owner_account,
					display_name: member.display_name,
					herder_account: member.herder_account,
					channel: profile.channel,
					lab_name: profile.lab_name,
					lab_slug: profile.lab_slug,
					tagline: profile.tagline,
					web_url: labUrl(profile.lab_slug),
					irc_accent: ircAccentOf(profile),
					created_at: member.created_at,
					agents: agentsByHerder.get(
						`${member.owner_account}\0${member.herder_account}`.toLowerCase()
					) || [],
				};
			}),
		});
	}
	if (
		request.method === "POST" &&
		pathname === "/api/internal/lab-edit-links"
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
		ensureStorefrontProfile({
			ownerAccount: member.owner_account,
			displayName: member.display_name,
			channel: storefrontChannel(member.display_name),
		});
		const minted = mintEditToken(member.owner_account);
		return jsonResponse(response, 201, {
			url: `${config.labBase}/edit#${minted.token}`,
			expires_at: minted.expires_at,
		});
	}
	if (request.method === "POST" && pathname === "/api/admin/lab-edit-links") {
		requireToken(request, config.adminToken);
		const body = await readJson(request);
		const ownerAccount = validExistingAccount(
			body.owner_account,
			"Owner account"
		);
		const member = database
			.prepare("SELECT * FROM members WHERE owner_account = ? COLLATE NOCASE")
			.get(ownerAccount);
		if (!member) {
			throw Object.assign(new Error("community member was not found"), {
				status: 404,
				code: "member_unknown",
			});
		}
		ensureStorefrontProfile({
			ownerAccount: member.owner_account,
			displayName: member.display_name,
			channel: storefrontChannel(member.display_name),
		});
		const minted = mintEditToken(member.owner_account);
		return jsonResponse(response, 201, {
			url: `${config.labBase}/edit#${minted.token}`,
			expires_at: minted.expires_at,
		});
	}
	if (
		request.method === "POST" &&
		pathname === "/api/internal/storefront-snapshot"
	) {
		requireToken(request, config.internalToken);
		const body = await readJson(request);
		const herderAccount = validExistingAccount(
			body.herder_account,
			"BotHerder account"
		);
		const member = database
			.prepare(
				"SELECT owner_account FROM members WHERE herder_account = ? COLLATE NOCASE"
			)
			.get(herderAccount);
		if (!member) {
			throw Object.assign(new Error("BotHerder membership is unknown"), {
				status: 403,
				code: "member_unknown",
			});
		}
		const snapshot = lab.sanitizeSnapshot(body.snapshot);
		database
			.prepare(
				`INSERT INTO hearth_snapshots (herder_account, snapshot, fetched_at)
				 VALUES (?, ?, ?)
				 ON CONFLICT(herder_account) DO UPDATE SET
					snapshot = excluded.snapshot,
					fetched_at = excluded.fetched_at`
			)
			.run(herderAccount, snapshot, nowIso());
		return jsonResponse(response, 200, {ok: true});
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
				`portal_request_failed path=${normalizePath(request.url || "/").pathname} ` +
					`error_type=${error.constructor.name} ` +
					`message=${JSON.stringify(String(error.message))}`
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
