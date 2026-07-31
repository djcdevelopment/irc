"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const {spawn} = require("node:child_process");
const {DatabaseSync} = require("node:sqlite");
const {startFakeErgo} = require("./fake-ergo.js");

const REGISTRAR = "communityregistrar";
const REGISTRAR_PASSWORD = "fake-registrar-password";
const OPER_NAME = "registrar";
const OPER_PASSWORD = "fake-oper-password";
const ADMIN_TOKEN = "fake-admin-token";
const INTERNAL_TOKEN = "fake-internal-token";

function freePort() {
	return new Promise((resolve) => {
		const probe = net.createServer();
		probe.listen(0, "127.0.0.1", () => {
			const {port} = probe.address();
			probe.close(() => resolve(port));
		});
	});
}

async function startPortal(root, ergoPort) {
	const port = await freePort();
	const node = /\s/.test(process.execPath) ? "node" : process.execPath;
	const portal = spawn(
		process.execPath,
		["--no-warnings", path.resolve(__dirname, "../server.js")],
		{
			env: {
				...process.env,
				COMMUNITY_PORTAL_HOST: "127.0.0.1",
				COMMUNITY_PORTAL_PORT: String(port),
				COMMUNITY_STATE_DIR: path.join(root, "state"),
				BOT_HERDER_MEMBERS_DIR: path.join(root, "herder-members"),
				THELOUNGE_HOME: path.join(root, "lounge"),
				COMMUNITY_THELOUNGE_BIN: `${node} ${path.resolve(
					__dirname,
					"fake-thelounge.js"
				)}`,
				COMMUNITY_PUBLIC_BASE: "https://portal.invalid/join",
				COMMUNITY_LOUNGE_URL: "https://lounge.invalid",
				COMMUNITY_IRC_PUBLIC_HOST: "irc.invalid",
				COMMUNITY_IRC_SERVER: "127.0.0.1",
				COMMUNITY_IRC_PORT: String(ergoPort),
				COMMUNITY_REGISTRAR_ACCOUNT: REGISTRAR,
				COMMUNITY_REGISTRAR_PASSWORD: REGISTRAR_PASSWORD,
				COMMUNITY_REGISTRAR_OPER_NAME: OPER_NAME,
				COMMUNITY_REGISTRAR_OPER_PASSWORD: OPER_PASSWORD,
				COMMUNITY_ADMIN_TOKEN: ADMIN_TOKEN,
				COMMUNITY_INTERNAL_TOKEN: INTERNAL_TOKEN,
				COMMUNITY_PRIMARY_HERDER: "neon2sHerder",
				COMMUNITY_CREDENTIAL_KEY: crypto.randomBytes(32).toString("base64url"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		}
	);
	let diagnostics = "";
	portal.stdout.setEncoding("utf8");
	portal.stderr.setEncoding("utf8");
	portal.stderr.on("data", (chunk) => {
		diagnostics += chunk;
	});
	await new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`the portal did not start\n${diagnostics}`)),
			20_000
		);
		portal.stdout.on("data", (chunk) => {
			if (chunk.includes("community_portal_ready")) {
				clearTimeout(timer);
				resolve();
			}
		});
		portal.on("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`the portal exited with ${code}\n${diagnostics}`));
		});
	});
	return {
		port,
		stop: () =>
			new Promise((resolve) => {
				portal.once("exit", resolve);
				portal.kill();
			}),
	};
}

