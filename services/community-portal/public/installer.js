"use strict";

(function expose(root, factory) {
	const api = factory();
	if (typeof module !== "undefined" && module.exports) {
		module.exports = api;
	}
	root.OmenAgentInstaller = api;
})(typeof globalThis === "undefined" ? this : globalThis, () => {
	const KIT_FILES = [
		"compose.yaml",
		"Dockerfile",
		"agent_adapter.py",
		"requirements.txt",
		"RUNBOOK.md",
	];

	function safe(value, name) {
		const text = String(value || "");
		if (!text || /[\r\n\0]/.test(text)) {
			throw new Error(`installer value is invalid: ${name}`);
		}
		return text;
	}

	function stem(result) {
		return safe(result.account, "account")
			.replace(/[^A-Za-z0-9_-]/g, "-")
			.toLowerCase();
	}

	function psQuote(value) {
		return `'${String(value).replaceAll("'", "''")}'`;
	}

	function shQuote(value) {
		return `'${String(value).replaceAll("'", `'"'"'`)}'`;
	}

	function values(result) {
		return {
			ircHost: safe(result.irc_host, "irc_host"),
			ircPort: safe(result.irc_port, "irc_port"),
			account: safe(result.account, "account"),
			password: safe(result.password, "password"),
			herder: safe(result.herder_account, "herder_account"),
			owner: safe(result.owner_account, "owner_account"),
			agentName: safe(result.agent_name, "agent_name"),
			kitBase: safe(result.agent_kit_base, "agent_kit_base").replace(/\/+$/, ""),
		};
	}

	function powershell(result) {
		const v = values(result);
		const files = KIT_FILES.map((name) => psQuote(name)).join(", ");
		return `# Omen Community remote-agent installer
# Run this file in PowerShell on the computer that will host the agent.
$ErrorActionPreference = "Stop"

function Require-Success([string]$Step) {
    if ($LASTEXITCODE -ne 0) { throw "$Step failed (exit $LASTEXITCODE)" }
}

Write-Host ""
Write-Host "Omen Agent setup for ${v.agentName}" -ForegroundColor Cyan
Write-Host "Run location: this computer must be able to reach your model endpoint."
Write-Host ""

& docker version *> $null
Require-Success "Docker daemon check"
& docker compose version *> $null
Require-Success "Docker Compose check"

Write-Host "Same-computer model: use http://host.docker.internal:PORT/v1, not localhost." -ForegroundColor Yellow
$baseUrl = (Read-Host "OpenAI-compatible base URL (example: https://api.example.com/v1)").TrimEnd("/")
$model = Read-Host "Model ID"
$secureKey = Read-Host "Provider API key (input is hidden)" -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
    $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
if (-not $baseUrl -or -not $model -or -not $apiKey) {
    throw "Base URL, model ID, and API key are required"
}

$installDir = Join-Path $HOME ${psQuote(`OmenAgent/${v.account}`)}
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
$kitBase = ${psQuote(v.kitBase)}
$files = @(${files})
foreach ($file in $files) {
    Write-Host "Downloading $file"
    Invoke-WebRequest -UseBasicParsing -Uri "$kitBase/$file" -OutFile (Join-Path $installDir $file)
}

$lines = @(
    ${psQuote(`IRC_SERVER=${v.ircHost}`)},
    ${psQuote(`IRC_PORT=${v.ircPort}`)},
    "IRC_TLS=true",
    ${psQuote(`IRC_ACCOUNT=${v.account}`)},
    ${psQuote(`IRC_NICK=${v.account}`)},
    ${psQuote(`IRC_PASSWORD=${v.password}`)},
    ${psQuote(`HERDER_ACCOUNT=${v.herder}`)},
    ${psQuote(`OWNER_ACCOUNT=${v.owner}`)},
    "OPENAI_BASE_URL=$baseUrl",
    "OPENAI_API_KEY=$apiKey",
    "OPENAI_MODEL=$model",
    "OPENAI_MAX_TOKENS=512",
    "OPENAI_TIMEOUT_SECONDS=600",
    "OPENAI_MAX_CONCURRENT_REQUESTS=2",
    ${psQuote(`AGENT_DESCRIPTION=${v.agentName}`)},
    ""
)
$utf8 = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllLines((Join-Path $installDir "agent.env"), $lines, $utf8)
$apiKey = $null

Push-Location $installDir
try {
    & docker compose config --quiet
    Require-Success "Compose validation"
    & docker compose up -d --build
    Require-Success "Agent startup"
    & docker compose ps

    Write-Host "Waiting for the IRC connection..."
    $connected = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $logs = (& docker compose logs --no-color --tail 100 agent 2>&1 | Out-String)
        if ($logs -match "connected account=") {
            $connected = $true
            break
        }
        Start-Sleep -Seconds 2
    }
    if (-not $connected) {
        & docker compose logs --no-color --tail 100 agent
        throw "The agent did not connect within 60 seconds. Review the logs above."
    }
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "Agent connected." -ForegroundColor Green
Write-Host "Test in IRC:"
Write-Host ${psQuote(`${v.herder}: ask ${v.agentName} Say hello in one sentence.`)} -ForegroundColor Yellow
Write-Host "Installed in: $installDir"
Write-Host "Troubleshoot: cd \`"$installDir\`"; docker compose logs --tail 100"

$installerPath = $MyInvocation.MyCommand.Path
if ($installerPath -and (Test-Path -LiteralPath $installerPath)) {
    Remove-Item -LiteralPath $installerPath -Force
    Write-Host "The downloaded installer was removed because it contained a one-time IRC credential."
}
`;
	}

	function bash(result) {
		const v = values(result);
		const files = KIT_FILES.map((name) => shQuote(name)).join(" ");
		return `#!/usr/bin/env bash
# Omen Community remote-agent installer
# Run this file in a terminal on the computer that will host the agent.
set -euo pipefail

printf '\\nOmen Agent setup for %s\\n' ${shQuote(v.agentName)}
printf 'Run location: this computer must be able to reach your model endpoint.\\n\\n'

command -v docker >/dev/null || { printf 'Docker is not installed.\\n' >&2; exit 1; }
command -v curl >/dev/null || { printf 'curl is not installed.\\n' >&2; exit 1; }
docker version >/dev/null
docker compose version >/dev/null

printf 'Same-computer model: use http://host.docker.internal:PORT/v1, not localhost.\\n'
read -r -p 'OpenAI-compatible base URL (example: https://api.example.com/v1): ' base_url
base_url="\${base_url%/}"
read -r -p 'Model ID: ' model
read -r -s -p 'Provider API key (input is hidden): ' api_key
printf '\\n'
[[ -n "$base_url" && -n "$model" && -n "$api_key" ]] || {
    printf 'Base URL, model ID, and API key are required.\\n' >&2
    exit 1
}

install_dir="$HOME/OmenAgent/${v.account}"
mkdir -p "$install_dir"
chmod 700 "$install_dir"
kit_base=${shQuote(v.kitBase)}
for file in ${files}; do
    printf 'Downloading %s\\n' "$file"
    curl --fail --show-error --silent --location \\
        --proto '=https' --tlsv1.2 \\
        "$kit_base/$file" --output "$install_dir/$file"
done

umask 077
cat >"$install_dir/agent.env" <<ENV
IRC_SERVER=${v.ircHost}
IRC_PORT=${v.ircPort}
IRC_TLS=true
IRC_ACCOUNT=${v.account}
IRC_NICK=${v.account}
IRC_PASSWORD=${v.password}
HERDER_ACCOUNT=${v.herder}
OWNER_ACCOUNT=${v.owner}
OPENAI_BASE_URL=$base_url
OPENAI_API_KEY=$api_key
OPENAI_MODEL=$model
OPENAI_MAX_TOKENS=512
OPENAI_TIMEOUT_SECONDS=600
OPENAI_MAX_CONCURRENT_REQUESTS=2
AGENT_DESCRIPTION=${v.agentName}
ENV
unset api_key
chmod 600 "$install_dir/agent.env"

cd "$install_dir"
docker compose config --quiet
docker compose up -d --build
docker compose ps

printf 'Waiting for the IRC connection...\\n'
connected=false
for _ in {1..30}; do
    if docker compose logs --no-color --tail 100 agent 2>&1 |
        grep -q 'connected account='; then
        connected=true
        break
    fi
    sleep 2
done
if [[ "$connected" != true ]]; then
    docker compose logs --no-color --tail 100 agent
    printf 'The agent did not connect within 60 seconds. Review the logs above.\\n' >&2
    exit 1
fi

printf '\\nAgent connected.\\n'
printf 'Test in IRC:\\n%s\\n' ${shQuote(`${v.herder}: ask ${v.agentName} Say hello in one sentence.`)}
printf 'Installed in: %s\\n' "$install_dir"
printf 'Troubleshoot: cd %q && docker compose logs --tail 100\\n' "$install_dir"

case "$0" in
    /*) rm -f -- "$0"
        printf 'The downloaded installer was removed because it contained a one-time IRC credential.\\n'
        ;;
esac
`;
	}

	function filenames(result) {
		const value = stem(result);
		return {
			powershell: `Install-OmenAgent-${value}.ps1`,
			bash: `install-omen-agent-${value}.sh`,
		};
	}

	return {bash, filenames, powershell};
});
