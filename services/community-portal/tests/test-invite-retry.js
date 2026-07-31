"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const {spawn} = require("node:child_process");
const {startFakeErgo} = require("./fake-ergo.js");

const REGISTRAR = "communityregistrar";
const REGISTRAR_PASSWORD = "fake-registrar-password";
const OPER_NAME = "registrar";
const OPER_PASSWORD = "fake-oper-password";
const ADMIN_TOKEN = "fake-admin-token";
const INTERNAL_TOKEN = "fake-internal-token";
const FOREIGN_PASSWORD = "a-different-members-password";

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
	return {port, stop: () => portal.kill()};
}

async function main() {
	fs.mkdirSync(os.tmpdir(), {recursive: true});
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "community-portal-"));
	const ergo = await startFakeErgo({
		accounts: {[REGISTRAR]: REGISTRAR_PASSWORD},
		operName: OPER_NAME,
		operPassword: OPER_PASSWORD,
	});
	const portal = await startPortal(root, ergo.port);

	const post = async (pathname, body, token) => {
		const response = await fetch(
			`http://127.0.0.1:${portal.port}${pathname}`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(token ? {authorization: `Bearer ${token}`} : {}),
				},
				body: JSON.stringify(body),
			}
		);
		return {status: response.status, body: await response.json()};
	};
	const get = async (pathname, token) => {
		const response = await fetch(
			`http://127.0.0.1:${portal.port}${pathname}`,
			{
				headers: token ? {authorization: `Bearer ${token}`} : {},
			}
		);
		return {status: response.status, body: await response.json()};
	};
	const inviteToken = async (displayName) => {
		const created = await post(
			"/api/admin/invites",
			{display_name: displayName},
			ADMIN_TOKEN
		);
		assert.equal(created.status, 201, "the invitation could not be created");
		return created.body.url.split("#")[1];
	};

	try {
		const guide = await fetch(
			`http://127.0.0.1:${portal.port}/guide/`
		);
		assert.equal(guide.status, 200);
		assert.match(
			guide.headers.get("content-security-policy") || "",
			/frame-ancestors 'none'/
		);
		const guideBody = await guide.text();
		assert.match(guideBody, /BotHerder Field Guide/i);
		assert.match(guideBody, /#lab-&lt;your-lab&gt;/);
		assert.match(guideBody, /editlab/);
		assert.match(guideBody, /!catalog/);
		assert.match(guideBody, /!artifacts/);
		assert.match(guideBody, /!whohas &lt;capability&gt;/);
		assert.match(guideBody, /!ask &lt;model&gt; &lt;prompt&gt;/);
		assert.match(guideBody, /OpenAI-compatible base URL/);
		assert.match(guideBody, /Download installer/);
		assert.match(guideBody, /Provision this agent/);
		assert.match(guideBody, /AGENT-HANDOFF\.md/);

		const guideCss = await fetch(
			`http://127.0.0.1:${portal.port}/guide/guide.css`
		);
		assert.equal(guideCss.status, 200);
		assert.match(
			guideCss.headers.get("content-type") || "",
			/text\/css/
		);
		assert.match(await guideCss.text(), /\.guide-shell/);

		const installerScript = await fetch(
			`http://127.0.0.1:${portal.port}/installer.js`
		);
		assert.equal(installerScript.status, 200);
		assert.match(
			installerScript.headers.get("content-type") || "",
			/text\/javascript/
		);
		assert.match(await installerScript.text(), /OmenAgentInstaller/);

		const agentHandoff = await fetch(
			`http://127.0.0.1:${portal.port}/guide/AGENT-HANDOFF.md`
		);
		assert.equal(agentHandoff.status, 200);
		assert.match(
			agentHandoff.headers.get("content-type") || "",
			/text\/markdown/
		);
		const handoffBody = await agentHandoff.text();
		assert.match(handoffBody, /Omen Community remote-agent handoff/);
		assert.match(handoffBody, /Provision this agent/);
		assert.match(handoffBody, /host\.docker\.internal/);

		// A name rejected on the first submission must not be pinned to the invite.
		ergo.accounts.set("djm", FOREIGN_PASSWORD);
		const deej = await inviteToken("Deej");
		const collided = await post("/api/invites/redeem", {
			token: deej,
			account: "djm",
			herder_account: "djmsBotHerder",
		});
		assert.equal(collided.status, 409);
		assert.equal(collided.body.error, "name_taken");
		assert.equal(
			collided.body.locked_names,
			undefined,
			"no account was created, so no name is locked"
		);

		const renamed = await post("/api/invites/redeem", {
			token: deej,
			account: "djmm",
			herder_account: "djmmsBotHerder",
		});
		assert.equal(
			renamed.status,
			200,
			`the retyped name was ignored: ${renamed.body.message}`
		);
		assert.equal(renamed.body.account, "djmm");
		assert.equal(renamed.body.herder_account, "djmmsBotHerder");
		assert.deepEqual(renamed.body.channels, [
			"#general",
			"#ops",
			"#lab-deej",
		]);
		assert.equal(
			ergo.registrations.filter((entry) => entry.account === "djm").length,
			1,
			"the retry re-attempted the abandoned name"
		);
		assert.equal(ergo.accounts.get("djmm"), renamed.body.password);
		const lounge = JSON.parse(
			fs.readFileSync(path.join(root, "lounge", "users", "djmm.json"), "utf8")
		);
		assert.equal(lounge.networks[0].saslPassword, renamed.body.password);
		assert.deepEqual(
			lounge.networks[0].channels.map((channel) => channel.name),
			["#general", "#ops", "#lab-deej"]
		);
		const herder = JSON.parse(
			fs.readFileSync(
				path.join(root, "herder-members", "djmmsBotHerder.json"),
				"utf8"
			)
		);
		assert.deepEqual(herder.channels, [
			"#general",
			"#ops",
			"#lab-deej",
		]);
		assert.equal(herder.storefront_channel, "#lab-deej");
		const storefronts = await get("/api/internal/storefronts", INTERNAL_TOKEN);
		assert.equal(storefronts.status, 200);
		assert.deepEqual(storefronts.body.storefronts, [
			{
				owner_account: "djmm",
				display_name: "Deej",
				herder_account: "djmmsBotHerder",
				channel: "#lab-deej",
				lab_name: "Deej",
				lab_slug: "deej",
				tagline: "",
				web_url: "https://portal.invalid/lab/deej",
				irc_accent: 11,
				created_at: storefronts.body.storefronts[0].created_at,
				agents: [],
			},
		]);

		// A half-finished attempt keeps the account it created and frees the other.
		ergo.accounts.set("takenherder", FOREIGN_PASSWORD);
		const ana = await inviteToken("Ana");
		const halfDone = await post("/api/invites/redeem", {
			token: ana,
			account: "ana",
			herder_account: "takenherder",
		});
		assert.equal(halfDone.status, 409);
		assert.deepEqual(halfDone.body.locked_names, {account: "ana"});
		const anaPassword = ergo.accounts.get("ana");
		assert.ok(anaPassword, "the IRC name should have been created");

		// An unreachable registrar cannot be read as "that name was never taken".
		ergo.setReachable(false);
		const offline = await post("/api/invites/redeem", {
			token: ana,
			account: "anna",
			herder_account: "annasBotHerder",
		});
		assert.equal(offline.status, 503);
		assert.equal(offline.body.error, "registrar_unreachable");
		ergo.setReachable(true);

		const bothRetyped = await post("/api/invites/redeem", {
			token: ana,
			account: "anna",
			herder_account: "annasBotHerder",
		});
		assert.equal(bothRetyped.status, 409);
		assert.equal(bothRetyped.body.error, "name_locked");
		assert.deepEqual(bothRetyped.body.locked_names, {account: "ana"});
		assert.ok(
			ergo.registrations.every((entry) => entry.account !== "anna"),
			"a created account must not be abandoned under a new name"
		);

		const lockedPreview = await post("/api/invites/preview", {token: ana});
		assert.deepEqual(lockedPreview.body.locked_names, {account: "ana"});

		const finished = await post("/api/invites/redeem", {
			token: ana,
			account: "ana",
			herder_account: "anasBotHerder",
		});
		assert.equal(finished.status, 200, finished.body.message);
		assert.equal(finished.body.account, "ana");
		assert.equal(finished.body.herder_account, "anasBotHerder");
		assert.equal(
			finished.body.password,
			anaPassword,
			"the password of the already-created account was regenerated"
		);

		// A failure that is not a name collision keeps the whole envelope.
		const blocked = path.join(root, "herder-members", "kimsBotHerder.json");
		fs.mkdirSync(blocked, {recursive: true});
		const kim = await inviteToken("Kim");
		const crashed = await post("/api/invites/redeem", {
			token: kim,
			account: "kim",
			herder_account: "kimsBotHerder",
		});
		assert.equal(crashed.status, 500);
		const kimPassword = ergo.accounts.get("kim");
		assert.ok(kimPassword, "the IRC name should have been created");

		const retried = await post("/api/invites/redeem", {
			token: kim,
			account: "kimmy",
			herder_account: "kimmysBotHerder",
		});
		assert.equal(retried.status, 500);
		assert.ok(
			ergo.registrations.every((entry) => entry.account !== "kimmy"),
			"crash recovery must reuse the credentials it already provisioned"
		);
		assert.equal(ergo.accounts.get("kim"), kimPassword);

		const crashPreview = await post("/api/invites/preview", {token: kim});
		assert.deepEqual(crashPreview.body.locked_names, {
			account: "kim",
			herder_account: "kimsBotHerder",
		});

		fs.rmSync(blocked, {recursive: true});
		const recovered = await post("/api/invites/redeem", {
			token: kim,
			account: "kimmy",
			herder_account: "kimmysBotHerder",
		});
		assert.equal(recovered.status, 200, recovered.body.message);
		assert.equal(recovered.body.account, "kim");
		assert.equal(recovered.body.password, kimPassword);

		// Agent invitations share the envelope helper and carry no typed names.
		const agentInvite = await post(
			"/api/internal/agent-invites",
			{
				owner_account: "djmm",
				herder_account: "djmmsBotHerder",
				agent_name: "scout",
			},
			INTERNAL_TOKEN
		);
		assert.equal(agentInvite.status, 201, agentInvite.body.message);
		const agent = await post("/api/invites/redeem", {
			token: agentInvite.body.url.split("#")[1],
		});
		assert.equal(agent.status, 200, agent.body.message);
		assert.equal(agent.body.account, agentInvite.body.agent_account);
		assert.equal(
			ergo.accounts.get(agent.body.account.toLowerCase()),
			agent.body.password
		);
	} finally {
		portal.stop();
		await ergo.close();
		try {
			fs.rmSync(root, {recursive: true, force: true});
		} catch {
			// A database handle still held on Windows is not a test failure.
		}
	}

	process.stdout.write("portal invitation-retry: PASS\n");
}

main().catch((error) => {
	process.exitCode = 1;
	process.stderr.write(`portal invitation-retry: FAIL\n${error.stack}\n`);
});
