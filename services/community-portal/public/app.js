"use strict";

const elements = Object.fromEntries(
	[
		"title",
		"subtitle",
		"expectations",
		"error",
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
		"download-agent-env",
		"download-compose",
		"download-dockerfile",
		"download-adapter",
		"download-requirements",
		"download-runbook",
	].map((id) => [
		id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()),
		document.getElementById(id),
	])
);

let token = "";
let preview = null;
let agentResult = null;

function show(element) {
	element.classList.remove("hidden");
}

function hide(element) {
	element.classList.add("hidden");
}

function showError(message) {
	elements.error.textContent = message;
	show(elements.error);
	hide(elements.working);
}

async function api(path, body) {
	const response = await fetch(path, {
		method: "POST",
		headers: {"Content-Type": "application/json"},
		body: JSON.stringify(body),
	});
	const value = await response.json().catch(() => ({}));
	if (!response.ok) {
		throw new Error(value.message || "The request could not be completed.");
	}
	return value;
}

function suggestedHerder(account) {
	const cleaned = account.replace(/[^A-Za-z0-9]/g, "");
	return `${cleaned || "My"}sBotHerder`.slice(0, 32);
}

function startWorking() {
	hide(elements.error);
	hide(elements.memberForm);
	hide(elements.agentForm);
	show(elements.working);
}

function finishMember(result) {
	hide(elements.working);
	elements.memberAccount.textContent = result.account;
	elements.memberPassword.textContent = result.password;
	elements.memberHerder.textContent = result.herder_account;
	elements.openLobby.href = result.lounge_url;
	elements.firstCommand.textContent = `${result.herder_account}: ask gpt-oss-120b say hello in one sentence`;
	elements.quasselHost.textContent = result.irc_host;
	elements.quasselPort.textContent = String(result.irc_port);
	show(elements.memberSuccess);
	history.replaceState(null, "", `${location.pathname}`);
}

function envText(result) {
	return [
		`IRC_SERVER=${result.irc_host}`,
		`IRC_PORT=${result.irc_port}`,
		"IRC_TLS=true",
		`IRC_ACCOUNT=${result.account}`,
		`IRC_NICK=${result.account}`,
		`IRC_PASSWORD=${result.password}`,
		`HERDER_ACCOUNT=${result.herder_account}`,
		`OWNER_ACCOUNT=${result.owner_account}`,
		"OPENAI_BASE_URL=https://api.openai.com/v1",
		"OPENAI_API_KEY=replace-me",
		"OPENAI_MODEL=replace-me",
		"OPENAI_MAX_TOKENS=512",
		"OPENAI_TIMEOUT_SECONDS=600",
		"OPENAI_MAX_CONCURRENT_REQUESTS=2",
		`AGENT_DESCRIPTION=${result.agent_name}`,
		"",
	].join("\n");
}

function downloadText(name, body) {
	const link = document.createElement("a");
	link.href = URL.createObjectURL(new Blob([body], {type: "text/plain"}));
	link.download = name;
	link.click();
	setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

function finishAgent(result) {
	agentResult = result;
	hide(elements.working);
	elements.agentAccount.textContent = result.account;
	elements.agentSuccessHerder.textContent = result.herder_account;
	const base = result.agent_kit_base;
	elements.downloadCompose.href = `${base}/compose.yaml`;
	elements.downloadDockerfile.href = `${base}/Dockerfile`;
	elements.downloadAdapter.href = `${base}/agent_adapter.py`;
	elements.downloadRequirements.href = `${base}/requirements.txt`;
	elements.downloadRunbook.href = `${base}/RUNBOOK.md`;
	show(elements.agentSuccess);
	history.replaceState(null, "", `${location.pathname}`);
}

async function initialize() {
	token = location.hash.slice(1);
	if (!token) {
		elements.title.textContent = "This page needs an invitation";
		elements.subtitle.textContent =
			"Ask the community administrator for a fresh one-time link.";
		return;
	}
	try {
		preview = await api("api/invites/preview", {token});
		show(elements.expectations);
		if (preview.kind === "member") {
			elements.title.textContent = `${preview.display_name}, you’re invited`;
			elements.subtitle.textContent =
				"Choose two names. Everything else is prepared for you.";
			elements.displayName.value =
				preview.display_name === "Friend" ? "" : preview.display_name;
			show(elements.memberForm);
		} else {
			elements.title.textContent = "Connect a remote agent";
			elements.subtitle.textContent =
				"Its provider credential remains on the agent host.";
			elements.agentName.textContent = preview.agent_name;
			elements.agentOwner.textContent = preview.owner_account;
			elements.agentHerder.textContent = preview.herder_account;
			show(elements.agentForm);
		}
	} catch (error) {
		elements.title.textContent = "This invitation cannot be used";
		elements.subtitle.textContent = "";
		showError(error.message);
	}
}

elements.account.addEventListener("input", () => {
	if (!elements.herderAccount.dataset.edited) {
		elements.herderAccount.value = suggestedHerder(elements.account.value);
	}
});
elements.herderAccount.addEventListener("input", () => {
	elements.herderAccount.dataset.edited = "true";
});

elements.memberForm.addEventListener("submit", async (event) => {
	event.preventDefault();
	startWorking();
	try {
		const result = await api("api/invites/redeem", {
			token,
			account: elements.account.value,
			herder_account: elements.herderAccount.value,
			display_name: elements.displayName.value,
		});
		finishMember(result);
	} catch (error) {
		showError(error.message);
		show(elements.memberForm);
	}
});

elements.redeemAgent.addEventListener("click", async () => {
	startWorking();
	try {
		finishAgent(await api("api/invites/redeem", {token}));
	} catch (error) {
		showError(error.message);
		show(elements.agentForm);
	}
});

elements.downloadAgentEnv.addEventListener("click", () => {
	if (agentResult) {
		downloadText("agent.env", envText(agentResult));
	}
});

for (const button of document.querySelectorAll("[data-copy]")) {
	button.addEventListener("click", async () => {
		const target = document.getElementById(button.dataset.copy);
		await navigator.clipboard.writeText(target.textContent);
		const prior = button.textContent;
		button.textContent = "Copied";
		setTimeout(() => {
			button.textContent = prior;
		}, 1200);
	});
}

initialize();
