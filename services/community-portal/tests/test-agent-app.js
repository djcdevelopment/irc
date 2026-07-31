"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

class ClassList {
	constructor(initial = []) {
		this.values = new Set(initial);
	}
	add(value) {
		this.values.add(value);
	}
	remove(value) {
		this.values.delete(value);
	}
	contains(value) {
		return this.values.has(value);
	}
}

function element(id) {
	const listeners = new Map();
	return {
		id,
		classList: new ClassList(["hidden"]),
		dataset: {},
		textContent: "",
		value: "",
		href: "",
		disabled: false,
		addEventListener(name, callback) {
			listeners.set(name, callback);
		},
		async dispatch(name) {
			return listeners.get(name)?.();
		},
	};
}

const ids = [
	"title",
	"subtitle",
	"expectations",
	"error",
	"locked-note",
	"member-form",
	"agent-form",
	"working",
	"member-success",
	"agent-success",
	"account",
	"herder-account",
	"display-name",
	"agent-name",
	"agent-owner",
	"agent-herder",
	"redeem-agent",
	"member-account",
	"member-password",
	"member-herder",
	"open-lobby",
	"first-command",
	"quassel-host",
	"quassel-port",
	"agent-account",
	"agent-success-herder",
	"download-windows-installer",
	"download-unix-installer",
	"powershell-install-command",
	"bash-install-command",
	"agent-test-command",
	"download-agent-env",
	"download-compose",
	"download-dockerfile",
	"download-adapter",
	"download-requirements",
	"download-runbook",
];
const elements = new Map(ids.map((id) => [id, element(id)]));

global.document = {
	getElementById(id) {
		return elements.get(id) || null;
	},
	querySelectorAll() {
		return [];
	},
};
global.location = {hash: "#agent-token", pathname: "/join/"};
global.history = {replaceState() {}};
global.OmenAgentInstaller = require("../public/installer.js");

let call = 0;
global.fetch = async (pathValue, options) => {
	call += 1;
	assert.equal(options.method, "POST");
	if (call === 1) {
		assert.equal(pathValue, "api/invites/preview");
		return {
			ok: true,
			async json() {
				return {
					kind: "agent",
					agent_name: "Scout",
					owner_account: "alice",
					herder_account: "AlicesBotHerder",
				};
			},
		};
	}
	assert.equal(pathValue, "api/invites/redeem");
	return {
		ok: true,
		async json() {
			return {
				irc_host: "irc.example",
				irc_port: 8443,
				account: "alice-scout",
				password: "one-time-secret",
				herder_account: "AlicesBotHerder",
				owner_account: "alice",
				agent_name: "Scout",
				agent_kit_base: "https://community.example/join/agent-kit",
			};
		},
	};
};

require(path.resolve(__dirname, "../public/app.js"));

setImmediate(async () => {
	assert.equal(elements.get("agent-form").classList.contains("hidden"), false);
	await elements.get("redeem-agent").dispatch("click");
	assert.equal(elements.get("agent-success").classList.contains("hidden"), false);
	assert.match(
		elements.get("powershell-install-command").textContent,
		/Install-OmenAgent-alice-scout\.ps1/
	);
	assert.match(
		elements.get("bash-install-command").textContent,
		/install-omen-agent-alice-scout\.sh/
	);
	assert.equal(
		elements.get("agent-test-command").textContent,
		"AlicesBotHerder: ask Scout Say hello in one sentence."
	);
	process.stdout.write("portal agent installer flow: PASS\n");
});