async function main() {
	fs.mkdirSync(os.tmpdir(), {recursive: true});
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "community-lab-"));
	const ergo = await startFakeErgo({
		accounts: {[REGISTRAR]: REGISTRAR_PASSWORD},
		operName: OPER_NAME,
		operPassword: OPER_PASSWORD,
	});
	let portal = await startPortal(root, ergo.port);

	const request = async (method, pathname, {body, token, headers = {}} = {}) => {
		const response = await fetch(
			`http://127.0.0.1:${portal.port}${pathname}`,
			{
				method,
				headers: {
					...(body ? {"content-type": "application/json"} : {}),
					...(token ? {authorization: `Bearer ${token}`} : {}),
					...headers,
				},
				body: body ? JSON.stringify(body) : undefined,
			}
		);
		const type = response.headers.get("content-type") || "";
		const payload = type.includes("json")
			? await response.json()
			: await response.text();
		return {status: response.status, body: payload, headers: response.headers};
	};
	const redeemNewMember = async (displayName, account, herder) => {
		const created = await request("POST", "/api/admin/invites", {
			body: {display_name: displayName},
			token: ADMIN_TOKEN,
		});
		assert.equal(created.status, 201);
		const token = created.body.url.split("#")[1];
		const redeemed = await request("POST", "/api/invites/redeem", {
			body: {token, account, herder_account: herder},
		});
		assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
		return redeemed.body;
	};

	try {
		// --- M1: profile creation, slug collisions, backfill idempotence ----
		const neon = await redeemNewMember("Neon Basement", "neon", "neonsHerder");
		assert.deepEqual(neon.channels, ["#general", "#ops", "#lab-neon-basement"]);
		assert.equal(neon.web_url, "https://portal.invalid/lab/neon-basement");
		// A display name that collapses to the same slug gets a suffix. The
		// second member arrives through the admin lane (the primary's own
		// path), which may register even a reserved primary companion name
		// and keeps the legacy channel default for pre-provisioned members.
		const second = await request("POST", "/api/admin/members", {
			body: {
				owner_account: "neon2",
				herder_account: "neon2sHerder",
				display_name: "Neon Basement!!",
			},
			token: ADMIN_TOKEN,
		});
		assert.equal(second.status, 200, JSON.stringify(second.body));
		let storefronts = await request("GET", "/api/internal/storefronts", {
			token: INTERNAL_TOKEN,
		});
		assert.equal(storefronts.status, 200);
		const slugs = storefronts.body.storefronts.map((entry) => entry.lab_slug);
		assert.deepEqual(slugs.sort(), ["neon-basement", "neon-basement-2"]);
		for (const entry of storefronts.body.storefronts) {
			assert.equal(entry.web_url, `https://portal.invalid/lab/${entry.lab_slug}`);
			assert.equal(entry.irc_accent, 11);
		}
		const byOwner = Object.fromEntries(
			storefronts.body.storefronts.map((entry) => [entry.owner_account, entry])
		);
		assert.match(byOwner.neon.channel, /^#lab-/);
		assert.match(
			byOwner.neon2.channel,
			/^#herder-/,
			"pre-provisioned members keep their legacy channel until they rename"
		);
		// The AMODE grant rode along with channel registration.
		assert.ok(
			ergo.amodes.some(
				(entry) =>
					entry.channel === "#lab-neon-basement" &&
					entry.mode === "+o" &&
					entry.account === "neonsHerder"
			),
			"the Herder was not granted channel operator"
		);

		// A restart re-runs the backfill without duplicating or renaming.
		await portal.stop();
		portal = await startPortal(root, ergo.port);
		storefronts = await request("GET", "/api/internal/storefronts", {
			token: INTERNAL_TOKEN,
		});
		assert.deepEqual(
			storefronts.body.storefronts.map((entry) => entry.lab_slug).sort(),
			["neon-basement", "neon-basement-2"],
			"restart changed lab slugs"
		);

		// --- M2: public lab page --------------------------------------------
		const page = await request("GET", "/lab/neon-basement");
		assert.equal(page.status, 200);
		assert.match(page.headers.get("content-type") || "", /text\/html/);
		const csp = page.headers.get("content-security-policy") || "";
		assert.match(csp, /default-src 'none'/);
		assert.match(csp, /style-src 'self' 'nonce-[A-Za-z0-9_-]+'/);
		assert.doesNotMatch(csp, /script-src/);
		assert.match(page.body, /Neon Basement/);
		assert.match(page.body, /you are visitor/);
		assert.match(page.body, /not currently projecting HEARTH state/);
		assert.match(page.body, /#lab-neon-basement/);

		// Counter increments once per address per hour.
		const countOf = (body) =>
			body
				.match(/class="digit">(\d)</g)
				.map((part) => part.slice(-2, -1))
				.join("");
		const repeat = await request("GET", "/lab/neon-basement");
		assert.equal(countOf(repeat.body), "000001", "same address re-counted");
		const elsewhere = await request("GET", "/lab/neon-basement", {
			headers: {"x-forwarded-for": "203.0.113.9"},
		});
		assert.equal(countOf(elsewhere.body), "000002", "new address not counted");

		// Unknown, malformed, and reserved slugs are 404s.
		for (const target of ["/lab/nope", "/lab/Bad_Slug!", "/lab/edit-x/../x"]) {
			const missing = await request("GET", target);
			assert.equal(missing.status, 404, target);
		}

		// The gallery lists every lab and rings the doorbell.
		for (const target of ["/lab", "/lab/"]) {
			const gallery = await request("GET", target);
			assert.equal(gallery.status, 200, target);
			assert.match(gallery.body, /The Labs/);
			assert.match(gallery.body, /href="\/lab\/neon-basement"/);
			assert.match(gallery.body, /Neon Basement/);
			assert.match(gallery.body, /membership is by invitation/);
			assert.match(gallery.body, /href="\/guide\/"/);
			assert.match(
				gallery.headers.get("content-security-policy") || "",
				/default-src 'none'/
			);
		}
		// Every lab page carries the doorbell too.
		assert.match(page.body, /membership is by invitation/);

		// --- M2: HEARTH snapshot ingestion ----------------------------------
		const snapshot = {
			providers: [
				{name: "omen-ollama", models: ["qwen3-coder:30b"], tags: ["default"]},
			],
			operations: [{name: "llm.chat", description: "conversational completion"}],
			kernel: {ledger_events: 22_150, gateway_providers: 17},
			recent: [{operation: "llm.chat", status: "succeeded", finished_at: ""}],
			artifacts: [],
		};
		const unauthorized = await request(
			"POST",
			"/api/internal/storefront-snapshot",
			{body: {herder_account: "neonsHerder", snapshot}, token: "wrong"}
		);
		assert.equal(unauthorized.status, 401);
		const unknownHerder = await request(
			"POST",
			"/api/internal/storefront-snapshot",
			{body: {herder_account: "ghost", snapshot}, token: INTERNAL_TOKEN}
		);
		assert.equal(unknownHerder.status, 403);
		// Larger than the 15000-byte sanitized cap while staying under the
		// 16 KiB request-body ceiling, so the snapshot cap itself fires.
		const oversized = await request(
			"POST",
			"/api/internal/storefront-snapshot",
			{
				body: {
					herder_account: "neonsHerder",
					snapshot: {
						...snapshot,
						operations: Array.from({length: 12}, () => ({
							name: "o".repeat(64),
							description: "x".repeat(160),
						})),
						providers: Array.from({length: 12}, () => ({
							name: "p".repeat(64),
							models: Array.from({length: 8}, () => "m".repeat(64)),
							tags: Array.from({length: 8}, () => "t".repeat(32)),
						})),
						recent: Array.from({length: 10}, () => ({
							operation: "r".repeat(64),
							status: "s".repeat(24),
							finished_at: "f".repeat(32),
						})),
					},
				},
				token: INTERNAL_TOKEN,
			}
		);
		assert.equal(oversized.status, 400, JSON.stringify(oversized.body));
		const accepted = await request(
			"POST",
			"/api/internal/storefront-snapshot",
			{body: {herder_account: "neonsHerder", snapshot}, token: INTERNAL_TOKEN}
		);
		assert.equal(accepted.status, 200);
		let projected = await request("GET", "/lab/neon-basement");
		assert.match(projected.body, /omen-ollama/);
		assert.match(projected.body, /qwen3-coder:30b/);
		assert.match(projected.body, /projected from HEARTH · as of \d\d:\d\d UTC/);
		assert.doesNotMatch(projected.body, /projection stale/);

		// A snapshot from the past renders as visibly stale.
		const database = new DatabaseSync(
			path.join(root, "state", "community.sqlite")
		);
		database
			.prepare("UPDATE hearth_snapshots SET fetched_at = ?")
			.run(new Date(Date.now() - 45 * 60_000).toISOString());
		database.close();
		projected = await request("GET", "/lab/neon-basement");
		assert.match(projected.body, /HEARTH projection stale/);

		// --- M3: edit tokens -------------------------------------------------
		const wrongMint = await request("POST", "/api/internal/lab-edit-links", {
			body: {owner_account: "neon", herder_account: "neon2sHerder"},
			token: INTERNAL_TOKEN,
		});
		assert.equal(wrongMint.status, 403, "mismatched member minted a token");
		const minted = await request("POST", "/api/internal/lab-edit-links", {
			body: {owner_account: "neon", herder_account: "neonsHerder"},
			token: INTERNAL_TOKEN,
		});
		assert.equal(minted.status, 201);
		assert.match(minted.body.url, /^https:\/\/portal\.invalid\/lab\/edit#/);
		const editToken = minted.body.url.split("#")[1];

		const noAuth = await request("GET", "/lab/api/profile");
		assert.equal(noAuth.status, 401);
		const profile = await request("GET", "/lab/api/profile", {
			token: editToken,
		});
		assert.equal(profile.status, 200);
		assert.equal(profile.body.lab_name, "Neon Basement");
		assert.equal(profile.body.lab_slug, "neon-basement");

		// Editor page is served under the reserved /lab/edit path.
		const editorPage = await request("GET", "/lab/edit");
		assert.equal(editorPage.status, 200);
		assert.match(editorPage.body, /Dress your lab/);

		// --- M3: profile updates, validation, and escaping -------------------
		const hostile = "<script>alert(1)</script>\"'&";
		const updated = await request("PUT", "/lab/api/profile", {
			token: editToken,
			body: {
				lab_name: "Neon Basement Labs",
				tagline: hostile,
				marquee: `*** ${hostile} ***`,
				bio: `line one\n\n${hostile}`,
				experiments: [hostile, "training a tiny model"],
				links: [{label: hostile, url: "https://example.com/x"}],
				ascii_banner: " /\\_/\\\n( o.o )  neon\n > ^ <",
				theme: {
					bg: "#101018",
					fg: "#e0e0ff",
					accent: "#FF00FF",
					accent2: "#00ffcc",
					irc_accent: 13,
				},
			},
		});
		assert.equal(updated.status, 200, JSON.stringify(updated.body));
		assert.equal(updated.body.lab_name, "Neon Basement Labs");
		const dressed = await request("GET", "/lab/neon-basement");
		assert.doesNotMatch(dressed.body, /<script>alert/);
		assert.match(dressed.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
		assert.match(dressed.body, /--lab-accent:#ff00ff/);
		assert.match(dressed.body, /\( o\.o \)  neon/);
		assert.match(dressed.body, /class="marquee"/);
		const accents = await request("GET", "/api/internal/storefronts", {
			token: INTERNAL_TOKEN,
		});
		const neonEntry = accents.body.storefronts.find(
			(entry) => entry.owner_account === "neon"
		);
		assert.equal(neonEntry.irc_accent, 13);
		assert.equal(neonEntry.lab_name, "Neon Basement Labs");

		// The gallery card wears the lab's own theme.
		const themedGallery = await request("GET", "/lab/");
		assert.match(
			themedGallery.body,
			/\.gallery-card\.card-\d+ \.name\{color:#ff00ff;\}/,
			"the gallery card ignored the lab theme"
		);
		assert.match(themedGallery.body, /background:#101018/);

		// Validation rejects hostile or oversized fields outright.
		const rejects = [
			{lab_name: "x"},
			{lab_name: "a<b>"},
			{tagline: "line\nbreak"},
			{links: [{label: "ftp", url: "ftp://example.com"}]},
			{links: [{label: "js", url: "javascript:alert(1)"}]},
			{ascii_banner: `${"x".repeat(81)}`},
			{ascii_banner: Array.from({length: 25}, () => "y").join("\n")},
			{ascii_banner: "bell\x07art"},
			{theme: {bg: "red"}},
			{theme: {irc_accent: 16}},
			{html_fragment: "<b>nope</b>"},
			{experiments: Array.from({length: 9}, () => "too many")},
		];
		for (const body of rejects) {
			const rejected = await request("PUT", "/lab/api/profile", {
				token: editToken,
				body,
			});
			assert.equal(rejected.status, 400, JSON.stringify(body));
		}

		// Re-minting revokes the previous token; the admin lane also mints.
		const reminted = await request("POST", "/api/admin/lab-edit-links", {
			body: {owner_account: "neon"},
			token: ADMIN_TOKEN,
		});
		assert.equal(reminted.status, 201);
		const revoked = await request("GET", "/lab/api/profile", {
			token: editToken,
		});
		assert.equal(revoked.status, 401, "old token survived a re-mint");
		const fresh = await request("GET", "/lab/api/profile", {
			token: reminted.body.url.split("#")[1],
		});
		assert.equal(fresh.status, 200);

		// An expired token stops working.
		const expiring = new DatabaseSync(
			path.join(root, "state", "community.sqlite")
		);
		expiring
			.prepare("UPDATE lab_edit_tokens SET expires_at = ?")
			.run(new Date(Date.now() - 1000).toISOString());
		expiring.close();
		const expired = await request("GET", "/lab/api/profile", {
			token: reminted.body.url.split("#")[1],
		});
		assert.equal(expired.status, 401, "expired token still worked");

		// --- M5: channel rename ---------------------------------------------
		const moveMint = await request("POST", "/api/admin/lab-edit-links", {
			body: {owner_account: "neon"},
			token: ADMIN_TOKEN,
		});
		const moveToken = moveMint.body.url.split("#")[1];
		for (const [slug, status] of [
			["edit", 400],
			["Bad Slug", 400],
			["neon-basement-2", 409],
		]) {
			const refused = await request("POST", "/lab/api/rename-channel", {
				token: moveToken,
				body: {lab_slug: slug},
			});
			assert.equal(refused.status, status, `slug ${slug}`);
		}
		const moved = await request("POST", "/lab/api/rename-channel", {
			token: moveToken,
			body: {lab_slug: "velvet-attic"},
		});
		assert.equal(moved.status, 200, JSON.stringify(moved.body));
		assert.equal(moved.body.channel, "#lab-velvet-attic");
		assert.equal(moved.body.lab_slug, "velvet-attic");
		assert.equal(moved.body.web_url, "https://portal.invalid/lab/velvet-attic");
		assert.deepEqual(moved.body.notes, []);
		assert.ok(
			ergo.amodes.some(
				(entry) =>
					entry.channel === "#lab-velvet-attic" &&
					entry.account === "neonsHerder"
			),
			"the Herder was not opped in the new channel"
		);
		assert.ok(
			ergo.topics.some(
				(entry) =>
					entry.channel === "#lab-neon-basement" &&
					entry.topic.includes("moved → #lab-velvet-attic")
			),
			"the old channel did not get a forwarding topic"
		);
		const movedHerder = JSON.parse(
			fs.readFileSync(
				path.join(root, "herder-members", "neonsHerder.json"),
				"utf8"
			)
		);
		assert.ok(movedHerder.channels.includes("#lab-velvet-attic"));
		assert.ok(!movedHerder.channels.includes("#lab-neon-basement"));
		assert.equal(movedHerder.storefront_channel, "#lab-velvet-attic");
		const movedLounge = JSON.parse(
			fs.readFileSync(path.join(root, "lounge", "users", "neon.json"), "utf8")
		);
		assert.ok(
			movedLounge.networks[0].channels.some(
				(channel) => channel.name === "#lab-velvet-attic"
			)
		);
		const newPage = await request("GET", "/lab/velvet-attic");
		assert.equal(newPage.status, 200);
		const oldPage = await request("GET", "/lab/neon-basement");
		assert.equal(oldPage.status, 404, "the old slug should be free");

		// --- M5: companion rename -------------------------------------------
		const oldHerderJson = movedHerder;
		const renamedCompanion = await request(
			"POST",
			"/lab/api/rename-companion",
			{token: moveToken, body: {companion: "VelvetKeeper"}}
		);
		assert.equal(
			renamedCompanion.status,
			200,
			JSON.stringify(renamedCompanion.body)
		);
		assert.equal(renamedCompanion.body.companion, "VelvetKeeper");
		assert.equal(renamedCompanion.body.previous, "neonsHerder");
		assert.equal(
			ergo.accounts.get("velvetkeeper"),
			oldHerderJson.irc_password,
			"the companion kept its password"
		);
		assert.ok(ergo.suspensions.includes("neonsHerder"));
		assert.ok(
			!fs.existsSync(path.join(root, "herder-members", "neonsHerder.json")),
			"the old member file survived"
		);
		const newHerderJson = JSON.parse(
			fs.readFileSync(
				path.join(root, "herder-members", "VelvetKeeper.json"),
				"utf8"
			)
		);
		assert.equal(newHerderJson.account, "VelvetKeeper");
		assert.equal(newHerderJson.nick, "VelvetKeeper");
		const renamedStorefronts = await request(
			"GET",
			"/api/internal/storefronts",
			{token: INTERNAL_TOKEN}
		);
		const renamedEntry = renamedStorefronts.body.storefronts.find(
			(entry) => entry.owner_account === "neon"
		);
		assert.equal(renamedEntry.herder_account, "VelvetKeeper");

		// The configured primary companion is protected from renames.
		const primaryMint = await request("POST", "/api/admin/lab-edit-links", {
			body: {owner_account: "neon2"},
			token: ADMIN_TOKEN,
		});
		const protectedRename = await request(
			"POST",
			"/lab/api/rename-companion",
			{
				token: primaryMint.body.url.split("#")[1],
				body: {companion: "SneakyRename"},
			}
		);
		assert.equal(protectedRename.status, 403, "primary companion renamed");

		// Offboarding clears the profile, snapshot, and token rows.
		const offboard = await request("POST", "/api/admin/members/offboard", {
			body: {owner_account: "neon", herder_account: "VelvetKeeper"},
			token: ADMIN_TOKEN,
		});
		assert.equal(offboard.status, 200, JSON.stringify(offboard.body));
		const gone = await request("GET", "/lab/velvet-attic");
		assert.equal(gone.status, 404);
	} finally {
		await portal.stop();
		await ergo.close();
		try {
			fs.rmSync(root, {recursive: true, force: true});
		} catch {
			// A database handle still held on Windows is not a test failure.
		}
	}

	process.stdout.write("portal lab profiles: PASS\n");
}

main().catch((error) => {
	process.exitCode = 1;
	process.stderr.write(`portal lab profiles: FAIL\n${error.stack}\n`);
});
