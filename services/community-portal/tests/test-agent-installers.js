"use strict";

const assert = require("node:assert/strict");
const installers = require("../public/installer.js");

const result = {
	irc_host: "irc.example",
	irc_port: 8443,
	account: "alice-scout",
	password: "one-time-irc-secret",
	herder_account: "AlicesBotHerder",
	owner_account: "alice",
	agent_name: "Scout",
	agent_kit_base: "https://community.example/join/agent-kit",
};

const names = installers.filenames(result);
assert.deepEqual(names, {
	powershell: "Install-OmenAgent-alice-scout.ps1",
	bash: "install-omen-agent-alice-scout.sh",
});

for (const script of [
	installers.powershell(result),
	installers.bash(result),
]) {
	assert.match(script, /docker compose config --quiet/);
	assert.match(script, /docker compose up -d --build/);
	assert.match(script, /reach your model endpoint/i);
	assert.match(script, /connected account=/);
	assert.match(script, /host\.docker\.internal:PORT\/v1/);
	assert.match(script, /AlicesBotHerder: ask Scout Say hello/);
	assert.match(script, /one-time-irc-secret/);
	assert.match(script, /community\.example\/join\/agent-kit/);
	assert.doesNotMatch(script, /OPENAI_API_KEY=replace-me/);
}

assert.throws(
	() => installers.bash({...result, password: "unsafe\nvalue"}),
	/invalid/
);

process.stdout.write("portal generated installers: PASS\n");
